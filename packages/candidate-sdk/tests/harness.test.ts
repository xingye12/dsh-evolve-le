/**
 * Candidate SDK contract tests (Gate 1): boundaries are enforced at
 * registration time — out-of-namespace section names, bad orders, empty or
 * oversized text, unknown modes and missing systemPrompt all fail closed.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createHarness } from '../src/testkit.js'
import { defineCandidate, type CandidateRuntime } from '../src/index.js'

interface TestConfig extends CandidateRuntime {
  candidateId: string
}

const builder = (name: string) => (config: TestConfig) => ({
  name: name as `candidate:${string}`,
  order: 100,
  text: `section for ${config.candidateId}`,
})

describe('defineCandidate boundaries', () => {
  it('registers an in-namespace section in both modes', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: { promptSection: builder('candidate:identity') },
      propose: { promptSection: builder('candidate:proposal-policy') },
    })
    for (const mode of ['solve', 'propose'] as const) {
      const harness = createHarness()
      candidate.register(harness.ctx, { mode, candidateId: 'c_test' })
      expect(harness.sections()).toHaveLength(1)
      harness.dispose()
      expect(harness.sections()).toEqual([])
    }
  })

  it('rejects section names outside the candidate: namespace', () => {
    const candidate = defineCandidate<TestConfig>({
      // Deliberately out-of-boundary name; the runtime check must reject it.
      solve: { promptSection: builder('system-prompt') },
      propose: { promptSection: builder('candidate:proposal-policy') },
    })
    const harness = createHarness()
    expect(() => candidate.register(harness.ctx, { mode: 'solve', candidateId: 'c_test' })).toThrow(
      /candidate-sdk: section name must match/,
    )
  })

  it('rejects non-integer and out-of-range orders', () => {
    const withOrder = (order: number) =>
      defineCandidate<TestConfig>({
        solve: {
          promptSection: (config) => ({
            name: 'candidate:identity',
            order,
            text: config.candidateId,
          }),
        },
        propose: {},
      })
    const harness = createHarness()
    expect(() => withOrder(1.5).register(harness.ctx, { mode: 'solve', candidateId: 'x' })).toThrow(
      /order/,
    )
    expect(() => withOrder(-1).register(harness.ctx, { mode: 'solve', candidateId: 'x' })).toThrow(
      /order/,
    )
    expect(() =>
      withOrder(10_001).register(harness.ctx, { mode: 'solve', candidateId: 'x' }),
    ).toThrow(/order/)
  })

  it('rejects empty and oversized text', () => {
    const withText = (text: string) =>
      defineCandidate<TestConfig>({
        solve: { promptSection: () => ({ name: 'candidate:identity', order: 1, text }) },
        propose: {},
      })
    const harness = createHarness()
    expect(() => withText('').register(harness.ctx, { mode: 'solve', candidateId: 'x' })).toThrow(
      /text/,
    )
    expect(() =>
      withText('x'.repeat(32 * 1024 + 1)).register(harness.ctx, {
        mode: 'solve',
        candidateId: 'x',
      }),
    ).toThrow(/text/)
  })

  it('rejects unknown modes and non-object configs', () => {
    const candidate = defineCandidate({
      solve: {},
      propose: {},
    })
    const harness = createHarness()
    expect(() => candidate.register(harness.ctx, { mode: 'audit' } as never)).toThrow(
      /mode must be/,
    )
    expect(() => candidate.register(harness.ctx, null as never)).toThrow(/config must be/)
  })

  it('rejects a definition missing a mode behavior', () => {
    expect(() => defineCandidate({ solve: {} } as never)).toThrow(/"propose"/)
  })

  it('fails closed when systemPrompt is not injectable', () => {
    const candidate = defineCandidate({
      solve: { promptSection: () => ({ name: 'candidate:identity', order: 1, text: 't' }) },
      propose: {},
    })
    const bare = {} as Context
    expect(() => candidate.register(bare, { mode: 'solve' })).toThrow(
      /systemPrompt service unavailable/,
    )
  })

  it('describe() resolves the plan without touching a context', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: { promptSection: builder('candidate:identity') },
      propose: {},
    })
    expect(candidate.describe({ mode: 'solve', candidateId: 'c_test' }).section?.name).toBe(
      'candidate:identity',
    )
    expect(candidate.describe({ mode: 'propose', candidateId: 'c_test' }).section).toBeUndefined()
  })

  it('candidates without a promptSection register no effects', () => {
    const candidate = defineCandidate({ solve: {}, propose: {} })
    const harness = createHarness()
    candidate.register(harness.ctx, { mode: 'solve' })
    expect(harness.sections()).toEqual([])
    expect(harness.effects()).toEqual([])
  })
})
