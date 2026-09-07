/**
 * Champion-agnostic sealed evaluation plan (ADR-048, specs/04 §8–10): the
 * pre-registered document that pins every sealed trial — task, attempt, side,
 * execution order, and per-cell seed — before the champion is known, so the
 * sealed evidence can never be shaped by the search. It carries only opaque
 * `sealed-NN` task ids; the real handles live in the sealed split store and
 * only the TCB provider resolves them.
 *
 * Draws (specs/06 §9): the execution order is the `'sealed-plan'` permutation
 * at counter 1, and every cell's seed is its own counter word at
 * `seedCounterStart + enumeration position` (task-major → attempt → side,
 * baseline first). The seed counters start at `trials + 1`, and generation
 * fails closed if the order permutation ever consumed that many counters
 * (rejection draws), so the two counter ranges can never overlap.
 * @module @dsh-evolve-le/core/sealed/plan
 */

import { createHash } from 'node:crypto'
import {
  drawWords,
  hashDrawInput,
  permutationOf,
  RNG_ALGORITHM,
  validateRngReceipt,
  type RngReceipt,
} from '../state/rng.js'

export const SEALED_PLAN_PROTOCOL = 'dsh-evolve-le/sealed-plan/v1'

/** Pre-registered analysis defaults (ADR-048): 95% CI, ≥100 000 resamples. */
export const SEALED_ANALYSIS_DEFAULTS = {
  ciResamples: 100_000,
  ciPercentilePerMille: 25,
  ciUpperPercentilePerMille: 975,
  ciCounterLower: 0,
  ciCounterUpper: 1,
} as const

export interface SealedBudget {
  wallClockMinutes: number
  usdMicros: number
  solverTokens: number
}

export interface SealedTrialCell {
  /** Position in the execution permutation (0..trials-1, unique). */
  index: number
  taskId: string
  attempt: number
  side: 'baseline' | 'champion'
  /** First 8 hex of the cell's dedicated `'sealed-plan'` counter word. */
  seed: string
}

export interface SealedAnalysis {
  ciResamples: number
  ciPercentilePerMille: number
  ciUpperPercentilePerMille: number
  ciCounterLower: number
  ciCounterUpper: number
}

export interface SealedPlanDoc {
  schemaVersion: 1
  protocol: typeof SEALED_PLAN_PROTOCOL
  runId: string
  /** sha256(`${masterSeed}||${runId}||${protocol}`) — commits without revealing. */
  seedCommitment: string
  baselineId: string
  taskCount: number
  taskIds: string[]
  kSealed: number
  seedCounterStart: number
  trials: SealedTrialCell[]
  orderReceipt: RngReceipt
  analysis: SealedAnalysis
  budget: SealedBudget
}

export interface SealedPlanInput {
  runId: string
  masterSeed: string
  baselineId: string
  /** Opaque sealed task ids (sorted); the plan never sees real handles. */
  taskIds: string[]
  /** Attempts per task per side (pre-registered k_sealed = 5). */
  kSealed: number
  budget: SealedBudget
}

function validateBudgetShape(budget: SealedBudget, context: string): void {
  if (
    typeof budget !== 'object' ||
    budget === null ||
    !Number.isSafeInteger(budget.wallClockMinutes) ||
    budget.wallClockMinutes < 1
  ) {
    throw new Error(`${context}: wallClockMinutes must be a positive safe integer`)
  }
  if (!Number.isSafeInteger(budget.usdMicros) || budget.usdMicros < 0) {
    throw new Error(`${context}: usdMicros must be a non-negative safe integer`)
  }
  if (!Number.isSafeInteger(budget.solverTokens) || budget.solverTokens < 0) {
    throw new Error(`${context}: solverTokens must be a non-negative safe integer`)
  }
}

/** Enumerate a cell's position: task-major → attempt → side (baseline first). */
function positionOf(plan: SealedPlanDoc, cell: SealedTrialCell): number {
  const task = plan.taskIds.indexOf(cell.taskId)
  const sideOffset = cell.side === 'baseline' ? 0 : 1
  return (task * plan.kSealed + (cell.attempt - 1)) * 2 + sideOffset
}

/** Generate the deterministic sealed plan and self-validate it. */
export function generateSealedPlan(input: SealedPlanInput): SealedPlanDoc {
  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    throw new Error('sealed plan: runId must be a non-empty string')
  }
  if (typeof input.masterSeed !== 'string' || input.masterSeed.length === 0) {
    throw new Error('sealed plan: masterSeed must be a non-empty string')
  }
  if (typeof input.baselineId !== 'string' || input.baselineId.length === 0) {
    throw new Error('sealed plan: baselineId must be a non-empty string')
  }
  const taskIds = [...new Set(input.taskIds)]
  if (
    taskIds.length !== input.taskIds.length ||
    taskIds.length === 0 ||
    input.taskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)
  ) {
    throw new Error('sealed plan: taskIds must be unique non-empty strings')
  }
  if (!Number.isSafeInteger(input.kSealed) || input.kSealed < 1) {
    throw new Error('sealed plan: kSealed must be a positive safe integer')
  }
  validateBudgetShape(input.budget, 'sealed plan')

  const trials = taskIds.length * input.kSealed * 2
  const { order, raw } = permutationOf({
    masterSeed: input.masterSeed,
    runId: input.runId,
    stream: 'sealed-plan',
    counter: 1,
    size: trials,
  })
  // The permutation consumes at least trials−1 counters, one more per
  // rejection draw. Seeds occupy counters ≥ trials+1: fail closed rather
  // than ever let the two ranges collide (probability ~2^-32 per draw).
  if (raw.length > trials) {
    throw new Error('sealed plan: order permutation consumed counters into the seed range')
  }
  const seedCounterStart = trials + 1

  const cells: SealedTrialCell[] = []
  for (const taskId of taskIds) {
    for (let attempt = 1; attempt <= input.kSealed; attempt += 1) {
      for (const side of ['baseline', 'champion'] as const) {
        const position = cells.length
        const word = drawWords({
          masterSeed: input.masterSeed,
          runId: input.runId,
          stream: 'sealed-plan',
          counter: seedCounterStart + position,
          words: 1,
        })[0]
        if (word === undefined) throw new Error('sealed plan: seed derivation returned no word')
        cells.push({
          index: order[position]!,
          taskId,
          attempt,
          side,
          seed: word.toString(16).padStart(8, '0'),
        })
      }
    }
  }

  const plan: SealedPlanDoc = {
    schemaVersion: 1,
    protocol: SEALED_PLAN_PROTOCOL,
    runId: input.runId,
    seedCommitment: createHash('sha256')
      .update(`${input.masterSeed}||${input.runId}||${SEALED_PLAN_PROTOCOL}`)
      .digest('hex'),
    baselineId: input.baselineId,
    taskCount: taskIds.length,
    taskIds,
    kSealed: input.kSealed,
    seedCounterStart,
    trials: cells,
    orderReceipt: {
      stream: 'sealed-plan',
      counter: 1,
      algorithm: RNG_ALGORITHM,
      inputHash: hashDrawInput({
        protocol: SEALED_PLAN_PROTOCOL,
        runId: input.runId,
        baselineId: input.baselineId,
        taskIds,
        kSealed: input.kSealed,
      }),
      raw,
      result: { order },
    },
    analysis: { ...SEALED_ANALYSIS_DEFAULTS },
    budget: { ...input.budget },
  }
  return validateSealedPlan(plan)
}

/**
 * Structural validation (fail closed). Without the master seed this cannot
 * re-derive the draws, but it can prove everything the seed would have to
 * produce: the exact cell population, its bind to the order permutation, the
 * receipt-level fields, and the pre-registered analysis/budget parameters.
 */
export function validateSealedPlan(raw: unknown): SealedPlanDoc {
  const plan = raw as SealedPlanDoc
  const fail = (problem: string): never => {
    throw new Error(`sealed plan: invalid plan: ${problem}`)
  }
  if (typeof plan !== 'object' || plan === null) fail('plan must be an object')
  if (plan.protocol !== SEALED_PLAN_PROTOCOL) fail('wrong protocol')
  if (plan.schemaVersion !== 1) fail('schemaVersion must be 1')
  if (typeof plan.runId !== 'string' || plan.runId.length === 0) fail('runId must be non-empty')
  if (typeof plan.baselineId !== 'string' || plan.baselineId.length === 0) {
    fail('baselineId must be non-empty')
  }
  if (typeof plan.seedCommitment !== 'string' || !/^[0-9a-f]{64}$/.test(plan.seedCommitment)) {
    fail('seedCommitment must be 64-hex')
  }
  if (!Array.isArray(plan.taskIds) || plan.taskIds.length === 0) fail('taskIds must be non-empty')
  if (plan.taskIds.some((taskId) => typeof taskId !== 'string' || taskId.length === 0)) {
    fail('taskIds must be non-empty strings')
  }
  if (new Set(plan.taskIds).size !== plan.taskIds.length) fail('taskIds must be unique')
  if (plan.taskCount !== plan.taskIds.length) fail('taskCount must equal taskIds.length')
  if (!Number.isSafeInteger(plan.kSealed) || plan.kSealed < 1) {
    fail('kSealed must be a positive safe integer')
  }
  const trials = plan.taskCount * plan.kSealed * 2
  if (plan.seedCounterStart !== trials + 1) fail('seedCounterStart must be trials + 1')
  if (!Array.isArray(plan.trials) || plan.trials.length !== trials) {
    fail(`trial count must be ${trials}`)
  }

  let receiptProblem: string | null = null
  try {
    validateRngReceipt(plan.orderReceipt)
  } catch (error) {
    receiptProblem = error instanceof Error ? error.message : String(error)
  }
  if (receiptProblem !== null) fail(receiptProblem)
  const receipt = plan.orderReceipt as RngReceipt
  if (receipt.stream !== 'sealed-plan') fail('orderReceipt stream must be sealed-plan')
  if (receipt.counter !== 1) fail('orderReceipt counter must be 1')
  if (
    receipt.inputHash !==
    hashDrawInput({
      protocol: SEALED_PLAN_PROTOCOL,
      runId: plan.runId,
      baselineId: plan.baselineId,
      taskIds: plan.taskIds,
      kSealed: plan.kSealed,
    })
  ) {
    fail('orderReceipt inputHash does not bind the plan parameters')
  }
  const order = (receipt.result as { order?: unknown })['order']
  if (
    !Array.isArray(order) ||
    order.length !== trials ||
    ![...order]
      .sort((a, b) => (a as number) - (b as number))
      .every((value, index) => value === index)
  ) {
    fail('orderReceipt result must be a permutation of the trial range')
  }
  const orderArray = order as number[]

  const seen = new Set<string>()
  for (const cell of plan.trials) {
    const key = `${cell.taskId}\0${cell.attempt}\0${cell.side}`
    if (seen.has(key)) fail(`duplicate cell ${key}`)
    seen.add(key)
    if (!plan.taskIds.includes(cell.taskId)) fail(`unknown taskId ${String(cell.taskId)}`)
    if (!Number.isSafeInteger(cell.attempt) || cell.attempt < 1 || cell.attempt > plan.kSealed) {
      fail('cell attempt must be in 1..kSealed')
    }
    if (cell.side !== 'baseline' && cell.side !== 'champion') fail('cell side must be valid')
    if (typeof cell.seed !== 'string' || !/^[0-9a-f]{8}$/.test(cell.seed)) {
      fail('cell seed must be 8-hex')
    }
    if (!Number.isSafeInteger(cell.index) || cell.index < 0 || cell.index >= trials) {
      fail('cell index must be in the trial range')
    }
    // The cell's execution slot is its enumeration position's permutation
    // slot — any reordering of the order breaks this bind.
    if (cell.index !== orderArray[positionOf(plan, cell)]) {
      fail('cell index does not match the order permutation')
    }
  }
  if (seen.size !== trials) fail('cells do not cover the full trial population')

  if (typeof plan.analysis !== 'object' || plan.analysis === null) {
    fail('analysis must be an object')
  }
  const analysis = plan.analysis as SealedAnalysis
  if (!Number.isSafeInteger(analysis.ciResamples) || analysis.ciResamples < 100_000) {
    fail('ciResamples must be a safe integer ≥ 100000')
  }
  if (
    !Number.isSafeInteger(analysis.ciPercentilePerMille) ||
    analysis.ciPercentilePerMille < 1 ||
    analysis.ciPercentilePerMille > 500
  ) {
    fail('ciPercentilePerMille must be an integer in 1..500')
  }
  if (
    !Number.isSafeInteger(analysis.ciUpperPercentilePerMille) ||
    analysis.ciUpperPercentilePerMille < 501 ||
    analysis.ciUpperPercentilePerMille > 999
  ) {
    fail('ciUpperPercentilePerMille must be an integer in 501..999')
  }
  if (analysis.ciPercentilePerMille >= analysis.ciUpperPercentilePerMille) {
    fail('CI bounds must be ordered')
  }
  for (const counter of [analysis.ciCounterLower, analysis.ciCounterUpper]) {
    if (!Number.isSafeInteger(counter) || counter < 0) fail('CI counters must be non-negative')
  }
  try {
    validateBudgetShape(plan.budget, 'sealed plan budget')
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  return plan
}

/**
 * Re-derive every draw from the master seed and compare byte-for-byte: the
 * commitment binding, the order permutation (raw + result), and every cell
 * seed. Any mismatch fails closed before a single sealed launch.
 */
export function verifySealedPlanDraws(plan: SealedPlanDoc, masterSeed: string): void {
  validateSealedPlan(plan)
  const commitment = createHash('sha256')
    .update(`${masterSeed}||${plan.runId}||${SEALED_PLAN_PROTOCOL}`)
    .digest('hex')
  if (commitment !== plan.seedCommitment) {
    throw new Error('sealed plan: seed commitment does not match the master seed')
  }
  const { order, raw } = permutationOf({
    masterSeed,
    runId: plan.runId,
    stream: 'sealed-plan',
    counter: 1,
    size: plan.trials.length,
  })
  const receipt = plan.orderReceipt as RngReceipt
  const receiptOrder = (receipt.result as { order: number[] }).order
  if (
    raw.length !== receipt.raw.length ||
    raw.some((word, index) => word !== receipt.raw[index]) ||
    order.length !== receiptOrder.length ||
    order.some((slot, index) => slot !== receiptOrder[index])
  ) {
    throw new Error('sealed plan: order receipt does not re-derive from the master seed')
  }
  for (const cell of plan.trials) {
    const word = drawWords({
      masterSeed,
      runId: plan.runId,
      stream: 'sealed-plan',
      counter: plan.seedCounterStart + positionOf(plan, cell),
      words: 1,
    })[0]
    if (word === undefined || cell.seed !== word.toString(16).padStart(8, '0')) {
      throw new Error(
        `sealed plan: trial seed for ${cell.taskId} a${cell.attempt} does not re-derive`,
      )
    }
  }
}
