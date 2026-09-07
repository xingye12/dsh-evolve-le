/**
 * Cluster-bootstrap contract tests (ADR-047, specs/03 §11 step 5): the lower
 * confidence bound over task-clustered paired deltas. The resample index
 * stream is deterministic: eight HMAC-derived seed words on the 'bootstrap'
 * RNG stream expand through xorshift128+ (rejection sampling for unbiased
 * indices), so the same (masterSeed, runId, counter) always yields the same
 * indices, receipt, and bound — replayable byte-for-byte from the receipt.
 */
import { describe, expect, it } from 'vitest'
import { clusterBootstrapLcb, xorshift128plusNext } from '../src/selection/bootstrap.js'

describe('xorshift128+ expansion (hand-computed golden)', () => {
  it('steps {s0:1, s1:2} to out=0x800045 and swaps the state halves', () => {
    const step = xorshift128plusNext({ s0: 1n, s1: 2n })
    expect(step.out).toBe(0x800045n)
    expect(step.s0).toBe(2n)
    expect(step.s1).toBe(0x800043n)
  })

  it('continues deterministically from the swapped state', () => {
    const first = xorshift128plusNext({ s0: 1n, s1: 2n })
    const second = xorshift128plusNext({ s0: first.s0, s1: first.s1 })
    expect(second.out).toBe(0x2000104n)
    expect(second.s0).toBe(0x800043n)
    expect(second.s1).toBe(0x18000c1n)
  })
})

describe('cluster bootstrap LCB', () => {
  it('is deterministic for the same (masterSeed, runId, counter)', () => {
    const input = {
      masterSeed: 'bootstrap-test-seed',
      runId: 'bootstrap-test-run',
      counter: 1,
      deltas: [1, 1, -1, -1, 0, 1, -1, 0],
      resamples: 10_000,
      percentile: 10,
    }
    const first = clusterBootstrapLcb(input)
    const second = clusterBootstrapLcb(input)
    expect(first.lcb).toBe(second.lcb)
    expect(first.mean).toBe(second.mean)
    expect(first.receipt).toEqual(second.receipt)
  })

  it('issues one receipt on the bootstrap stream that binds the expansion algorithm', () => {
    const result = clusterBootstrapLcb({
      masterSeed: 'bootstrap-test-seed',
      runId: 'bootstrap-test-run',
      counter: 7,
      deltas: [1, -1, 0, 0],
      resamples: 1_000,
      percentile: 10,
    })
    const receipt = result.receipt
    expect(receipt.stream).toBe('bootstrap')
    expect(receipt.counter).toBe(7)
    expect(receipt.algorithm).toBe('dsh-evolve-le/counter-hmac-sha256/v1')
    // Eight seed words expand the whole resample stream; the receipt never
    // stores the expanded indices (they re-derive from the seeds).
    expect(receipt.raw).toHaveLength(8)
    expect(typeof receipt.inputHash).toBe('string')
    expect(receipt.result).toEqual({
      algorithm: 'dsh-evolve-le/xorshift128plus-rejection/v1',
      resamples: 1_000,
      clusters: 4,
      percentile: 10,
      meanPerMille: 0,
      lcbPerMille: expect.any(Number),
    })
  })

  it('degenerate all-equal deltas pin mean === lcb === the value', () => {
    for (const value of [-1, 0, 1]) {
      const result = clusterBootstrapLcb({
        masterSeed: 'bootstrap-test-seed',
        runId: 'bootstrap-test-run',
        counter: 3,
        deltas: Array.from({ length: 6 }, () => value),
        resamples: 10_000,
        percentile: 10,
      })
      expect(result.mean).toBe(value)
      expect(result.lcb).toBe(value)
    }
  })

  it('keeps the LCB inside the delta range and at or below the mean', () => {
    const result = clusterBootstrapLcb({
      masterSeed: 'bootstrap-test-seed',
      runId: 'bootstrap-test-run',
      counter: 4,
      deltas: [1, 1, 1, -1, -1, -1, 0, 0],
      resamples: 10_000,
      percentile: 10,
    })
    expect(result.mean).toBeCloseTo(0, 10)
    expect(result.lcb).toBeLessThanOrEqual(result.mean + 1e-12)
    expect(result.lcb).toBeGreaterThanOrEqual(-1)
    expect(result.lcb).toBeLessThanOrEqual(1)
  })

  it('is monotone in the percentile: p=1 ≤ p=10 ≤ p=50', () => {
    // Equal ±1 counts make the resample-mean distribution symmetric around
    // the sample mean 0, so the empirical median equals the mean exactly.
    const base = {
      masterSeed: 'bootstrap-test-seed',
      runId: 'bootstrap-test-run',
      counter: 5,
      deltas: [1, 1, -1, -1, 0, 0, 1, -1],
      resamples: 10_000,
    }
    const p1 = clusterBootstrapLcb({ ...base, percentile: 1 })
    const p10 = clusterBootstrapLcb({ ...base, percentile: 10 })
    const p50 = clusterBootstrapLcb({ ...base, percentile: 50 })
    expect(p1.lcb).toBeLessThanOrEqual(p10.lcb)
    expect(p10.lcb).toBeLessThanOrEqual(p50.lcb)
    expect(p50.lcb).toBeCloseTo(p50.mean, 10)
  })

  it('rejects an empty delta vector', () => {
    expect(() =>
      clusterBootstrapLcb({
        masterSeed: 's',
        runId: 'r',
        counter: 1,
        deltas: [],
        resamples: 100,
        percentile: 10,
      }),
    ).toThrow(/delta/)
  })

  it('rejects invalid percentile and resample values', () => {
    const base = {
      masterSeed: 's',
      runId: 'r',
      counter: 1,
      deltas: [1, 0],
      resamples: 100,
    }
    expect(() => clusterBootstrapLcb({ ...base, percentile: 0 })).toThrow(/percentile/)
    expect(() => clusterBootstrapLcb({ ...base, percentile: 51 })).toThrow(/percentile/)
    expect(() => clusterBootstrapLcb({ ...base, resamples: 0 })).toThrow(/resamples/)
  })
})
