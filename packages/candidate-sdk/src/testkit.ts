/**
 * Candidate testkit (specs/02 §7): a dependency-free fake of the exact Cordis
 * surface {@link defineCandidate} touches, so candidate-owned tests can assert
 * their mode wiring without a live harness, network, or model.
 *
 * It is deliberately minimal — it records `systemPrompt.section` calls and
 * `ctx.effect` ownership, nothing else. If a candidate needs more than this to
 * test itself, that is a signal its behavior exceeds the candidate surface.
 *
 * @module @dsh-evolve-le/candidate-sdk/testkit
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CandidateMode, PromptSection } from './index.js'

/** One live section: present while its owning effect is undisposed. */
export interface RecordedSection extends PromptSection {}

/** One registered effect and whether its teardown has run. */
export interface RecordedEffect {
  index: number
  disposed: boolean
}

/** A mock plugin context plus readouts; `ctx` is cast, the rest is real. */
export interface CandidateHarness {
  /** Mock context satisfying exactly the surface the SDK touches. */
  readonly ctx: Context
  /** Sections currently registered (disposers remove them). */
  sections(): readonly RecordedSection[]
  /** Effects registered through `ctx.effect`, with disposal state. */
  effects(): readonly RecordedEffect[]
  /** Run all effect teardowns in reverse order (simulates Fiber disposal). */
  dispose(): void
}

/**
 * Build a recording harness. Sections registered by
 * `candidate.register(harness.ctx, config)` appear in `sections()` and vanish
 * after `dispose()`, mirroring how a real Fiber unwind drops effect-owned
 * prompt contributions.
 */
export function createHarness(): CandidateHarness {
  const liveSections: RecordedSection[] = []
  const effects: RecordedEffect[] = []
  const teardownFor = new Map<RecordedEffect, () => void>()

  const systemPrompt = {
    section(input: PromptSection): () => void {
      const record: RecordedSection = { name: input.name, order: input.order, text: input.text }
      liveSections.push(record)
      return () => {
        const at = liveSections.indexOf(record)
        if (at >= 0) liveSections.splice(at, 1)
      }
    },
  }

  const runTeardown = (record: RecordedEffect): void => {
    if (record.disposed) return
    record.disposed = true
    const teardown = teardownFor.get(record)
    teardown?.()
  }

  const effect = (factory: () => (() => void) | void): (() => void) => {
    const record: RecordedEffect = { index: effects.length, disposed: false }
    effects.push(record)
    teardownFor.set(record, factory() ?? (() => {}))
    return () => runTeardown(record)
  }

  const ctx = { systemPrompt, effect } as unknown as Context

  return {
    ctx,
    sections: () => [...liveSections],
    effects: () => effects.map((effect) => ({ ...effect })),
    dispose(): void {
      for (const record of [...effects].reverse()) runTeardown(record)
    },
  }
}

/** Convenience config for tests: any mode, plus whatever fields the candidate needs. */
export function modeConfig<C extends { mode: CandidateMode }>(
  mode: CandidateMode,
  extra: Omit<C, 'mode'> = {} as Omit<C, 'mode'>,
): C {
  return { mode, ...extra } as C
}
