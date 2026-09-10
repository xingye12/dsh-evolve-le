/**
 * Native solve agent usage contract (ADR-030, specs/04 §usage): the native
 * DSH solve path must report the SAME usage authority as the compatibility
 * loop — a single `usage_update` carrying the session's cumulative token
 * totals and the gateway-receipt cost, plus `PromptResponse.usage` — because
 * harbor's acp.py settles `result.json` cost/token fields from exactly those
 * two surfaces. Token counts come from the upstream agent-loop's
 * `assistant/message` session events (`data.usage`, populated from the
 * adapter's `usage` chunk); the cost figure comes from the gateway receipt
 * accumulator acp-boot threads in, never self-computed.
 *
 * Runtime-limits contract (same file, second describe): upstream
 * `agents.create()` has no turn cap (AgentOptions carries only
 * provider/model/maxTokens), so the capsule enforces `maxTurns` through the
 * upstream extension point — an agent-scoped `agent/pre-step` waterfall
 * listener registered in setup() that REJECTS the proposed step once the
 * loop's own turn counter exceeds the cap (the loop then ends the turn as
 * `blocked`). The wall-clock deadline cannot ride `CreateAgentOptions.signal`
 * (creation-only, detached before publication), so a timer cancels the agent
 * through `handle.agent.cancel({kind:'user'})` — the same path ACP
 * session/cancel takes, aborting the in-flight request through the loop's
 * phase signal. `commandTimeoutMs` flows to the solve_exec tool definition.
 */
import { describe, expect, it } from 'vitest'
import type { AgentSideConnection, SessionNotification } from '@agentclientprotocol/sdk'
import {
  createCandidateSolveObservationTracker,
  createNativeSolveAgent,
  type NativeSolveUsageSink,
} from '../src/acp/native-solve-agent.js'
import type { LiveSolveRuntimeLimits } from '../src/acp/solve-protocol.js'

type CapturedUpdate = {
  sessionUpdate: string
  content?: { text?: string }
  used?: number
  size?: number
  cost?: { amount: number; currency: string }
}

type PreStepPayload = { turn: number; step: number; messages: unknown[] }
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }
type PreStepListener = (
  payload: PreStepPayload,
  next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>

type MockAgentCtx = {
  on: (event: string, listener: PreStepListener) => void
  get?: (name: string) => unknown
  provide: (name: string, value: unknown) => void
  systemPrompt: { section: () => () => undefined }
  candidateWorkflows?: unknown
  tools: { register: (definition: { name: string; timeoutMs?: number }) => () => undefined }
}

function assistantMessageEvent(
  text: string,
  usage?: {
    inputTokens: number
    outputTokens: number
  },
): { type: string; data: unknown } {
  return {
    type: 'assistant/message',
    data: {
      turn: 0,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

function makeFixture(options: {
  events: ReadonlyArray<{ type: string; data?: unknown }>
  sink?: NativeSolveUsageSink
  limits?: LiveSolveRuntimeLimits
  now?: () => number
  candidateSetup?: (agentCtx: MockAgentCtx) => Promise<void> | void
  /** Simulates the outer-scope candidate-workflow-stub (ADR-060). */
  preinstalledCandidateWorkflows?: {
    register(workflow: { name: string; run?: (input: unknown) => Promise<unknown> }): () => void
    snapshot(): Array<{ name: string; run?: (input: unknown) => Promise<unknown> }>
  }
  /** Records every `provide` the runner makes on the agent context. */
  providedNames?: string[]
}): {
  agent: ReturnType<typeof createNativeSolveAgent>
  updates: CapturedUpdate[]
  cancels: unknown[]
  created: Array<{ signal?: AbortSignal; setup?: (agentCtx: MockAgentCtx) => unknown }>
  toolRegistrations: Array<{ name: string; timeoutMs?: number }>
  preStepListeners: PreStepListener[]
} {
  const updates: CapturedUpdate[] = []
  const cancels: unknown[] = []
  const created: Array<{ signal?: AbortSignal; setup?: (agentCtx: MockAgentCtx) => unknown }> = []
  const toolRegistrations: Array<{ name: string; timeoutMs?: number }> = []
  const preStepListeners: PreStepListener[] = []
  const connection = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      updates.push(params.update as CapturedUpdate)
    },
  } as unknown as AgentSideConnection
  const handle = {
    agent: {
      followup(_message: unknown): void {},
      whenIdle: () => Promise.resolve(),
      cancel(cause: unknown): void {
        cancels.push(cause)
      },
      session: { events: options.events },
    },
    dispose: () => Promise.resolve(),
  }
  const ctx = {
    agents: {
      create: (createOptions: {
        signal?: AbortSignal
        setup?: (agentCtx: MockAgentCtx) => unknown
      }) => {
        created.push(createOptions)
        // The upstream factory awaits setup() before publishing the agent;
        // run it against the scoped-context mock so listeners and tool
        // registrations are captured exactly as the real loop would see them.
        const agentCtx: MockAgentCtx = {
          on: (event, listener) => {
            if (event === 'agent/pre-step') preStepListeners.push(listener)
          },
          systemPrompt: { section: () => () => undefined },
          get: (name) => (agentCtx as unknown as Record<string, unknown>)[name],
          provide(name, value) {
            options.providedNames?.push(name)
            ;(agentCtx as unknown as Record<string, unknown>)[name] = value
          },
          ...(options.preinstalledCandidateWorkflows === undefined
            ? {}
            : { candidateWorkflows: options.preinstalledCandidateWorkflows }),
          tools: {
            register: (definition) => {
              toolRegistrations.push({ name: definition.name, timeoutMs: definition.timeoutMs })
              return () => undefined
            },
          },
        }
        return Promise.resolve(createOptions.setup?.(agentCtx)).then(() => handle)
      },
    },
    systemPrompt: {
      section: () => () => undefined,
    },
    tools: {
      register: (definition: { name: string; timeoutMs?: number }) => {
        toolRegistrations.push({ name: definition.name, timeoutMs: definition.timeoutMs })
        return () => undefined
      },
    },
    ...(options.candidateSetup === undefined
      ? {}
      : { candidateStrategySetup: options.candidateSetup }),
  } as never
  const agent = createNativeSolveAgent(ctx, connection, {
    provider: 'test-provider',
    model: 'test-model',
    ...(options.sink === undefined ? {} : { usageSink: options.sink }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { agent, updates, cancels, created, toolRegistrations, preStepListeners }
}

describe('native solve agent usage reporting', () => {
  it('derives only bounded prior-tool facts for candidate workflow input', () => {
    const tracker = createCandidateSolveObservationTracker()
    tracker.writeCompleted()
    tracker.execStarted({ command: 'ls', args: ['-la'] })
    tracker.execFinished('empty-output')
    tracker.execStarted({ command: 'ls', args: ['-la'] })
    tracker.execFinished('failed')
    tracker.readCompleted()
    expect(tracker.snapshot()).toEqual({
      toolCalls: { exec: 2, read: 1, write: 1 },
      previousAction: 'read',
      lastExec: { outcome: 'failed', consecutiveRepeated: 1 },
      writesSinceLastExec: 0,
    })
  })

  it('emits one usage_update and PromptResponse.usage from session events plus the receipt sink', async () => {
    const sink: NativeSolveUsageSink = { costUsdMicros: 1_140 }
    const { agent, updates } = makeFixture({
      sink,
      events: [
        assistantMessageEvent('first turn', { inputTokens: 100, outputTokens: 20 }),
        assistantMessageEvent('second turn', { inputTokens: 105, outputTokens: 15 }),
      ],
    })
    const session = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'solve the task' }],
    })

    // Trajectory chunks still flow, one per assistant text block.
    const chunks = updates.filter((update) => update.sessionUpdate === 'agent_message_chunk')
    expect(chunks.map((update) => update.content?.text)).toEqual(['first turn', 'second turn'])

    // The usage authority: exactly one update, cumulative tokens from the
    // session events, cost from the gateway receipt sink (micros → USD).
    const usageUpdates = updates.filter((update) => update.sessionUpdate === 'usage_update')
    expect(usageUpdates).toHaveLength(1)
    expect(usageUpdates[0]).toMatchObject({
      used: 240,
      size: 240,
      cost: { amount: 0.00114, currency: 'USD' },
    })
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage).toEqual({ inputTokens: 205, outputTokens: 35, totalTokens: 240 })
  })

  it('reports zero usage and zero cost when the turn produced no billable events', async () => {
    const { agent, updates } = makeFixture({ events: [] })
    const session = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'noop' }],
    })
    const usageUpdates = updates.filter((update) => update.sessionUpdate === 'usage_update')
    expect(usageUpdates).toHaveLength(1)
    expect(usageUpdates[0]).toMatchObject({
      used: 0,
      size: 0,
      cost: { amount: 0, currency: 'USD' },
    })
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('reads the sink at emission time so cost accumulates across turns', async () => {
    const sink: NativeSolveUsageSink = { costUsdMicros: 0 }
    const { agent, updates } = makeFixture({
      sink,
      events: [assistantMessageEvent('only turn', { inputTokens: 41, outputTokens: 7 })],
    })
    const session = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    // The gateway receipt for the in-flight turn lands before whenIdle()
    // resolves; the sink must be read AFTER the turn, not at session creation.
    sink.costUsdMicros = 2_500
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    })
    const usageUpdates = updates.filter((update) => update.sessionUpdate === 'usage_update')
    expect(usageUpdates[0]?.cost).toEqual({ amount: 0.0025, currency: 'USD' })
    expect(response.usage?.totalTokens).toBe(48)
  })

  it('still forwards session/cancel to the native agent as a user cancel', async () => {
    const { agent, cancels } = makeFixture({ events: [] })
    const session = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    await agent.cancel({ sessionId: session.sessionId })
    expect(cancels).toEqual([{ kind: 'user' }])
  })

  it('maps an aborted turn/end record to stopReason cancelled', async () => {
    // The upstream loop swallows the abort in kick(), so whenIdle() resolves
    // normally; the loop-owned truth is the `turn/end` session event it
    // appends in turn()'s finally with reason.kind 'aborted'. ACP session/
    // cancel and the wall-clock deadline both arrive through that record.
    const { agent, updates } = makeFixture({
      events: [
        assistantMessageEvent('partial answer', { inputTokens: 12, outputTokens: 3 }),
        {
          type: 'turn/end',
          data: { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } },
        },
      ],
    })
    const session = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'cancel me' }],
    })
    expect(response.stopReason).toBe('cancelled')
    // Settled usage still reports: harbor's acp.py reads the same surfaces on
    // a cancelled prompt, and partial-turn tokens/cost are real spend.
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
    const usageUpdates = updates.filter((update) => update.sessionUpdate === 'usage_update')
    expect(usageUpdates).toHaveLength(1)
  })
})

describe('native solve agent runtime limits', () => {
  const LIMITS: LiveSolveRuntimeLimits = {
    maxTurns: 40,
    commandTimeoutMs: 123_000,
    requestTimeoutMs: 660_000,
    wallClockMs: 2_400_000,
  }
  const enter = (messages: unknown[]): Promise<PreStepDecision> =>
    Promise.resolve({ kind: 'enter', messages })

  it('rejects the step past maxTurns through the agent/pre-step waterfall', async () => {
    const { agent, preStepListeners, toolRegistrations } = makeFixture({
      events: [],
      limits: LIMITS,
    })
    await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    // Upstream has no maxTurns option on agents.create(); the cap is enforced
    // by an agent-scoped pre-step listener that rejects once the loop's own
    // turn counter passes the cap (the loop ends that turn as `blocked`).
    expect(preStepListeners).toHaveLength(1)
    const listener = preStepListeners[0] as PreStepListener
    const atCap = await listener({ turn: LIMITS.maxTurns, step: 1, messages: ['m'] }, () =>
      enter(['m']),
    )
    expect(atCap).toEqual({ kind: 'enter', messages: ['m'] })
    const pastCap = await listener({ turn: LIMITS.maxTurns + 1, step: 1, messages: ['m'] }, () =>
      enter(['m']),
    )
    expect(pastCap).toEqual({ kind: 'reject' })
    const exec = toolRegistrations.find((tool) => tool.name === 'solve_exec')
    expect(exec?.timeoutMs).toBe(123_000)
  })

  it('cancels the agent at the wall-clock deadline and still reports usage', async () => {
    let clock = 1_000
    const sink: NativeSolveUsageSink = { costUsdMicros: 600 }
    const { agent, cancels, updates } = makeFixture({
      sink,
      limits: LIMITS,
      now: () => clock,
      events: [
        assistantMessageEvent('late turn', { inputTokens: 10, outputTokens: 5 }),
        // The deadline cancel ends the turn as aborted; the loop records it in
        // turn/end, and ACP must see the cancelled stop reason — never a fake
        // end_turn for a turn the deadline killed.
        {
          type: 'turn/end',
          data: { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } },
        },
      ],
    })
    const session = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    // The turn lands after the deadline: the deadline timer must have raised
    // the same user-cancel path session/cancel uses, and the prompt still
    // ends cleanly with the settled usage figures.
    clock = 1_000 + LIMITS.wallClockMs + 1
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'too late' }],
    })
    expect(cancels).toEqual([{ kind: 'user' }])
    expect(response.stopReason).toBe('cancelled')
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    const usageUpdates = updates.filter((update) => update.sessionUpdate === 'usage_update')
    expect(usageUpdates[0]?.cost).toEqual({ amount: 0.0006, currency: 'USD' })
  })

  it('works without limits (offline rehearsal path keeps its current behavior)', async () => {
    const { agent, created, preStepListeners, toolRegistrations } = makeFixture({ events: [] })
    await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    expect(created[0]?.signal).toBeUndefined()
    expect(preStepListeners).toHaveLength(0)
    const exec = toolRegistrations.find((tool) => tool.name === 'solve_exec')
    // No capsule override: the tool layer's own default applies.
    expect(exec?.timeoutMs).toBe(300_000)
  })

  it('runs the candidate solve-policy workflow at every admitted step and injects its bounded checkpoint', async () => {
    const calls: unknown[] = []
    const { agent, preStepListeners } = makeFixture({
      events: [],
      candidateSetup: (agentCtx) => {
        const registry = (
          agentCtx as unknown as {
            candidateWorkflows?: { register: (workflow: unknown) => () => void }
          }
        ).candidateWorkflows
        registry?.register({
          name: 'candidate-workflow:solve-policy',
          description: 'checkpoint policy',
          async run(input: unknown) {
            calls.push(input)
            return { checkpoint: 'Inspect the current artifact before another mutation.' }
          },
        })
      },
    })
    await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    expect(preStepListeners).toHaveLength(1)

    const decision = await (preStepListeners[0] as PreStepListener)(
      { turn: 1, step: 2, messages: ['task'] },
      () => enter(['task']),
    )

    expect(calls).toEqual([
      {
        protocol: 'dsh-evolve-le/candidate-solve-policy/v2',
        turn: 1,
        step: 2,
        observation: {
          toolCalls: { exec: 0, read: 0, write: 0 },
          previousAction: 'none',
          lastExec: { outcome: 'none', consecutiveRepeated: 0 },
          writesSinceLastExec: 0,
        },
      },
    ])
    expect(decision).toMatchObject({ kind: 'enter' })
    expect(JSON.stringify((decision as { messages: unknown[] }).messages)).toContain(
      'Inspect the current artifact before another mutation.',
    )
  })

  it('dispatches the bounded automatic-tool and lifecycle-event strategy surfaces', async () => {
    const calls: Array<{ name: string; phase: string; turn: number; step: number }> = []
    const { agent, preStepListeners } = makeFixture({
      events: [],
      candidateSetup: (agentCtx) => {
        const services = agentCtx as unknown as {
          candidateStrategyEvents?: {
            register(event: { name: string; handler: (input: any) => unknown }): () => void
          }
          candidateStrategyTools?: {
            register(tool: { name: string; run: (input: any) => Promise<unknown> }): () => void
          }
        }
        services.candidateStrategyEvents?.register({
          name: 'candidate:session/start',
          handler: (input) => {
            calls.push({ name: 'start', phase: input.phase, turn: input.turn, step: input.step })
            return { checkpoint: 'Start by inspecting the workspace state.' }
          },
        })
        services.candidateStrategyEvents?.register({
          name: 'candidate:agent/pre-step',
          handler: (input) => {
            calls.push({ name: 'event', phase: input.phase, turn: input.turn, step: input.step })
            return { checkpoint: 'Check whether the last action changed the hypothesis.' }
          },
        })
        services.candidateStrategyEvents?.register({
          name: 'candidate:session/end',
          handler: (input) => {
            calls.push({ name: 'end', phase: input.phase, turn: input.turn, step: input.step })
          },
        })
        services.candidateStrategyTools?.register({
          name: 'candidate_next_step',
          async run(input) {
            calls.push({ name: 'tool', phase: input.phase, turn: input.turn, step: input.step })
            return { checkpoint: 'Use the next tool call to discriminate the leading cause.' }
          },
        })
      },
    })
    const created = await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    const live = agent.sessions.get(created.sessionId)
    expect(live).toBeDefined()
    expect(preStepListeners).toHaveLength(1)

    const decision = await (preStepListeners[0] as PreStepListener)(
      { turn: 3, step: 4, messages: ['task'] },
      () => enter(['task']),
    )
    expect(JSON.stringify(decision)).toContain('Start by inspecting the workspace state.')
    expect(JSON.stringify(decision)).toContain('Check whether the last action changed the hypothesis.')
    expect(JSON.stringify(decision)).toContain('Use the next tool call to discriminate the leading cause.')
    expect(live?.strategyUsage).toEqual({
      workflowInvocations: 0,
      strategyToolInvocations: 1,
      agentEventInvocations: 1,
      sessionEventInvocations: 1,
    })

    await agent.dispose()
    expect(calls).toEqual([
      { name: 'start', phase: 'session-start', turn: 0, step: 0 },
      { name: 'event', phase: 'pre-step', turn: 3, step: 4 },
      { name: 'tool', phase: 'pre-step', turn: 3, step: 4 },
      { name: 'end', phase: 'session-end', turn: 0, step: 0 },
    ])
    expect(live?.strategyUsage.sessionEventInvocations).toBe(2)
  })

  it('executes only the exact solve-policy name and drops an oversized checkpoint', async () => {
    const calls: string[] = []
    const { agent, preStepListeners } = makeFixture({
      events: [],
      candidateSetup: (agentCtx) => {
        const registry = (
          agentCtx as unknown as {
            candidateWorkflows?: { register: (workflow: unknown) => () => void }
          }
        ).candidateWorkflows
        registry?.register({
          name: 'candidate-workflow:other-policy',
          description: 'must not execute',
          async run() {
            calls.push('other')
            return { checkpoint: 'unexpected' }
          },
        })
        registry?.register({
          name: 'candidate-workflow:solve-policy',
          description: 'oversized checkpoint',
          async run() {
            calls.push('solve')
            return { checkpoint: 'x'.repeat(2_049) }
          },
        })
      },
    })
    await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    const decision = await (preStepListeners[0] as PreStepListener)(
      { turn: 1, step: 0, messages: ['task'] },
      () => enter(['task']),
    )

    expect(calls).toEqual(['solve'])
    expect(decision).toEqual({ kind: 'enter', messages: ['task'] })
  })

  it('reuses the outer-scope stub registry instead of re-providing on the agent context (ADR-060)', async () => {
    // The capsule's outer scope ships candidate-workflow-stub (ADR-054);
    // Cordis forbids re-providing an ancestor service, so the runner must
    // reuse it. The ADR-059 smoke's mockReplay turn crashed here with a
    // duplicate-provision throw before this fix.
    const registrations: Array<{ name: string; run?: (input: unknown) => Promise<unknown> }> = []
    const stub = {
      register(workflow: { name: string; run?: (input: unknown) => Promise<unknown> }) {
        registrations.push(workflow)
        return () => {
          const at = registrations.indexOf(workflow)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
      snapshot() {
        return [...registrations]
      },
    }
    const providedNames: string[] = []
    const calls: unknown[] = []
    const { agent, preStepListeners } = makeFixture({
      events: [],
      providedNames,
      preinstalledCandidateWorkflows: stub,
      candidateSetup: (agentCtx) => {
        const registry = (
          agentCtx as unknown as {
            candidateWorkflows?: typeof stub
          }
        ).candidateWorkflows
        registry?.register({
          name: 'candidate-workflow:solve-policy',
          description: 'checkpoint policy through the outer scope',
          async run(input: unknown) {
            calls.push(input)
            return { checkpoint: 'Outer-scope registry checkpoint.' }
          },
        })
      },
    })
    await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    expect(providedNames).not.toContain('candidateWorkflows')
    expect(preStepListeners).toHaveLength(1)

    const decision = await (preStepListeners[0] as PreStepListener)(
      { turn: 1, step: 2, messages: ['task'] },
      () => enter(['task']),
    )

    expect(calls).toEqual([
      {
        protocol: 'dsh-evolve-le/candidate-solve-policy/v2',
        turn: 1,
        step: 2,
        observation: {
          toolCalls: { exec: 0, read: 0, write: 0 },
          previousAction: 'none',
          lastExec: { outcome: 'none', consecutiveRepeated: 0 },
          writesSinceLastExec: 0,
        },
      },
    ])
    expect(decision).toMatchObject({ kind: 'enter' })
    expect(JSON.stringify((decision as { messages: unknown[] }).messages)).toContain(
      'Outer-scope registry checkpoint.',
    )
  })

  it('skips a declaration-only stub record that carries no runnable solve-policy hook (ADR-060)', async () => {
    const registrations: Array<{ name: string; run?: (input: unknown) => Promise<unknown> }> = []
    const stub = {
      register(workflow: { name: string; run?: (input: unknown) => Promise<unknown> }) {
        registrations.push(workflow)
        return () => {
          const at = registrations.indexOf(workflow)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
      snapshot() {
        return [...registrations]
      },
    }
    const { agent, preStepListeners } = makeFixture({
      events: [],
      preinstalledCandidateWorkflows: stub,
      candidateSetup: (agentCtx) => {
        const registry = (
          agentCtx as unknown as {
            candidateWorkflows?: typeof stub
          }
        ).candidateWorkflows
        // Declaration-only: the fixed name without an executable hook must
        // never be invoked.
        registry?.register({ name: 'candidate-workflow:solve-policy' })
      },
    })
    await agent.newSession({ cwd: '/workspace', mcpServers: [] })
    // No executable solve policy → no pre-step listener is installed.
    expect(preStepListeners).toHaveLength(0)
  })
})
