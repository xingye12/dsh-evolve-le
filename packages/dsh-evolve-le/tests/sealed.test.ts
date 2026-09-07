/**
 * Sealed plan + scoring contract tests (ADR-048, specs/04 §8–10): the
 * champion-agnostic sealed-plan document (generation, validation, draw
 * verification) and the sealed score/verdict gates. These pin the exact
 * streams, counters, and hash bindings the formal record script relies on —
 * the sealed phase draws on its own 'sealed-plan'/'sealed-bootstrap' streams
 * and must never reuse the 'bootstrap' counters 0..5 the tournament rows
 * consumed (specs/06 §9).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/state/canonical.js'
import {
  drawWords,
  hashDrawInput,
  permutationOf,
  RNG_ALGORITHM,
  type RngStreamName,
} from '../src/state/rng.js'
import {
  generateSealedPlan,
  SEALED_PLAN_PROTOCOL,
  validateSealedPlan,
  verifySealedPlanDraws,
  type SealedPlanDoc,
  type SealedTrialCell,
} from '../src/sealed/plan.js'
import { scoreSealed, verdictSealed, type SealedTrialOutcome } from '../src/sealed/evaluate.js'
import { clusterBootstrapLcb } from '../src/selection/bootstrap.js'

const RUN_ID = 'sealed-plan-test'
const MASTER_SEED = 'sealed-plan-test-master-seed'
const BASELINE = 'sealed-baseline-id'
/** The pre-registered formal budget (ADR-048): 720min / ≈$33 / 460M tokens. */
const BUDGET = { wallClockMinutes: 720, usdMicros: 33_000_000, solverTokens: 460_000_000 }

const FORMAL_TASKS = Array.from(
  { length: 23 },
  (_unused, index) => `sealed-${String(index + 1).padStart(2, '0')}`,
)

function planInput(overrides: Partial<Parameters<typeof generateSealedPlan>[0]> = {}) {
  return {
    runId: RUN_ID,
    masterSeed: MASTER_SEED,
    baselineId: BASELINE,
    taskIds: FORMAL_TASKS,
    kSealed: 5,
    budget: BUDGET,
    ...overrides,
  }
}

/** Position in the canonical enumeration: task-major → attempt → side
 * (baseline first), matching the plan's pre-permutation cell order. */
function positionOf(
  plan: SealedPlanDoc,
  taskId: string,
  attempt: number,
  side: 'baseline' | 'champion',
): number {
  const task = plan.taskIds.indexOf(taskId)
  const sideOffset = side === 'baseline' ? 0 : 1
  return (task * plan.kSealed + (attempt - 1)) * 2 + sideOffset
}

/** Expected seed for a cell: first 8 hex of the 'sealed-plan' word at
 * counter `seedCounterStart + enumeration position` (ADR-048). */
function expectedSeed(plan: SealedPlanDoc, position: number): string {
  const word = drawWords({
    masterSeed: MASTER_SEED,
    runId: RUN_ID,
    stream: 'sealed-plan' as unknown as RngStreamName,
    counter: plan.seedCounterStart + position,
    words: 1,
  })[0]!
  return word.toString(16).padStart(8, '0')
}

describe('sealed plan document (ADR-048)', () => {
  it('generates the pre-registered 23×5×2 = 230-trial plan on the sealed-plan stream', () => {
    const plan = generateSealedPlan(planInput())
    expect(plan.schemaVersion).toBe(1)
    expect(plan.protocol).toBe(SEALED_PLAN_PROTOCOL)
    expect(plan.runId).toBe(RUN_ID)
    expect(plan.baselineId).toBe(BASELINE)
    expect(plan.taskCount).toBe(23)
    expect(plan.kSealed).toBe(5)
    expect(plan.taskIds).toEqual(FORMAL_TASKS)
    expect(plan.trials).toHaveLength(230)
    expect(plan.seedCounterStart).toBe(231)

    // Every (task, attempt, side) cell appears exactly once.
    const cells = new Set(
      plan.trials.map((cell) => `${cell.taskId}\0${cell.attempt}\0${cell.side}`),
    )
    expect(cells.size).toBe(230)
    for (const task of FORMAL_TASKS) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect(cells.has(`${task}\0${attempt}\0baseline`)).toBe(true)
        expect(cells.has(`${task}\0${attempt}\0champion`)).toBe(true)
      }
    }
    // Execution order is the 'sealed-plan' permutation at counter 1; the
    // receipt binds the exact input description.
    const indices = plan.trials.map((cell) => cell.index).sort((a, b) => a - b)
    expect(indices).toEqual(Array.from({ length: 230 }, (_unused, index) => index))
    expect(plan.orderReceipt.stream).toBe('sealed-plan')
    expect(plan.orderReceipt.counter).toBe(1)
    expect(plan.orderReceipt.algorithm).toBe(RNG_ALGORITHM)
    expect(plan.orderReceipt.inputHash).toBe(
      hashDrawInput({
        protocol: SEALED_PLAN_PROTOCOL,
        runId: RUN_ID,
        baselineId: BASELINE,
        taskIds: FORMAL_TASKS,
        kSealed: 5,
      }),
    )
    expect(plan.orderReceipt.result).toEqual({
      order: permutationOf({
        masterSeed: MASTER_SEED,
        runId: RUN_ID,
        stream: 'sealed-plan' as unknown as RngStreamName,
        counter: 1,
        size: 230,
      }).order,
    })
    // The pre-registered analysis defaults: 95% CI (2.5th/97.5th), ≥100k
    // resamples, lower bound at 'sealed-bootstrap' counter 0.
    expect(plan.analysis).toEqual({
      ciResamples: 100_000,
      ciPercentilePerMille: 25,
      ciUpperPercentilePerMille: 975,
      ciCounterLower: 0,
      ciCounterUpper: 1,
    })
    expect(plan.budget).toEqual(BUDGET)
    // The plan is canonical JSON: hashable byte-for-byte (the lock doc's
    // sealedPlanHash binds exactly this document).
    expect(() => canonicalHash(plan)).not.toThrow()
  })

  it('commits the master seed without revealing it', () => {
    const plan = generateSealedPlan(planInput())
    expect(plan.seedCommitment).toBe(
      createHash('sha256')
        .update(`${MASTER_SEED}||${RUN_ID}||${SEALED_PLAN_PROTOCOL}`)
        .digest('hex'),
    )
    expect(JSON.stringify(plan)).not.toContain(MASTER_SEED)
  })

  it('binds every trial seed to its cell, independent of execution order', () => {
    const plan = generateSealedPlan(planInput())
    const target: SealedTrialCell = plan.trials.find(
      (cell) => cell.taskId === 'sealed-03' && cell.attempt === 2 && cell.side === 'champion',
    )!
    const position = positionOf(plan, 'sealed-03', 2, 'champion')
    expect(target.seed).toBe(expectedSeed(plan, position))
    expect(target.seed).toMatch(/^[0-9a-f]{8}$/)
    // The cell's execution index is its enumeration position's permutation
    // slot — the seed never depends on where the cell ends up running.
    expect(target.index).toBe(plan.orderReceipt.result.order[position])
    for (const cell of plan.trials) {
      const p = positionOf(plan, cell.taskId, cell.attempt, cell.side)
      expect(cell.seed).toBe(expectedSeed(plan, p))
      expect(cell.index).toBe(plan.orderReceipt.result.order[p])
    }
  })

  it('is deterministic byte-for-byte', () => {
    expect(generateSealedPlan(planInput())).toEqual(generateSealedPlan(planInput()))
  })

  it('validateSealedPlan accepts the generated doc and returns it', () => {
    const plan = generateSealedPlan(planInput())
    expect(validateSealedPlan(structuredClone(plan))).toEqual(plan)
  })

  it('rejects structural violations fail-closed', () => {
    const plan = generateSealedPlan(planInput())
    const cases: Array<[string, (bad: SealedPlanDoc) => void]> = [
      ['protocol', (bad) => (bad.protocol = 'dsh-evolve-le/sealed-plan/v9')],
      ['schemaVersion', (bad) => (bad.schemaVersion = 2)],
      ['runId', (bad) => (bad.runId = '')],
      ['seedCommitment', (bad) => (bad.seedCommitment = 'zz')],
      ['baselineId', (bad) => (bad.baselineId = '')],
      ['taskCount', (bad) => (bad.taskCount = 22)],
      ['duplicate taskIds', (bad) => (bad.taskIds = [...bad.taskIds.slice(0, 22), 'sealed-01'])],
      ['empty taskId', (bad) => (bad.taskIds = [...bad.taskIds.slice(0, 22), ''])],
      ['kSealed zero', (bad) => (bad.kSealed = 0)],
      ['kSealed fractional', (bad) => (bad.kSealed = 2.5)],
      [
        'trial count',
        (bad) => {
          bad.trials = bad.trials.slice(0, 229)
        },
      ],
      [
        'duplicate cell',
        (bad) => {
          bad.trials = bad.trials.map((cell, index) =>
            index === 1
              ? {
                  ...cell,
                  taskId: bad.trials[0]!.taskId,
                  attempt: bad.trials[0]!.attempt,
                  side: bad.trials[0]!.side,
                }
              : cell,
          )
        },
      ],
      [
        'attempt zero',
        (bad) => {
          bad.trials = bad.trials.map((cell, index) =>
            index === 0 ? { ...cell, attempt: 0 } : cell,
          )
        },
      ],
      [
        'invalid side',
        (bad) => {
          bad.trials = bad.trials.map((cell, index) =>
            index === 0 ? { ...cell, side: 'challenger' as 'baseline' } : cell,
          )
        },
      ],
      [
        'index gap',
        (bad) => {
          bad.trials = bad.trials.map((cell, index) =>
            index === 5 ? { ...cell, index: 500 } : cell,
          )
        },
      ],
      [
        'bad seed',
        (bad) => {
          bad.trials = bad.trials.map((cell, index) =>
            index === 0 ? { ...cell, seed: 'XYZ' } : cell,
          )
        },
      ],
      ['seedCounterStart', (bad) => (bad.seedCounterStart = 999)],
      ['wallClockMinutes', (bad) => (bad.budget.wallClockMinutes = 0)],
      ['usdMicros', (bad) => (bad.budget.usdMicros = -1)],
      ['solverTokens', (bad) => (bad.budget.solverTokens = 1.5)],
      ['ciResamples', (bad) => (bad.analysis.ciResamples = 50_000)],
      ['ciPercentilePerMille', (bad) => (bad.analysis.ciPercentilePerMille = 0)],
      ['ciUpperPercentilePerMille', (bad) => (bad.analysis.ciUpperPercentilePerMille = 1000)],
      [
        'ci bounds ordered',
        (bad) => {
          bad.analysis.ciPercentilePerMille = 600
          bad.analysis.ciUpperPercentilePerMille = 500
        },
      ],
      ['orderReceipt stream', (bad) => (bad.orderReceipt.stream = 'bootstrap')],
      ['orderReceipt counter', (bad) => (bad.orderReceipt.counter = 0)],
      ['orderReceipt algorithm', (bad) => (bad.orderReceipt.algorithm = 'other')],
      ['orderReceipt inputHash', (bad) => (bad.orderReceipt.inputHash = 'ab'.repeat(32))],
      [
        'orderReceipt result',
        (bad) =>
          (bad.orderReceipt.result = { order: bad.orderReceipt.result.order.slice().reverse() }),
      ],
    ]
    for (const [name, tamper] of cases) {
      const bad = structuredClone(plan)
      tamper(bad as SealedPlanDoc)
      expect(() => validateSealedPlan(bad), name).toThrow()
    }
  })

  it('verifySealedPlanDraws re-derives permutation and seeds; tampering fails closed', () => {
    const plan = generateSealedPlan(planInput())
    expect(() => verifySealedPlanDraws(plan, MASTER_SEED)).not.toThrow()

    // Wrong seed: the commitment binding breaks first.
    expect(() => verifySealedPlanDraws(plan, 'another-master-seed')).toThrow()

    const badCommitment = structuredClone(plan)
    badCommitment.seedCommitment = '00'.repeat(32)
    expect(() => verifySealedPlanDraws(badCommitment, MASTER_SEED)).toThrow()

    const badRaw = structuredClone(plan)
    badRaw.orderReceipt.raw = [1, 2, 3]
    expect(() => verifySealedPlanDraws(badRaw, MASTER_SEED)).toThrow()

    const badOrder = structuredClone(plan)
    badOrder.orderReceipt.result = { order: badOrder.orderReceipt.result.order.slice().reverse() }
    expect(() => verifySealedPlanDraws(badOrder, MASTER_SEED)).toThrow()

    const badTrialSeed = structuredClone(plan)
    badTrialSeed.trials = badTrialSeed.trials.map((cell, index) =>
      index === 0 ? { ...cell, seed: 'deadbeef' } : cell,
    )
    expect(() => verifySealedPlanDraws(badTrialSeed, MASTER_SEED)).toThrow()
  })
})

describe('sealed scoring (ADR-048)', () => {
  const TASKS = ['sealed-01', 'sealed-02', 'sealed-03', 'sealed-04']
  const plan = generateSealedPlan(planInput({ taskIds: TASKS, kSealed: 3, budget: BUDGET }))

  /** Outcome rows for the whole plan: per (task, side), the first
   * `successes` attempts succeed and the rest fail. */
  function outcomesFor(
    successes: Record<string, { baseline: number; champion: number }>,
  ): SealedTrialOutcome[] {
    return plan.trials.map((cell) => {
      const count = successes[cell.taskId]![cell.side]
      const outcome = cell.attempt <= count ? 'success' : 'failure'
      return { index: cell.index, outcome, costUsdMicros: 1000, durationMs: 30_000 }
    })
  }

  it('scores paired deltas with the 95% cluster CI on the sealed-bootstrap stream', () => {
    const score = scoreSealed({
      plan,
      masterSeed: MASTER_SEED,
      outcomes: outcomesFor({
        'sealed-01': { baseline: 0, champion: 3 },
        'sealed-02': { baseline: 0, champion: 3 },
        'sealed-03': { baseline: 1, champion: 2 },
        'sealed-04': { baseline: 3, champion: 0 },
      }),
    })
    expect(score.taskCount).toBe(4)
    expect(score.plannedTrials).toBe(24)
    expect(score.completeness).toBe(1)
    expect(score.missingTrials).toBe(0)
    expect(score.perTask.map((row) => row.taskId)).toEqual(TASKS)
    expect(score.perTask.map((row) => row.baselinePass)).toEqual([0, 0, 1, 3])
    expect(score.perTask.map((row) => row.championPass)).toEqual([3, 3, 2, 0])
    expect(score.perTask.map((row) => row.delta)).toEqual([1, 1, 1 / 3, -1])
    // Delta = (1/23)Σ d_i in the formal plan; here (1 + 1 + 1/3 − 1)/4 = 1/3.
    expect(score.delta).toBeCloseTo(1 / 3, 12)
    expect(score.improved).toBe(3)
    expect(score.tied).toBe(0)
    expect(score.regressed).toBe(1)
    expect(score.ciLower).toBeLessThanOrEqual(score.delta)
    expect(score.ciUpper).toBeGreaterThanOrEqual(score.delta)
    expect(score.ciReceiptLower.stream).toBe('sealed-bootstrap')
    expect(score.ciReceiptLower.counter).toBe(0)
    expect(score.ciReceiptLower.result).toMatchObject({ percentilePerMille: 25 })
    expect(score.ciReceiptUpper.stream).toBe('sealed-bootstrap')
    expect(score.ciReceiptUpper.counter).toBe(1)
    expect(score.ciReceiptUpper.result).toMatchObject({ percentilePerMille: 975 })
  })

  it('collapses to the point estimate when every task delta is equal', () => {
    const score = scoreSealed({
      plan,
      masterSeed: MASTER_SEED,
      outcomes: outcomesFor({
        'sealed-01': { baseline: 0, champion: 3 },
        'sealed-02': { baseline: 0, champion: 3 },
        'sealed-03': { baseline: 0, champion: 3 },
        'sealed-04': { baseline: 0, champion: 3 },
      }),
    })
    expect(score.delta).toBe(1)
    expect(score.ciLower).toBe(1)
    expect(score.ciUpper).toBe(1)
  })

  it('missing rows fail the trial and dent completeness; timeouts execute but fail', () => {
    const outcomes = outcomesFor({
      'sealed-01': { baseline: 0, champion: 3 },
      'sealed-02': { baseline: 0, champion: 3 },
      'sealed-03': { baseline: 0, champion: 3 },
      'sealed-04': { baseline: 0, champion: 3 },
    })
    outcomes[0] = {
      index: outcomes[0]!.index,
      outcome: 'missing',
      costUsdMicros: 0,
      durationMs: null,
    }
    outcomes[1] = {
      index: outcomes[1]!.index,
      outcome: 'timeout',
      costUsdMicros: 1000,
      durationMs: 90_000,
    }
    const score = scoreSealed({ plan, masterSeed: MASTER_SEED, outcomes })
    expect(score.completeness).toBe(22 / 24)
    expect(score.missingTrials).toBe(1)
    // Neither missing nor timeout counts as a pass on its cell. The fixture
    // baseline never passes sealed-01, and the champion loses only its a1
    // (timeout): delta 2/3 there, 1 on the other three tasks.
    const first = score.perTask.find((row) => row.taskId === 'sealed-01')!
    expect(first.championPass).toBe(2)
    expect(score.delta).toBe((1 + 1 + 1 + 2 / 3) / 4)
  })

  it('fails closed on gaps, duplicates, unknown indices, bad kinds, and bad costs', () => {
    const good = outcomesFor({
      'sealed-01': { baseline: 0, champion: 3 },
      'sealed-02': { baseline: 0, champion: 3 },
      'sealed-03': { baseline: 0, champion: 3 },
      'sealed-04': { baseline: 0, champion: 3 },
    })
    expect(() =>
      scoreSealed({ plan, masterSeed: MASTER_SEED, outcomes: good.slice(0, 23) }),
    ).toThrow()
    expect(() =>
      scoreSealed({
        plan,
        masterSeed: MASTER_SEED,
        outcomes: [...good, { ...good[0]!, index: 24 }],
      }),
    ).toThrow()
    expect(() =>
      scoreSealed({
        plan,
        masterSeed: MASTER_SEED,
        outcomes: good.map((row, index) => (index === 1 ? { ...row, index: 0 } : row)),
      }),
    ).toThrow()
    expect(() =>
      scoreSealed({
        plan,
        masterSeed: MASTER_SEED,
        outcomes: good.map((row, index) =>
          index === 0 ? { ...row, outcome: 'exploded' as 'success' } : row,
        ),
      }),
    ).toThrow()
    expect(() =>
      scoreSealed({
        plan,
        masterSeed: MASTER_SEED,
        outcomes: good.map((row, index) => (index === 0 ? { ...row, costUsdMicros: 0.5 } : row)),
      }),
    ).toThrow()
  })
})

describe('sealed verdict (ADR-048)', () => {
  it('applies the four pre-registered gates', () => {
    expect(verdictSealed({ delta: 0.1, ciLower: 0.02, completeness: 1, criticalFindings: 0 })).toBe(
      'SEALED_PROMOTED',
    )
    // Delta exactly at the +5pp gate still passes it.
    expect(
      verdictSealed({ delta: 0.05, ciLower: 0.03, completeness: 1, criticalFindings: 0 }),
    ).toBe('SEALED_PROMOTED')
    // CI crossing zero (including exactly zero) is promising, not confirmed.
    expect(
      verdictSealed({ delta: 0.1, ciLower: -0.01, completeness: 1, criticalFindings: 0 }),
    ).toBe('PROMISING_NOT_CONFIRMED')
    expect(verdictSealed({ delta: 0.1, ciLower: 0, completeness: 1, criticalFindings: 0 })).toBe(
      'PROMISING_NOT_CONFIRMED',
    )
    // Below the +5pp gate.
    expect(
      verdictSealed({ delta: 0.049, ciLower: 0.02, completeness: 1, criticalFindings: 0 }),
    ).toBe('SEALED_REJECTED')
    // A critical finding rejects even an otherwise passing estimate.
    expect(verdictSealed({ delta: 0.1, ciLower: 0.02, completeness: 1, criticalFindings: 1 })).toBe(
      'SEALED_REJECTED',
    )
    // An incomplete evaluation cannot promote (rule 7: missing → failure).
    expect(
      verdictSealed({ delta: 0.1, ciLower: 0.02, completeness: 0.9, criticalFindings: 0 }),
    ).toBe('SEALED_REJECTED')
  })
})

describe('cluster bootstrap for the sealed CI (ADR-048)', () => {
  const sealedStream = { stream: 'sealed-bootstrap' as unknown as RngStreamName }

  it('supports an exact fractional percentile on a dedicated stream', () => {
    const result = clusterBootstrapLcb({
      masterSeed: MASTER_SEED,
      runId: RUN_ID,
      counter: 0,
      deltas: [1, 1, 1],
      resamples: 100_000,
      ...sealedStream,
      percentileExact: 2.5,
    })
    expect(result.lcb).toBe(1)
    expect(result.receipt.stream).toBe('sealed-bootstrap')
    expect(result.receipt.counter).toBe(0)
    expect(result.receipt.result).toMatchObject({ percentilePerMille: 25 })
    // The input hash binds the stream and the percentile in its canonical
    // per-mille form (journal payloads are safe integers only).
    expect(result.receipt.inputHash).toBe(
      hashDrawInput({
        stream: 'sealed-bootstrap',
        clusters: 3,
        deltas: [1, 1, 1],
        resamples: 100_000,
        percentilePerMille: 25,
      }),
    )
  })

  it('interpolates between ranks for the fractional percentile', () => {
    // Uniform [0, 1]: ~25% of resample means are exactly 0, so the 2.5th
    // percentile is exactly 0; the 97.5th is exactly 1.
    const lower = clusterBootstrapLcb({
      masterSeed: MASTER_SEED,
      runId: RUN_ID,
      counter: 0,
      deltas: [0, 1],
      resamples: 100_000,
      ...sealedStream,
      percentileExact: 2.5,
    })
    const upper = clusterBootstrapLcb({
      masterSeed: MASTER_SEED,
      runId: RUN_ID,
      counter: 1,
      deltas: [0, 1],
      resamples: 100_000,
      ...sealedStream,
      percentileExact: 97.5,
    })
    expect(lower.lcb).toBe(0)
    expect(upper.lcb).toBe(1)
  })

  it('rejects contradictory or out-of-range percentile inputs', () => {
    expect(() =>
      clusterBootstrapLcb({
        masterSeed: MASTER_SEED,
        runId: RUN_ID,
        counter: 0,
        deltas: [1, 1],
        resamples: 100_000,
        ...sealedStream,
        percentile: 10,
        percentileExact: 2.5,
      }),
    ).toThrow()
    expect(() =>
      clusterBootstrapLcb({
        masterSeed: MASTER_SEED,
        runId: RUN_ID,
        counter: 0,
        deltas: [1, 1],
        resamples: 100_000,
        ...sealedStream,
        percentileExact: 0,
      }),
    ).toThrow()
    expect(() =>
      clusterBootstrapLcb({
        masterSeed: MASTER_SEED,
        runId: RUN_ID,
        counter: 0,
        deltas: [1, 1],
        resamples: 100_000,
        ...sealedStream,
        percentileExact: 100,
      }),
    ).toThrow()
  })
})
