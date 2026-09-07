import { describe, expect, it } from 'vitest'
import { calibrateSearch, type CalibrationInput } from '../src/selection/calibration.js'

/**
 * ADR-042 contract: the UCB-Air calibration preflight (specs/03 §2) rejects a
 * search envelope that can never reach K under the frozen gate before any paid
 * launch. Golden values are hand-derived from the frozen arithmetic:
 *
 *   minimumTrials = ceil(K^(1/alpha)) + q0 × shortlistSize
 *
 * with alpha = ucbAirAlphaPerMille/1000: K=3 → ceil(6.24)=7 → 9; K=10 →
 * ceil(46.42)=47 → 49; K=80 at the ADR-045 formal-profile alpha=0.8 →
 * ceil(80^1.25)=240 → 255.
 */

function stableDemoSearch(overrides: Partial<CalibrationInput> = {}): CalibrationInput {
  return {
    kTarget: 3,
    coldStartTrials: 1,
    shortlistSize: 2,
    ucbAirAlphaPerMille: 600,
    maxSolverTrials: 15,
    taskTrials: 15,
    ...overrides,
  }
}

function k10Search(overrides: Partial<CalibrationInput> = {}): CalibrationInput {
  return {
    kTarget: 10,
    coldStartTrials: 1,
    shortlistSize: 2,
    ucbAirAlphaPerMille: 600,
    maxSolverTrials: 60,
    taskTrials: 60,
    ...overrides,
  }
}

function k80Search(overrides: Partial<CalibrationInput> = {}): CalibrationInput {
  return {
    kTarget: 80,
    coldStartTrials: 3,
    shortlistSize: 5,
    // ADR-045: the formal k80 profile pre-registers alpha=0.8 (the 0.6 gate
    // needs N ≥ 80^(5/3) ≈ 1486 trials, unaffordable under the 30h envelope).
    ucbAirAlphaPerMille: 800,
    maxSolverTrials: 400,
    taskTrials: 400,
    ...overrides,
  }
}

describe('calibrateSearch (ADR-042, specs/03 §2)', () => {
  it('accepts the stable-demo envelope (minimum 9 inside 15)', () => {
    const verdict = calibrateSearch(stableDemoSearch())
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('minimumTrials=9')
    expect(verdict.problems).toEqual([])
  })

  it('accepts the K=10 envelope with the pre-registered 24×1 baseline matrix', () => {
    const verdict = calibrateSearch(
      k10Search({ benchmarkBaseline: { taskCount: 24, attemptsPerTask: 1, batchSize: 6 } }),
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('minimumTrials=49')
    expect(verdict.problems).toEqual([])
  })

  it('accepts K=10 without a benchmark baseline (stable-demo discovery funds D)', () => {
    const verdict = calibrateSearch(k10Search())
    expect(verdict.ok).toBe(true)
  })

  it('accepts the ADR-045 k80 envelope at alpha=0.8 (minimum 255 inside 400)', () => {
    const verdict = calibrateSearch(k80Search())
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('finalGate=240')
    expect(verdict.detail).toContain('minimumTrials=255')
    expect(verdict.problems).toEqual([])
  })

  it('accepts the k80 envelope with the pre-registered 39×2 baseline matrix', () => {
    const verdict = calibrateSearch(
      k80Search({ benchmarkBaseline: { taskCount: 39, attemptsPerTask: 2, batchSize: 8 } }),
    )
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('alpha=0.8')
    expect(verdict.detail).toContain('matrix=78')
    expect(verdict.detail).toContain('bestCaseSupply=3198')
    expect(verdict.problems).toEqual([])
  })

  it('still REJECTS the k80 envelope at the frozen alpha=0.6 (minimum 1501)', () => {
    // The pre-ADR-045 rejection shape stays contract-tested: at alpha=0.6 the
    // final gate alone needs N ≥ 80^(5/3) ≈ 1486 trials.
    const verdict = calibrateSearch(k80Search({ ucbAirAlphaPerMille: 600 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContainEqual(expect.stringContaining('minimumTrials=1501'))
    expect(verdict.problems).toContainEqual(expect.stringContaining('exceeds maxSolverTrials=400'))
    expect(verdict.problems).toContainEqual(
      expect.stringContaining('exceeds budget.taskTrials=400'),
    )
  })

  it('rejects a boundary miss: stable-demo minimum 9 against maxSolverTrials 8', () => {
    const verdict = calibrateSearch(stableDemoSearch({ maxSolverTrials: 8 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContainEqual(expect.stringContaining('exceeds maxSolverTrials=8'))
  })

  it('rejects when the Harbor task-trial budget alone is short (solver cap fine)', () => {
    const verdict = calibrateSearch(stableDemoSearch({ taskTrials: 8 }))
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContainEqual(expect.stringContaining('exceeds budget.taskTrials=8'))
    expect(verdict.problems).not.toContainEqual(expect.stringContaining('exceeds maxSolverTrials'))
  })

  it('honors the frozen alpha: alpha=1.0 lowers the gate to ceil(K)+q0×shortlist', () => {
    // 10^1 = 10 → minimum 12, inside the 15-trial stable-demo cap.
    const verdict = calibrateSearch(stableDemoSearch({ kTarget: 10, ucbAirAlphaPerMille: 1000 }))
    expect(verdict.ok).toBe(true)
    expect(verdict.detail).toContain('minimumTrials=12')
  })

  it('rejects a benchmark matrix whose trials plus cold starts bust the solver cap', () => {
    // 24 + 10×1 = 34 > 30, even though 49 would bust it too — the matrix bound
    // must be reported independently of the minimum.
    const verdict = calibrateSearch(
      k10Search({
        maxSolverTrials: 30,
        taskTrials: 60,
        benchmarkBaseline: { taskCount: 24, attemptsPerTask: 1, batchSize: 6 },
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContainEqual(expect.stringContaining('benchmark baseline matrix'))
  })

  it('rejects a benchmark baseline whose best-case pool supply cannot fund the gate', () => {
    // Pool ≤ 2 → supply 2 + 10×2 = 22 < 49: even if every task failed, the
    // search starves before K (the K=10 attempt-1 failure shape, pre-launch).
    const verdict = calibrateSearch(
      k10Search({
        benchmarkBaseline: { taskCount: 2, attemptsPerTask: 1, batchSize: 2 },
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContainEqual(expect.stringContaining('best-case pool supply'))
    expect(verdict.problems).toContainEqual(expect.stringContaining('22 < minimumTrials 49'))
  })

  it('a larger baseline matrix lifts the best-case supply bound', () => {
    // Pool ≤ 5 → supply 5 + 10×5 = 55 ≥ 49: feasible with margin.
    const verdict = calibrateSearch(
      k10Search({
        benchmarkBaseline: { taskCount: 5, attemptsPerTask: 1, batchSize: 5 },
      }),
    )
    expect(verdict.ok).toBe(true)
  })

  it('reports the final-gate and supply arithmetic in the detail for the record', () => {
    const verdict = calibrateSearch(
      k10Search({ benchmarkBaseline: { taskCount: 24, attemptsPerTask: 1, batchSize: 6 } }),
    )
    expect(verdict.detail).toContain('finalGate=47')
    expect(verdict.detail).toContain('alpha=0.6')
    expect(verdict.detail).toContain('matrix=24')
    expect(verdict.detail).toContain('bestCaseSupply=264')
  })
})
