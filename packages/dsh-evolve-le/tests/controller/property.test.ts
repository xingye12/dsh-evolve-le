/**
 * Gate 3 property tests (specs/07 §5 acceptance): randomized crash/resume
 * chains over the real controller. A seeded PRNG picks each crash boundary in
 * sequence; every chain must converge to EXACTLY the state a clean run of the
 * same scripted world produces — same state hash, same external-effect count,
 * same budget arithmetic — no matter where the crashes landed.
 *
 * In-process crashes emulate process death by dropping the writer lock file
 * (a dead process's lock is eventually taken over by the next writer; the
 * subprocess matrix covers the real dead-pid takeover path).
 */
import { unlink } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Controller, type BoundaryPoint, type RunStatus } from '../../src/controller/controller.js'
import { FakeProvider } from '../../src/controller/provider.js'

const BOUNDARIES: BoundaryPoint[] = [
  'intent-durable',
  'launch-before-effect',
  'launch-effect-done',
  'launch-receipt-durable',
  'terminal-observed',
  'artifact-stored',
  'action-committed',
]

class Crash extends Error {
  constructor(point: string) {
    super(`crash at ${point}`)
  }
}

/** Deterministic xorshift32 — reproducible from the seed, no library. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state
  }
}

const LIMITS = { usd: 10_000_000, 'task-trials': 1_000 }
const ESTIMATE = [
  { dimension: 'usd' as const, amount: 500_000 },
  { dimension: 'task-trials' as const, amount: 1 },
]
let tick = 0
const clock = (): string => new Date(1_700_000_000_000 + (tick += 1)).toISOString()

interface ActionSpec {
  actionId: string
  candidateId: string
  opaqueTaskId: string
  script: { outcome: 'success' | 'failure' | 'timeout'; cost: number | null }
}

function worldFor(seed: number): ActionSpec[] {
  const rng = makeRng(seed)
  const count = 2 + (rng() % 4)
  return Array.from({ length: count }, (_unused, index) => {
    const pick = rng() % 3
    const outcome = pick === 0 ? 'success' : pick === 1 ? 'failure' : 'timeout'
    return {
      actionId: `a${index + 1}`,
      candidateId: `cand-${(rng() % 2) + 1}`,
      opaqueTaskId: `task-${index + 1}`,
      script:
        outcome === 'timeout' ? { outcome, cost: null } : { outcome, cost: 50 + (rng() % 100) },
    }
  })
}

interface World {
  runDir: string
  objectsRoot: string
  provider: FakeProvider
  cleanup: () => Promise<void>
}

async function freshWorld(prefix: string, spec: ActionSpec[]): Promise<World> {
  const evidence = await mkdtemp(join(tmpdir(), prefix))
  const provider = new FakeProvider({ outcome: 'success', costUsdMicros: 100 })
  for (const action of spec) {
    provider.script(`eval-${action.actionId}`, {
      outcome: action.script.outcome,
      costUsdMicros: action.script.cost,
    })
  }
  return {
    runDir: join(evidence, 'runs', 'run-prop'),
    objectsRoot: join(evidence, 'objects'),
    provider,
    cleanup: () => rm(evidence, { recursive: true, force: true }),
  }
}

/**
 * Drive the world one pass; optionally die at `crashAt`. Returns the final
 * status when the pass completed, or null when the injected crash fired.
 */
async function runPass(
  world: World,
  spec: ActionSpec[],
  crashAt: BoundaryPoint | undefined,
): Promise<RunStatus | null> {
  let controller: Controller | null = null
  try {
    controller = await Controller.open(
      world.runDir,
      world.objectsRoot,
      {
        runId: 'run-prop',
        budgetLimits: LIMITS,
        onBoundary: (point) => {
          if (crashAt !== undefined && point === crashAt) throw new Crash(point)
        },
      },
      world.provider,
      clock,
    )
    if (controller.state.phase === 'DRAFT') await controller.changePhase('PREFLIGHT', 'prop')
    if (controller.state.phase === 'PREFLIGHT') await controller.changePhase('CALIBRATED', 'prop')
    if (controller.state.phase === 'CALIBRATED') await controller.changePhase('SEARCHING', 'prop')
    if (controller.state.waves['w1'] === undefined) {
      await controller.planWave(
        'w1',
        'dev-observed',
        spec.map((action) => action.actionId),
      )
    }
    for (const action of spec) {
      await controller.runEvaluation({
        actionId: action.actionId,
        waveId: 'w1',
        candidateId: action.candidateId,
        opaqueTaskId: action.opaqueTaskId,
        attempt: 1,
        split: 'dev-observed',
        estimate: ESTIMATE,
      })
    }
    await controller.commitWave('w1')
    const status = controller.status()
    await controller.close()
    return status
  } catch (error) {
    if (!(error instanceof Crash)) throw error
    // Emulate process death: the lock dies with the (pretend) process. The
    // journal handles stay leaked exactly like a real crash; disk state is
    // the only truth the next pass reads.
    await unlink(join(world.runDir, 'owner.lock.json')).catch(() => undefined)
    return null
  }
}

describe('seeded property: random crash chains converge to the clean state', () => {
  // Up to 10 seeds × (1 clean + ≤13 crash passes), each pass replaying the
  // whole journal with a per-event fsync — the durability contract, not
  // something to optimize away. Measured ~30 s at HEAD (ba146ac measured
  // slower), so the 30 s suite default makes this test environment-jitter
  // flaky; the property asserts convergence, never wall-clock speed.
  it('chains of random crash points reach the clean run state hash exactly', { timeout: 180_000 }, async () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const spec = worldFor(seed * 0x9e3779b9)
      const rng = makeRng(seed * 7919)

      const clean = await freshWorld('dsh-prop-clean-', spec)
      const cleanStatus = await runPass(clean, spec, undefined)
      expect(cleanStatus, `seed ${seed}: clean run did not complete`).not.toBeNull()
      await clean.cleanup()

      const crashed = await freshWorld('dsh-prop-crash-', spec)
      const chain: string[] = []
      let final: RunStatus | null = null
      for (let pass = 0; pass < 12 && final === null; pass += 1) {
        const crash = rng() % 3 === 0 ? undefined : BOUNDARIES[rng() % BOUNDARIES.length]
        if (crash !== undefined) chain.push(crash)
        final = await runPass(crashed, spec, crash)
      }
      if (final === null) {
        final = await runPass(crashed, spec, undefined)
      }

      const context = `seed ${seed} (${['clean-evt', ...chain].join(' → ')})`
      expect(final, `${context}: crash chain never completed`).not.toBeNull()
      expect(final!.stateHash, `${context}: state hash diverged`).toBe(cleanStatus!.stateHash)
      expect(final!.observationCount, `${context}: score count`).toBe(spec.length)
      expect(final!.budget['usd'], `${context}: usd totals diverged`).toEqual(
        cleanStatus!.budget['usd'],
      )
      // The external world saw exactly one launch per action across the
      // whole chain — no duplicated effect no matter where crashes landed.
      expect(crashed.provider.counters.launchEffects, context).toHaveLength(spec.length)
      await crashed.cleanup()
    }
  })
})
