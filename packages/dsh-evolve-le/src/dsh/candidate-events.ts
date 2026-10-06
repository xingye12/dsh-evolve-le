/** TCB projection of pinned DSH events into candidate-local strategy callbacks. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

export const CANDIDATE_RUNTIME_EVENT_NAMES = [
  'candidate:agent/pre-step',
  'candidate:session/start',
  'candidate:session/end',
  'candidate:agent/request',
  'candidate:agent/request-error',
  'candidate:agent/error',
  'candidate:agent/status',
  'candidate:agent/turn-stopping',
  'candidate:agent/tool-pre-execute',
  'candidate:agent/tool-post-execute',
  'candidate:agent/tool-result',
  'candidate:session/event',
  'candidate:session/turn-start',
  'candidate:session/turn-end',
  'candidate:session/step-start',
  'candidate:session/step-end',
  'candidate:session/compaction-start',
  'candidate:session/compaction-summary',
  'candidate:session/compaction-end',
  'candidate:session/compaction-prune',
] as const
export const CANDIDATE_EVENT_BRIDGE_PROTOCOL = 'dsh-evolve-le/candidate-events/v2' as const
export const CANDIDATE_EVENT_POLICY = Object.freeze({
  protocol: CANDIDATE_EVENT_BRIDGE_PROTOCOL,
  maxPending: 256,
  maxCheckpointsPerStep: 64,
})
export type CandidateStrategyEvent = { name: string; handler: (...args: unknown[]) => unknown }
export type CandidateStrategyEventsRegistry = {
  register(event: CandidateStrategyEvent): () => void
  emit(name: string, input: unknown): Promise<unknown[]>
  snapshot(): readonly CandidateStrategyEvent[]
  audit(): readonly unknown[]
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function installCandidateStrategyEvents(ctx: Context): CandidateStrategyEventsRegistry {
  const events: CandidateStrategyEvent[] = []
  const audit: unknown[] = []
  const registry: CandidateStrategyEventsRegistry = {
    register(event) {
      events.push(event)
      return () => {
        const i = events.indexOf(event)
        if (i >= 0) events.splice(i, 1)
      }
    },
    async emit(name, input) {
      const values: unknown[] = []
      // Snapshot registrations before awaiting candidate code.
      for (const event of events.slice())
        if (event.name === name) {
          const safe = freeze(structuredClone(input))
          let ok = false,
            c: string | undefined
          try {
            const value = await event.handler(safe)
            values.push(value)
            c = candidateCheckpoint(value)
            ok = true
          } finally {
            audit.push(
              freeze({
                protocol: CANDIDATE_EVENT_BRIDGE_PROTOCOL,
                name,
                context: safe,
                ok,
                checkpointSha256:
                  c === undefined ? null : createHash('sha256').update(c).digest('hex'),
              }),
            )
          }
        }
      return values
    },
    snapshot: () => [...events],
    audit: () => structuredClone(audit),
  }
  ctx.provide('candidateStrategyEvents' as never, registry as never)
  return registry
}
export function candidateCheckpoint(value: unknown): string | undefined {
  const c =
    value !== null && typeof value === 'object'
      ? (value as { checkpoint?: unknown }).checkpoint
      : undefined
  return typeof c === 'string' && c.length > 0 && c.length <= 2048 ? c : undefined
}
const SESSION_EVENTS = new Map([
  ['turn/start', 'turn-start'],
  ['turn/end', 'turn-end'],
  ['step/start', 'step-start'],
  ['step/end', 'step-end'],
  ['compaction/start', 'compaction-start'],
  ['compaction/summary', 'compaction-summary'],
  ['compaction/end', 'compaction-end'],
  ['compaction/prune', 'compaction-prune'],
  ['user/message', undefined],
  ['assistant/message', undefined],
  ['tool/call', undefined],
  ['tool/result', undefined],
] as const)
const TOOL_KINDS: Record<string, string> = {
  solve_exec: 'exec',
  solve_read: 'read',
  solve_write: 'write',
  proposal_read_file: 'read',
  proposal_list_files: 'read',
  proposal_write_child: 'write',
  proposal_finish: 'finish',
  subagent: 'delegate',
}
const STOP_KINDS = new Set(['completed', 'aborted', 'error', 'max-tokens', 'blocked'])
const STATUSES = new Set(['idle', 'running'])

type RuntimeCtx = {
  agent?: { session?: { id?: string; append(type: string, data: unknown): unknown } }
  on(name: string, fn: (...args: any[]) => unknown): unknown
}
/** Emitting observers are drained before the next step and final settlement.
 * Waterfalls await callbacks but delegate next exactly once and unmodified.
 * Outputs only queue bounded checkpoints; they cannot replace tool results,
 * retry requests, mutate history, alter routes or override a TCB decision.
 */
export function installCandidateEventBridge(
  ctx: Context,
  registry: CandidateStrategyEventsRegistry,
  context: (turn: number, step: number) => object,
  checkpoint: (value: string) => void,
  counted?: (surface: 'agent' | 'session', count: number) => void,
): { drain(): Promise<void> } {
  const runtime = ctx as unknown as RuntimeCtx
  let tail = Promise.resolve(),
    failure: unknown,
    pending = 0,
    turn = 0,
    step = 0
  const position = (data: any) => {
    if (Number.isSafeInteger(data?.turn) && data.turn >= 0) turn = Math.min(data.turn, 1_000_000)
    if (Number.isSafeInteger(data?.step) && data.step >= 0) step = Math.min(data.step, 1_000_000)
    return { turn, step }
  }
  const queue = (name: string, data: any, facts: object = {}): Promise<void> => {
    const pos = position(data)
    if (!registry.snapshot().some((e) => e.name === name)) return tail
    if (pending >= CANDIDATE_EVENT_POLICY.maxPending) {
      failure ??= new Error('candidate event queue limit exceeded')
      return tail
    }
    const input = {
      ...context(pos.turn, pos.step),
      protocol: 'dsh-evolve-le/candidate-strategy-context/v2',
      phase: 'event',
      event: { name, ...facts },
    }
    pending++
    tail = tail
      .then(async () => {
        if (failure !== undefined) return
        const values = await registry.emit(name, input)
        counted?.(name.startsWith('candidate:session/') ? 'session' : 'agent', values.length)
        for (const value of values) {
          const c = candidateCheckpoint(value)
          if (c !== undefined) checkpoint(c)
        }
      })
      .catch((error) => {
        failure ??= error
      })
      .finally(() => {
        pending--
      })
    return tail
  }
  const drain = async () => {
    let observed: Promise<void>
    do {
      observed = tail
      await observed
    } while (observed !== tail)
    if (failure !== undefined) throw failure
  }
  for (const source of ['agent/request', 'agent/request-error'] as const) {
    runtime.on(source, async (data: any, next: () => Promise<unknown>) => {
      await queue(`candidate:${source}`, data)
      await drain()
      return next()
    })
  }
  runtime.on('agent/turn-stopping', async (data: any) => {
    await queue('candidate:agent/turn-stopping', data)
    await drain()
  })
  runtime.on('agent/error', (data: any) => {
    void queue('candidate:agent/error', data)
  })
  runtime.on('agent/status', (data: any) => {
    void queue('candidate:agent/status', data, {
      status: STATUSES.has(data?.status) ? data.status : 'unknown',
    })
  })
  runtime.on('tools/pre-execute', async (exec: any, next: () => Promise<unknown>) => {
    await queue('candidate:agent/tool-pre-execute', exec, {
      toolKind: TOOL_KINDS[exec?.name] ?? 'candidate',
      outcome: 'pending',
    })
    await drain()
    return next()
  })
  runtime.on('tools/post-execute', async (exec: any, result: any, next: () => Promise<unknown>) => {
    await queue('candidate:agent/tool-post-execute', exec, {
      toolKind: TOOL_KINDS[exec?.name] ?? 'candidate',
      outcome: result?.isError === false ? 'succeeded' : 'failed',
    })
    await drain()
    return next()
  })
  runtime.on('tools/result', (exec: any, result: any) => {
    void queue('candidate:agent/tool-result', exec, {
      toolKind: TOOL_KINDS[exec?.name] ?? 'candidate',
      outcome: result?.isError === false ? 'succeeded' : 'failed',
    })
  })
  runtime.on('session/event', (session: any, event: any) => {
    if (session?.id !== runtime.agent?.session?.id || !SESSION_EVENTS.has(event?.type)) return
    const facts = {
      sessionEventType: event.type,
      ...(event.type === 'turn/end'
        ? {
            stopReason: STOP_KINDS.has(event.data?.reason?.kind)
              ? event.data.reason.kind
              : 'unknown',
          }
        : {}),
    }
    void queue('candidate:session/event', event.data, facts)
    const suffix = SESSION_EVENTS.get(event.type)
    if (suffix !== undefined) void queue(`candidate:session/${suffix}`, event.data, facts)
  })
  return { drain }
}

/** Bound checkpoints awaiting an admitted pre-step, including late observers. */
export function queueCandidateCheckpoint(queue: string[], checkpoint: string): void {
  if (queue.length >= CANDIDATE_EVENT_POLICY.maxCheckpointsPerStep)
    throw new Error('candidate checkpoint queue limit exceeded')
  queue.push(checkpoint)
}
