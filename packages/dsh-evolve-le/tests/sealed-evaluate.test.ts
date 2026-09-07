/**
 * Sealed evaluation runner contract tests (ADR-048, specs/04 §8–10): from a
 * REAL CHAMPION_LOCKED run root (driven by the actual iteration driver), the
 * runner executes the pre-registered sealed plan through the provider —
 * never through the controller. Results land in the 0600 sealed jobs root,
 * the controller's observations stay untouched, exactly one reveal event
 * fires, and the verdict moves the phase per the four pre-registered gates.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalHash } from '../src/state/canonical.js'
import { runSplitCeremony } from '../src/split/ceremony.js'
import { FakeProvider, type ScriptedResult } from '../src/controller/provider.js'
import { readRunStatus, type ControllerConfig } from '../src/controller/controller.js'
import {
  generateSealedPlan,
  SEALED_PLAN_PROTOCOL,
  type SealedPlanDoc,
  type SealedBudget,
} from '../src/sealed/plan.js'
import {
  sealedEvaluate,
  SEALED_RESULTS_PROTOCOL,
  SEALED_VERDICT_PROTOCOL,
  type SealedEvaluateResult,
  type SealedResultsDoc,
} from '../src/sealed/evaluate.js'
import {
  cleanupFixtureDirs,
  driverFor,
  formalRun,
  journalText,
  lockDoc,
  newRun,
  scriptBaselineTournament,
  scriptMatrixFailures,
  TOUR_COUNTS,
  TOUR_HANDLES,
} from './iteration/fixture.js'

const dirs: string[] = []
afterAll(async () => {
  await cleanupFixtureDirs()
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const K_SEALED = 3

/** Drive a real formal run to CHAMPION_LOCKED and build the sealed plan the
 * record script would have pre-registered. */
async function driveToLocked(prefix: string, planOverrides: Partial<SealedBudget> = {}) {
  const fx = await formalRun(prefix)
  const provider = new FakeProvider({ outcome: 'success' })
  const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
  scriptBaselineTournament(provider, baselineId, observed, { outcome: 'failure' })

  const store = runSplitCeremony({
    runId: fx.config.runId,
    masterSeed: fx.config.masterSeed,
    handles: TOUR_HANDLES,
    counts: TOUR_COUNTS,
  }).sealedStore
  // The plan names the OPAQUE sealed ids; sealedMap is the secret side.
  expect(Object.keys(store.sealedMap).sort()).toEqual(['sealed-01', 'sealed-02'])

  const plan = generateSealedPlan({
    runId: fx.config.runId,
    masterSeed: fx.config.masterSeed,
    baselineId,
    taskIds: Object.keys(store.sealedMap).sort(),
    kSealed: K_SEALED,
    budget: {
      wallClockMinutes: 60,
      usdMicros: 1_000_000,
      solverTokens: 0,
      ...planOverrides,
    },
  })
  const receipt = {
    protocol: SEALED_PLAN_PROTOCOL,
    path: 'sealed-plan.json' as const,
    sha256: `sha256:${canonicalHash(plan)}`,
  }
  const report = await driverFor(fx, provider, {}, receipt).drive()
  expect(report.stopReason).toBe('CHAMPION_LOCKED')
  const lock = await lockDoc(fx.runRoot)
  expect(lock.sealedPlanHash).toBe(receipt.sha256)
  return { fx, provider, store, plan, lock }
}

/** The controller config the CLI would rebuild from the frozen run config. */
function controllerConfigOf(fx: Awaited<ReturnType<typeof formalRun>>): ControllerConfig {
  return {
    runId: fx.config.runId,
    budgetLimits: {
      usd: fx.config.budget.usd,
      'proposer-tokens': fx.config.budget.proposerTokens,
      'proposal-calls': fx.config.budget.proposalCalls,
      'task-trials': fx.config.budget.taskTrials,
      'wall-clock-seconds': fx.config.budget.wallClockMinutes * 60,
    },
  }
}

/** A fake provider that records every sealed launch request. */
class RecordingProvider extends FakeProvider {
  requests: unknown[] = []
  async launch(request: unknown, idempotencyKey: string) {
    this.requests.push(request)
    return super.launch(request, idempotencyKey)
  }
}

function sealedKey(runId: string, index: number): string {
  return `sealed-${runId}-t${index}`
}

/** Script every sealed cell: champion wins, baseline fails (or vice versa). */
function scriptSealed(
  provider: FakeProvider,
  plan: SealedPlanDoc,
  runId: string,
  championResult: ScriptedResult = { outcome: 'success' },
  baselineResult: ScriptedResult = { outcome: 'failure' },
): void {
  for (const cell of plan.trials) {
    provider.script(
      sealedKey(runId, cell.index),
      cell.side === 'champion' ? championResult : baselineResult,
    )
  }
}

async function evaluate(
  fx: Awaited<ReturnType<typeof formalRun>>,
  provider: FakeProvider,
  plan: SealedPlanDoc,
  lock: Record<string, string>,
  extra: {
    candidateLockHash?: string
    championId?: string
    masterSeed?: string
    jobsRoot?: string
    clock?: () => string
    criticalFindings?: number
  } = {},
): Promise<SealedEvaluateResult> {
  const jobsRoot = extra.jobsRoot ?? (await mkdtemp(join(tmpdir(), 'dsh-sealed-jobs-')))
  dirs.push(jobsRoot)
  return sealedEvaluate({
    runRoot: fx.runRoot,
    config: controllerConfigOf(fx),
    masterSeed: extra.masterSeed ?? fx.config.masterSeed,
    plan,
    candidateLockHash: extra.candidateLockHash ?? lock.tripleHash!,
    championId: extra.championId ?? lock.winnerId!,
    provider,
    concurrency: 2,
    jobsRoot,
    ...(extra.criticalFindings !== undefined ? { criticalFindings: extra.criticalFindings } : {}),
    ...(extra.clock !== undefined ? { clock: extra.clock } : {}),
  })
}

async function resultsDoc(jobsRoot: string): Promise<SealedResultsDoc> {
  return JSON.parse(await readFile(join(jobsRoot, 'results.json'), 'utf8')) as SealedResultsDoc
}

async function verdictDoc(jobsRoot: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(jobsRoot, 'verdict.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

async function assertPrivateModes(jobsRoot: string): Promise<void> {
  for (const name of ['sealed-start.json', 'results.json', 'verdict.json']) {
    expect((await stat(join(jobsRoot, name))).mode & 0o777, name).toBe(0o600)
  }
}

describe('sealed evaluation runner (ADR-048)', () => {
  it('promotes a champion that wins every sealed cell: one reveal, observations untouched, runner-up never tested', async () => {
    const { fx, plan, lock } = await driveToLocked('dsh-sealed-promote-')
    const recording = new RecordingProvider({ outcome: 'success' })
    scriptSealed(recording, plan, fx.config.runId)
    const observationsBefore = (
      await readRunStatus(join(fx.runRoot, 'controller'), controllerConfigOf(fx))
    ).observationCount

    const result = await evaluate(fx, recording, plan, lock)
    expect(result.verdict).toBe('SEALED_PROMOTED')
    expect(result.revealed).toBe(true)
    expect(result.phase).toBe('PROMOTED')
    expect(result.results).not.toBeNull()

    // Results never enter the controller: observations, archive, and journal
    // are untouched by the 12 sealed trials.
    const status = await readRunStatus(join(fx.runRoot, 'controller'), controllerConfigOf(fx))
    expect(status.phase).toBe('PROMOTED')
    expect(status.observationCount).toBe(observationsBefore)
    const journal = await journalText(fx.runRoot)
    expect(journal).not.toContain(sealedKey(fx.config.runId, 0))
    expect(journal).not.toContain('"split":"sealed"')

    // Exactly one reveal event, and the phase chain CANDIDATE_LOCKED →
    // SEALED_EVALUATED → PROMOTED is journaled.
    expect(journal.split('"type":"sealed.revealed"').length - 1).toBe(1)
    expect(journal).toContain('"to":"SEALED_EVALUATED"')
    expect(journal).toContain('"to":"PROMOTED"')

    // The provider saw exactly the 12 planned cells: baseline + champion
    // only — no third candidate id can ever reach a sealed launch.
    expect(recording.requests).toHaveLength(12)
    const sides = new Set<string>()
    for (const request of recording.requests) {
      const req = request as {
        candidateId: string
        opaqueTaskId: string
        attempt: number
        split: string
      }
      expect(req.candidateId === lock.winnerId || req.candidateId === plan.baselineId).toBe(true)
      expect(['sealed-01', 'sealed-02']).toContain(req.opaqueTaskId)
      expect(req.split).toBe('sealed')
      expect(req.attempt).toBeGreaterThanOrEqual(1)
      expect(req.attempt).toBeLessThanOrEqual(K_SEALED)
      sides.add(req.candidateId)
    }
    expect(sides).toEqual(new Set([lock.winnerId, plan.baselineId]))
  }, 240_000)

  it('records the complete evidence chain: results doc, canonical verdict doc, reveal receipt', async () => {
    const { fx, plan, lock } = await driveToLocked('dsh-sealed-chain-')
    const provider = new FakeProvider({ outcome: 'success' })
    scriptSealed(provider, plan, fx.config.runId)

    const jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-sealed-jobs-'))
    dirs.push(jobsRoot)
    const result = await evaluate(fx, provider, plan, lock, { jobsRoot })
    expect(result.verdict).toBe('SEALED_PROMOTED')

    await assertPrivateModes(jobsRoot)
    const results = await resultsDoc(jobsRoot)
    expect(results.schemaVersion).toBe(1)
    expect(results.protocol).toBe(SEALED_RESULTS_PROTOCOL)
    expect(results.planHash).toBe(lock.sealedPlanHash)
    expect(results.candidateLockHash).toBe(lock.tripleHash)
    expect(results.championId).toBe(lock.winnerId)
    expect(results.trials).toHaveLength(12)
    expect(results.score.delta).toBe(1)
    expect(results.score.completeness).toBe(1)
    expect(results.verdict).toBe('SEALED_PROMOTED')

    // One row file per trial, each naming its cell; the start anchor freezes
    // the wall budget before any launch.
    for (const cell of plan.trials) {
      const row = JSON.parse(
        await readFile(join(jobsRoot, `trial-${cell.index}.json`), 'utf8'),
      ) as Record<string, unknown>
      expect(row).toMatchObject({
        schemaVersion: 1,
        index: cell.index,
        taskId: cell.taskId,
        attempt: cell.attempt,
        side: cell.side,
        seed: cell.seed,
        outcome: cell.side === 'champion' ? 'success' : 'failure',
      })
      expect((await stat(join(jobsRoot, `trial-${cell.index}.json`))).mode & 0o777).toBe(0o600)
    }
    const start = JSON.parse(await readFile(join(jobsRoot, 'sealed-start.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(start).toMatchObject({
      schemaVersion: 1,
      runId: fx.config.runId,
      planHash: lock.sealedPlanHash,
      wallBudgetMinutes: 60,
    })

    // The verdict doc is canonical JSON and the journal's reveal receipt is
    // exactly its hash; the results file hash chains per-trial rows to it.
    const verdict = await verdictDoc(jobsRoot)
    expect(verdict.protocol).toBe(SEALED_VERDICT_PROTOCOL)
    expect(verdict.verdict).toBe('SEALED_PROMOTED')
    expect(verdict.deltaPerMille).toBe(1000)
    expect(verdict.ciLowerPerMille).toBe(1000)
    expect(verdict.completenessPerMille).toBe(1000)
    expect(verdict.resultsSha256).toBe(
      createHash('sha256')
        .update(await readFile(join(jobsRoot, 'results.json')))
        .digest('hex'),
    )
    const receipt = canonicalHash(verdict)
    const journal = await journalText(fx.runRoot)
    expect(journal).toContain(`"revealReceiptHash":"${receipt}"`)
  }, 240_000)

  it('resumes a crashed run: pre-written rows are reused, no relaunch, no second reveal', async () => {
    const { fx, plan, lock } = await driveToLocked('dsh-sealed-resume-')
    const provider = new FakeProvider({ outcome: 'success' })
    scriptSealed(provider, plan, fx.config.runId)

    const jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-sealed-jobs-'))
    dirs.push(jobsRoot)
    // The crashed first attempt: wall anchor frozen, half the rows written.
    // The resume clock stays inside the 60-minute window (5 minutes after the
    // anchor), or the wall gate would materialize the rest instead of
    // launching it.
    const clock = (): string => '2026-09-07T00:05:00.000Z'
    await writeFile(
      join(jobsRoot, 'sealed-start.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: fx.config.runId,
          planHash: lock.sealedPlanHash,
          startedAt: clock(),
          wallBudgetMinutes: 60,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    for (const cell of plan.trials.filter((trial) => trial.index < 6)) {
      await writeFile(
        join(jobsRoot, `trial-${cell.index}.json`),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            index: cell.index,
            taskId: cell.taskId,
            attempt: cell.attempt,
            side: cell.side,
            seed: cell.seed,
            // Honest crash fiction matching the scripted outcomes below:
            // champion cells succeed, baseline cells fail, delta stays 1 no
            // matter which sides the first six execution indices carry.
            outcome: cell.side === 'champion' ? 'success' : 'failure',
            costUsdMicros: 1000,
            durationMs: 30_000,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
    }

    const launchesBefore = provider.counters.launchEffects.length
    const first = await evaluate(fx, provider, plan, lock, { jobsRoot, clock })
    expect(first.verdict).toBe('SEALED_PROMOTED')
    // Only the unwritten half launched; the pre-written rows counted.
    expect(provider.counters.launchEffects.length - launchesBefore).toBe(6)
    const results = await resultsDoc(jobsRoot)
    expect(results.trials).toHaveLength(12)
    expect(results.score.delta).toBe(1)

    // Re-invocation after the reveal is a pure read: no launches, no second
    // reveal, the same recorded verdict.
    const second = await evaluate(fx, provider, plan, lock, { jobsRoot })
    expect(second).toEqual(first)
    expect(provider.counters.launchEffects.length - launchesBefore).toBe(6)
    const journal = await journalText(fx.runRoot)
    expect(journal.split('"type":"sealed.revealed"').length - 1).toBe(1)
    const startAfter = JSON.parse(
      await readFile(join(jobsRoot, 'sealed-start.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(startAfter.startedAt).toBe(clock())
  }, 240_000)

  it('stays SEALED_EVALUATED as PROMISING_NOT_CONFIRMED when the CI crosses zero', async () => {
    const { fx, plan, lock } = await driveToLocked('dsh-sealed-pnc-')
    const provider = new FakeProvider({ outcome: 'success' })
    // Champion wins every cell of sealed-01, none of sealed-02: task deltas
    // [1, 0] → the 95% CI lower bound is 0 → not confirmed.
    for (const cell of plan.trials) {
      provider.script(sealedKey(fx.config.runId, cell.index), {
        outcome: cell.side === 'champion' && cell.taskId === 'sealed-01' ? 'success' : 'failure',
      })
    }

    const result = await evaluate(fx, provider, plan, lock)
    expect(result.verdict).toBe('PROMISING_NOT_CONFIRMED')
    expect(result.revealed).toBe(true)
    expect(result.phase).toBe('SEALED_EVALUATED')
    expect(result.results!.score.delta).toBe(0.5)
    expect(result.results!.score.ciLower).toBe(0)
    const status = await readRunStatus(join(fx.runRoot, 'controller'), controllerConfigOf(fx))
    expect(status.phase).toBe('SEALED_EVALUATED')
    const journal = await journalText(fx.runRoot)
    expect(journal).toContain('"to":"SEALED_EVALUATED"')
    expect(journal).not.toContain('"to":"PROMOTED"')
  }, 240_000)

  it('rejects when the baseline wins every paired delta (phase REJECTED, still revealed)', async () => {
    const { fx, plan, lock } = await driveToLocked('dsh-sealed-reject-')
    const provider = new FakeProvider({ outcome: 'success' })
    // Baseline wins every cell; the champion loses every cell.
    for (const cell of plan.trials) {
      provider.script(sealedKey(fx.config.runId, cell.index), {
        outcome: cell.side === 'baseline' ? 'success' : 'failure',
      })
    }

    const result = await evaluate(fx, provider, plan, lock)
    expect(result.verdict).toBe('SEALED_REJECTED')
    expect(result.revealed).toBe(true)
    expect(result.phase).toBe('REJECTED')
    // Baseline wins every pair: each task delta is -1 (rejected well before
    // the +5pp gate).
    expect(result.results!.score.delta).toBe(-1)
    const status = await readRunStatus(join(fx.runRoot, 'controller'), controllerConfigOf(fx))
    expect(status.phase).toBe('REJECTED')
    const journal = await journalText(fx.runRoot)
    expect(journal.split('"type":"sealed.revealed"').length - 1).toBe(1)
    expect(journal).toContain('"to":"REJECTED"')
  }, 240_000)

  it('rejects a critical finding even when every gate would pass', async () => {
    const { fx, plan, lock } = await driveToLocked('dsh-sealed-critical-')
    const provider = new FakeProvider({ outcome: 'success' })
    scriptSealed(provider, plan, fx.config.runId)

    const result = await evaluate(fx, provider, plan, lock, { criticalFindings: 1 })
    expect(result.verdict).toBe('SEALED_REJECTED')
    expect(result.phase).toBe('REJECTED')
    expect(result.results!.score.delta).toBe(1)
    expect(result.results!.criticalFindings).toBe(1)
  }, 240_000)

  it('fails closed to PROTOCOL_INVALID on a wrong triple hash — before any launch', async () => {
    const { fx, provider, plan, lock } = await driveToLocked('dsh-sealed-integrity-')
    const launchesBefore = provider.counters.launchEffects.length

    const result = await evaluate(fx, provider, plan, lock, {
      candidateLockHash: '0'.repeat(64),
    })
    expect(result.verdict).toBe('PROTOCOL_INVALID')
    expect(result.revealed).toBe(false)
    expect(result.results).toBeNull()
    expect(result.phase).toBe('PROTOCOL_INVALID')

    const journal = await journalText(fx.runRoot)
    expect(journal).toContain('"to":"PROTOCOL_INVALID"')
    expect(journal.split('"type":"sealed.revealed"').length - 1).toBe(0)
    expect(provider.counters.launchEffects.length).toBe(launchesBefore)
  }, 240_000)

  it('fails closed on a tampered plan (hash mismatch) and a wrong master seed (draw verification)', async () => {
    const { fx, provider, plan, lock } = await driveToLocked('dsh-sealed-tampered-')
    const launchesBefore = provider.counters.launchEffects.length
    const tampered = structuredClone(plan)
    tampered.trials = tampered.trials.map((cell, index) =>
      index === 0 ? { ...cell, seed: 'deadbeef' } : cell,
    )
    const result = await evaluate(fx, provider, tampered, lock)
    expect(result.verdict).toBe('PROTOCOL_INVALID')
    expect(result.revealed).toBe(false)
    expect(result.phase).toBe('PROTOCOL_INVALID')
    expect(provider.counters.launchEffects.length).toBe(launchesBefore)
    expect(await journalText(fx.runRoot)).not.toContain('"type":"sealed.revealed"')

    const second = await driveToLocked('dsh-sealed-wrongseed-')
    const launchesBefore2 = second.provider.counters.launchEffects.length
    const wrongSeed = await evaluate(second.fx, second.provider, second.plan, second.lock, {
      masterSeed: 'another-master-seed',
    })
    expect(wrongSeed.verdict).toBe('PROTOCOL_INVALID')
    expect(wrongSeed.revealed).toBe(false)
    expect(wrongSeed.phase).toBe('PROTOCOL_INVALID')
    expect(second.provider.counters.launchEffects.length).toBe(launchesBefore2)
    expect(await journalText(second.fx.runRoot)).not.toContain('"type":"sealed.revealed"')
  }, 240_000)

  it('records a missing lock document as PROTOCOL_INVALID without launching', async () => {
    const { fx, provider, plan, lock } = await driveToLocked('dsh-sealed-nolock-')
    await rm(join(fx.runRoot, 'candidate-lock.json'))
    const launchesBefore = provider.counters.launchEffects.length

    const result = await evaluate(fx, provider, plan, lock)
    expect(result.verdict).toBe('PROTOCOL_INVALID')
    expect(result.revealed).toBe(false)
    expect(provider.counters.launchEffects.length).toBe(launchesBefore)
    const journal = await journalText(fx.runRoot)
    expect(journal).toContain('"to":"PROTOCOL_INVALID"')
  }, 240_000)

  it('refuses to touch a run that is not CANDIDATE_LOCKED (no journal mutation)', async () => {
    // A stable-demo drive stops at K_REACHED; a fabricated lock doc + plan
    // must not move its phase.
    const fx = await newRun('dsh-sealed-notlocked-', {
      kTarget: 1,
      proposalWidth: 2,
      coldStartTrials: 3,
      maxSolverTrials: 30,
      maxConsecutiveExpansionFailures: 2,
      taskTrials: 120,
      wallClockMinutes: 2770,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
    scriptBaselineTournament(provider, baselineId, observed, { outcome: 'failure' })
    const report = await driverFor(fx, provider).drive()
    // The discovery-only drive exits early with no real failure signal and
    // never locks a champion — a lock fabricated on such a root must be
    // refused.
    expect(report.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')

    const plan = generateSealedPlan({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      baselineId,
      taskIds: ['sealed-01', 'sealed-02'],
      kSealed: K_SEALED,
      budget: { wallClockMinutes: 60, usdMicros: 1_000_000, solverTokens: 0 },
    })
    const fakeLock = {
      protocol: 'dsh-evolve-le/candidate-lock/v1',
      runId: fx.config.runId,
      winnerId: baselineId,
      sourceHash: '00'.repeat(32),
      archiveSha256: '00'.repeat(32),
      runManifestHash: fx.configHash,
      sealedPlanHash: `sha256:${canonicalHash(plan)}`,
      tripleHash: 'ab'.repeat(32),
    }
    await writeFile(
      join(fx.runRoot, 'candidate-lock.json'),
      `${JSON.stringify(fakeLock, null, 2)}\n`,
    )

    const journalBefore = await journalText(fx.runRoot)
    await expect(evaluate(fx, provider, plan, fakeLock)).rejects.toThrow(/CANDIDATE_LOCKED/)
    expect(await journalText(fx.runRoot)).toBe(journalBefore)
  }, 240_000)

  it('materializes missing rows fail-closed when the wall budget is exhausted (rule 7)', async () => {
    const { fx, provider, plan, lock } = await driveToLocked('dsh-sealed-wall-', {
      wallClockMinutes: 60,
    })
    const launchesBefore = provider.counters.launchEffects.length

    const jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-sealed-jobs-'))
    dirs.push(jobsRoot)
    // The frozen anchor predates the budget window: every trial is unrun.
    await writeFile(
      join(jobsRoot, 'sealed-start.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: fx.config.runId,
          planHash: lock.sealedPlanHash,
          startedAt: '2026-09-05T00:00:00.000Z',
          wallBudgetMinutes: 60,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )

    const result = await evaluate(fx, provider, plan, lock, {
      jobsRoot,
      clock: () => '2026-09-07T00:00:00.000Z',
    })
    expect(result.verdict).toBe('SEALED_REJECTED')
    expect(result.revealed).toBe(true)
    expect(result.phase).toBe('REJECTED')
    expect(provider.counters.launchEffects.length).toBe(launchesBefore)
    const results = await resultsDoc(jobsRoot)
    expect(results.trials).toHaveLength(12)
    expect(results.trials.every((row) => row.outcome === 'missing')).toBe(true)
    expect(results.trials.every((row) => row.unrun === 'wall-budget-exhausted')).toBe(true)
    expect(results.score.completeness).toBe(0)
    expect(results.score.delta).toBe(0)
  }, 240_000)

  it('stops launching once the usd budget is exhausted and materializes the rest', async () => {
    const { fx, provider, plan, lock } = await driveToLocked('dsh-sealed-usd-', {
      usdMicros: 500,
    })
    // 100 µUSD per trial on BOTH sides: three waves of two (600) overshoot
    // the 500 budget → 6 launches, 6 materialized-missing rows.
    scriptSealed(
      provider,
      plan,
      fx.config.runId,
      { outcome: 'success', costUsdMicros: 100, durationMs: 30_000 },
      { outcome: 'failure', costUsdMicros: 100, durationMs: 30_000 },
    )
    const launchesBefore = provider.counters.launchEffects.length

    const result = await evaluate(fx, provider, plan, lock)
    expect(result.verdict).toBe('SEALED_REJECTED')
    expect(provider.counters.launchEffects.length - launchesBefore).toBe(6)
    const results = result.results!
    expect(results.trials.filter((row) => row.unrun === 'usd-budget-exhausted')).toHaveLength(6)
    expect(results.trials.filter((row) => row.outcome === 'missing')).toHaveLength(6)
    expect(results.score.completeness).toBe(6 / 12)
  }, 240_000)
})
