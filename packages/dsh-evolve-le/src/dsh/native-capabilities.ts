/** Trusted composition of upstream compaction and foreground subagents (ADR-075).
 * No agent loop or model client lives here. All children use the existing DSH
 * factory and the same gateway adapter as their parent.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CANDIDATE_EVENT_POLICY } from './candidate-events.js'

export const NATIVE_CAPABILITIES_POLICY = Object.freeze({
  protocol: 'dsh-evolve-le/native-capabilities/v2',
  events: CANDIDATE_EVENT_POLICY,
  compaction: Object.freeze({
    auto: true,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxTokens: 8192,
    compactionRetries: 0,
    maxOverflowRetries: 1,
  }),
  subagents: Object.freeze({
    maxDepth: 1,
    maxChildren: 4,
    maxConcurrent: 2,
    maxSteps: 32,
    background: false,
  }),
})

export class DelegationBudget {
  private count = 0
  private active = 0
  constructor(
    private readonly limits: { maxChildren: number; maxConcurrent: number; maxDepth: number },
  ) {}
  reserve(depth: number): () => void {
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > this.limits.maxDepth)
      throw new Error('subagent depth limit exceeded')
    if (this.count >= this.limits.maxChildren) throw new Error('subagent count limit exceeded')
    if (this.active >= this.limits.maxConcurrent)
      throw new Error('subagent concurrent limit exceeded')
    this.count += 1
    this.active += 1
    let released = false
    return () => {
      if (!released) {
        released = true
        this.active -= 1
      }
    }
  }
}

export interface NativeSessionEvidence {
  id: string
  parentSession: string
  depth: number
  stopReason: string
  events: readonly { type: string; data?: unknown }[]
  candidateEvents?: readonly unknown[]
  error?: string
}

type LocalAgent = {
  ctx: Context
  options: { provider?: string; model?: string; maxTokens?: number; subagentDepth?: number }
  session: {
    id: string
    header: { id: string; cwd?: string; delegationDepth?: number }
    events: readonly { type: string; data?: unknown }[]
    append(type: string, data: unknown): unknown
  }
  followup(message: unknown): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: 'parent' }): void
}
type ChildHandle = { agent: LocalAgent; dispose(): Promise<void> }
type ChildRequest = {
  parent: LocalAgent
  signal: AbortSignal
  prompt: unknown[]
  descriptor: unknown
  maxDepth?: number
  agentOptions?: LocalAgent['options']
}
type Subagents = {
  registerProvider(provider: {
    name: string
    inheritsParentContext: boolean
    capabilities: {
      outputSchema: boolean
      depthLimit: boolean
      toolFilter: boolean
      persona: boolean
    }
    start(request: ChildRequest): Promise<{
      id: string
      localAgent: LocalAgent
      result: Promise<{ output: unknown[]; stopReason: string }>
      dispose(): Promise<void>
    }>
  }): () => void
}

function get<T>(ctx: Context, name: string): T | undefined {
  return (ctx as unknown as { get?: (name: string) => unknown }).get?.(name) as T | undefined
}

/** Give each session fresh candidate registries while preserving the DSH scope.
 * Cordis service isolation is composition only; the capsule is the OS boundary.
 */
export function isolateNativeStrategyContext(ctx: Context): Context {
  if (typeof ctx.isolate !== 'function') return ctx
  const scoped = ctx
    .isolate('candidateWorkflows')
    .isolate('candidateStrategyEvents')
    .isolate('candidateStrategyTools')
  const workflows: unknown[] = []
  scoped.provide(
    'candidateWorkflows' as never,
    {
      register(value: unknown) {
        workflows.push(value)
        return () => {
          const index = workflows.indexOf(value)
          if (index >= 0) workflows.splice(index, 1)
        }
      },
      snapshot: () => [...workflows],
    } as never,
  )
  return scoped
}

export type CandidateChildEvents = { drain(): Promise<void>; audit(): readonly unknown[] }

/** Install the standard upstream delegation tool and one TCB-bounded provider.
 * A unique provider belongs to this root agent; children receive the same
 * capability setup but no delegation tool. Failed starts consume count too.
 */
export async function installNativeSubagents(
  agentCtx: Context,
  setupChild: (ctx: Context) => void | CandidateChildEvents | Promise<void | CandidateChildEvents>,
  evidence: NativeSessionEvidence[],
): Promise<void> {
  const subagents = get<Subagents>(agentCtx, 'subagents')
  // Historical/offline fixtures without the new production overlay keep
  // their existing semantics. New capsules always mount this service.
  if (subagents === undefined) return
  const parent = (agentCtx as unknown as { agent: LocalAgent }).agent
  const load = (name: string): Promise<unknown> => import(name)
  const helpers = (await load('@deepseek-ai/dsh-subagent')) as {
    resolveChildDepth(parent: LocalAgent, cap: number): number
    childSessionMeta(parent: LocalAgent, depth: number, seed: number): object
    resolveChildAgentOptions(parent: LocalAgent, options: undefined, depth: number): object
    applyChildComposition(ctx: Context, parent: LocalAgent, composition: object): void
    captureDelegatedPolicyOverrides(parent: LocalAgent): unknown
    appendDelegatedPolicyOverrides(session: LocalAgent['session'], policy: unknown): void
    finalAssistantOutput(events: LocalAgent['session']['events']): unknown[] | undefined
  }
  const tool = await load('@deepseek-ai/dsh-tool-subagent')
  const budget = new DelegationBudget(NATIVE_CAPABILITIES_POLICY.subagents)
  const live = new Set<() => Promise<void>>()
  const starting = new Set<Promise<void>>()
  let closed = false
  const providerName = `evolve-spawn-${parent.session.id}`
  subagents.registerProvider({
    name: providerName,
    inheritsParentContext: false,
    capabilities: { depthLimit: true, outputSchema: false, toolFilter: false, persona: false },
    async start(request) {
      if (closed || request.signal.aborted) throw new Error('subagent owner cancelled or disposed')
      if (request.parent !== parent) throw new Error('subagent provider belongs to another agent')
      const depth = helpers.resolveChildDepth(
        parent,
        Math.min(
          request.maxDepth ?? NATIVE_CAPABILITIES_POLICY.subagents.maxDepth,
          NATIVE_CAPABILITIES_POLICY.subagents.maxDepth,
        ),
      )
      const release = budget.reserve(depth)
      const id = randomUUID()
      const record: NativeSessionEvidence = {
        id,
        parentSession: parent.session.id,
        depth,
        stopReason: 'error',
        events: [],
      }
      evidence.push(record)
      let finishStarting!: () => void
      const started = new Promise<void>((resolve) => {
        finishStarting = resolve
      })
      starting.add(started)
      const settleStarting = () => {
        starting.delete(started)
        finishStarting()
      }
      const observer: { current?: CandidateChildEvents } = {}
      let handle: ChildHandle
      try {
        // Never accept caller model/budget overrides. The adapter independently
        // enforces the route; the child inherits this exact parent's options.
        if (request.agentOptions !== undefined)
          throw new Error('subagent route overrides are forbidden')
        const registry = get<{ create(options: object): Promise<ChildHandle> }>(
          parent.ctx,
          'agents',
        )
        if (registry === undefined) throw new Error('subagent agent registry unavailable')
        const policy = helpers.captureDelegatedPolicyOverrides(parent)
        handle = await registry.create({
          sessionId: id,
          meta: helpers.childSessionMeta(parent, depth, 0),
          agentOptions: helpers.resolveChildAgentOptions(parent, undefined, depth),
          signal: request.signal,
          setup: async (childCtx: Context) => {
            const child = (childCtx as unknown as { agent: LocalAgent }).agent
            helpers.appendDelegatedPolicyOverrides(child.session, policy)
            const events = await setupChild(childCtx)
            if (typeof events === 'object') observer.current = events
            helpers.applyChildComposition(childCtx, parent, {})
            child.session.append('subagent/descriptor', request.descriptor)
            childCtx.on(
              'agent/pre-step' as never,
              (async (payload: { step: number }, next: () => Promise<unknown>) =>
                payload.step > NATIVE_CAPABILITIES_POLICY.subagents.maxSteps
                  ? { kind: 'reject' }
                  : next()) as never,
            )
          },
        })
      } catch (error) {
        record.error = String(error)
        settleStarting()
        release()
        throw error
      }
      const onAbort = () => handle.agent.cancel({ kind: 'parent' })
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted || closed) onAbort()
      let disposal: Promise<void> | undefined
      const result = (async () => {
        try {
          if (!request.signal.aborted && !closed) {
            handle.agent.followup({
              id: randomUUID(),
              role: 'user',
              source: { kind: 'user' },
              content: request.prompt,
            })
            await handle.agent.whenIdle()
            await observer.current?.drain()
          }
          const end = [...handle.agent.session.events].reverse().find((e) => e.type === 'turn/end')
          const reason = (end?.data as { reason?: { kind?: string } } | undefined)?.reason?.kind
          record.stopReason =
            reason === 'completed'
              ? 'completed'
              : reason === 'max-tokens'
                ? 'max-tokens'
                : reason === 'blocked'
                  ? 'refusal'
                  : request.signal.aborted || closed || reason === 'aborted'
                    ? 'aborted'
                    : 'error'
          return {
            output: helpers.finalAssistantOutput(handle.agent.session.events) ?? [],
            stopReason: record.stopReason,
          }
        } catch (error) {
          record.error = String(error)
          throw error
        } finally {
          record.events = structuredClone(handle.agent.session.events)
          if (observer.current) record.candidateEvents = observer.current.audit()
          request.signal.removeEventListener('abort', onAbort)
        }
      })()
      const dispose = (): Promise<void> =>
        (disposal ??= (async () => {
          try {
            await handle.dispose()
            await result.catch(() => undefined)
          } finally {
            request.signal.removeEventListener('abort', onAbort)
            release()
            record.events = structuredClone(handle.agent.session.events)
            if (observer.current) record.candidateEvents = observer.current.audit()
            live.delete(dispose)
          }
        })())
      live.add(dispose)
      settleStarting()
      return { id, localAgent: handle.agent, result, dispose }
    },
  })
  agentCtx.effect(() => async () => {
    closed = true
    await Promise.allSettled(starting)
    const results = await Promise.allSettled([...live].map((dispose) => dispose()))
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((r) => r.reason),
        'subagent cleanup failed',
      )
  })
  await agentCtx.plugin(
    tool as never,
    {
      provider: providerName,
      maxDepth: 1,
      enableRunInBackground: false,
      backgroundMode: 'one-shot',
    } as never,
  )
}
