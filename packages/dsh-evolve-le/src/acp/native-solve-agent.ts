/** ACP transport over an upstream DSH agent/session scope. */

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
} from '@agentclientprotocol/sdk'
import { BUILDER_VERSION } from '../version.js'
import {
  createNativeDshAgent,
  candidateStrategySetupOf,
  installNativePromptSections,
  nativeUserMessage,
  type NativeDshAgent,
} from '../dsh/native-composition.js'
import { installNativeSolveTools } from './native-solve-tools.js'
import { promptText } from './replay-agent.js'
import type { LiveSolveRuntimeLimits } from './solve-protocol.js'

/** TCB-owned native solve instructions; native DSH tools replace directives. */
export const NATIVE_SOLVE_POLICY_SECTION = {
  name: 'tcb:native-solve-policy',
  order: 9_900,
  text: [
    'You are solving a Terminal-Bench task in the workspace supplied by ACP.',
    'Use solve_exec for commands, solve_read for absolute-path reads, and solve_write for complete file writes.',
    'These tools are the only workspace effect channel. Verify changes with solve_exec before responding.',
    'When the task is complete, respond with the concise final answer expected by the verifier.',
  ].join('\n'),
} as const

export interface NativeSolveSession {
  sessionId: string
  cwd: string
  handle: NativeDshAgent
  emittedEvents: number
  /** Session creation time on the (possibly injected) clock. */
  createdAt: number
  /** Wall-clock deadline timer; cleared when the session is disposed. */
  deadlineTimer?: ReturnType<typeof setTimeout> | undefined
}

/**
 * Gateway-receipt cost accumulator threaded in from acp-boot's `complete`
 * closure. Token counts ride the upstream agent-loop's `assistant/message`
 * session events, but the receipt's `costUsdMicros` never enters the DSH
 * stream — the adapter result has no cost field — so the agent reads this
 * sink AFTER each turn settles (never at session creation) and reports the
 * cumulative figure, matching the compatibility loop's authority split:
 * receipt figures, never self-computed.
 */
export interface NativeSolveUsageSink {
  costUsdMicros: number
}

export interface NativeSolveAgentOptions {
  provider?: string
  model?: string
  maxTokens?: number
  usageSink?: NativeSolveUsageSink
  /**
   * Hard runtime caps (ADR-030). Upstream `agents.create()` carries no turn
   * cap, so `maxTurns` is enforced by an agent-scoped `agent/pre-step`
   * waterfall listener (registered in setup) that rejects the proposed step
   * once the loop's own turn counter exceeds the cap — the loop ends that
   * turn as `blocked`. `wallClockMs` arms a deadline timer that cancels the
   * agent through the same `cancel({kind:'user'})` path ACP session/cancel
   * uses (CreateAgentOptions.signal is creation-only and cannot carry a
   * later deadline). `commandTimeoutMs` becomes the solve_exec tool budget.
   */
  limits?: LiveSolveRuntimeLimits
  /** Clock override for tests; defaults to Date.now. */
  now?: () => number
}

/** Sum the `data.usage` token figures across one session's message events. */
function sessionTokenUsage(events: readonly { type: string; data?: unknown }[]): {
  inputTokens: number
  outputTokens: number
} {
  let inputTokens = 0
  let outputTokens = 0
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const usage = (event.data as { usage?: unknown } | undefined)?.usage
    if (usage === null || typeof usage !== 'object') continue
    const input = (usage as { inputTokens?: unknown }).inputTokens
    const output = (usage as { outputTokens?: unknown }).outputTokens
    if (typeof input === 'number' && Number.isFinite(input)) inputTokens += input
    if (typeof output === 'number' && Number.isFinite(output)) outputTokens += output
  }
  return { inputTokens, outputTokens }
}

/**
 * Whether the session's latest `turn/end` record says the turn was aborted.
 * The upstream loop swallows the abort in kick(), so whenIdle() resolves
 * normally even for a cancelled turn; the loop-owned truth is the `turn/end`
 * session event appended in turn()'s finally with `reason.kind === 'aborted'`.
 * ACP session/cancel and the wall-clock deadline both arrive through that
 * record, so reading it maps every cancel path to the ACP `cancelled` stop
 * reason uniformly — a cancelled turn must never masquerade as `end_turn`.
 */
function latestTurnAborted(events: readonly { type: string; data?: unknown }[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
    return reason?.kind === 'aborted'
  }
  return false
}

/**
 * Adapt only ACP framing. Turn scheduling, tool dispatch, session events and
 * cancellation remain owned by the DSH agent-loop.
 */
export function createNativeSolveAgent(
  ctx: Context,
  connection: AgentSideConnection,
  options: NativeSolveAgentOptions = {},
): Agent & { sessions: Map<string, NativeSolveSession>; dispose(): Promise<void> } {
  const sessions = new Map<string, NativeSolveSession>()
  const emit = async (
    sessionId: string,
    events: readonly { type: string; data?: unknown }[],
    from: number,
  ): Promise<void> => {
    for (const event of events.slice(from)) {
      if (event.type !== 'assistant/message') continue
      const content = (event.data as { message?: { content?: unknown } } | undefined)?.message
        ?.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const text = (block as { type?: unknown; text?: unknown }).text
        if (
          (block as { type?: unknown }).type === 'text' &&
          typeof text === 'string' &&
          text.length > 0
        ) {
          await connection.sessionUpdate({
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
          })
        }
      }
    }
  }

  const dispose = async (): Promise<void> => {
    const live = [...sessions.values()]
    sessions.clear()
    for (const session of live) {
      if (session.deadlineTimer !== undefined) clearTimeout(session.deadlineTimer)
    }
    await Promise.all(live.map((session) => session.handle.dispose().catch(() => undefined)))
  }

  return {
    sessions,
    dispose,
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'dsh-evolve-le-native-runner', version: BUILDER_VERSION },
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
      }
    },
    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const sessionId = randomUUID()
      const limits = options.limits
      const handle = await createNativeDshAgent(ctx, {
        sessionId,
        cwd: params.cwd,
        mode: 'solve',
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        setup: async (agentCtx) => {
          await candidateStrategySetupOf(ctx)?.(agentCtx)
          installNativePromptSections(agentCtx, [NATIVE_SOLVE_POLICY_SECTION])
          installNativeSolveTools(agentCtx, {
            connection,
            sessionId,
            cwd: params.cwd,
            ...(limits === undefined ? {} : { commandTimeoutMs: limits.commandTimeoutMs }),
          })
          if (limits !== undefined) {
            // Turn cap: upstream AgentOptions has no maxTurns, so reject the
            // proposed step once the loop's own turn counter passes the cap.
            // The loop ends that turn as `blocked` and goes idle; the capsule
            // never drives past the budget.
            const maxTurns = limits.maxTurns
            const onPreStep = (
              payload: { turn: number },
              next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
            ): Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }> =>
              payload.turn > maxTurns
                ? Promise.resolve({ kind: 'reject' })
                : next()
            ;(agentCtx as unknown as { on: (event: string, listener: typeof onPreStep) => void }).on(
              'agent/pre-step',
              onPreStep,
            )
          }
        },
      })
      const session: NativeSolveSession = {
        sessionId,
        cwd: params.cwd,
        handle,
        emittedEvents: 0,
        createdAt: (options.now ?? Date.now)(),
      }
      if (limits !== undefined) {
        // Wall-clock deadline: cancel through the same path ACP session/cancel
        // takes so the in-flight request aborts via the loop's phase signal.
        // The timer is the in-turn backstop; prompt() re-checks the deadline
        // at each turn boundary so a turn that starts past it still cancels.
        session.deadlineTimer = setTimeout(
          () => {
            session.handle.agent.cancel?.({ kind: 'user' })
          },
          limits.wallClockMs,
        )
        session.deadlineTimer.unref?.()
      }
      sessions.set(sessionId, session)
      return { sessionId }
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId)
      if (session === undefined) throw new Error(`native DSH: unknown session ${params.sessionId}`)
      // Wall-clock deadline check at the turn boundary: the deadline timer is
      // the in-turn backstop, but a turn that STARTS past the deadline must
      // still cancel (the injected clock in tests only moves between turns).
      if (session.deadlineTimer !== undefined && options.limits !== undefined) {
        const now = options.now ?? Date.now
        if (now() >= session.createdAt + options.limits.wallClockMs) {
          clearTimeout(session.deadlineTimer)
          session.deadlineTimer = undefined
          session.handle.agent.cancel?.({ kind: 'user' })
        }
      }
      session.handle.agent.followup(nativeUserMessage(promptText(params)))
      await session.handle.agent.whenIdle()
      const events = session.handle.agent.session?.events ?? []
      await emit(session.sessionId, events, session.emittedEvents)
      session.emittedEvents = events.length
      // Usage authority (same split as the compatibility loop): token totals
      // from the agent-loop's own session events; cost from the gateway
      // receipt sink, read now that the in-flight turn has settled.
      const { inputTokens, outputTokens } = sessionTokenUsage(events)
      const costUsdMicros = options.usageSink?.costUsdMicros ?? 0
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
        stopReason: latestTurnAborted(events) ? 'cancelled' : 'end_turn',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      }
    },
    async cancel(params: CancelNotification): Promise<void> {
      const session = sessions.get(params.sessionId)
      session?.handle.agent.cancel?.({ kind: 'user' })
    },
    async authenticate(_params: AuthenticateRequest): Promise<void> {
      // No ACP authentication method is advertised by this capsule.
    },
  }
}
