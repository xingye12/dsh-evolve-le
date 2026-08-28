/**
 * Gate 0 control fixture for the negative default-export test: identical
 * inject declaration and direct property read as `bad-default-export.ts`, but
 * WITHOUT the stray `export default apply`. Through the real Loader the
 * namespace form keeps `inject: ['dshEvolveProbe']`, so the read resolves and
 * the plugin activates — proving the negative fixture fails specifically
 * because of the default export, not because of the read itself.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProbeService } from './probe-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshEvolveProbe: ProbeService
  }
}

export const name = 'dsh-evolve-le:good-inject-twin'
export const inject = ['dshEvolveProbe']

export function apply(ctx: Context): void {
  if (ctx.dshEvolveProbe === undefined) {
    throw new Error('dshEvolveProbe service missing despite declared inject')
  }
}
