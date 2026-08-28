/**
 * Cordis lifecycle inventory: a JSON-serializable snapshot of every observable
 * registration on a root context — provided services, plugin runtimes, fibers,
 * per-fiber event listeners and effects — plus the process-level active-handle
 * census. Two snapshots are equal iff the observable runtime state is equal,
 * so `snapshot(before)` vs `snapshot(after disposal)` is the quiescence check
 * required by the Gate 0 acceptance (unload must return the process to exactly
 * the pre-boot state).
 *
 * The walked surfaces (`ctx.reflect.store`, `ctx.registry`, `ctx.events._hooks`,
 * `fiber._hooks`, `fiber._disposables`) are public fields of the pinned
 * `@deepseek-ai/cordis@4.0.1`; this module reads them but never mutates them.
 * @module @dsh-evolve-le/core/cordis/inventory
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'

/** One provided service visible from the root context. */
export interface ServiceRecord {
  /** Service name (the injection key). */
  name: string
  /** Display label of the Fiber providing it. */
  fiber: string
}

/** One plugin runtime registered on the root context. */
export interface RuntimeRecord {
  /** Plugin display name (`runtime.name`, or the callback's function name). */
  name: string
  /** Number of live fibers of this runtime. */
  fibers: number
}

/** One live fiber. */
export interface FiberRecord {
  /** Fiber display name (nearest named ancestor, else `root`). */
  name: string
  /** Registry-assigned unique id; `0` for the root fiber, `null` after unload. */
  uid: number | null
  /** Numeric `FiberState`: 0 pending, 1 disposed, 2 active, 3 failed. */
  state: number
}

/** Listener counts grouped by event name and owning fiber. */
export interface ListenerRecord {
  /** Event name. */
  event: string
  /** Owning fiber display label. */
  fiber: string
  /** Number of listeners registered on this fiber for this event. */
  count: number
}

/** Effect (disposable) counts grouped by owning fiber. */
export interface EffectRecord {
  /** Owning fiber display label. */
  fiber: string
  /** Number of undisposed disposables on this fiber. */
  count: number
}

/** Observable Cordis runtime state of one root context. */
export interface CordisInventory {
  /** Provided services, sorted by name then fiber. */
  services: ServiceRecord[]
  /** Plugin runtimes, sorted by name. */
  runtimes: RuntimeRecord[]
  /** Live fibers, sorted by uid then name. */
  fibers: FiberRecord[]
  /** Event listeners, sorted by event then fiber. */
  listeners: ListenerRecord[]
  /** Registered effects/disposables, sorted by fiber. */
  effects: EffectRecord[]
}

/** Process-level active-resource census (kind → count), sorted by kind. */
export type ProcessHandleInventory = Record<string, number>

/** Stable display label for a fiber: `<name>#<uid>` (uid null after unload). */
function fiberLabel(fiber: Fiber): string {
  return `${fiber.name}#${fiber.uid ?? 'x'}`
}

/**
 * Structural view of one `ctx.reflect.store` entry. The pinned cordis ships
 * the field as a `Dict` whose value type is not exported, so this trusted-side
 * reader narrows it to the two members it observes (same shape as
 * `Impl` in `vendor/cordis/src/reflect.ts`).
 */
interface ServiceImplRecord {
  name: string
  fiber: Fiber
}

/** Structural view of one `ctx.events._hooks` listener record. */
interface EventHookRecord {
  ctx: Context
}

/** Structural view of the event service's per-event listener lists. */
type EventHooks = Record<string | symbol, EventHookRecord[]>

/**
 * Snapshot the observable Cordis runtime state of a root context.
 * @param ctx - any context of the tree; the reflect store, registry, and fiber
 *   walk all operate on the root.
 * @returns a JSON-safe, deterministically ordered inventory.
 */
export function snapshotCordisInventory(ctx: Context): CordisInventory {
  const labels = new Map<Fiber, string>()
  const label = (fiber: Fiber): string => {
    let value = labels.get(fiber)
    if (value === undefined) {
      value = fiberLabel(fiber)
      labels.set(fiber, value)
    }
    return value
  }

  const services: ServiceRecord[] = []
  // The store is keyed by per-service isolate Symbols, so Object.values (which
  // only walks string keys) would always see nothing.
  const store = ctx.root.reflect.store as unknown as Record<symbol, ServiceImplRecord>
  for (const key of Reflect.ownKeys(store)) {
    if (typeof key !== 'symbol') continue
    const impl = store[key]
    if (impl === undefined) continue
    services.push({ name: impl.name, fiber: label(impl.fiber) })
  }
  services.sort((a, b) => a.name.localeCompare(b.name) || a.fiber.localeCompare(b.fiber))

  const runtimes: RuntimeRecord[] = []
  const fibers: FiberRecord[] = []
  for (const runtime of ctx.root.registry.values()) {
    runtimes.push({
      name: runtime.name ?? runtime.callback?.name ?? '<anonymous>',
      fibers: runtime.fibers.length,
    })
    for (const fiber of runtime.fibers) {
      fibers.push({ name: fiber.name, uid: fiber.uid, state: fiber.state })
    }
  }
  runtimes.sort((a, b) => a.name.localeCompare(b.name))
  fibers.sort((a, b) => (a.uid ?? -1) - (b.uid ?? -1) || a.name.localeCompare(b.name))

  const listeners = new Map<string, number>()
  const effects = new Map<string, number>()

  // Regular listeners live on the event service keyed by event name (each
  // record owns its registering context); the fiber-local `_hooks` lists hold
  // the special-cased `internal/update` listeners. Both are real
  // registrations, so both are counted.
  const eventHooks = ctx.root.events._hooks as unknown as EventHooks
  for (const key of Reflect.ownKeys(eventHooks)) {
    const hooks = eventHooks[key as keyof EventHooks]
    if (hooks === undefined) continue
    const eventName = typeof key === 'symbol' ? key.toString() : key
    for (const hook of hooks) {
      const mapKey = `${eventName}\0${label(hook.ctx.fiber)}`
      listeners.set(mapKey, (listeners.get(mapKey) ?? 0) + 1)
    }
  }
  const account = (fiber: Fiber): void => {
    const name = label(fiber)
    for (const [event, list] of Object.entries(fiber._hooks)) {
      if (list.length === 0) continue
      const key = `${event}\0${name}`
      listeners.set(key, (listeners.get(key) ?? 0) + list.length)
    }
    if (fiber._disposables.length > 0) {
      effects.set(name, (effects.get(name) ?? 0) + fiber._disposables.length)
    }
  }
  account(ctx.root.fiber)
  for (const runtime of ctx.root.registry.values()) {
    for (const fiber of runtime.fibers) account(fiber)
  }

  return {
    services,
    runtimes,
    fibers,
    listeners: [...listeners.entries()]
      .map(([key, count]) => {
        const separator = key.indexOf('\0')
        return { event: key.slice(0, separator), fiber: key.slice(separator + 1), count }
      })
      .sort((a, b) => a.event.localeCompare(b.event) || a.fiber.localeCompare(b.fiber)),
    effects: [...effects.entries()]
      .map(([fiber, count]) => ({ fiber, count }))
      .sort((a, b) => a.fiber.localeCompare(b.fiber)),
  }
}

/**
 * Census the process's active event-loop resources by kind.
 * @returns a sorted kind→count record of `process.getActiveResourcesInfo()`.
 */
export function snapshotProcessHandles(): ProcessHandleInventory {
  const counts: Record<string, number> = {}
  for (const kind of process.getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}
