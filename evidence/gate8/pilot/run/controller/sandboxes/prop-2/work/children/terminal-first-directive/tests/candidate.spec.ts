/**
 * Candidate-owned spec for the golden baseline (specs/02 §7) — terminal-first variant.
 * These are the mechanism/preservation assertions declared in candidate.json: mode wiring
 * and effect ownership, verified against the SDK testkit without a live
 * harness, network or model.
 */
import { describe, expect, it } from 'vitest'
import { createHarness } from '@dsh-evolve-le/candidate-sdk/testkit'
import { apply, type Config } from '../src/index.js'

const config = (mode: Config['mode']): Config => ({
  candidateId: 'c_gate1goldenfixture000000000000',
  mode,
})

describe('self-evolving-candidate baseline', () => {
  it('registers exactly one candidate:identity section in solve mode', () => {
    const harness = createHarness()
    apply(harness.ctx, config('solve'))
    const sections = harness.sections()
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('candidate:identity')
    expect(sections[0]?.order).toBe(100)
    expect(sections[0]?.text).toContain('c_gate1goldenfixture000000000000')
    expect(sections[0]?.text).toContain('solve mode')
    expect(sections[0]?.text).toContain('not allowed to finish before you have executed at least one command')
  })

  it('registers exactly one candidate:proposal-policy section in propose mode', () => {
    const harness = createHarness()
    apply(harness.ctx, config('propose'))
    const sections = harness.sections()
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('candidate:proposal-policy')
    expect(sections[0]?.text).toContain('propose mode')
  })

  it('owns its section through an effect: disposal removes it and runs teardown', () => {
    const harness = createHarness()
    apply(harness.ctx, config('solve'))
    expect(harness.effects()).toHaveLength(1)
    expect(harness.effects()[0]?.disposed).toBe(false)

    harness.dispose()
    expect(harness.sections()).toEqual([])
    expect(harness.effects()[0]?.disposed).toBe(true)
  })

  it('registers nothing beyond the single section', () => {
    const harness = createHarness()
    apply(harness.ctx, config('solve'))
    // The SDK surface records sections and effects only; a baseline candidate
    // contributes exactly one of each.
    expect(harness.sections()).toHaveLength(1)
    expect(harness.effects()).toHaveLength(1)
  })
})
