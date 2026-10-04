/**
 * Independent, non-promoting sealed confirmation runner.
 *
 * This intentionally has no Controller dependency.  It is for a fixed,
 * explicitly named challenger where the formal tournament did not create a
 * candidate lock.  It must never write a reveal event or a promotion verdict.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BenchmarkProvider } from '../controller/provider.js'
import type { ObservationOutcome } from '../state/reducer.js'
import { canonicalHash } from '../state/canonical.js'
import { scoreSealed, type SealedScore, type SealedTrialRow } from './evaluate.js'
import { verifySealedPlanDraws, type SealedPlanDoc, type SealedTrialCell } from './plan.js'

export const SEALED_CONFIRMATION_PROTOCOL = 'dsh-evolve-le/sealed-confirmation/v1'
export const SEALED_CONFIRMATION_RESULTS_PROTOCOL = 'dsh-evolve-le/sealed-confirmation-results/v1'
const POLL_INTERVAL_MS = 5_000

export interface SealedConfirmationInput {
  /** New, confirmation-only run id; it is not the parent search run id. */
  runId: string
  masterSeed: string
  plan: SealedPlanDoc
  baselineId: string
  candidateId: string
  provider: BenchmarkProvider
  jobsRoot: string
  concurrency: number
  clock?: () => string
}

export interface SealedConfirmationResultsDoc {
  schemaVersion: 1
  protocol: typeof SEALED_CONFIRMATION_RESULTS_PROTOCOL
  planHash: string
  baselineId: string
  candidateId: string
  trials: SealedTrialRow[]
  score: SealedScore
  /** Deliberately not a sealed-promotion verdict. */
  disposition: 'CONFIRMATION_COMPLETE_NO_PROMOTION'
}

function confirmationKey(runId: string, index: number): string {
  return `confirmation-${runId}-t${index}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function assertRecordedCell(row: SealedTrialRow, cell: SealedTrialCell): void {
  if (
    row.index !== cell.index ||
    row.taskId !== cell.taskId ||
    row.attempt !== cell.attempt ||
    row.side !== cell.side ||
    row.seed !== cell.seed
  ) {
    throw new Error(`sealed confirmation: trial-${cell.index}.json does not match its plan cell`)
  }
}

function missingRow(cell: SealedTrialCell, unrun: string): SealedTrialRow {
  return {
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
}

/** Execute exactly the frozen baseline/challenger plan without controller mutation. */
export async function sealedConfirm(input: SealedConfirmationInput): Promise<SealedConfirmationResultsDoc> {
  if (input.plan.runId !== input.runId || input.plan.baselineId !== input.baselineId) {
    throw new Error('sealed confirmation: manifest/plan identity mismatch')
  }
  if (input.candidateId.length === 0 || input.baselineId.length === 0) {
    throw new Error('sealed confirmation: candidate identities must be non-empty')
  }
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error('sealed confirmation: concurrency must be a positive safe integer')
  }
  verifySealedPlanDraws(input.plan, input.masterSeed)
  const clock = input.clock ?? (() => new Date().toISOString())
  const planHash = `sha256:${canonicalHash(input.plan)}`
  await mkdir(input.jobsRoot, { recursive: true })

  const manifestPath = join(input.jobsRoot, 'confirmation-manifest.json')
  const manifest = {
    schemaVersion: 1,
    protocol: SEALED_CONFIRMATION_PROTOCOL,
    runId: input.runId,
    baselineId: input.baselineId,
    candidateId: input.candidateId,
    planHash,
    promotion: false,
  }
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
  if (existsSync(manifestPath)) {
    if ((await readFile(manifestPath, 'utf8')) !== manifestText) {
      throw new Error('sealed confirmation: manifest mismatch')
    }
  } else {
    await writePrivate(manifestPath, manifest)
  }

  const startPath = join(input.jobsRoot, 'confirmation-start.json')
  let startedAt: string
  if (existsSync(startPath)) {
    const start = JSON.parse(await readFile(startPath, 'utf8')) as Record<string, unknown>
    if (start.runId !== input.runId || start.planHash !== planHash || typeof start.startedAt !== 'string') {
      throw new Error('sealed confirmation: confirmation-start.json mismatch')
    }
    startedAt = start.startedAt
  } else {
    startedAt = clock()
    await writePrivate(startPath, {
      schemaVersion: 1,
      runId: input.runId,
      planHash,
      startedAt,
      wallBudgetMinutes: input.plan.budget.wallClockMinutes,
    })
  }
  const deadlineMs = Date.parse(startedAt) + input.plan.budget.wallClockMinutes * 60_000
  if (!Number.isFinite(deadlineMs)) throw new Error('sealed confirmation: invalid start timestamp')

  const rows = new Map<number, SealedTrialRow>()
  let spentUsdMicros = 0
  let spentTokens = 0
  for (const cell of input.plan.trials) {
    const rowPath = join(input.jobsRoot, `trial-${cell.index}.json`)
    if (!existsSync(rowPath)) continue
    const row = JSON.parse(await readFile(rowPath, 'utf8')) as SealedTrialRow
    assertRecordedCell(row, cell)
    rows.set(cell.index, row)
    spentUsdMicros += row.costUsdMicros ?? 0
    spentTokens += row.solverTokens ?? 0
  }
  const pending = [...input.plan.trials].sort((a, b) => a.index - b.index)
  const materializeRest = async (unrun: string): Promise<void> => {
    for (const cell of pending) {
      if (rows.has(cell.index)) continue
      const row = missingRow(cell, unrun)
      rows.set(cell.index, row)
      await writePrivate(join(input.jobsRoot, `trial-${cell.index}.json`), row)
    }
  }

  let cursor = 0
  while (cursor < pending.length) {
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
    const wave = pending.slice(cursor, cursor + input.concurrency).filter((cell) => !rows.has(cell.index))
    cursor += input.concurrency
    if (wave.length === 0) continue
    const launched = await Promise.all(wave.map(async (cell) => {
      const key = confirmationKey(input.runId, cell.index)
      const existing = await input.provider.inspectByKey(key)
      const externalJobId = existing === null
        ? (await input.provider.launch({
            candidateId: cell.side === 'baseline' ? input.baselineId : input.candidateId,
            opaqueTaskId: cell.taskId,
            attempt: cell.attempt,
            split: 'sealed',
          }, key)).externalJobId
        : existing.externalJobId
      for (;;) {
        const { status } = await input.provider.inspect(externalJobId)
        if (status !== 'RUNNING') return { cell, externalJobId }
        await sleep(POLL_INTERVAL_MS)
      }
    }))
    for (const { cell, externalJobId } of launched) {
      const terminal = await input.provider.collect(externalJobId)
      const row: SealedTrialRow = {
        schemaVersion: 1,
        index: cell.index,
        taskId: cell.taskId,
        attempt: cell.attempt,
        side: cell.side,
        seed: cell.seed,
        outcome: terminal.outcome as ObservationOutcome,
        costUsdMicros: terminal.costUsdMicros,
        durationMs: terminal.durationMs,
        ...(terminal.solverTokens === undefined || terminal.solverTokens === null
          ? {}
          : { solverTokens: terminal.solverTokens }),
      }
      rows.set(cell.index, row)
      spentUsdMicros += row.costUsdMicros ?? 0
      spentTokens += row.solverTokens ?? 0
      await writePrivate(join(input.jobsRoot, `trial-${cell.index}.json`), row)
    }
  }
  if (rows.size !== input.plan.trials.length) await materializeRest('runner-incomplete')
  const trials = [...rows.values()].sort((a, b) => a.index - b.index)
  const score = scoreSealed({
    plan: input.plan,
    masterSeed: input.masterSeed,
    outcomes: trials.map(({ index, outcome, costUsdMicros, durationMs }) => ({ index, outcome, costUsdMicros, durationMs })),
  })
  const result: SealedConfirmationResultsDoc = {
    schemaVersion: 1,
    protocol: SEALED_CONFIRMATION_RESULTS_PROTOCOL,
    planHash,
    baselineId: input.baselineId,
    candidateId: input.candidateId,
    trials,
    score,
    disposition: 'CONFIRMATION_COMPLETE_NO_PROMOTION',
  }
  const resultsPath = join(input.jobsRoot, 'results.json')
  if (existsSync(resultsPath)) {
    const recorded = JSON.parse(await readFile(resultsPath, 'utf8')) as SealedConfirmationResultsDoc
    if (JSON.stringify(recorded) !== JSON.stringify(result)) {
      throw new Error('sealed confirmation: recorded results mismatch')
    }
  } else {
    await writePrivate(resultsPath, result)
  }
  return result
}
