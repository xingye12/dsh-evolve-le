/**
 * UCB-Air expand-versus-evaluate decision (specs/03 §7).
 *
 * Expansion is chosen iff the admitted count is still below the target `K`
 * and `(N + P_eval)^alpha >= T`, where `N` counts completed ordinary
 * development trials that entered utility, `P_eval` counts the current wave's
 * reserved evaluations, and `T` counts admitted candidates (baseline
 * included) plus the current wave's unique pending-children upper bound.
 * Proposal attempts are a separate counter and never enter `N`; `alpha` is
 * frozen at 0.6 for the run and its off-by-one semantics are pinned by tests.
 * @module @dsh-evolve-le/core/selection/ucbair
 */

export const UCB_AIR_ALPHA = 0.6

export interface UcbAirInput {
  /** Completed ordinary development trials counted into utility. */
  completedTrials: number
  /** Evaluations already reserved in the current wave (pending). */
  pendingEvaluations: number
  /** Admitted candidates including the baseline, plus pending children. */
  admittedCandidates: number
  /** Target admitted non-baseline candidates for the run. */
  kTarget: number
  /** Frozen for the run (specs/03 §2); defaults to 0.6. */
  alpha?: number
}

export function shouldExpand(input: UcbAirInput): boolean {
  if (input.kTarget < 1)
    throw new Error(`ucbair: kTarget must be >= 1, got ${String(input.kTarget)}`)
  const alpha = input.alpha ?? UCB_AIR_ALPHA
  if (input.completedTrials < 0 || input.pendingEvaluations < 0 || input.admittedCandidates < 1) {
    throw new Error('ucbair: counters must be non-negative and T >= 1 (baseline admitted)')
  }
  if (input.admittedCandidates >= input.kTarget + 1) {
    // K counts non-baseline candidates; baseline + K children is the ceiling.
    return false
  }
  return (input.completedTrials + input.pendingEvaluations) ** alpha >= input.admittedCandidates
}
