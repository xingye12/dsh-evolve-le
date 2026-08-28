/**
 * Gate 0 fixture: a namespace-form plugin providing the `dshEvolveProbe`
 * service. Loaded through the real Cordis Loader from `cordis.*.yml`.
 *
 * Erasable TypeScript only: this file is imported by the Loader through Node's
 * real module pipeline (native type stripping), not by a TS-aware test
 * transform, so runtime syntax must stay erasable.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Service value provided under the `dshEvolveProbe` key. */
export interface ProbeService {
  readonly marker: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshEvolveProbe: ProbeService
  }
}

export const name = 'dsh-evolve-le:probe-service'

export function apply(ctx: Context): void {
  ctx.provide('dshEvolveProbe', { marker: 'gate0-probe' })
}
