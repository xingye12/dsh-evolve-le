/**
 * Tree-v2 migration-root baseline candidate (specs/02,
 * docs/tree-v2-implementation-spec.md §migration root).
 *
 * This package is the parentless root of the tree-v2 candidate tree: its
 * candidate.json is a `candidate-intent` receipt with `parent: null`, a mode
 * contract targeting both solve and propose, and no preserved modes. The
 * trusted builder binds it to the exact legacy v1 source it supersedes
 * through the migration receipt (`resultsInherited: false`) — no legacy
 * score or trial result carries over.
 *
 * Namespace form only (`name` / `inject` / `Config` / `apply`, no default
 * export): the Cordis Loader normalizes modules through
 * `exports.default ?? exports`, so a stray default export would drop these
 * sibling exports (pinned DSH postmortem 0001). The root mounts the strategy
 * component (`src/strategy.ts`) through `ctx.plugin()`, as the tree-v2
 * contract requires of every component root.
 *
 * @module @dsh-evolve-le/candidate-tree-v2-baseline
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { strategyPlugin } from './strategy.js'

/** Cordis plugin name; also the Loader runtime display name. */
export const name = 'self-evolving-candidate'

/** Native DSH services used by the baseline strategy. */
export const inject = ['systemPrompt', 'tools', 'skills', 'candidateWorkflows']

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

/** Loader entry config schema (merged with the `Config` interface above). */
export const Config: Schema<Config> = Schema.object({
  candidateId: Schema.string().required(),
  mode: Schema.union(['solve', 'propose']).default('solve'),
})

/**
 * Activate the candidate by mounting its strategy component. The component
 * owns every contribution as an effect of its own Fiber, so the builder's
 * unload-invariant stage observes an exact inventory restore on dispose.
 * @param ctx - the plugin's Fiber context.
 * @param config - validated entry config from `cordis.yml`.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(strategyPlugin, config)
}
