/**
 * Two-mode candidate (specs/02 §2–7) - no-op-execution-gate-v2 variant: the
 * solve prompt now demands two distinct observed tool invocations before any
 * final reply, hardening the single-inspection gate against null-execution
 * trials.
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
import { defineCandidate } from '@dsh-evolve-le/candidate-sdk'

/** Cordis plugin name; also the Loader runtime display name. */
export const name = 'self-evolving-candidate'

/** The only service this candidate touches (specs/02 §5: systemPrompt). */
export const inject = ['systemPrompt']

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

const candidate = defineCandidate<Config>({
  solve: {
    promptSection: (config) => ({
      name: 'candidate:identity',
      order: 100,
      text:
        `You are executing under self-evolving candidate ${config.candidateId} ` +
        'in solve mode. Execute the assigned terminal-bench task now: read the ' +
        'task specification, inspect the workspace, and complete the required ' +
        'artifact. Session hygiene rule: before you may send any final message ' +
        'you must have recorded at least two distinct observable tool ' +
        'invocations whose outputs you actually read - a bare acknowledgement or ' +
        'a single listing is never sufficient. If you have not executed and ' +
        'observed at least two tool results, keep working; do not submit an ' +
        'empty session. Even if the task seems trivial, produce the artifact, ' +
        'run the available checks, and submit only when the task checks pass.',
    }),
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
  },
})

/**
 * Activate the candidate's contribution for the configured mode. The section
 * is effect-owned, so disposing this plugin's Fiber removes it and nothing
 * else - which is exactly what the builder's unload-invariant stage asserts.
 * @param ctx - the plugin's Fiber context.
 * @param config - validated entry config from `cordis.yml`.
 */
export function apply(ctx: Context, config: Config): void {
  candidate.register(ctx, config)
}
