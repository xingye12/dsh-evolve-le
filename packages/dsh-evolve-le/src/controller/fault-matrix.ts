/**
 * Crash-boundary matrix runner (Gate 3 acceptance, specs/06 §16 + specs/07
 * §5): for every durable saga boundary, kill a REAL controller child process
 * with SIGKILL at that boundary, resume it in a fresh process, and verify
 * from the outside — journal, budget ledger, and the provider's persisted
 * effect counters — that the run converges with
 *
 * - no duplicate external launch effect (one per action, keys distinct);
 * - no duplicate score (exactly one observation per trial identity);
 * - no duplicate cost (spent equals the priced outcomes, unpriced explicit);
 * - the same final state hash as every other boundary and a clean run.
 *
 * Shared by the vitest suite (src import) and the evidence recorder (lib
 * import), so `pnpm test` and `pnpm evidence:gate3` exercise one matrix.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BudgetTotals } from '../state/budget.js'
import { readRunStatus } from './controller.js'
import type { BoundaryPoint } from './controller.js'
import { FileProvider } from './file-provider.js'

const exec = promisify(execFile)

export const MATRIX_BOUNDARIES: BoundaryPoint[] = [
  'intent-durable',
  'launch-before-effect',
  'launch-effect-done',
  'launch-receipt-durable',
  'terminal-observed',
  'artifact-stored',
  'action-committed',
  'wave-committed',
]

/** Scripted world: a1 success ($100), a2 timeout (unpriced), a3 success. */
const OUTCOME_FLAGS = ['--outcome', 'eval-a2=timeout']

export interface MatrixCase {
  boundary: BoundaryPoint | null
  /** Every kill actually landed as SIGKILL before the resume. */
  killed: boolean[]
  resumedCleanly: boolean
  launchEffects: string[]
  duplicateLaunchEffect: boolean
  actionsCommitted: number
  observationCount: number
  duplicateScore: boolean
  waveCommitted: boolean
  usd: BudgetTotals
  taskTrials: BudgetTotals
  stateHash: string
  passed: boolean
  failures: string[]
}

export interface MatrixResult {
  cases: MatrixCase[]
  /** All cases (and the clean baseline) converged to one state hash. */
  convergedStateHash: string | null
  allPassed: boolean
}

interface ChildReport {
  phase: string
  stateHash: string
  actions: Array<{ actionId: string; status: string }>
  budget: Record<string, BudgetTotals>
  recovery: { wavesCommitted: string[] }
}

/**
 * Run one kill/resume scenario. `crashPlan` lists the boundaries to kill at,
 * one per child launch, in order; the final child always runs to completion.
 * Returns the case record with pass/fail detail for the evidence document.
 */
export async function runCase(options: {
  binPath: string
  crashPlan: BoundaryPoint[]
}): Promise<MatrixCase> {
  const { binPath, crashPlan } = options
  const evidence = await mkdtemp(join(tmpdir(), 'dsh-fault-'))
  const runDir = join(evidence, 'runs', 'run-fault')
  const objectsRoot = join(evidence, 'objects')
  const providerFile = join(evidence, 'provider.json')
  const failures: string[] = []
  const killed: boolean[] = []

  try {
    for (const crashAt of crashPlan) {
      try {
        await exec(
          process.execPath,
          [binPath, runDir, objectsRoot, providerFile, '--crash-at', crashAt, ...OUTCOME_FLAGS],
          { timeout: 60_000, maxBuffer: 1 << 20 },
        )
        killed.push(false)
      } catch (error) {
        const killedBySignal = (error as { killed?: boolean }).killed === true
        const signal = (error as { signal?: string }).signal
        if (killedBySignal || signal === 'SIGKILL') {
          killed.push(true)
        } else {
          throw error
        }
      }
    }
    // Final resume: always runs to completion.
    const { stdout } = await exec(
      process.execPath,
      [binPath, runDir, objectsRoot, providerFile, ...OUTCOME_FLAGS],
      { timeout: 60_000, maxBuffer: 1 << 20 },
    )
    const report = JSON.parse(stdout) as ChildReport

    // External world: exactly one launch effect per action, distinct jobs.
    const provider = await FileProvider.open(providerFile)
    const { launchEffects } = provider.counters()
    const duplicateLaunchEffect =
      new Set(launchEffects).size !== launchEffects.length || launchEffects.length !== 3

    // Score: one observation per trial identity, exactly three trials.
    const status = await readRunStatus(runDir, {
      runId: 'run-fault',
      budgetLimits: { usd: 1_000_000, 'task-trials': 100 },
    })
    const duplicateScore = status.observationCount !== 3
    const actionsCommitted = status.actions.filter((action) => action.status === 'COMMITTED').length
    const waveCommitted = status.waves.every((wave) => wave.status === 'committed')
    const usd = status.budget['usd'] ?? { reserved: -1, spent: -1, unpriced: -1 }
    const taskTrials = status.budget['task-trials'] ?? { reserved: -1, spent: -1, unpriced: -1 }

    if (duplicateScore) {
      failures.push(`observation count ${status.observationCount} != 3`)
    }
    if (crashPlan.length > 0 && !killed.every(Boolean)) {
      failures.push(`a scheduled crash did not kill the child: ${JSON.stringify(killed)}`)
    }
    if (duplicateLaunchEffect) {
      failures.push(`duplicate or missing launch effects: ${JSON.stringify(launchEffects)}`)
    }
    if (report.phase !== 'SEARCHING') failures.push(`final phase ${report.phase}`)
    if (actionsCommitted !== 3) failures.push(`${actionsCommitted} committed actions`)
    if (waveCommitted !== true || status.waves.length !== 1) {
      failures.push(`wave state ${JSON.stringify(status.waves)}`)
    }
    // Cost: $100 + unpriced timeout + $100, reservations fully released.
    if (usd.spent !== 200 || usd.unpriced !== 1 || usd.reserved !== 0) {
      failures.push(`usd totals ${JSON.stringify(usd)}`)
    }
    if (taskTrials.spent !== 3 || taskTrials.reserved !== 0) {
      failures.push(`trial totals ${JSON.stringify(taskTrials)}`)
    }
    // Score detail: the timeout trial scored 0, successes scored 1.
    if (report.actions.length !== 3) failures.push(`report actions ${report.actions.length}`)

    return {
      boundary: crashPlan[crashPlan.length - 1] ?? null,
      killed,
      resumedCleanly: failures.length === 0,
      launchEffects,
      duplicateLaunchEffect,
      actionsCommitted,
      observationCount: status.observationCount,
      duplicateScore,
      waveCommitted,
      usd,
      taskTrials,
      stateHash: status.stateHash,
      passed: failures.length === 0,
      failures,
    }
  } finally {
    await rm(evidence, { recursive: true, force: true })
  }
}

/**
 * The full acceptance matrix: one kill per boundary (in a fresh world each),
 * a double-kill chain, and a clean baseline — all must converge.
 */
export async function runFaultMatrix(binPath: string): Promise<MatrixResult> {
  const cases: MatrixCase[] = []
  for (const boundary of MATRIX_BOUNDARIES) {
    cases.push(await runCase({ binPath, crashPlan: [boundary] }))
  }
  cases.push(await runCase({ binPath, crashPlan: ['intent-durable', 'launch-effect-done'] }))
  const baseline = await runCase({ binPath, crashPlan: [] })
  cases.push(baseline)

  const hashes = new Set(cases.map((one) => one.stateHash))
  const convergedStateHash = hashes.size === 1 ? [...hashes][0]! : null
  const allPassed = cases.every((one) => one.passed) && convergedStateHash !== null
  return { cases, convergedStateHash, allPassed }
}
