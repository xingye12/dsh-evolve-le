/**
 * Sealed evaluation runner (ADR-048, specs/04 §8–10): executes the
 * pre-registered sealed plan through the provider — never through the
 * controller saga — from a run root that stopped at CANDIDATE_LOCKED, and
 * discloses the verdict exactly once into the journal.
 *
 * Rules implemented here:
 * - The controller is touched at three points only: the phase gate
 *   (CANDIDATE_LOCKED or nothing), the one-shot `sealed.revealed` event, and
 *   the phase transitions SEALED_EVALUATED → PROMOTED/REJECTED. Sealed
 *   results never enter observations, the archive, or the export.
 * - Integrity failures (lock doc, plan hash, draw verification) move the
 *   phase to PROTOCOL_INVALID with no reveal and no launches. A run that is
 *   not CANDIDATE_LOCKED is refused without any journal mutation.
 * - Every trial is materialized as a 0600 row file: launched facts from
 *   `provider.collect`, budget-exhausted cells as `missing` rows (rule 7).
 *   A crash resumes from the rows — no relaunch, no re-bill.
 * - Budgets are the plan's own (wall minutes / usd / solver tokens), checked
 *   at wave granularity: an overshoot is bounded by one wave, and launched
 *   jobs are always collected.
 * @module @dsh-evolve-le/core/sealed/evaluate
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash } from '../state/canonical.js'
import { clusterBootstrapLcb, type BootstrapLcbResult } from '../selection/bootstrap.js'
import type { RngReceipt } from '../state/rng.js'
import type { ObservationOutcome } from '../state/reducer.js'
import { Controller, readRunStatus, type ControllerConfig } from '../controller/controller.js'
import type { BenchmarkProvider } from '../controller/provider.js'
import { verifySealedPlanDraws, type SealedPlanDoc, type SealedTrialCell } from './plan.js'

export const SEALED_RESULTS_PROTOCOL = 'dsh-evolve-le/sealed-results/v1'
export const SEALED_VERDICT_PROTOCOL = 'dsh-evolve-le/sealed-verdict/v1'

/** The pre-registered promotion gate (ADR-048): +5pp paired delta. */
export const SEALED_DELTA_GATE = 0.05

export type SealedVerdict = 'SEALED_PROMOTED' | 'PROMISING_NOT_CONFIRMED' | 'SEALED_REJECTED'

export interface SealedTrialOutcome {
  index: number
  outcome: ObservationOutcome
  /** Null when the provider cannot attribute cost (recorded, never free). */
  costUsdMicros: number | null
  durationMs: number | null
}

export interface SealedScore {
  taskCount: number
  plannedTrials: number
  completeness: number
  missingTrials: number
  perTask: Array<{ taskId: string; baselinePass: number; championPass: number; delta: number }>
  delta: number
  improved: number
  tied: number
  regressed: number
  ciLower: number
  ciUpper: number
  ciReceiptLower: RngReceipt
  ciReceiptUpper: RngReceipt
}

/**
 * Score the sealed plan: paired task deltas (champion − baseline passes per
 * attempt), a 95% cluster-bootstrap CI on the dedicated 'sealed-bootstrap'
 * stream (counters from the plan's analysis), and the fail-closed trial
 * population checks (gaps, duplicates, unknown indices, bad costs).
 */
export function scoreSealed(input: {
  plan: SealedPlanDoc
  masterSeed: string
  outcomes: readonly SealedTrialOutcome[]
}): SealedScore {
  const { plan } = input
  const trials = plan.trials.length
  if (input.outcomes.length !== trials) {
    throw new Error(`sealed score: expected ${trials} outcome rows, got ${input.outcomes.length}`)
  }
  const indices = input.outcomes.map((row) => row.index).sort((a, b) => a - b)
  if (!indices.every((index, position) => index === position)) {
    throw new Error('sealed score: outcome rows must cover every trial index exactly once')
  }
  const outcomesByIndex = new Map<number, SealedTrialOutcome>()
  for (const row of input.outcomes) {
    if (
      row.outcome !== 'success' &&
      row.outcome !== 'failure' &&
      row.outcome !== 'missing' &&
      row.outcome !== 'timeout'
    ) {
      throw new Error(`sealed score: unknown outcome kind ${String(row.outcome)}`)
    }
    if (
      row.costUsdMicros !== null &&
      (!Number.isSafeInteger(row.costUsdMicros) || row.costUsdMicros < 0)
    ) {
      throw new Error('sealed score: costUsdMicros must be null or a non-negative safe integer')
    }
    if (row.durationMs !== null && (!Number.isSafeInteger(row.durationMs) || row.durationMs < 0)) {
      throw new Error('sealed score: durationMs must be null or a non-negative safe integer')
    }
    outcomesByIndex.set(row.index, row)
  }

  let missingTrials = 0
  let timeoutTrials = 0
  const perTask = plan.taskIds.map((taskId) => {
    let baselinePass = 0
    let championPass = 0
    for (let attempt = 1; attempt <= plan.kSealed; attempt += 1) {
      for (const side of ['baseline', 'champion'] as const) {
        const cell = plan.trials.find(
          (candidate) =>
            candidate.taskId === taskId && candidate.attempt === attempt && candidate.side === side,
        )
        if (cell === undefined) {
          throw new Error(`sealed score: missing cell ${taskId} a${attempt} ${side}`)
        }
        const row = outcomesByIndex.get(cell.index)!
        if (row.outcome === 'missing') missingTrials += 1
        if (row.outcome === 'timeout') timeoutTrials += 1
        if (row.outcome === 'success') {
          if (side === 'baseline') baselinePass += 1
          else championPass += 1
        }
      }
    }
    return {
      taskId,
      baselinePass,
      championPass,
      delta: (championPass - baselinePass) / plan.kSealed,
    }
  })

  const deltas = perTask.map((row) => row.delta)
  const delta = deltas.reduce((sum, value) => sum + value, 0) / plan.taskCount
  // percentileExact is a percent in (0, 100): the plan's per-mille bounds
  // divide by 10 (25‰ → 2.5, 975‰ → 97.5).
  const ci = (counter: number, percentileExact: number): BootstrapLcbResult =>
    clusterBootstrapLcb({
      masterSeed: input.masterSeed,
      runId: plan.runId,
      counter,
      deltas,
      resamples: plan.analysis.ciResamples,
      stream: 'sealed-bootstrap',
      percentileExact,
    })
  const lower = ci(plan.analysis.ciCounterLower, plan.analysis.ciPercentilePerMille / 10)
  const upper = ci(plan.analysis.ciCounterUpper, plan.analysis.ciUpperPercentilePerMille / 10)

  // Protocol completeness (specs/00 §6.2): every planned trial must have a
  // clean terminal verdict — a never-run ('missing') or wall-cut ('timeout')
  // cell dents completeness; both also count as fails on their cell.
  return {
    taskCount: plan.taskCount,
    plannedTrials: trials,
    completeness: (trials - missingTrials - timeoutTrials) / trials,
    missingTrials,
    perTask,
    delta,
    improved: deltas.filter((value) => value > 0).length,
    tied: deltas.filter((value) => value === 0).length,
    regressed: deltas.filter((value) => value < 0).length,
    ciLower: lower.lcb,
    ciUpper: upper.lcb,
    ciReceiptLower: lower.receipt,
    ciReceiptUpper: upper.receipt,
  }
}

/**
 * The four pre-registered verdict gates (ADR-048): completeness 100% and no
 * critical findings, Delta ≥ +5pp, and a 95% CI lower bound strictly above
 * zero. A CI crossing zero is promising, not confirmed.
 */
export function verdictSealed(input: {
  delta: number
  ciLower: number
  completeness: number
  criticalFindings: number
}): SealedVerdict {
  if (input.completeness < 1) return 'SEALED_REJECTED'
  if (input.criticalFindings > 0) return 'SEALED_REJECTED'
  if (input.delta < SEALED_DELTA_GATE) return 'SEALED_REJECTED'
  if (input.ciLower <= 0) return 'PROMISING_NOT_CONFIRMED'
  return 'SEALED_PROMOTED'
}

export interface SealedTrialRow {
  schemaVersion: 1
  index: number
  taskId: string
  attempt: number
  side: 'baseline' | 'champion'
  seed: string
  outcome: ObservationOutcome
  costUsdMicros: number | null
  durationMs: number | null
  solverTokens?: number
  /** Budget reason a cell was never launched ('wall-budget-exhausted', …). */
  unrun?: string
}

export interface SealedResultsDoc {
  schemaVersion: 1
  protocol: typeof SEALED_RESULTS_PROTOCOL
  planHash: string
  candidateLockHash: string
  championId: string
  trials: SealedTrialRow[]
  score: SealedScore
  verdict: SealedVerdict
  criticalFindings: number
}

export interface SealedEvaluateInput {
  runRoot: string
  config: ControllerConfig
  masterSeed: string
  plan: SealedPlanDoc
  /** The lock document's `tripleHash` (ADR-047). */
  candidateLockHash: string
  /** When given, must equal the lock document's `winnerId` (fail closed). */
  championId?: string
  provider: BenchmarkProvider
  concurrency: number
  jobsRoot: string
  /** Externally attested critical findings (0 = none). */
  criticalFindings?: number
  clock?: () => string
}

export interface SealedEvaluateResult {
  verdict: SealedVerdict | 'PROTOCOL_INVALID'
  /** True once the verdict hash is journaled (this call or an earlier one). */
  revealed: boolean
  phase: string
  results: SealedResultsDoc | null
}

const SEALED_SPLIT = 'sealed' as const
const POLL_INTERVAL_MS = 5_000

function sealedKey(runId: string, index: number): string {
  return `sealed-${runId}-t${index}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writePrivate(path: string, doc: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

interface CandidateLockDoc {
  protocol: string
  runId: string
  winnerId: string
  sealedPlanHash: string
  tripleHash: string
}

async function readCandidateLock(runRoot: string): Promise<CandidateLockDoc | null> {
  const path = join(runRoot, 'candidate-lock.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(await readFile(path, 'utf8')) as CandidateLockDoc
  } catch {
    return null
  }
}

/** Run (or resume, or replay) the sealed evaluation for one run root. */
export async function sealedEvaluate(input: SealedEvaluateInput): Promise<SealedEvaluateResult> {
  const clock = input.clock ?? (() => new Date().toISOString())
  const criticalFindings = input.criticalFindings ?? 0
  if (!Number.isSafeInteger(criticalFindings) || criticalFindings < 0) {
    throw new Error('sealed-evaluate: criticalFindings must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error('sealed-evaluate: concurrency must be a positive safe integer')
  }
  // The plan must be canonical-representable to hash (floats fail closed).
  const planHash = `sha256:${canonicalHash(input.plan)}`
  const controllerDir = join(input.runRoot, 'controller')
  const resultsPath = join(input.jobsRoot, 'results.json')

  // Completed evaluation on disk → pure read-only replay: no writer lock, no
  // launches, no second reveal. (A phase still CANDIDATE_LOCKED means the
  // crash hit between writing results and the reveal — fall through.)
  if (existsSync(resultsPath)) {
    const status = await readRunStatus(controllerDir, input.config)
    if (status.phase !== 'CANDIDATE_LOCKED') {
      const recorded = JSON.parse(await readFile(resultsPath, 'utf8')) as SealedResultsDoc
      if (
        recorded.planHash !== planHash ||
        recorded.candidateLockHash !== input.candidateLockHash
      ) {
        throw new Error(
          'sealed-evaluate: recorded results do not match the input plan or lock hash (fail closed)',
        )
      }
      return { verdict: recorded.verdict, revealed: true, phase: status.phase, results: recorded }
    }
  }

  const controller = await Controller.open(
    controllerDir,
    join(input.runRoot, 'objects'),
    input.config,
    input.provider,
    clock,
  )
  try {
    if (controller.state.phase !== 'CANDIDATE_LOCKED') {
      throw new Error(
        `sealed-evaluate: run phase is ${controller.state.phase}, not CANDIDATE_LOCKED — sealed evaluation starts only from the champion lock`,
      )
    }

    // Integrity gates — all before any external effect. A failure here is a
    // protocol violation: phase moves to PROTOCOL_INVALID, nothing reveals,
    // nothing launches.
    const failClosed = async (reason: string): Promise<SealedEvaluateResult> => {
      await controller.changePhase('PROTOCOL_INVALID', `sealed integrity: ${reason}`)
      return {
        verdict: 'PROTOCOL_INVALID',
        revealed: false,
        phase: controller.state.phase,
        results: null,
      }
    }
    const lock = await readCandidateLock(input.runRoot)
    if (lock === null) return failClosed('candidate-lock.json missing or unreadable')
    if (lock.protocol !== 'dsh-evolve-le/candidate-lock/v1') {
      return failClosed('candidate-lock.json has an unknown protocol')
    }
    if (lock.runId !== input.config.runId) {
      return failClosed('candidate-lock.json names a different run')
    }
    if (lock.tripleHash !== input.candidateLockHash) {
      return failClosed('candidate-lock tripleHash does not match the given hash')
    }
    if (input.championId !== undefined && lock.winnerId !== input.championId) {
      return failClosed('champion id does not match the lock document')
    }
    if (lock.sealedPlanHash !== planHash) {
      return failClosed('sealed plan hash does not match the lock document')
    }
    try {
      verifySealedPlanDraws(input.plan, input.masterSeed)
    } catch (error) {
      return failClosed(error instanceof Error ? error.message : String(error))
    }
    const winnerId = lock.winnerId

    // Freeze the wall anchor before the first launch; resume reuses it.
    await mkdir(input.jobsRoot, { recursive: true })
    const startPath = join(input.jobsRoot, 'sealed-start.json')
    let startedAt: string
    if (existsSync(startPath)) {
      const start = JSON.parse(await readFile(startPath, 'utf8')) as {
        runId?: string
        planHash?: string
        startedAt?: string
      }
      if (
        start.runId !== input.config.runId ||
        start.planHash !== planHash ||
        typeof start.startedAt !== 'string'
      ) {
        throw new Error(
          'sealed-evaluate: sealed-start.json does not match the input plan (fail closed)',
        )
      }
      startedAt = start.startedAt
    } else {
      startedAt = clock()
      await writePrivate(startPath, {
        schemaVersion: 1,
        runId: input.config.runId,
        planHash,
        startedAt,
        wallBudgetMinutes: input.plan.budget.wallClockMinutes,
      })
    }
    const deadlineMs = Date.parse(startedAt) + input.plan.budget.wallClockMinutes * 60_000

    // Resume from already-written rows; every row is the recorded fact.
    const rows = new Map<number, SealedTrialRow>()
    let spentUsdMicros = 0
    let spentTokens = 0
    for (const cell of input.plan.trials) {
      const rowPath = join(input.jobsRoot, `trial-${cell.index}.json`)
      if (!existsSync(rowPath)) continue
      const row = JSON.parse(await readFile(rowPath, 'utf8')) as SealedTrialRow
      if (
        row.index !== cell.index ||
        row.taskId !== cell.taskId ||
        row.attempt !== cell.attempt ||
        row.side !== cell.side ||
        row.seed !== cell.seed
      ) {
        throw new Error(
          `sealed-evaluate: trial-${cell.index}.json does not match its plan cell (fail closed)`,
        )
      }
      rows.set(cell.index, row)
      spentUsdMicros += row.costUsdMicros ?? 0
      spentTokens += row.solverTokens ?? 0
    }

    const pending = [...input.plan.trials].sort((a, b) => a.index - b.index)
    const materializeRest = async (unrun: string): Promise<void> => {
      for (const cell of pending) {
        if (rows.has(cell.index)) continue
        const row: SealedTrialRow = {
          schemaVersion: 1,
          index: cell.index,
          taskId: cell.taskId,
          attempt: cell.attempt,
          side: cell.side,
          seed: cell.seed,
          outcome: 'missing',
          costUsdMicros: 0,
          durationMs: null,
          solverTokens: 0,
          unrun,
        }
        rows.set(cell.index, row)
        await writePrivate(join(input.jobsRoot, `trial-${cell.index}.json`), row)
      }
    }

    let cursor = 0
    while (cursor < pending.length) {
      // Budget gates run before each wave: never start a wave the plan can no
      // longer afford. Launched jobs are always collected (rule 7).
      if (Date.parse(clock()) >= deadlineMs) {
        await materializeRest('wall-budget-exhausted')
        break
      }
      if (spentUsdMicros > input.plan.budget.usdMicros) {
        await materializeRest('usd-budget-exhausted')
        break
      }
      if (spentTokens > input.plan.budget.solverTokens) {
        await materializeRest('token-budget-exhausted')
        break
      }
      const wave: SealedTrialCell[] = []
      for (
        let offset = 0;
        offset < input.concurrency && cursor + offset < pending.length;
        offset += 1
      ) {
        const cell = pending[cursor + offset]!
        if (!rows.has(cell.index)) wave.push(cell)
      }
      cursor += input.concurrency
      if (wave.length === 0) continue

      const launched = await Promise.all(
        wave.map(async (cell) => {
          const { externalJobId } = await input.provider.launch(
            {
              candidateId: cell.side === 'champion' ? winnerId : input.plan.baselineId,
              opaqueTaskId: cell.taskId,
              attempt: cell.attempt,
              split: SEALED_SPLIT,
            },
            sealedKey(input.config.runId, cell.index),
          )
          for (;;) {
            const { status } = await input.provider.inspect(externalJobId)
            if (status !== 'RUNNING') return { cell, externalJobId }
            await sleep(POLL_INTERVAL_MS)
          }
        }),
      )
      for (const { cell, externalJobId } of launched) {
        const terminal = await input.provider.collect(externalJobId)
        const row: SealedTrialRow = {
          schemaVersion: 1,
          index: cell.index,
          taskId: cell.taskId,
          attempt: cell.attempt,
          side: cell.side,
          seed: cell.seed,
          outcome: terminal.outcome,
          costUsdMicros: terminal.costUsdMicros,
          durationMs: terminal.durationMs,
          solverTokens: terminal.solverTokens ?? 0,
        }
        rows.set(cell.index, row)
        await writePrivate(join(input.jobsRoot, `trial-${cell.index}.json`), row)
        spentUsdMicros += terminal.costUsdMicros ?? 0
        spentTokens += terminal.solverTokens ?? 0
      }
    }

    const sortedRows = pending.map((cell) => rows.get(cell.index)!)
    const score = scoreSealed({
      plan: input.plan,
      masterSeed: input.masterSeed,
      outcomes: sortedRows.map((row) => ({
        index: row.index,
        outcome: row.outcome,
        costUsdMicros: row.costUsdMicros,
        durationMs: row.durationMs,
      })),
    })
    const verdict = verdictSealed({
      delta: score.delta,
      ciLower: score.ciLower,
      completeness: score.completeness,
      criticalFindings,
    })
    const resultsDoc: SealedResultsDoc = {
      schemaVersion: 1,
      protocol: SEALED_RESULTS_PROTOCOL,
      planHash,
      candidateLockHash: input.candidateLockHash,
      championId: winnerId,
      trials: sortedRows,
      score,
      verdict,
      criticalFindings,
    }
    // The verdict's resultsSha256 chains the per-trial rows to the verdict;
    // the journal's reveal receipt is the verdict's canonical hash.
    const resultsBytes = `${JSON.stringify(resultsDoc, null, 2)}\n`
    await writeFile(resultsPath, resultsBytes, { encoding: 'utf8', mode: 0o600 })
    const verdictDoc = {
      schemaVersion: 1,
      protocol: SEALED_VERDICT_PROTOCOL,
      runId: input.config.runId,
      planHash,
      candidateLockHash: input.candidateLockHash,
      championId: winnerId,
      verdict,
      deltaPerMille: Math.round(score.delta * 1000),
      ciLowerPerMille: Math.round(score.ciLower * 1000),
      ciUpperPerMille: Math.round(score.ciUpper * 1000),
      completenessPerMille: Math.round(score.completeness * 1000),
      criticalFindings,
      resultsSha256: createHash('sha256').update(resultsBytes).digest('hex'),
    }
    await writePrivate(join(input.jobsRoot, 'verdict.json'), verdictDoc)

    // Disclose exactly once, then move the phase per the gates. The guard
    // handles the crash-between-write-and-reveal window on a re-run.
    if (controller.state.phase === 'CANDIDATE_LOCKED') {
      if (controller.state.locks.sealedRevealed === null) {
        await controller.revealSealed({
          candidateId: winnerId,
          revealReceiptHash: canonicalHash(verdictDoc),
        })
      }
      await controller.changePhase(
        'SEALED_EVALUATED',
        `sealed evaluation concluded: verdict ${verdict}`,
      )
      if (verdict === 'SEALED_PROMOTED') {
        await controller.changePhase(
          'PROMOTED',
          'sealed verdict: delta ≥ +5pp with a strictly positive 95% CI lower bound',
        )
      } else if (verdict === 'SEALED_REJECTED') {
        await controller.changePhase('REJECTED', `sealed verdict: ${verdict}`)
      }
    }
    return {
      verdict,
      revealed: controller.state.locks.sealedRevealed !== null,
      phase: controller.state.phase,
      results: resultsDoc,
    }
  } finally {
    await controller.close()
  }
}
