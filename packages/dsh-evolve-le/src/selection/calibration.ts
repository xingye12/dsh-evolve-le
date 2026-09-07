/**
 * UCB-Air calibration preflight (specs/03 §2, ADR-042): a pure check that a
 * search envelope can structurally reach K under the frozen expansion gate
 * before any paid launch. specs/03 §2 mandates that calibration REJECT the
 * run when the minimum evaluation budget conflicts with the configured caps —
 * no alpha change, no failed-build padding, no silent profile resize.
 *
 * Frozen arithmetic (specs/03 §7 with the ADR-042 N-definition correction —
 * N counts every completed development trial: discovery + cold start +
 * ordinary):
 *
 *   minimumTrials = ceil(K^(1/alpha)) + q0 × shortlistSize
 *
 * The K-th admission fires only after N >= K^(1/alpha) (T = baseline + K−1
 * children before that expansion), and the wave snapshot may admit up to
 * shortlistSize nodes whose q0 cold starts must still be funded. With a
 * benchmark baseline (specs/04 §4.2) the driver replaces stable-demo
 * discovery with the full matrix, so the matrix bounds and the best-case pool
 * supply (every baseline task fails, each admitted candidate draws at most
 * poolSize handles) are checked here too.
 * @module @dsh-evolve-le/core/selection/calibration
 */

export interface BenchmarkBaselineBudget {
  /** Observed tasks in the frozen benchmark baseline matrix. */
  taskCount: number
  /** Baseline attempts per task (specs/04 §4.2: at least 2 for formal K=80). */
  attemptsPerTask: number
  /** Wave-scheduling batch width; a partial final batch is legal. */
  batchSize: number
}

export interface CalibrationInput {
  kTarget: number
  coldStartTrials: number
  shortlistSize: number
  /** UCB-Air exponent per-mille (600 = 0.6), frozen for the run. */
  ucbAirAlphaPerMille: number
  maxSolverTrials: number
  /** Harbor task-trial budget (must cover the whole search envelope). */
  taskTrials: number
  /** Present for benchmark profiles (specs/04 §4.2); absent for stable-demo. */
  benchmarkBaseline?: BenchmarkBaselineBudget
}

export interface CalibrationVerdict {
  ok: boolean
  /** Human-readable summary for the preflight finding detail. */
  detail: string
  problems: string[]
}

/**
 * Pure calibration verdict. Golden values (contract-tested): K=3 → final
 * gate 7, minimum 9 (inside the 15-trial stable-demo cap); K=10 → 47, 49;
 * K=80 at the frozen default alpha=0.6 → 1486, 1501 (the rejection shape
 * specs/03 §2 mandates), and at the ADR-045 formal-profile alpha=0.8 →
 * 240, 255 — inside the amended 400-trial envelope.
 */
export function calibrateSearch(input: CalibrationInput): CalibrationVerdict {
  const problems: string[] = []
  const alpha = input.ucbAirAlphaPerMille / 1000
  // FP guard: K^(1/alpha) lands on exact integers for many (K, alpha) pairs
  // and must not drift across the ceil boundary.
  const finalGate = Math.ceil(Math.pow(input.kTarget, 1 / alpha) - 1e-9)
  const minimumTrials = finalGate + input.coldStartTrials * input.shortlistSize
  if (minimumTrials > input.maxSolverTrials) {
    problems.push(
      `minimumTrials=${minimumTrials} (finalGate=${finalGate} + q0×shortlistSize=${input.coldStartTrials * input.shortlistSize}) exceeds maxSolverTrials=${input.maxSolverTrials}`,
    )
  }
  if (minimumTrials > input.taskTrials) {
    problems.push(`minimumTrials=${minimumTrials} exceeds budget.taskTrials=${input.taskTrials}`)
  }
  const baseline = input.benchmarkBaseline
  let matrixTrials = 0
  let bestCaseSupply = 0
  if (baseline !== undefined) {
    matrixTrials = baseline.taskCount * baseline.attemptsPerTask
    if (matrixTrials + input.kTarget * input.coldStartTrials > input.maxSolverTrials) {
      problems.push(
        `benchmark baseline matrix ${matrixTrials} + K×q0 ${input.kTarget * input.coldStartTrials} exceeds maxSolverTrials=${input.maxSolverTrials}`,
      )
    }
    // Best-case pool supply: every baseline task fails → the largest pool the
    // matrix can produce, each admitted candidate drawing at most poolSize
    // handles (cold starts included). Even that must fund the gate.
    bestCaseSupply = matrixTrials + input.kTarget * baseline.taskCount
    if (bestCaseSupply < minimumTrials) {
      problems.push(
        `best-case pool supply ${bestCaseSupply} < minimumTrials ${minimumTrials}: the benchmark baseline cannot fund the final expansion gate`,
      )
    }
  }
  const baselineDetail =
    baseline === undefined
      ? 'discovery=stable-demo'
      : `baseline taskCount=${baseline.taskCount} attemptsPerTask=${baseline.attemptsPerTask} batchSize=${baseline.batchSize} matrix=${matrixTrials} bestCaseSupply=${bestCaseSupply}`
  return {
    ok: problems.length === 0,
    detail:
      `K=${input.kTarget} alpha=${alpha} finalGate=${finalGate} ` +
      `minimumTrials=${minimumTrials} maxSolverTrials=${input.maxSolverTrials} ` +
      `taskTrials=${input.taskTrials} ${baselineDetail}`,
    problems,
  }
}
