/**
 * Gate 0 baseline candidate plugin.
 *
 * Namespace form only (`name` / `Config` / `apply`, no default export): the
 * Cordis Loader normalizes modules through `exports.default ?? exports`, so a
 * stray default export would drop these sibling exports (see the pinned DSH
 * postmortem 0001). Every change to this surface must keep the real-Loader
 * E2E in `packages/dsh-evolve-le/tests/cordis-boot.test.ts` green.
 * @module @dsh-evolve-le/candidate-baseline
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name; also the Loader runtime display name. */
export const name = 'dsh-evolve-le:candidate-baseline'

/** Probe event observed by the Gate 0 loader E2E. */
export const PROBE_EVENT = 'dsh-evolve-le/candidate-baseline:probe'

/** Baseline candidate configuration validated by the Loader at mount. */
export interface Config {
  /** Execution mode; the Gate 1 candidate SDK will bind semantics to it. */
  mode: 'solve' | 'propose'
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['solve', 'propose']).default('solve'),
})

declare module '@deepseek-ai/cordis' {
  interface Events {
    'dsh-evolve-le/candidate-baseline:probe'(marker: string): void
  }
}

/**
 * Register the baseline candidate's observable effects: one event listener and
 * one explicit external-resource effect with a teardown disposer. Both unwind
 * with the owning Fiber, which is exactly what the Gate 0 unload inventory
 * asserts.
 * @param ctx - the plugin's Fiber context.
 * @param config - validated entry config from `cordis.yml`.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on(PROBE_EVENT, (marker: string) => {
    ctx.logger.info(`${name} probe: ${marker} (mode=${config.mode})`)
  })
  ctx.effect(() => {
    // Stand-in for an owned external resource: its teardown must run during
    // Fiber disposal without leaving state in the process.
    const resource = { closed: false }
    return () => {
      resource.closed = true
    }
  })
}
