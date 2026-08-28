import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineCandidate } from '@dsh-evolve-le/candidate-sdk'

export const name = 'self-evolving-candidate'
export const inject = ['systemPrompt']

export interface Config {
  mode: 'solve' | 'propose'
}

export const Config: Schema<Config> = Schema.object({
  mode: Schema.union(['solve', 'propose']).default('solve'),
})

const candidate = defineCandidate({
  solve: { promptSection: 'sk-abcdefghijklmnopqrstuvwx' },
  propose: { promptSection: 'candidate:proposal-policy' },
})

export function apply(ctx: Context, config: Config): void {
  candidate.register(ctx, config)
}
