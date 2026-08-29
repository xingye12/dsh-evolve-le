/**
 * Controller contract tests (Gate 3, specs/07 §5 + specs/06 §12–13):
 * single-writer exclusion, the launch-once-per-key saga, recovery of every
 * nonterminal disposition without starting new actions, wave commit by
 * reservation order, and the lock-free read-only status view.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  Controller,
  type BoundaryPoint,
  type ControllerConfig,
  type EvaluationInput,
  readRunStatus,
} from '../../src/controller/controller.js'
import { acquireWriterLock, LOCK_FILE } from '../../src/controller/lock.js'
import { FakeProvider, type ScriptedResult } from '../../src/controller/provider.js'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const LIMITS = { usd: 1_000_000, 'task-trials': 100 }
let tick = 0
const clock = (): string => new Date(1_700_000_000_000 + (tick += 1)).toISOString()

interface Fixture {
  runDir: string
  objectsRoot: string
  config: ControllerConfig
  provider: FakeProvider
}

async function fixture(prefix: string): Promise<Fixture> {
  const evidence = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(evidence)
  const runDir = join(evidence, 'runs', 'run-test')
  const objectsRoot = join(evidence, 'objects')
  return {
    runDir,
    objectsRoot,
    config: { runId: 'run-test', budgetLimits: LIMITS, segmentMaxBytes: 1 << 20 },
    provider: new FakeProvider({ outcome: 'success', costUsdMicros: 100 }),
  }
}

function evaluation(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    actionId: 'a1',
    waveId: null,
    candidateId: 'cand-1',
    opaqueTaskId: 'task-1',
    attempt: 1,
    split: 'dev-observed',
    estimate: [
      { dimension: 'usd' as const, amount: 500_000 },
      { dimension: 'task-trials' as const, amount: 1 },
    ],
    ...overrides,
  }
}

async function openSearching(fx: Fixture): Promise<Controller> {
  const controller = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
  await controller.changePhase('PREFLIGHT', 'test')
  await controller.changePhase('CALIBRATED', 'test')
  await controller.changePhase('SEARCHING', 'test')
  return controller
}

describe('single-writer lock', () => {
  it('blocks a second writer while the owner is live, then frees on release', async () => {
    const fx = await fixture('dsh-ctl-lock-')
    const controller = await Controller.open(
      fx.runDir,
      fx.objectsRoot,
      fx.config,
      fx.provider,
      clock,
    )
    // Same-process double open is rejected outright.
    await expect(
      Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock),
    ).rejects.toThrow(/already holds the lock/)
    // The read-only status view never needs the lock.
    await expect(readRunStatus(fx.runDir, fx.config)).resolves.toMatchObject({ phase: 'DRAFT' })
    await controller.close()

    // A different live owner (pid 1 under this boot) blocks takeover too.
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    await writeFile(
      join(fx.runDir, LOCK_FILE),
      `${JSON.stringify({
        token: 'other',
        pid: 1,
        bootId,
        acquiredAt: new Date().toISOString(),
        leaseMs: 60_000,
      })}\n`,
    )
    await expect(
      Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock),
    ).rejects.toThrow(/live pid/)
    // The stale-lock takeover test below covers the dead-owner path.
    await rm(join(fx.runDir, LOCK_FILE))
    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    await second.close()
  })

  it('takes over a stale lock whose owner is dead, refuses a corrupt one', async () => {
    const fx = await fixture('dsh-ctl-stale-')
    // A dead owner (pid never started under this boot is not provable, so
    // simulate a foreign boot id — the same signal takeover relies on).
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(fx.runDir, { recursive: true }).then(() =>
        writeFile(
          join(fx.runDir, LOCK_FILE),
          `${JSON.stringify({
            token: 'stale',
            pid: process.pid,
            bootId: 'an-old-boot',
            acquiredAt: new Date().toISOString(),
            leaseMs: 60_000,
          })}\n`,
        ),
      ),
    )
    const controller = await Controller.open(
      fx.runDir,
      fx.objectsRoot,
      fx.config,
      fx.provider,
      clock,
    )
    expect(controller.state.phase).toBe('DRAFT')
    await controller.close()

    // A lock file that cannot be parsed is never blindly taken.
    await writeFile(join(fx.runDir, LOCK_FILE), '{not json')
    await expect(
      Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock),
    ).rejects.toThrow(/cannot read existing|refusing blind takeover/)
  })

  it('rejects double acquisition within the same process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ctl-self-'))
    dirs.push(dir)
    const first = await acquireWriterLock(dir)
    await expect(acquireWriterLock(dir)).rejects.toThrow(/already holds the lock/)
    await first.release()
  })
})

describe('evaluation saga', () => {
  it('runs the full saga once; a repeated call adds no effect, score, or cost', async () => {
    const fx = await fixture('dsh-ctl-saga-')
    const controller = await openSearching(fx)
    const input = evaluation()
    const first = await controller.runEvaluation(input)
    expect(first).toMatchObject({ outcome: 'success', reward: 1 })
    // Resume-style replay: everything is already durable.
    const second = await controller.runEvaluation(input)
    expect(second).toEqual(first)
    // Exactly one external launch effect, one collect, one scored trial.
    expect(fx.provider.counters.launchEffects).toHaveLength(1)
    expect(fx.provider.counters.collects).toHaveLength(1)
    const status = controller.status()
    expect(status.actions).toHaveLength(1)
    expect(status.actions[0]).toMatchObject({
      actionId: 'a1',
      status: 'COMMITTED',
      externalJobId: 'job-1',
    })
    expect(status.budget['usd']).toEqual({ reserved: 0, spent: 100, unpriced: 0 })
    expect(status.budget['task-trials']).toEqual({ reserved: 0, spent: 1, unpriced: 0 })
    await controller.close()
  })

  it('settle is bounded by the reservation; refunds release the remainder', async () => {
    const fx = await fixture('dsh-ctl-bud-')
    const controller = await openSearching(fx)
    await controller.runEvaluation(evaluation({ actionId: 'a1' }))
    // 500_000 reserved, 100 spent, then the reservation remainder releases.
    expect(controller.status().budget['usd']).toEqual({ reserved: 0, spent: 100, unpriced: 0 })
    await controller.close()
  })

  it('records missing cost as unpriced usage, never zero-priced', async () => {
    const fx = await fixture('dsh-ctl-unpriced-')
    fx.provider.script('eval-a1', {
      outcome: 'timeout',
      costUsdMicros: null,
    } satisfies ScriptedResult)
    const controller = await openSearching(fx)
    const observation = await controller.runEvaluation(evaluation({ actionId: 'a1' }))
    expect(observation).toMatchObject({ outcome: 'timeout', reward: 0, costUsdMicros: null })
    expect(controller.status().budget['usd']).toEqual({ reserved: 0, spent: 0, unpriced: 1 })
    await controller.close()
  })
})

describe('recovery (specs/06 §12)', () => {
  class CrashSignal extends Error {
    constructor(point: string) {
      super(`injected crash at ${point}`)
    }
  }

  /** Drive the saga but abort (simulated crash) at the given boundary. */
  async function crashAt(fx: Fixture, point: BoundaryPoint, input: EvaluationInput): Promise<void> {
    const controller = await Controller.open(
      fx.runDir,
      fx.objectsRoot,
      {
        ...fx.config,
        onBoundary: (fired) => {
          if (fired === point) throw new CrashSignal(point)
        },
      },
      fx.provider,
      clock,
    )
    await controller.changePhase('PREFLIGHT', 'test')
    await controller.changePhase('CALIBRATED', 'test')
    await controller.changePhase('SEARCHING', 'test')
    await controller.planWave('w1', 'dev-observed', ['a1'])
    await expect(controller.runEvaluation(input)).rejects.toThrow(CrashSignal)
    // A real crash kills the process; in-test the equivalent is releasing the
    // writer lock without inventing any new events. The snapshot written by
    // close() is derived/disposable and does not alter the committed prefix.
    await controller.close()
  }

  it('resumes a crash after the intent: launch once with the same key', async () => {
    const fx = await fixture('dsh-ctl-r1-')
    await crashAt(fx, 'intent-durable', evaluation({ waveId: 'w1' }))
    // The durable state has the reservation but no launch.
    const probe = await readRunStatus(fx.runDir, fx.config)
    expect(probe.actions).toEqual([
      { actionId: 'a1', status: 'RESERVED', externalJobId: null, waveId: 'w1' },
    ])
    // Re-open: recovery does NOT launch (no new actions).
    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.recovery.inspected).toEqual([
      { actionId: 'a1', externalJobId: null, disposition: 'pending-launch' },
    ])
    expect(fx.provider.counters.launchEffects).toHaveLength(0)
    // The saga resumes; the effect happens exactly once.
    await second.runEvaluation(evaluation({ waveId: 'w1' }))
    expect(fx.provider.counters.launchEffects).toHaveLength(1)
    expect(second.state.actions['a1']?.status).toBe('COMMITTED')
    await second.commitWave('w1')
    expect(second.state.waves['w1']?.status).toBe('committed')
    await second.close()
  })

  it('resumes a crash during launch (no receipt): adopt the keyed effect', async () => {
    const fx = await fixture('dsh-ctl-r2-')
    await crashAt(fx, 'launch-effect-done', evaluation({ waveId: 'w1' }))
    // The external effect exists (job-1) but the journal has no receipt.
    expect(fx.provider.counters.launchEffects).toEqual(['job-1'])
    const probe = await readRunStatus(fx.runDir, fx.config)
    expect(probe.actions[0]).toMatchObject({ status: 'RESERVED', externalJobId: null })

    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.recovery.inspected).toEqual([
      { actionId: 'a1', externalJobId: null, disposition: 'pending-launch' },
    ])
    await second.runEvaluation(evaluation({ waveId: 'w1' }))
    // The keyed effect was adopted — no second launch.
    expect(fx.provider.counters.launchEffects).toEqual(['job-1'])
    expect(second.state.actions['a1']?.externalJobId).toBe('job-1')
    await second.close()
  })

  it('resumes a crash after the launch receipt but before terminal: collect existing', async () => {
    const fx = await fixture('dsh-ctl-r3-')
    await crashAt(fx, 'launch-receipt-durable', evaluation({ waveId: 'w1' }))
    const probe = await readRunStatus(fx.runDir, fx.config)
    expect(probe.actions[0]).toMatchObject({ status: 'RUNNING', externalJobId: 'job-1' })
    expect(fx.provider.counters.launchEffects).toHaveLength(1)
    expect(fx.provider.counters.collects).toHaveLength(0)

    // The job is already terminal externally: recovery collects and commits
    // it without any new launch effect.
    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.recovery.inspected).toEqual([
      { actionId: 'a1', externalJobId: 'job-1', disposition: 'collected' },
    ])
    expect(fx.provider.counters.launchEffects).toHaveLength(1)
    expect(second.state.actions['a1']?.status).toBe('COMMITTED')
    expect(
      second.state.observations[['cand-1', 'task-1', 'dev-observed', 1].join('\0')],
    ).toMatchObject({
      outcome: 'success',
      reward: 1,
    })
    await second.close()
  })

  it('resumes a crash after the terminal fact: no duplicate observation', async () => {
    const fx = await fixture('dsh-ctl-r3b-')
    await crashAt(fx, 'terminal-observed', evaluation({ waveId: 'w1' }))
    const probe = await readRunStatus(fx.runDir, fx.config)
    expect(probe.actions[0]).toMatchObject({ status: 'COLLECTING', externalJobId: 'job-1' })

    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.state.actions['a1']?.status).toBe('COMMITTED')
    // One collect call total across both processes.
    expect(fx.provider.counters.collects).toHaveLength(1)
    expect(Object.keys(second.state.observations)).toHaveLength(1)
    await second.close()
  })

  it('resumes a crash between collect and commit: validate the object, commit once', async () => {
    const fx = await fixture('dsh-ctl-r3c-')
    await crashAt(fx, 'artifact-stored', evaluation({ waveId: 'w1' }))
    const probe = await readRunStatus(fx.runDir, fx.config)
    expect(probe.actions[0]).toMatchObject({ status: 'COLLECTING', externalJobId: 'job-1' })

    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.state.actions['a1']?.status).toBe('COMMITTED')
    expect(Object.keys(second.state.observations)).toHaveLength(1)
    // Settled exactly once: reserve 500_000 − settle 100 → spent 100.
    expect(second.status().budget['usd']).toEqual({ reserved: 0, spent: 100, unpriced: 0 })
    await second.close()
  })

  it('resumes a crash after commit: replay, no duplicate score or cost', async () => {
    const fx = await fixture('dsh-ctl-r3d-')
    await crashAt(fx, 'action-committed', evaluation({ waveId: 'w1' }))
    const before = await readRunStatus(fx.runDir, fx.config)
    expect(before.actions[0]?.status).toBe('COMMITTED')
    expect(before.budget['usd']).toEqual({ reserved: 0, spent: 100, unpriced: 0 })

    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.recovery.inspected).toEqual([])
    // Recovery completed the wave commit (§12 step 8) — the only state change.
    expect(second.recovery.wavesCommitted).toEqual(['w1'])
    expect(second.state.actions['a1']?.status).toBe('COMMITTED')
    expect(
      second.state.observations[['cand-1', 'task-1', 'dev-observed', 1].join('\0')],
    ).toMatchObject({
      outcome: 'success',
      reward: 1,
    })
    expect(fx.provider.counters.collects).toHaveLength(1)
    expect(second.status().budget['usd']).toEqual({ reserved: 0, spent: 100, unpriced: 0 })
    await second.close()
  })

  it('records a provider-confirmed lost job as a missing trial', async () => {
    const fx = await fixture('dsh-ctl-r4-')
    fx.provider.script('eval-a1', { outcome: 'success', status: 'LOST' } satisfies ScriptedResult)
    await crashAt(fx, 'launch-receipt-durable', evaluation({ waveId: 'w1' }))
    // Recovery inspects → LOST → settleMissing: failed trial, unpriced usage.
    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.recovery.inspected).toEqual([
      { actionId: 'a1', externalJobId: 'job-1', disposition: 'lost' },
    ])
    expect(second.state.actions['a1']?.status).toBe('COMMITTED')
    expect(
      second.state.observations[['cand-1', 'task-1', 'dev-observed', 1].join('\0')],
    ).toMatchObject({
      outcome: 'missing',
      reward: 0,
    })
    expect(second.status().budget['usd']).toMatchObject({ spent: 0, unpriced: 1 })
    await second.commitWave('w1')
    await second.close()
  })

  it('commits a finished wave during recovery and verifies the state hash', async () => {
    const fx = await fixture('dsh-ctl-r5-')
    const first = await openSearching(fx)
    await first.planWave('w1', 'dev-observed', ['a1', 'a2'])
    await first.runEvaluation(evaluation({ actionId: 'a1', waveId: 'w1', opaqueTaskId: 'task-1' }))
    await first.runEvaluation(
      evaluation({ actionId: 'a2', waveId: 'w1', opaqueTaskId: 'task-2', candidateId: 'cand-2' }),
    )
    // Crash before wave commit: close without committing the wave.
    await first.close()

    const second = await Controller.open(
      fx.runDir,
      fx.objectsRoot,
      fx.config,
      new FakeProvider(),
      clock,
    )
    expect(second.recovery.wavesCommitted).toEqual(['w1'])
    expect(second.state.waves['w1']?.status).toBe('committed')
    expect(second.recovery.stateHash).toBe(second.status().stateHash)
    await second.close()
  })

  it('leaves a still-running job nonterminal and resumes it later', async () => {
    const fx = await fixture('dsh-ctl-r6-')
    fx.provider.script('eval-a1', {
      outcome: 'success',
      neverTerminal: true,
    } satisfies ScriptedResult)
    await crashAt(fx, 'launch-receipt-durable', evaluation({ waveId: 'w1' }))

    const second = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(second.recovery.inspected).toEqual([
      { actionId: 'a1', externalJobId: 'job-1', disposition: 'running' },
    ])
    expect(second.state.actions['a1']?.status).toBe('RUNNING')
    await second.close()

    // The job goes terminal later; the next recovery collects it.
    fx.provider.script('eval-a1', {
      outcome: 'failure',
      costUsdMicros: 42,
    } satisfies ScriptedResult)
    const third = await Controller.open(fx.runDir, fx.objectsRoot, fx.config, fx.provider, clock)
    expect(third.state.actions['a1']?.status).toBe('COMMITTED')
    expect(
      third.state.observations[['cand-1', 'task-1', 'dev-observed', 1].join('\0')],
    ).toMatchObject({
      outcome: 'failure',
      reward: 0,
      costUsdMicros: 42,
    })
    await third.close()
  })

  it('refuses a tampered object: recovery fails closed', async () => {
    const fx = await fixture('dsh-ctl-r7-')
    const first = await openSearching(fx)
    await first.runEvaluation(evaluation({ actionId: 'a1', waveId: null }))
    await first.close()
    // Corrupt the stored trajectory bytes.
    const { readFile, writeFile, readdir } = await import('node:fs/promises')
    const shard = join(fx.objectsRoot, 'sha256')
    const [aa] = await readdir(shard)
    const file = join(shard, aa, (await readdir(join(shard, aa)))[0])
    await writeFile(file, (await readFile(file)).subarray(1))
    await expect(
      Controller.open(fx.runDir, fx.objectsRoot, fx.config, new FakeProvider(), clock),
    ).rejects.toThrow(/digest|content|byte|size/i)
  })
})

describe('read-only status command', () => {
  it('reports artifact-backed status without taking the lock', async () => {
    const fx = await fixture('dsh-ctl-status-')
    const controller = await openSearching(fx)
    await controller.runEvaluation(evaluation({ actionId: 'a1', waveId: null }))
    const status = await readRunStatus(fx.runDir, fx.config)
    expect(status).toMatchObject({
      runId: 'run-test',
      phase: 'SEARCHING',
      reservationCounter: 1,
    })
    expect(status.actions).toEqual([
      { actionId: 'a1', status: 'COMMITTED', externalJobId: 'job-1', waveId: null },
    ])
    expect(status.budget['task-trials']).toEqual({ reserved: 0, spent: 1, unpriced: 0 })
    await controller.close()
    // Still readable after close, from the snapshot or full replay.
    const after = await readRunStatus(fx.runDir, fx.config)
    expect(after.stateHash).toBe(status.stateHash)
  })
})
