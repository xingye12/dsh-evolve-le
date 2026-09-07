/**
 * Golden two-mode baseline candidate (specs/02 §2–7, Gate 1).
 *
 * Namespace form only (`name` / `inject` / `Config` / `apply`, no default
 * export): the Cordis Loader normalizes modules through
 * `exports.default ?? exports`, so a stray default export would drop these
 * sibling exports (pinned DSH postmortem 0001). All behavior goes through the
 * candidate SDK so the surface stays typed, namespaced and effect-owned.
 *
 * @module @dsh-evolve-le/candidate-baseline
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  defineCandidate,
  type CandidateSkillRegistration,
  type CandidateToolDefinition,
} from '@dsh-evolve-le/candidate-sdk'

/** Cordis plugin name; also the Loader runtime display name. */
export const name = 'self-evolving-candidate'

/** Native DSH services used by the baseline strategy. */
export const inject = ['systemPrompt', 'tools', 'skills']

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Installs this candidate strategy into a native DSH agent scope. */
    candidateStrategySetup?: (agentCtx: Context) => void
  }
}

/** Baseline candidate configuration validated by the Loader at mount. */
export interface Config {
  /** Canonical candidate identity assigned by the trusted builder. */
  candidateId: string
  /** Execution mode; bound to behavior by the candidate SDK. */
  mode: 'solve' | 'propose'
}

export const Config: Schema<Config> = Schema.object({
  candidateId: Schema.string().required(),
  mode: Schema.union(['solve', 'propose']).default('solve'),
})

const strategyTool = (config: Config): CandidateToolDefinition => ({
  name: 'candidate_strategy_snapshot',
  description: 'Return the active candidate strategy identity for audit-friendly planning.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: {
      type: 'object',
      properties: { candidateId: { type: 'string' }, mode: { type: 'string' } },
      required: ['candidateId', 'mode'],
      additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  },
  async execute() {
    return { candidateId: config.candidateId, mode: config.mode }
  },
})

const strategySkill = (config: Config): CandidateSkillRegistration => ({
  name: 'candidate-strategy-review',
  description: 'Review the current strategy before committing a multi-step change.',
  whenToUse: 'Use before a consequential tool sequence or when recovering from a failed step.',
  content:
    `Candidate ${config.candidateId} is in ${config.mode} mode. ` +
    'State the intended outcome, choose the smallest reversible tool sequence, and verify its result before continuing.',
  invocation: { modelInvocable: true, userInvocable: false },
})

const candidate = defineCandidate<Config>({
  solve: {
    promptSection: (config) => ({
      name: 'candidate:identity',
      order: 100,
      text:
        `You are executing under self-evolving candidate ${config.candidateId} ` +
        'in solve mode. Candidate-owned tools and skills provide bounded strategy ' +
        'assistance; the model adapter, verifier, and protocol remain TCB-owned.',
    }),
    tools: (config) => [strategyTool(config)],
    skills: (config) => [strategySkill(config)],
  },
  propose: {
    promptSection: (config) => ({
      name: 'candidate:proposal-policy',
      order: 100,
      text:
        `You are executing under self-evolving candidate ${config.candidateId} ` +
        'in propose mode. Produce one proposal manifest describing a minimal, ' +
        'testable change; do not modify runtime behavior in this mode.',
    }),
    tools: (config) => [strategyTool(config)],
    skills: (config) => [strategySkill(config)],
  },
})

/**
 * Activate the candidate's contribution for the configured mode. The section
 * is effect-owned, so disposing this plugin's Fiber removes it and nothing
 * else — which is exactly what the builder's unload-invariant stage asserts.
 * @param ctx - the plugin's Fiber context.
 * @param config - validated entry config from `cordis.yml`.
 */
export function apply(ctx: Context, config: Config): void {
  candidate.register(ctx, config)
  // The root registration keeps the Loader probe observable. Native DSH
  // agents call this capability from create({ setup }) so candidate-owned
  // tools/skills are also installed in the agent Fiber (the scope that owns
  // their effects), rather than in a controller-global registry.
  const provide = (ctx as unknown as { provide?: (name: string, value: unknown) => void }).provide
  if (typeof provide === 'function') {
    provide.call(ctx, 'candidateStrategySetup', (agentCtx: Context) => {
      // Native DSH agent scopes own their prompt registry. Keep the complete
      // candidate contribution in that scope so prompt, tools and skills are
      // composed by AgentSpine together and disposed with the agent Fiber.
      candidate.register(agentCtx, config, { prompt: true })
    })
  }
}
