/**
 * Real-Cordis-Loader boot for dsh-evolve-le trusted code.
 *
 * This mirrors `boot()` from the pinned `@deepseek-ai/dsh-app-boot`
 * `0.1.0-rc.5` source (`deepseek-harness/packages/boot/app-boot/src/index.ts`),
 * which is not published on npm at that version: create the root `Context`,
 * install `@deepseek-ai/cordis-plugin-loader`, mount the config file through a
 * root `cordis:include` builtin entry (with `cordis:group` beside it), wait for
 * the Loader tree to settle, then audit that every enabled entry activated.
 * The two failure stages (`host preparation failed` before any config entry
 * mounts, `plugin tree failed to load` afterwards) and the deepest-cause stack
 * preservation follow the upstream boot exactly. Divergences from upstream are
 * deliberate and recorded in `PROJECT_STATUS.md`.
 * @module @dsh-evolve-le/core/cordis/boot
 */

import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'

/** Value mirrors for Cordis's const enum (no runtime object is exported). */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/** Result of a successful {@link bootLoader}. */
export interface BootedLoader {
  /** The settled root context. */
  ctx: Context
  /** The Fiber owning the Loader service; disposing it unmounts the whole entry tree. */
  loaderFiber: Fiber
}

/** Options for {@link bootLoader}. */
export interface BootLoaderOptions {
  /** Overlay patches applied over the included entry tree, in order (later wins). */
  patches?: PatchOptions[]
  /**
   * Host setup run after the Loader mounts and before any config-tree entry
   * loads. Its failure is reported as `host preparation failed`.
   */
  prepare?: (ctx: Context) => Promise<void> | void
  /** Reuse an existing root context instead of creating one; the caller owns its lifetime. */
  context?: Context
}

/**
 * Boot the pinned Cordis Loader against a `cordis.yml` entry list and resolve
 * only after the whole tree settles and every enabled entry activated.
 * @param configPath - the config file to include; relative paths resolve from `process.cwd()`.
 * @param options - patches, host preparation, or a caller-owned root context.
 * @returns the settled context plus the Loader Fiber for teardown.
 * @throws {LoaderActivationError} when an entry failed to import, rejected
 *   during activation, or never left the pending state.
 */
export async function bootLoader(
  configPath: string,
  options: BootLoaderOptions = {},
): Promise<BootedLoader> {
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  const ctx = options.context ?? new Context()
  let stage = 'host preparation failed'
  try {
    ctx.baseUrl = pathToFileURL(dirname(absolute)).href + '/'
    const loaderFiber = await ctx.plugin(Loader)
    await options.prepare?.(ctx)
    stage = 'plugin tree failed to load'
    await mountRootInclude(ctx, absolute, options.patches)
    await ctx.get('loader')?.await()
    await assertEntriesActivated(ctx, 'dsh-evolve-le:boot')
    return { ctx, loaderFiber }
  } catch (cause) {
    // Root-fiber disposal contains cleanup failures per observer; a repeated
    // call returns the settled result, so this await cannot replace `cause`.
    await ctx.fiber.dispose()
    const detail = cause instanceof Error ? cause.message : String(cause)
    let deepest: unknown = cause
    while (deepest instanceof Error && deepest.cause !== undefined) deepest = deepest.cause
    const stack =
      deepest instanceof Error && deepest !== cause ? `\n${deepest.stack ?? deepest.message}` : ''
    throw new Error(`dsh-evolve-le:boot: ${stage}: ${detail}${stack}`, { cause })
  }
}

/**
 * Mount the config file as the root Include entry with `cordis:group` beside
 * it, mirroring upstream `mountRootInclude` (pinned id `include`).
 */
async function mountRootInclude(
  ctx: Context,
  absoluteConfigPath: string,
  patches: readonly PatchOptions[] = [],
): Promise<void> {
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const rootInclude: EntryOptions = {
    id: 'include',
    name: 'cordis:include',
    config: {
      path: pathToFileURL(absoluteConfigPath).href,
      ...(patches.length > 0 ? { patches: [...patches] } : {}),
    },
  }
  await ctx.loader.create(rootInclude)
}

/** One entry that did not activate, with the deepest available failure reason. */
export interface EntryActivationFailure {
  /** The entry's configured name (its specifier in `cordis.yml`). */
  name: string
  /** Human-readable reason: import failure, activation rejection, or pending inject. */
  reason: string
}

/** Thrown by {@link bootLoader} when the settled tree contains failed or pending entries. */
export class LoaderActivationError extends Error {
  /** The entries that did not activate. */
  readonly failures: EntryActivationFailure[]

  constructor(stage: string, failures: EntryActivationFailure[]) {
    super(
      `${stage}: ${failures.length === 1 ? '1 entry' : `${failures.length} entries`} did not activate\n` +
        failures.map((f) => `${f.name}: ${f.reason}`).join('\n'),
    )
    this.name = 'LoaderActivationError'
    this.failures = failures
  }
}

/**
 * Reject a settled Loader tree whose enabled entries are not all active:
 * failed entries are awaited to recover their private rejection reason, and
 * pending entries name their unresolved services. Mirrors upstream
 * `assertEntriesActivated`.
 */
async function assertEntriesActivated(ctx: Context, label: string): Promise<void> {
  const failures: EntryActivationFailure[] = []
  for (const entry of ctx.loader.entries()) {
    if (entry.disabled) continue
    const fiber = entry.fiber
    if (fiber === undefined) {
      failures.push({ name: entry.options.name, reason: 'plugin failed to resolve or load' })
      continue
    }
    if (fiber.state === FIBER_ACTIVE) continue
    if (fiber.state === FIBER_FAILED) {
      try {
        await fiber.await()
        failures.push({
          name: entry.options.name,
          reason: 'fiber failed without a recoverable reason',
        })
      } catch (error) {
        failures.push({
          name: entry.options.name,
          reason: error instanceof Error ? (error.stack ?? error.message) : String(error),
        })
      }
      continue
    }
    const missing = Object.keys(fiber.inject).filter(
      (service) => fiber.ctx.get(service) === undefined,
    )
    const subject = missing.length === 1 ? 'service' : 'services'
    failures.push({
      name: entry.options.name,
      reason: `pending (waiting for ${subject}: ${missing.join(', ') || 'unknown'})`,
    })
  }
  if (failures.length > 0) throw new LoaderActivationError(label, failures)
}
