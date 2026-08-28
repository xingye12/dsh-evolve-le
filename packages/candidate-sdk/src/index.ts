/**
 * Candidate SDK runtime surface (specs/02 §4–7).
 *
 * This is the ONLY non-TCB library a candidate may build on. It is
 * dependency-free at runtime (types come from `@deepseek-ai/cordis` as a
 * type-only import), so the trusted builder can compile it into every capsule
 * without pulling an evolving dependency closure behind the candidate's back.
 *
 * The SDK deliberately exposes behavior declaration, not escape hatches: a
 * candidate describes per-mode prompt contributions, and the SDK owns the
 * Cordis mechanics (`inject` expectations, effect ownership, section-name
 * namespacing). Everything a candidate contributes is named `candidate:*` so
 * a controller can attribute and revoke it.
 *
 * @module @dsh-evolve-le/candidate-sdk
 */

import type { Context } from '@deepseek-ai/cordis'

/** The two execution modes every candidate must support (specs/02 §2). */
export type CandidateMode = 'solve' | 'propose'

/** Section names are namespaced so contributions stay attributable. */
export type CandidateSectionName = `candidate:${string}`

/** Structural view of one system-prompt contribution. */
export interface PromptSection {
  name: CandidateSectionName
  order: number
  text: string
}

/** Per-candidate runtime config; candidates may extend this with their own fields. */
export interface CandidateRuntime {
  mode: CandidateMode
}

/** Minimal structural view of the DSH `systemPrompt` service. */
export interface SystemPromptLike {
  section(input: PromptSection): () => void
}

/** How one mode behaves; built lazily from config so text can embed runtime identity. */
export interface ModeBehavior<Config extends CandidateRuntime> {
  /** Called once at plugin activation; the returned section is effect-owned. */
  promptSection?: (config: Config) => PromptSection
}

/** What a candidate author writes: exactly two modes, nothing else. */
export interface CandidateDefinition<Config extends CandidateRuntime> {
  solve: ModeBehavior<Config>
  propose: ModeBehavior<Config>
}

/** Boundaries every contributed section must respect (specs/02 §7 budget). */
export const SECTION_LIMITS = {
  namePattern: /^candidate:[a-z0-9][a-z0-9-]*$/,
  maxNameLength: 64,
  minOrder: 0,
  maxOrder: 10_000,
  maxTextLength: 32 * 1024,
} as const

/** Introspection result: what this candidate would contribute in a mode. */
export interface CandidatePlan {
  mode: CandidateMode
  section: PromptSection | undefined
}

/** A registered candidate plugin factory returned by {@link defineCandidate}. */
export interface CandidatePlugin<Config extends CandidateRuntime> {
  /** Resolve what this candidate contributes in the given config's mode. */
  describe(config: Config): CandidatePlan
  /** Activate the contribution on a real Cordis plugin context (effect-owned). */
  register(ctx: Context, config: Config): void
}

function invalid(reason: string): never {
  throw new Error(`candidate-sdk: ${reason}`)
}

function validateSection(section: PromptSection, mode: CandidateMode): PromptSection {
  if (section === null || typeof section !== 'object') {
    invalid(`promptSection for mode "${mode}" must return an object`)
  }
  const { name, order, text } = section
  if (
    typeof name !== 'string' ||
    name.length > SECTION_LIMITS.maxNameLength ||
    !SECTION_LIMITS.namePattern.test(name)
  ) {
    invalid(`section name must match ${String(SECTION_LIMITS.namePattern)} (got ${String(name)})`)
  }
  if (
    typeof order !== 'number' ||
    !Number.isInteger(order) ||
    order < SECTION_LIMITS.minOrder ||
    order > SECTION_LIMITS.maxOrder
  ) {
    invalid(
      `section "${name}" order must be an integer in [${SECTION_LIMITS.minOrder}, ${SECTION_LIMITS.maxOrder}] (got ${String(order)})`,
    )
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > SECTION_LIMITS.maxTextLength) {
    invalid(
      `section "${name}" text must be a non-empty string of at most ${SECTION_LIMITS.maxTextLength} chars`,
    )
  }
  return { name, order, text }
}

function resolveSection<Config extends CandidateRuntime>(
  definition: CandidateDefinition<Config>,
  config: Config,
): PromptSection | undefined {
  if (config === null || typeof config !== 'object') {
    invalid('config must be an object')
  }
  if (config.mode !== 'solve' && config.mode !== 'propose') {
    invalid(`config.mode must be "solve" or "propose" (got ${String(config.mode)})`)
  }
  const behavior = config.mode === 'solve' ? definition.solve : definition.propose
  if (behavior == null || typeof behavior !== 'object') {
    invalid(`candidate definition must declare a "${config.mode}" behavior object`)
  }
  if (behavior.promptSection == null) return undefined
  if (typeof behavior.promptSection !== 'function') {
    invalid(`promptSection for mode "${config.mode}" must be a function`)
  }
  return validateSection(behavior.promptSection(config), config.mode)
}

/**
 * Declare a two-mode candidate. Throws at registration time (activation fails,
 * the build is rejected) for any out-of-boundary contribution — candidates
 * fail closed, never silently.
 *
 * @example
 * ```ts
 * const candidate = defineCandidate<Config>({
 *   solve: { promptSection: cfg => ({ name: 'candidate:identity', order: 100, text: `…${cfg.candidateId}…` }) },
 *   propose: { promptSection: cfg => ({ name: 'candidate:proposal-policy', order: 100, text: '…' }) },
 * })
 * export function apply(ctx: Context, config: Config): void {
 *   candidate.register(ctx, config)
 * }
 * ```
 */
export function defineCandidate<Config extends CandidateRuntime = CandidateRuntime>(
  definition: CandidateDefinition<Config>,
): CandidatePlugin<Config> {
  if (definition === null || typeof definition !== 'object') {
    invalid('definition must be an object with solve and propose behaviors')
  }
  // Definition-time check is structural only: the section builders need a
  // real config, so their output is validated in register/describe.
  for (const mode of ['solve', 'propose'] as const) {
    const behavior = definition[mode]
    if (behavior === null || typeof behavior !== 'object') {
      invalid(`candidate definition must declare a "${mode}" behavior object`)
    }
    if (behavior.promptSection !== undefined && typeof behavior.promptSection !== 'function') {
      invalid(`promptSection for mode "${mode}" must be a function`)
    }
  }

  return {
    describe(config: Config): CandidatePlan {
      return { mode: config.mode, section: resolveSection(definition, config) }
    },
    register(ctx: Context, config: Config): void {
      const section = resolveSection(definition, config)
      if (section === undefined) return
      const systemPrompt = (ctx as unknown as { systemPrompt?: SystemPromptLike }).systemPrompt
      if (systemPrompt === null || systemPrompt === undefined) {
        invalid(
          'systemPrompt service unavailable; the plugin must declare inject = ["systemPrompt"]',
        )
      }
      // Effect-owned: the section's disposer runs when the plugin Fiber
      // disposes, so unload inventories stay exact.
      ctx.effect(() => systemPrompt.section(section))
    },
  }
}
