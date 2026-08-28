/**
 * Gate 0 NEGATIVE fixture: a namespace plugin with a stray
 * `export default apply` beside named `name`/`inject` exports.
 *
 * The Cordis Loader normalizes module exports through
 * `exports.default ?? exports` (`vendor/loader/src/index.ts`,
 * `unwrapExports`), so the bare `apply` function wins and the sibling
 * `inject: ['dshEvolveProbe']` is discarded. `apply` then runs in a Fiber with
 * an empty inject set, and the direct property read below throws
 * `cannot get property "dshEvolveProbe" without inject` at load time — the
 * exact failure documented in DSH postmortem 0001. The real-Loader E2E must
 * reject on this fixture; the loader-twin fixture without the default export
 * must load, proving the default export is the cause.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProbeService } from './probe-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshEvolveProbe: ProbeService
  }
}

export const name = 'dsh-evolve-le:bad-default-export'
export const inject = ['dshEvolveProbe']

export function apply(ctx: Context): void {
  // Direct property read of a declared-inject service: throws when the Loader
  // dropped the plugin's `inject`.
  void ctx.dshEvolveProbe
}

export default apply
