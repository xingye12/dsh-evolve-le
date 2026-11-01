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
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
/** Cordis plugin name; also the Loader runtime display name. */
export declare const name = "self-evolving-candidate";
/** Native DSH services used by the baseline strategy. */
export declare const inject: string[];
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Installs this candidate strategy into a native DSH agent scope. */
        candidateStrategySetup?: (agentCtx: Context) => void;
    }
}
/** Baseline candidate configuration validated by the Loader at mount. */
export interface Config {
    /** Canonical candidate identity assigned by the trusted builder. */
    candidateId: string;
    /** Execution mode; bound to behavior by the candidate SDK. */
    mode: 'solve' | 'propose';
}
export declare const Config: Schema<Config>;
/**
 * Activate the candidate's contribution for the configured mode. The section
 * is effect-owned, so disposing this plugin's Fiber removes it and nothing
 * else — which is exactly what the builder's unload-invariant stage asserts.
 * @param ctx - the plugin's Fiber context.
 * @param config - validated entry config from `cordis.yml`.
 */
export declare function apply(ctx: Context, config: Config): void;
