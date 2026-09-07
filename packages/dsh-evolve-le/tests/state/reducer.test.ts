/**
 * Reducer contract tests (Gate 3, specs/06 §5 + specs/00 §8 + specs/03):
 * the pure fold over journal events owns phase, actions, observations,
 * waves, candidates, locks, and budget mirrors. These tests drive the REAL
 * journal+ledger (see helpers) so every folded event is byte-identical to
 * what recovery reads, then pin: legal phase/saga edges, fail-closed
 * violations, wave-synchronous commit with order-invariant state hash, and
 * seeded-property replay determinism.
 */
import { describe, expect, it } from 'vitest'
import { canonicalHash } from '../../src/state/canonical.js'
import {
  initialState,
  replayEvents,
  stateHashOf,
  waveDecisionSnapshot,
} from '../../src/state/reducer.js'
import { openScenario, runEvaluationAction, type Scenario } from './helpers.js'

const PHASE_CHAIN: Array<[string, string]> = [
  ['run.phase.changed', 'PREFLIGHT'],
  ['run.phase.changed', 'CALIBRATED'],
  ['run.phase.changed', 'SEARCHING'],
]

async function searchingScenario(prefix: string): Promise<{
  scenario: Scenario
  cleanup: () => Promise<void>
}> {
  const opened = await openScenario(prefix)
  for (const [type, to] of PHASE_CHAIN) {
    await opened.scenario.emit(type, { to, reason: 'test' })
  }
  return opened
}

async function waveOf(
  scenario: Scenario,
  input: { waveId: string; count: number; prefix?: string },
): Promise<void> {
  const prefix = input.prefix ?? input.waveId
  await scenario.emit('wave.planned', {
    waveId: input.waveId,
    split: 'dev-observed',
    members: Array.from({ length: input.count }, (_unused, index) => `${prefix}-a${index + 1}`),
  })
  for (let index = 1; index <= input.count; index += 1) {
    await runEvaluationAction(scenario, {
      actionId: `${prefix}-a${index}`,
      waveId: input.waveId,
      candidateId: `cand-${index}`,
      opaqueTaskId: `task-${index}`,
      outcome: index % 2 === 0 ? 'failure' : 'success',
    })
  }
}

describe('full saga fold', () => {
  it('walks phases, runs a wave, and records observations', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-saga-')
    await waveOf(scenario, { waveId: 'w1', count: 3 })
    const events = await scenario.state()
    const state = replayEvents(events as never, scenario.reducerConfig)
    expect(state.phase).toBe('SEARCHING')
    expect(state.reservationCounter).toBe(3)
    expect(Object.keys(state.observations)).toHaveLength(3)
    expect(state.actions['w1-a2']?.status).toBe('COMMITTED')
    expect(state.externalJobs['w1-a1']).toBe('job-w1-a1')
    expect(state.budget['usd']).toEqual({ reserved: 1_499_700, spent: 300, unpriced: 0 })
    expect(state.budget['task-trials']).toEqual({ reserved: 0, spent: 3, unpriced: 0 })
    // wave.committed needs the controller's decision snapshot.
    const wave = state.waves['w1']
    expect(wave?.status).toBe('open')
    await scenario.emit('wave.committed', {
      waveId: 'w1',
      decisionSnapshotHash: waveDecisionSnapshot(state, wave!),
    })
    const after = replayEvents((await scenario.state()) as never, scenario.reducerConfig)
    expect(after.waves['w1']?.status).toBe('committed')
    expect(stateHashOf(after)).not.toBe(stateHashOf(state))
    await scenario.close()
    await cleanup()
  })

  it('missing outcomes still count (f+), success reward only on success', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-outcome-')
    await scenario.emit('wave.planned', {
      waveId: 'w1',
      split: 'dev-observed',
      members: ['m1', 'm2'],
    })
    await runEvaluationAction(scenario, {
      actionId: 'm1',
      waveId: 'w1',
      candidateId: 'c1',
      opaqueTaskId: 't1',
      outcome: 'timeout',
    })
    await runEvaluationAction(scenario, {
      actionId: 'm2',
      waveId: 'w1',
      candidateId: 'c1',
      opaqueTaskId: 't2',
      outcome: 'missing',
    })
    const state = replayEvents((await scenario.state()) as never, scenario.reducerConfig)
    const rewards = Object.values(state.observations).map((observation) => observation.reward)
    expect(rewards).toEqual([0, 0])
    // Missing usage is unpriced, never silently zero-priced.
    expect(state.budget['usd']?.unpriced).toBe(2)
    await scenario.close()
    await cleanup()
  })
})

describe('fail-closed transitions', () => {
  it('rejects illegal phase edges and unknown phases at fold time', async () => {
    // The journal accepts any well-formed event; the reducer is where
    // semantic violations fail closed.
    const skip = await openScenario('dsh-red-phaseA-')
    await skip.scenario.emit('run.phase.changed', { to: 'SEARCHING', reason: 'skip' })
    const skipEvents = await skip.scenario.state()
    expect(() => replayEvents(skipEvents as never, skip.scenario.reducerConfig)).toThrow(
      /not a legal edge/,
    )
    await skip.scenario.close()
    await skip.cleanup()

    const repeat = await openScenario('dsh-red-phaseB-')
    await repeat.scenario.emit('run.phase.changed', { to: 'PREFLIGHT', reason: 'ok' })
    await repeat.scenario.emit('run.phase.changed', { to: 'PREFLIGHT', reason: 'again' })
    const repeatEvents = await repeat.scenario.state()
    expect(() => replayEvents(repeatEvents as never, repeat.scenario.reducerConfig)).toThrow(
      /not a legal edge/,
    )
    await repeat.scenario.close()
    await repeat.cleanup()
  })

  it('rejects saga steps out of order at fold time', async () => {
    // Launching an unknown action fails the fold by itself.
    const ghost = await searchingScenario('dsh-red-ghost-')
    await ghost.scenario.emit('action.launched', {
      actionId: 'ghost',
      externalJobId: 'j',
      provider: 'p',
    })
    const ghostEvents = await ghost.scenario.state()
    expect(() => replayEvents(ghostEvents as never, ghost.scenario.reducerConfig)).toThrow(
      /unknown action ghost/,
    )
    await ghost.scenario.close()
    await ghost.cleanup()

    // observed-terminal before launched is not a legal transition.
    const order = await searchingScenario('dsh-red-order-')
    await order.scenario.emit('wave.planned', { waveId: 'w1', split: null, members: ['a1'] })
    await order.scenario.emit('action.reserved', {
      actionId: 'a1',
      kind: 'evaluation',
      idempotencyKey: 'k1',
      request: { x: 1 },
      waveId: 'w1',
      budget: [{ dimension: 'usd', amount: 1 }],
    })
    await order.scenario.emit('action.observed-terminal', {
      actionId: 'a1',
      fact: { outcome: 'success' },
    })
    const orderEvents = await order.scenario.state()
    expect(() => replayEvents(orderEvents as never, order.scenario.reducerConfig)).toThrow(
      /cannot go RESERVED -> COLLECTING/,
    )
    await order.scenario.close()
    await order.cleanup()
  })

  it('rejects duplicate observation identity', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-dup-')
    await waveOf(scenario, { waveId: 'w1', count: 2, prefix: 'w1' })
    // Same candidate/task/split/attempt via a second action → identity clash.
    await scenario.emit('action.reserved', {
      actionId: 'w1-a3',
      kind: 'evaluation',
      idempotencyKey: 'k3',
      request: { repeat: true },
      waveId: null,
      budget: [],
    })
    await scenario.emit('action.launched', {
      actionId: 'w1-a3',
      externalJobId: 'j3',
      provider: 'p',
    })
    await scenario.emit('action.observed-terminal', { actionId: 'w1-a3', fact: {} })
    await scenario.emit('action.committed', {
      actionId: 'w1-a3',
      observation: {
        actionId: 'w1-a3',
        candidateId: 'cand-1',
        opaqueTaskId: 'task-1',
        split: 'dev-observed',
        attempt: 1,
        outcome: 'success',
        reward: 1,
        costUsdMicros: 1,
        durationMs: 1,
      },
    })
    const events = await scenario.state()
    expect(() => replayEvents(events as never, scenario.reducerConfig)).toThrow(
      /duplicate observation identity/,
    )
    await scenario.close()
    await cleanup()
  })

  it('enforces one-shot candidate lock and sealed reveal at fold time', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-lock-')
    await scenario.emit('candidate.registered', {
      candidateId: 'c1',
      sourceHash: 'a'.repeat(64),
      parentCandidateId: null,
      proposalActionId: null,
    })
    await scenario.emit('candidate.locked', { candidateId: 'c1', lockHash: 'b'.repeat(64) })
    await scenario.emit('candidate.locked', { candidateId: 'c1', lockHash: 'c'.repeat(64) })
    let events = await scenario.state()
    expect(() => replayEvents(events as never, scenario.reducerConfig)).toThrow(/one-shot/)
    await scenario.close()
    await cleanup()

    const reveal = await searchingScenario('dsh-red-reveal-')
    await reveal.scenario.emit('sealed.revealed', {
      candidateId: 'c1',
      revealReceiptHash: 'd'.repeat(64),
    })
    await reveal.scenario.emit('sealed.revealed', {
      candidateId: 'c1',
      revealReceiptHash: 'e'.repeat(64),
    })
    events = await reveal.scenario.state()
    expect(() => replayEvents(events as never, reveal.scenario.reducerConfig)).toThrow(/one-shot/)
    await reveal.scenario.close()
    await reveal.cleanup()
  })

  it('rejects wave commit with pending members or a wrong snapshot', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-wave-')
    await scenario.emit('wave.planned', {
      waveId: 'w1',
      split: 'dev-observed',
      members: ['a1', 'a2'],
    })
    await runEvaluationAction(scenario, {
      actionId: 'a1',
      waveId: 'w1',
      candidateId: 'c1',
      opaqueTaskId: 't1',
    })
    await scenario.emit('wave.committed', { waveId: 'w1', decisionSnapshotHash: 'f'.repeat(64) })
    const events = await scenario.state()
    expect(() => replayEvents(events as never, scenario.reducerConfig)).toThrow(
      /nonterminal members/,
    )
    await scenario.close()
    await cleanup()
  })

  it('mirrors budget limits: a mirrored over-limit entry fails the fold', async () => {
    const { scenario, cleanup } = await openScenario('dsh-red-budget-', { usd: 100 })
    // Reserve 60 legitimately through the ledger, then hand-write a mirror
    // event the ledger would have refused: the reducer must reject it too.
    await scenario.budgetEntry({ kind: 'reserve', dimension: 'usd', actionId: 'a1', amount: 60 })
    await scenario.emit('budget.entry', {
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a2',
      amount: 60,
      unpricedUnits: 0,
      entryHash: `sha256:${'ab'.repeat(32)}`,
    })
    const events = await scenario.state()
    expect(() => replayEvents(events as never, scenario.reducerConfig)).toThrow(/frozen limit/)
    await scenario.close()
    await cleanup()
  })
})

describe('permutation invariance within a wave', () => {
  it('committing wave members in different orders yields the same state hash', async () => {
    // Run A: members committed in reservation order.
    const a = await searchingScenario('dsh-red-permA-')
    await a.scenario.emit('wave.planned', {
      waveId: 'w1',
      split: 'dev-observed',
      members: ['a1', 'a2', 'a3'],
    })
    for (let index = 1; index <= 3; index += 1) {
      await runEvaluationAction(a.scenario, {
        actionId: `a${index}`,
        waveId: 'w1',
        candidateId: `cand-${index}`,
        opaqueTaskId: `task-${index}`,
      })
    }
    const stateA = replayEvents((await a.scenario.state()) as never, a.scenario.reducerConfig)

    // Run B: same reservations (same reservationSeq and request hashes), but
    // the commit phase runs in a different completion order.
    const b = await searchingScenario('dsh-red-permB-')
    await b.scenario.emit('wave.planned', {
      waveId: 'w1',
      split: 'dev-observed',
      members: ['a1', 'a2', 'a3'],
    })
    for (let index = 1; index <= 3; index += 1) {
      await b.scenario.emit('action.reserved', {
        actionId: `a${index}`,
        kind: 'evaluation',
        idempotencyKey: `eval-a${index}`,
        request: { candidateId: `cand-${index}`, opaqueTaskId: `task-${index}`, attempt: 1 },
        waveId: 'w1',
        budget: [
          { dimension: 'usd', amount: 500_000 },
          { dimension: 'task-trials', amount: 1 },
        ],
      })
      await b.scenario.budgetEntry({
        kind: 'reserve',
        dimension: 'usd',
        actionId: `a${index}`,
        amount: 500_000,
      })
      await b.scenario.budgetEntry({
        kind: 'reserve',
        dimension: 'task-trials',
        actionId: `a${index}`,
        amount: 1,
      })
    }
    for (let index = 1; index <= 3; index += 1) {
      await b.scenario.emit('action.launched', {
        actionId: `a${index}`,
        externalJobId: `job-a${index}`,
        provider: 'fake-provider',
      })
    }
    for (const index of [3, 1, 2]) {
      await b.scenario.emit('action.observed-terminal', {
        actionId: `a${index}`,
        fact: { outcome: 'success' },
      })
      await b.scenario.emit('artifact.collected', {
        actionId: `a${index}`,
        artifact: {
          algorithm: 'sha256',
          digest: 'b'.repeat(64),
          size: 100,
          mediaType: 'application/vnd.dsh-evolve-le.trajectory+json',
          label: 'DEV_OBSERVED',
        },
      })
      await b.scenario.emit('action.committed', {
        actionId: `a${index}`,
        observation: {
          actionId: `a${index}`,
          candidateId: `cand-${index}`,
          opaqueTaskId: `task-${index}`,
          split: 'dev-observed',
          attempt: 1,
          outcome: 'success',
          reward: 1,
          costUsdMicros: 100,
          durationMs: 5_000,
        },
      })
      await b.scenario.budgetEntry({
        kind: 'settle',
        dimension: 'usd',
        actionId: `a${index}`,
        amount: 100,
      })
      await b.scenario.budgetEntry({
        kind: 'settle',
        dimension: 'task-trials',
        actionId: `a${index}`,
        amount: 1,
      })
    }
    const stateB = replayEvents((await b.scenario.state()) as never, b.scenario.reducerConfig)

    // Journal order genuinely differs; the core state does not.
    expect(stateA.seq).toBeGreaterThan(0)
    const observedOrderA = (await a.scenario.state())
      .filter((event) => event.type === 'action.committed')
      .map((event) => event.payload['actionId'])
    const observedOrderB = (await b.scenario.state())
      .filter((event) => event.type === 'action.committed')
      .map((event) => event.payload['actionId'])
    expect(observedOrderA).toEqual(['a1', 'a2', 'a3'])
    expect(observedOrderB).toEqual(['a3', 'a1', 'a2'])
    expect(stateHashOf(stateA)).toBe(stateHashOf(stateB))

    // The wave decision snapshot is likewise order-insensitive.
    const waveA = stateA.waves['w1']
    const waveB = stateB.waves['w1']
    expect(waveDecisionSnapshot(stateA, waveA!)).toBe(waveDecisionSnapshot(stateB, waveB!))
    await a.scenario.close()
    await a.cleanup()
    await b.scenario.close()
    await b.cleanup()
  })
})

describe('seeded property: arbitrary valid sequences fold deterministically', () => {
  /** Deterministic xorshift32 — no library, reproducible from the seed. */
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

  it('random valid sagas replay to the same hash twice, with chained seqs', async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const rng = makeRng(seed * 0x9e3779b9)
      const { scenario, cleanup } = await searchingScenario(`dsh-red-prop${seed}-`)
      const waves = 1 + (rng() % 3)
      for (let waveIndex = 1; waveIndex <= waves; waveIndex += 1) {
        const waveId = `w${waveIndex}`
        const count = 1 + (rng() % 3)
        const members = Array.from({ length: count }, (_u, i) => `${waveId}-a${i + 1}`)
        await scenario.emit('wave.planned', { waveId, split: 'dev-observed', members })
        // Reservation order is fixed (reservationSeq must be stable); the
        // completion order is the permuted part.
        for (let index = 1; index <= count; index += 1) {
          await runEvaluationAction(scenario, {
            actionId: `${waveId}-a${index}`,
            waveId,
            candidateId: `cand-${waveIndex}-${index}`,
            opaqueTaskId: `task-${index}`,
            outcome: rng() % 3 === 0 ? 'timeout' : rng() % 2 === 0 ? 'failure' : 'success',
          })
        }
      }
      const events = await scenario.state()
      const once = replayEvents(events as never, scenario.reducerConfig)
      const twice = replayEvents(events as never, scenario.reducerConfig)
      expect(stateHashOf(once)).toBe(stateHashOf(twice))
      expect(once.seq).toBe(events.length)
      // Every applied event advanced seq by exactly one.
      expect(once.lastEventHash).toBe(events.at(-1)?.eventHash)
      await scenario.close()
      await cleanup()
    }
  })

  it('initial state hashes deterministically and ignores journal position', async () => {
    const config = { runId: 'run-test', budgetLimits: {} }
    const first = initialState(config)
    const second = initialState(config)
    expect(stateHashOf(first)).toBe(stateHashOf(second))
    expect(first.seq).toBe(0)
    // The genesis hash is over the core, not the bookkeeping.
    expect(stateHashOf({ ...first, seq: 99, lastEventHash: 'sha256:' + '1'.repeat(64) })).toBe(
      stateHashOf(first),
    )
    expect(canonicalHash({ a: 1 })).toHaveLength(64)
  })
})

describe('NO_DEVELOPMENT_IMPROVEMENT phase (ADR-047)', () => {
  it('is a legal early terminal from DRAFT', async () => {
    const { scenario, cleanup } = await openScenario('dsh-red-nodev-draft-')
    await scenario.emit('run.phase.changed', {
      to: 'NO_DEVELOPMENT_IMPROVEMENT',
      reason: 'baseline won the tournament',
    })
    const state = replayEvents((await scenario.state()) as never, scenario.reducerConfig)
    expect(state.phase).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    await scenario.close()
    await cleanup()
  })

  it('is a legal edge from SEARCHING', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-nodev-search-')
    await scenario.emit('run.phase.changed', {
      to: 'NO_DEVELOPMENT_IMPROVEMENT',
      reason: 'winner delta <= 0',
    })
    const state = replayEvents((await scenario.state()) as never, scenario.reducerConfig)
    expect(state.phase).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    await scenario.close()
    await cleanup()
  })

  it('is terminal: a resume can never re-enter search', async () => {
    const { scenario, cleanup } = await searchingScenario('dsh-red-nodev-terminal-')
    await scenario.emit('run.phase.changed', {
      to: 'NO_DEVELOPMENT_IMPROVEMENT',
      reason: 'no improvement',
    })
    await scenario.emit('run.phase.changed', { to: 'SEARCHING', reason: 're-enter' })
    const state = await scenario.state()
    expect(() => replayEvents(state as never, scenario.reducerConfig)).toThrow(
      /not a legal edge/,
    )
    await scenario.close()
    await cleanup()
  })
})
