/**
 * Shared strategy surfaces for the tree-v2 migration-root baseline
 * (docs/tree-v2-implementation-spec.md §migration root).
 *
 * This module is the tree-v2 baseline's second production module: the
 * component root (`src/index.ts`) mounts it through `ctx.plugin()`, and the
 * candidate-intent receipt names it in `runtime.modeComponents` for both
 * modes. Keeping the strategy construction here — rather than inline in the
 * root — is what makes the tree a real multi-file component that child
 * candidates can later target or preserve file-by-file.
 *
 * Behavior is byte-for-byte the golden legacy baseline's: one identity
 * prompt section per mode, one audit tool, one review skill, all
 * effect-owned through the candidate SDK.
 *
 * @module @dsh-evolve-le/candidate-tree-v2-baseline/strategy
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  defineCandidate,
  type CandidateSkillRegistration,
  type CandidateToolDefinition,
  type CandidateWorkflowRegistration,
} from '@dsh-evolve-le/candidate-sdk'

/** Baseline candidate configuration validated by the Loader at mount. */
interface Config {
  /** Canonical candidate identity assigned by the trusted builder. */
  candidateId: string
  /** Execution mode; bound to behavior by the candidate SDK. */
  mode: 'solve' | 'propose'
}

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

/**
 * Stable named seam for child candidates to evolve an actual per-step solve
 * policy. The TCB invokes only this workflow name in the native solve
 * pre-step waterfall and accepts only a bounded `{ checkpoint }` result.
 * The migration root deliberately emits no checkpoint.
 */
const solvePolicyWorkflow = (_config: Config): CandidateWorkflowRegistration => ({
  name: 'candidate-workflow:solve-policy',
  description: 'Produce a bounded checkpoint for the next live solve step.',
  async run() {
    return {}
  },
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
    workflows: (config) => [solvePolicyWorkflow(config)],
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
 * Mount the complete two-mode strategy into `ctx`. Every contribution is
 * effect-owned, so disposing this plugin's Fiber removes the section, the
 * tool and the skill — and nothing else.
 * @param ctx - the plugin's Fiber context.
 * @param config - validated entry config from `cordis.yml`.
 */
export function strategyPlugin(ctx: Context, config: Config): void {
  candidate.register(ctx, config)
  // The root registration keeps the Loader probe observable. Native DSH
  // agents call this capability from create({ setup }) so candidate-owned
  // tools/skills/workflows are also installed in the agent Fiber (the scope
  // that owns their effects), rather than in a controller-global registry.
  const provide = (ctx as unknown as { provide?: (name: string, value: unknown) => void }).provide
  if (typeof provide === 'function') {
    provide.call(ctx, 'candidateStrategySetup', (agentCtx: Context) => {
      // Native DSH agent scopes own their prompt registry. Keep the complete
      // candidate contribution in that scope so prompt, tools, skills and the
      // bounded solve-policy workflow are composed by AgentSpine together and
      // disposed with the agent Fiber.
      candidate.register(agentCtx, config, { prompt: true })
    })
  }
}
