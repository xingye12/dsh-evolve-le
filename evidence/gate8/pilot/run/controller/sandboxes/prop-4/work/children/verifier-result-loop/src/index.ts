/**
 * Two-mode candidate (specs/02 §2–7) - verifier-result-loop variant: the
 * solve prompt now requires running and observing the task's own verifier or
 * test entrypoint before any final reply, so wrong-artifact trials cannot
 * finalize while the verifier still reports failure.
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
        'in solve mode. Execute the assigned terminal-bench task and produce the ' +
        'exact artifact the task requests. Before any final message, locate and ' +
        'run the task\'s own verifier or test entrypoint (the check the grader ' +
        'will run), capture and read its output, and confirm the output indicates ' +
        'success. A final reply is forbidden while the verifier reports failure: ' +
        'fix the artifact from the reported diagnostics and re-run until the ' +
        'verifier passes. Do not substitute prose for the required artifact, and ' +
        'do not finalize before you have observed the verifier output.',
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
