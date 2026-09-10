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
import {
  installNativeSolveTools,
  type NativeSolveToolObservationSink,
} from './native-solve-tools.js'
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

/**
 * Candidate-owned workflow name which the trusted solve runtime executes at
 * every admitted agent step.  Unlike a static prompt-section delta, this hook
 * receives the live turn/step coordinate and can request a bounded checkpoint
 * in the actual DSH pre-step waterfall.  It cannot dispatch ACP tools, alter
 * the verifier, or change controller limits.
 */
export const CANDIDATE_SOLVE_POLICY_WORKFLOW = 'candidate-workflow:solve-policy' as const
export const CANDIDATE_SOLVE_POLICY_PROTOCOL = 'dsh-evolve-le/candidate-solve-policy/v2' as const
export const CANDIDATE_STRATEGY_CONTEXT_PROTOCOL =
  'dsh-evolve-le/candidate-strategy-context/v1' as const
export const CANDIDATE_AGENT_PRE_STEP_EVENT = 'candidate:agent/pre-step' as const
export const CANDIDATE_SESSION_START_EVENT = 'candidate:session/start' as const
export const CANDIDATE_SESSION_END_EVENT = 'candidate:session/end' as const

/** Content-free, TCB-derived facts from prior tool effects in this session. */
export interface CandidateSolveObservation {
  toolCalls: { exec: number; read: number; write: number }
  previousAction: 'none' | 'exec' | 'read' | 'write'
  lastExec: {
    outcome: 'none' | 'succeeded' | 'failed' | 'empty-output' | 'timed-out' | 'unknown'
    consecutiveRepeated: number
  }
  writesSinceLastExec: number
}

type CandidateSolveObservationTracker = NativeSolveToolObservationSink & {
  snapshot(): CandidateSolveObservation
}

const observationCount = (value: number): number => Math.min(value, 1_000_000)

/**
 * Keep raw tool data private to the TCB while deriving a small deterministic
 * observation that a candidate may only turn into a bounded checkpoint.
 */
export function createCandidateSolveObservationTracker(): CandidateSolveObservationTracker {
  let exec = 0
  let read = 0
  let write = 0
  let previousAction: CandidateSolveObservation['previousAction'] = 'none'
  let lastCommandKey: string | undefined
  let consecutiveRepeated = 0
  let lastOutcome: CandidateSolveObservation['lastExec']['outcome'] = 'none'
  let writesSinceLastExec = 0
  return {
    execStarted(input) {
      const key = JSON.stringify([input.command, input.args ?? []])
      consecutiveRepeated = key === lastCommandKey ? observationCount(consecutiveRepeated + 1) : 0
      lastCommandKey = key
      exec = observationCount(exec + 1)
      writesSinceLastExec = 0
      previousAction = 'exec'
    },
    execFinished(outcome) {
      lastOutcome = outcome
    },
    readCompleted() {
      read = observationCount(read + 1)
      previousAction = 'read'
    },
    writeCompleted() {
      write = observationCount(write + 1)
      writesSinceLastExec = observationCount(writesSinceLastExec + 1)
      previousAction = 'write'
    },
    snapshot() {
      return {
        toolCalls: { exec, read, write },
        previousAction,
        lastExec: { outcome: lastOutcome, consecutiveRepeated },
        writesSinceLastExec,
      }
    },
  }
}

type CandidateWorkflow = {
  name: string
  description: string
  run(input: unknown): Promise<unknown>
}

type CandidateWorkflowRegistry = {
  register(workflow: CandidateWorkflow): () => void
  snapshot(): readonly CandidateWorkflow[]
}

type CandidateStrategyEvent = { name: string; handler: (...args: unknown[]) => unknown }
type CandidateStrategyEventsRegistry = {
  register(event: CandidateStrategyEvent): () => void
  emit(name: string, input: unknown): Promise<unknown[]>
  snapshot(): readonly CandidateStrategyEvent[]
}
type CandidateStrategyTool = { name: string; run(input: unknown): Promise<unknown> }
type CandidateStrategyToolsRegistry = {
  register(tool: CandidateStrategyTool): () => void
  snapshot(): readonly CandidateStrategyTool[]
}

function installCandidateStrategyEvents(agentCtx: Context): CandidateStrategyEventsRegistry {
  const events: CandidateStrategyEvent[] = []
  const provide = (agentCtx as unknown as { provide?: (name: string, value: unknown) => void }).provide
  if (typeof provide !== 'function') throw new Error('native solve: agent context cannot provide candidateStrategyEvents')
  const registry: CandidateStrategyEventsRegistry = {
    register(event) {
      events.push(event)
      return () => {
        const index = events.indexOf(event)
        if (index >= 0) events.splice(index, 1)
      }
    },
    async emit(name, input) {
      const values: unknown[] = []
      for (const event of events) if (event.name === name) values.push(await event.handler(input))
      return values
    },
    snapshot: () => [...events],
  }
  provide.call(agentCtx, 'candidateStrategyEvents', registry)
  return registry
}

function installCandidateStrategyTools(agentCtx: Context): CandidateStrategyToolsRegistry {
  const tools: CandidateStrategyTool[] = []
  const provide = (agentCtx as unknown as { provide?: (name: string, value: unknown) => void }).provide
  if (typeof provide !== 'function') throw new Error('native solve: agent context cannot provide candidateStrategyTools')
  const registry: CandidateStrategyToolsRegistry = {
    register(tool) {
      tools.push(tool)
      return () => {
        const index = tools.indexOf(tool)
        if (index >= 0) tools.splice(index, 1)
      }
    },
    snapshot: () => [...tools],
  }
  provide.call(agentCtx, 'candidateStrategyTools', registry)
  return registry
}

/**
 * ADR-060: the capsule's outer scope carries the candidate-workflow-stub
 * (ADR-054) so candidate plugins can publish workflow declarations at Loader
 * activation. Cordis forbids re-providing a service that already exists in
 * an ancestor scope — the agent Fiber's state copies the root, so the
 * per-Fiber fresh registry the ADR-054 draft assumed is structurally
 * impossible; the ADR-059 smoke's mockReplay turn proved it with a duplicate
 * provision throw. When the stub is present the runner reuses it: candidate
 * registration/disposal stay effect-scoped through the same registry object,
 * and the TCB still executes only the fixed solve-policy name. Stub-free
 * scopes (unit fixtures, pre-ADR-054 capsules) keep the fresh provision.
 */
function installCandidateWorkflowRegistry(agentCtx: Context): {
  workflows: () => readonly CandidateWorkflow[]
} {
  const inherited = inheritedCandidateWorkflows(agentCtx)
  if (inherited !== undefined) {
    if (typeof inherited.register !== 'function' || typeof inherited.snapshot !== 'function') {
      throw new Error(
        'native solve: outer-scope candidateWorkflows registry is not usable (missing register/snapshot)',
      )
    }
    return { workflows: () => inherited.snapshot() }
  }
  const workflows: CandidateWorkflow[] = []
  const provide = (
    agentCtx as unknown as {
      provide?: (name: string, value: CandidateWorkflowRegistry) => void
    }
  ).provide
  if (typeof provide !== 'function') {
    throw new Error('native solve: agent context cannot provide candidateWorkflows')
  }
  provide.call(agentCtx, 'candidateWorkflows', {
    register(workflow: CandidateWorkflow): () => void {
      workflows.push(workflow)
      return () => {
        const index = workflows.indexOf(workflow)
        if (index >= 0) workflows.splice(index, 1)
      }
    },
    snapshot(): readonly CandidateWorkflow[] {
      return [...workflows]
    },
  })
  return { workflows: () => workflows }
}

function inheritedCandidateWorkflows(agentCtx: Context): CandidateWorkflowRegistry | undefined {
  try {
    const service = (agentCtx as unknown as { get?: (name: string) => unknown }).get?.(
      'candidateWorkflows',
    )
    return service !== null && typeof service === 'object'
      ? (service as CandidateWorkflowRegistry)
      : undefined
  } catch {
    return undefined
  }
}

function checkpointOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const checkpoint = (value as { checkpoint?: unknown }).checkpoint
  if (typeof checkpoint !== 'string' || checkpoint.length === 0 || checkpoint.length > 2_048) {
    return undefined
  }
  return checkpoint
}

export interface NativeSolveSession {
  sessionId: string
  cwd: string
  handle: NativeDshAgent
  emittedEvents: number
  /** Session creation time on the (possibly injected) clock. */
  createdAt: number
  /** Wall-clock deadline timer; cleared when the session is disposed. */
  deadlineTimer?: ReturnType<typeof setTimeout> | undefined
  /** Emits the bounded end-of-session strategy event once, during disposal. */
  completeStrategySession?: () => Promise<void>
  strategyUsage: {
    workflowInvocations: number
    strategyToolInvocations: number
    agentEventInvocations: number
    sessionEventInvocations: number
  }
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
    await Promise.all(
      live.map(async (session) => {
        // Session lifecycle hooks are TCB-dispatched, not arbitrary DSH event
        // subscriptions.  Their result cannot affect an already-closed ACP
        // session, but it is included in the per-session execution evidence.
        await session.completeStrategySession?.().catch(() => undefined)
        await session.handle.dispose().catch(() => undefined)
      }),
    )
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
      const observation = createCandidateSolveObservationTracker()
      const strategyUsage = {
        workflowInvocations: 0,
        strategyToolInvocations: 0,
        agentEventInvocations: 0,
        sessionEventInvocations: 0,
      }
      let strategyEvents: CandidateStrategyEventsRegistry | undefined
      let strategyTools: CandidateStrategyToolsRegistry | undefined
      let pendingSessionCheckpoints: string[] = []
      const strategyContext = (
        phase: 'session-start' | 'pre-step' | 'session-end',
        turn: number,
        step: number,
      ) => ({
        protocol: CANDIDATE_STRATEGY_CONTEXT_PROTOCOL,
        turn,
        step,
        phase,
        observation: observation.snapshot(),
      })
      const handle = await createNativeDshAgent(ctx, {
        sessionId,
        cwd: params.cwd,
        mode: 'solve',
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        setup: async (agentCtx) => {
          // The workflow registry is an explicit candidate surface.  Candidate
          // setup may register many audit workflows, but the TCB executes only
          // the fixed solve-policy name below and only as a bounded checkpoint
          // injection; it is not an ACP/tool escape hatch.
          const workflowRegistry = installCandidateWorkflowRegistry(agentCtx)
          strategyEvents = installCandidateStrategyEvents(agentCtx)
          strategyTools = installCandidateStrategyTools(agentCtx)
          await candidateStrategySetupOf(ctx)?.(agentCtx)
          installNativePromptSections(agentCtx, [NATIVE_SOLVE_POLICY_SECTION])
          installNativeSolveTools(agentCtx, {
            connection,
            sessionId,
            cwd: params.cwd,
            observation,
            ...(limits === undefined ? {} : { commandTimeoutMs: limits.commandTimeoutMs }),
          })
          const solvePolicies = workflowRegistry.workflows().filter(
            // ADR-060: stub-registered records may carry declaration-only
            // entries; only an executable solve-policy workflow runs.
            (workflow) =>
              workflow.name === CANDIDATE_SOLVE_POLICY_WORKFLOW &&
              typeof workflow.run === 'function',
          )
          if (
            limits !== undefined ||
            solvePolicies.length > 0 ||
            strategyTools.snapshot().length > 0 ||
            strategyEvents
              .snapshot()
              .some((event) => event.name === CANDIDATE_AGENT_PRE_STEP_EVENT)
          ) {
            // Turn cap: upstream AgentOptions has no maxTurns, so reject the
            // proposed step once the loop's own turn counter passes the cap.
            // The loop ends that turn as `blocked` and goes idle; the capsule
            // never drives past the budget.
            const onPreStep = async (
              payload: { turn: number },
              next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
            ): Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }> => {
              if (limits !== undefined && payload.turn > limits.maxTurns) return { kind: 'reject' }
              const admitted = await next()
              if (admitted.kind === 'reject') return admitted
              const checkpoints: string[] = [...pendingSessionCheckpoints]
              pendingSessionCheckpoints = []
              const input = strategyContext(
                'pre-step',
                payload.turn,
                (payload as { step?: number }).step ?? 0,
              )
              const eventValues = await strategyEvents!.emit(CANDIDATE_AGENT_PRE_STEP_EVENT, input)
              strategyUsage.agentEventInvocations += eventValues.length
              for (const value of eventValues) {
                const checkpoint = checkpointOf(value)
                if (checkpoint !== undefined) checkpoints.push(checkpoint)
              }
              for (const tool of strategyTools!.snapshot().slice(0, 4)) {
                strategyUsage.strategyToolInvocations += 1
                const checkpoint = checkpointOf(await tool.run(input))
                if (checkpoint !== undefined) checkpoints.push(checkpoint)
              }
              for (const policy of solvePolicies) {
                strategyUsage.workflowInvocations += 1
                const checkpoint = checkpointOf(
                  await policy.run({
                    protocol: CANDIDATE_SOLVE_POLICY_PROTOCOL,
                    turn: payload.turn,
                    step: (payload as { step?: number }).step ?? 0,
                    observation: observation.snapshot(),
                  }),
                )
                if (checkpoint !== undefined) checkpoints.push(checkpoint)
              }
              if (checkpoints.length === 0) return admitted
              return {
                kind: 'enter',
                messages: [
                  ...admitted.messages,
                  ...checkpoints.map((checkpoint) =>
                    nativeUserMessage(
                      `<candidate-solve-checkpoint>${checkpoint}</candidate-solve-checkpoint>`,
                    ),
                  ),
                ],
              }
            }
            ;(
              agentCtx as unknown as { on: (event: string, listener: typeof onPreStep) => void }
            ).on('agent/pre-step', onPreStep)
          }
        },
      })
      if (strategyEvents !== undefined) {
        const eventValues = await strategyEvents.emit(
          CANDIDATE_SESSION_START_EVENT,
          strategyContext('session-start', 0, 0),
        )
        strategyUsage.sessionEventInvocations += eventValues.length
        for (const value of eventValues) {
          const checkpoint = checkpointOf(value)
          if (checkpoint !== undefined) pendingSessionCheckpoints.push(checkpoint)
        }
      }
      const session: NativeSolveSession = {
        sessionId,
        cwd: params.cwd,
        handle,
        emittedEvents: 0,
        createdAt: (options.now ?? Date.now)(),
        strategyUsage,
        completeStrategySession: async () => {
          if (strategyEvents === undefined) return
          const eventValues = await strategyEvents.emit(
            CANDIDATE_SESSION_END_EVENT,
            strategyContext('session-end', 0, 0),
          )
          strategyUsage.sessionEventInvocations += eventValues.length
        },
      }
      if (limits !== undefined) {
        // Wall-clock deadline: cancel through the same path ACP session/cancel
        // takes so the in-flight request aborts via the loop's phase signal.
        // The timer is the in-turn backstop; prompt() re-checks the deadline
        // at each turn boundary so a turn that starts past it still cancels.
        session.deadlineTimer = setTimeout(() => {
          session.handle.agent.cancel?.({ kind: 'user' })
        }, limits.wallClockMs)
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
