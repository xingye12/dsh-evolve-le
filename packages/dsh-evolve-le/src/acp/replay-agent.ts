/**
 * ACP recorded-replay agent (Gate 2, specs/07 §3-4): serves the Agent Client
 * Protocol over a Capsule composition booted through the real Cordis Loader,
 * on `@agentclientprotocol/sdk` 0.25.1 — the exact version the locked upstream
 * `@deepseek-ai/dsh-acp` 0.1.0-rc.5 builds on. The turn is a deterministic
 * recorded-LLM replay, not a model call: the prompt (composed system sections
 * + user turn) is hashed to a lookup key and answered from the builder-owned
 * table in `runner/acp/recorded-replay.js`; a miss falls back to streaming
 * the composed sections verbatim, so the E2E can always assert that the
 * candidate's section actually flowed through the real Loader into the
 * session layer. No model, no network, no credentials.
 * @module @dsh-evolve-le/core/acp/replay-agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import { BUILDER_VERSION } from '../version.js'
import { promptSha256, replayResponseFor } from './recorded-replay.js'

export interface ReplayPromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

interface SystemPromptService {
  snapshot?: () => readonly ReplayPromptSection[] | Promise<readonly ReplayPromptSection[]>
  assemble?: () => Promise<{ sections: readonly { name: string; text: string }[] }>
}

/** One session: captured prompt identity and the task workspace path. */
export interface ReplaySession {
  sessionId: string
  sections: readonly ReplayPromptSection[]
  cwd: string
}

/** The deterministic replay turn emitted for `session/prompt`. */
export interface ReplayTurn {
  stopReason: 'end_turn'
  chunks: { name: string; text: string }[]
}

/** Plain text of the text blocks of a prompt (the user turn, in order). */
export function promptText(prompt: PromptRequest): string {
  const blocks = Array.isArray(prompt.prompt) ? prompt.prompt : [prompt.prompt]
  return blocks
    .filter((block: ContentBlock): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function systemPromptService(ctx: Context): SystemPromptService | undefined {
  const direct = (ctx as unknown as { systemPrompt?: SystemPromptService }).systemPrompt
  if (direct !== undefined) return direct
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  return typeof get === 'function' ? (get.call(ctx, 'systemPrompt') as SystemPromptService | undefined) : undefined
}

/**
 * Read the composed prompt only through public service APIs. The compatibility
 * runner exposes a synchronous snapshot; upstream DSH exposes asynchronous
 * SystemPrompt.assemble(), whose section order is already canonical.
 */
export async function replayPromptSections(ctx: Context): Promise<readonly ReplayPromptSection[]> {
  const service = systemPromptService(ctx)
  if (service === undefined) return []
  if (typeof service.snapshot === 'function') return await service.snapshot()
  if (typeof service.assemble !== 'function') return []
  const assembly = await service.assemble()
  return assembly.sections.map((section, order) => ({ ...section, order }))
}

/**
 * Build the recorded-replay `Agent` over a booted Capsule context. Session
 * creation captures the composed prompt sections and the workspace `cwd`;
 * each prompt turn hashes the full prompt and answers from the recorded
 * table, falling back to streaming the composed sections when no recording
 * exists. No model, no network, no wall-clock dependence beyond UUID identity.
 */
export function createReplayAgent(
  ctx: Context,
  connection: AgentSideConnection,
): Agent & { sessions: Map<string, ReplaySession> } {
  const sessions = new Map<string, ReplaySession>()
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
      const sections = await replayPromptSections(ctx)
      const sessionId = randomUUID()
      sessions.set(sessionId, { sessionId, sections, cwd: params.cwd })
      return { sessionId }
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId)
      if (session === undefined) {
        throw new Error(`acp replay: unknown session ${params.sessionId}`)
      }
      const userText = promptText(params)
      const hash = promptSha256({ sections: session.sections, userText })
      const recorded = replayResponseFor(hash)
      if (recorded !== undefined) {
        await connection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: recorded },
          },
        })
        return { stopReason: 'end_turn' }
      }
      // Deterministic fallback: make the miss and the composed sections
      // observable so candidate influence is verifiable on every turn.
      await connection.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `[dsh-evolve-le replay] no recorded response for prompt sha256:${hash} (workspace: ${session.cwd}); composed sections:`,
          },
        },
      })
      for (const section of [...session.sections].sort((a, b) => a.order - b.order)) {
        await connection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `[${section.name}]\n${section.text}`,
            },
          },
        })
      }
      return { stopReason: 'end_turn' }
    },
    async cancel(_params: CancelNotification): Promise<void> {
      // Replay turns are synchronous; there is nothing in flight to cancel.
    },
    async authenticate(_params: AuthenticateRequest): Promise<void> {
      // The replay agent advertises no authMethods, so the connection never
      // routes here; the interface requires the method to exist.
    },
  }
}

/** Extract the plain text of `agent_message_chunk` updates from a session. */
export function replayChunkText(
  updates: { sessionUpdate: string; content?: { text?: string } }[],
): string[] {
  return updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
}
