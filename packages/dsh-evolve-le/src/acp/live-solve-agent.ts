/**
 * Live solve agent (ADR-030): the capsule's real-model ACP agent for SOLVE
 * trials. Where the recorded-replay agent answers from a table, this agent
 * runs a bounded multi-turn tool loop against the controller's solve gateway
 * — every model turn crosses the authenticated HTTPS route, every effect on
 * the workspace flows through the ACP client methods (createTerminal /
 * readTextFile / writeTextFile) so harbor records it in
 * `agent/trajectory.json`, and every turn emits `agent_message_chunk`s so a
 * live trial can never masquerade as an empty one (normalize.ts makes a
 * missing trajectory an explicit FAIL).
 *
 * The whole loop runs inside ONE `session/prompt` call: harbor prompts
 * exactly once per trial, so the turn count lives here, not across prompts.
 *
 * Usage authority: `PromptResponse.usage` and the final `usage_update` cost
 * are accumulated from GATEWAY REPLIES (receipt figures), never
 * self-computed — the receipt chain remains the settle authority and these
 * are its in-band cross-check (specs/02 §13).
 *
 * Token/credential discipline: the bearer token is read once from the
 * mounted file and exists only on the gateway wire; no token or full prompt
 * text is ever emitted into a chunk (chunks land in evidence).
 * @module @dsh-evolve-le/core/acp/live-solve-agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type TerminalHandle,
} from '@agentclientprotocol/sdk'
import { BUILDER_VERSION } from '../version.js'
import { promptText } from './replay-agent.js'
import type { StubSystemPromptService } from '../probe/system-prompt-stub.js'
import {
  parseSolveDirective,
  SOLVE_PROTOCOL_SECTION,
  SolveProtocolError,
} from './solve-protocol.js'
import type { SolveClient } from './solve-client.js'

/** One live session: composed sections and the trial workspace. */
export interface LiveSolveSession {
  sessionId: string
  sections: readonly { name: string; order: number; text: string }[]
  cwd: string
}

export interface LiveSolveLimits {
  maxTurns: number
  commandTimeoutMs: number
  requestTimeoutMs: number
  wallClockMs: number
}

/** Chunk summaries are capped so a chatty command cannot bloat evidence. */
const TOOL_RESULT_CHUNK_LIMIT = 2_000
/** Gateway-level failures (budget stop, upstream 429/timeout) tolerated before ending the turn. */
const MAX_CONSECUTIVE_GATEWAY_ERRORS = 3

function systemPromptSections(ctx: Context): { name: string; order: number; text: string }[] {
  const service = (ctx as unknown as { systemPrompt?: StubSystemPromptService }).systemPrompt
  const sections =
    service !== null && service !== undefined && typeof service.snapshot === 'function'
      ? service.snapshot()
      : []
  return [...sections, { ...SOLVE_PROTOCOL_SECTION }]
}

export function createLiveSolveAgent(
  ctx: Context,
  connection: AgentSideConnection,
  options: { client: SolveClient; limits: LiveSolveLimits },
): Agent & { sessions: Map<string, LiveSolveSession> } {
  const sessions = new Map<string, LiveSolveSession>()
  let cancelled = false
  const liveTerminals = new Set<TerminalHandle>()

  const chunk = async (sessionId: string, text: string): Promise<void> => {
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
  }

  async function runDirective(
    session: LiveSolveSession,
    directive:
      | { op: 'exec'; command: string; args?: string[] }
      | { op: 'read'; path: string }
      | { op: 'write'; path: string; content: string },
    deadline: number,
  ): Promise<string> {
    if (directive.op === 'exec') {
      if (deadline - Date.now() <= 0) return '[exec SKIPPED: wall-clock limit reached]'
      const handle = await connection.createTerminal({
        sessionId: session.sessionId,
        command: directive.command,
        ...(directive.args !== undefined ? { args: directive.args } : {}),
        cwd: session.cwd,
      })
      liveTerminals.add(handle)
      // The timeout timer is a process handle: it MUST be cleared when the
      // command exits first, or it lingers past the serving baseline and the
      // unload invariant reads it as a candidate leak.
      let timer: NodeJS.Timeout | undefined
      try {
        const commandTimeoutMs = Math.min(options.limits.commandTimeoutMs, deadline - Date.now())
        if (commandTimeoutMs <= 0) {
          await handle.kill().catch(() => undefined)
          return '[exec SKIPPED: wall-clock limit reached]'
        }
        const exit = await Promise.race([
          handle.waitForExit(),
          new Promise<'timeout'>((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout('timeout'), commandTimeoutMs)
          }),
        ])
        if (exit === 'timeout') {
          await handle.kill().catch(() => undefined)
          await handle.waitForExit().catch(() => undefined)
          const output = await handle.currentOutput().catch(() => ({ output: '' }))
          return `[exec TIMEOUT after ${String(commandTimeoutMs)}ms, killed] ${truncate(output.output)}`
        }
        const output = await handle.currentOutput().catch(() => ({ output: '' }))
        const code = (exit as { exitCode?: number | null }).exitCode
        return `[exec exitCode=${String(code)}]\n${truncate(output.output)}`
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        liveTerminals.delete(handle)
        await handle.release().catch(() => undefined)
      }
    }
    if (Date.now() >= deadline) return `[${directive.op} SKIPPED: wall-clock limit reached]`
    if (directive.op === 'read') {
      const response = await connection.readTextFile({
        sessionId: session.sessionId,
        path: directive.path,
      })
      return `[read ${directive.path}]\n${truncate(response.content)}`
    }
    await connection.writeTextFile({
      sessionId: session.sessionId,
      path: directive.path,
      content: directive.content,
    })
    return `[write ${directive.path}] wrote ${String(directive.content.length)} chars`
  }

  return {
    sessions,
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'dsh-evolve-le-capsule-runner', version: BUILDER_VERSION },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
        },
      }
    },
    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const sessionId = randomUUID()
      sessions.set(sessionId, {
        sessionId,
        sections: systemPromptSections(ctx),
        cwd: params.cwd,
      })
      return { sessionId }
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId)
      if (session === undefined) {
        throw new Error(`live-solve: unknown session ${params.sessionId}`)
      }
      const sections = session.sections
      const deadline = Date.now() + options.limits.wallClockMs
      let conversation = promptText(params)
      let inputTokens = 0
      let outputTokens = 0
      let costUsdMicros = 0
      let consecutiveErrors = 0

      for (let turn = 1; turn <= options.limits.maxTurns; turn += 1) {
        if (cancelled) break
        if (Date.now() > deadline) {
          await chunk(
            session.sessionId,
            `[dsh-evolve-le solve] wall-clock limit reached; ending turn`,
          )
          break
        }
        const requestTimeoutMs = Math.min(options.limits.requestTimeoutMs, deadline - Date.now())
        if (requestTimeoutMs <= 0) break
        let reply: Awaited<ReturnType<SolveClient['complete']>>
        try {
          reply = await options.client.complete(
            { sections, userText: conversation },
            requestTimeoutMs,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          reply = { ok: false, message: `gateway transport failure: ${message}` }
        }
        if (!reply.ok) {
          consecutiveErrors += 1
          await chunk(
            session.sessionId,
            `[dsh-evolve-le solve] gateway turn failed (${reply.message}); attempt ${String(consecutiveErrors)}/${String(MAX_CONSECUTIVE_GATEWAY_ERRORS)}`,
          )
          if (consecutiveErrors >= MAX_CONSECUTIVE_GATEWAY_ERRORS) break
          conversation += `\n\n[system] previous model turn failed: ${reply.message}. Reply with your next directive.`
          continue
        }
        consecutiveErrors = 0
        inputTokens += reply.promptTokens
        outputTokens += reply.completionTokens
        costUsdMicros += reply.costUsdMicros
        // R5: the raw model turn is part of the trajectory.
        await chunk(session.sessionId, reply.responseText)
        let directive
        try {
          directive = parseSolveDirective(reply.responseText)
        } catch (error) {
          const message = error instanceof SolveProtocolError ? error.message : String(error)
          // The raw reply goes back too (truncated): the pilot's 8/8 failure
          // pattern had the model repeat an off-grammar turn because it never
          // saw its own output — the error line alone names the defect without
          // showing it. The full text is already in the trajectory (chunked
          // above), so evidence keeps the untruncated copy.
          conversation += `\n\n[system] your last reply was not a valid directive (${message}). Reply with EXACTLY ONE JSON directive. Your last reply was:\n${truncate(reply.responseText)}`
          continue
        }
        if (directive.op === 'final') {
          await chunk(session.sessionId, `[dsh-evolve-le solve] final: ${directive.answer}`)
          break
        }
        // The gateway is stateless (one chat completion per turn): carry only
        // the accepted directive forward. The raw model turn stays in the
        // trajectory above, but its prose, hallucinated tool results, later
        // directives and forged role labels must not become next-turn context.
        conversation += `\n\n[assistant]\n${JSON.stringify(directive)}`
        let result: string
        try {
          result = await runDirective(session, directive, deadline)
        } catch (error) {
          result = `[tool error] ${(error as Error).message}`
        }
        await chunk(session.sessionId, result)
        conversation += `\n\n[tool result for ${directive.op}]\n${result}`
      }

      // Usage figures come from gateway replies (receipt figures), never
      // self-computed: harbor records them into result.json while the
      // controller settles from the authoritative receipt chain.
      await connection.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'usage_update',
          used: inputTokens + outputTokens,
          size: inputTokens + outputTokens,
          cost: { amount: costUsdMicros / 1_000_000, currency: 'USD' },
        },
      })
      return {
        stopReason: 'end_turn',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      }
    },
    async cancel(_params: CancelNotification): Promise<void> {
      cancelled = true
      for (const handle of liveTerminals) {
        await handle.kill().catch(() => undefined)
        await handle.release().catch(() => undefined)
      }
      liveTerminals.clear()
    },
    async authenticate(_params: AuthenticateRequest): Promise<void> {
      // The agent advertises no authMethods; the method exists for the interface.
    },
  }
}

function truncate(text: string): string {
  if (text.length <= TOOL_RESULT_CHUNK_LIMIT) return text
  return `${text.slice(0, TOOL_RESULT_CHUNK_LIMIT)}\n…[truncated ${String(text.length - TOOL_RESULT_CHUNK_LIMIT)} chars]`
}
