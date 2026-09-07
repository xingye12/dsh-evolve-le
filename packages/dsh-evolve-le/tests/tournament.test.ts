/**
 * Tournament contract tests (ADR-047, specs/03 §11): eligibility, the q10
 * shortlist on the dedicated 'tournament' RNG stream with hash tie-break, the
 * deterministic coverage plan, task-weighted paired-delta scoring with the
 * 90% cluster-bootstrap LCB and specs/03 §10 tie-break, and the champion
 * triple-hash lock primitive.
 */
import { describe, expect, it } from 'vitest'
import {
  TOURNAMENT_DEFAULTS,
  buildTournamentCoverage,
  drawTournamentShortlist,
  eligibleTournamentNodes,
  scoreTournament,
  tripleLockHash,
} from '../src/selection/tournament.js'
import type { CandidateState, Observation } from '../src/state/reducer.js'

function candidate(id: string): CandidateState {
  return {
    candidateId: id,
    sourceHash: `src-${id}`,
    parentCandidateId: null,
    proposalActionId: null,
    status: 'admitted',
  }
}

function observation(
  candidateId: string,
  opaqueTaskId: string,
  outcome: 'success' | 'failure',
  attempt = 1,
): Observation {
  return {
    actionId: `eval-x-${candidateId}-${opaqueTaskId}-a${attempt}`,
    attempt,
    candidateId,
    opaqueTaskId,
    outcome,
    reward: outcome === 'success' ? 1 : 0,
    split: 'dev-observed',
    costUsdMicros: 100,
    durationMs: 1_000,
  }
}

describe('tournament defaults (specs/03 §11)', () => {
  it('pins the pre-registered defaults', () => {
    expect(TOURNAMENT_DEFAULTS).toEqual({
      minEligibilityTrials: 12,
      coverageAttemptsPerTask: 1,
      maxTrials: 360,
      bootstrapResamples: 100_000,
      confidencePercentile: 10,
      epsilonPerf: 0.01,
    })
  })
})

describe('eligibility', () => {
  it('admits only children with at least minEligibilityTrials observations and complete artifacts', () => {
    const nodes = [
      { candidateId: 'c-qualified', observationCount: 12, artifactsComplete: true },
      { candidateId: 'c-few-trials', observationCount: 11, artifactsComplete: true },
      { candidateId: 'c-no-artifacts', observationCount: 20, artifactsComplete: false },
    ]
    const eligible = eligibleTournamentNodes({
      baselineId: 'baseline',
      nodes,
      minEligibilityTrials: 12,
    })
    expect(eligible.map((node) => node.candidateId)).toEqual(['c-qualified'])
  })

  it('never returns the baseline as an eligible child (the driver adds it as node 0)', () => {
    const eligible = eligibleTournamentNodes({
      baselineId: 'baseline',
      nodes: [
        { candidateId: 'baseline', observationCount: 0, artifactsComplete: true },
        { candidateId: 'c1', observationCount: 12, artifactsComplete: true },
      ],
      minEligibilityTrials: 12,
    })
    expect(eligible.map((node) => node.candidateId)).toEqual(['c1'])
  })

  it('returns eligible children in canonical (sorted) order', () => {
    const nodes = [
      { candidateId: 'c-b', observationCount: 12, artifactsComplete: true },
      { candidateId: 'c-a', observationCount: 15, artifactsComplete: true },
    ]
    const eligible = eligibleTournamentNodes({
      baselineId: 'baseline',
      nodes,
      minEligibilityTrials: 12,
    })
    expect(eligible.map((node) => node.candidateId)).toEqual(['c-a', 'c-b'])
  })
})

describe('q10 shortlist draw', () => {
  const SEED = 'tournament-draw-seed'
  const RUN = 'tournament-draw-run'

  it('draws on the dedicated tournament stream and is deterministic', () => {
    const candidates = Array.from({ length: 6 }, (_unused, index) => candidate(`c-${index}`))
    const observations = candidates.flatMap((node, index) => [
      observation(node.candidateId, 't-1', index < 3 ? 'success' : 'failure'),
      observation(node.candidateId, 't-2', 'failure'),
    ])
    const first = drawTournamentShortlist({
      masterSeed: SEED,
      runId: RUN,
      counter: 1,
      candidates,
      observations,
      shortlistSize: 3,
    })
    const second = drawTournamentShortlist({
      masterSeed: SEED,
      runId: RUN,
      counter: 1,
      candidates,
      observations,
      shortlistSize: 3,
    })
    expect(first.shortlist).toEqual(second.shortlist)
    expect(first.draw.receipt.stream).toBe('tournament')
    expect(first.draw.receipt.counter).toBe(1)
    expect(first.shortlist).toHaveLength(3)
    for (const id of first.shortlist) expect(candidates.some((node) => node.candidateId === id)).toBe(true)
  })

  it('caps the shortlist at the eligible population size', () => {
    const candidates = [candidate('c-0'), candidate('c-1')]
    const observations = [observation('c-0', 't-1', 'success'), observation('c-1', 't-1', 'failure')]
    const draw = drawTournamentShortlist({
      masterSeed: SEED,
      runId: RUN,
      counter: 2,
      candidates,
      observations,
      shortlistSize: 5,
    })
    expect(draw.shortlist.sort()).toEqual(['c-0', 'c-1'])
  })

  it('rejects an empty population', () => {
    expect(() =>
      drawTournamentShortlist({
        masterSeed: SEED,
        runId: RUN,
        counter: 3,
        candidates: [],
        observations: [],
        shortlistSize: 5,
      }),
    ).toThrow(/empty node population/)
  })
})

describe('coverage plan', () => {
  const TASKS = Array.from({ length: 49 }, (_unused, index) => `task-${String(index + 1).padStart(3, '0')}`)
  const NODES = ['baseline', ...Array.from({ length: 5 }, (_unused, index) => `c-${index}`)]

  it('plans 6 nodes × 49 tasks × 1 attempt = 294 trials in node-major waves', () => {
    const plan = buildTournamentCoverage({
      baselineId: 'baseline',
      shortlist: NODES.slice(1),
      tasks: TASKS,
      attemptsPerTask: 1,
      batchSize: 8,
      concurrency: 8,
      priorAttempts: () => 0,
    })
    expect(plan.nodes).toEqual(NODES)
    expect(plan.tasks).toEqual(TASKS)
    expect(plan.trialCount).toBe(294)
    // 49 tasks / batch 8 → 7 batches per node, one wave each; 6 nodes → 42.
    expect(plan.waves).toHaveLength(42)
    expect(plan.waves[0]).toEqual({
      waveId: 'tournament-0-1-1',
      nodeIdx: 0,
      members: TASKS.slice(0, 8).map((taskId) => ({ taskId, attempt: 1 })),
    })
    // The last batch of node 0 carries the remaining single task; node 1
    // starts only after every node-0 wave (node-major order).
    expect(plan.waves[6]).toEqual({
      waveId: 'tournament-0-7-1',
      nodeIdx: 0,
      members: TASKS.slice(48, 49).map((taskId) => ({ taskId, attempt: 1 })),
    })
    expect(plan.waves[7]!.nodeIdx).toBe(1)
    expect(plan.waves[7]!.waveId).toBe('tournament-1-1-1')
  })

  it('numbers attempts above the prior count for the same (node, task)', () => {
    const plan = buildTournamentCoverage({
      baselineId: 'baseline',
      shortlist: ['c-0'],
      tasks: ['t-1', 't-2'],
      attemptsPerTask: 1,
      batchSize: 2,
      concurrency: 2,
      priorAttempts: (candidateId, taskId) => (candidateId === 'baseline' && taskId === 't-1' ? 2 : 0),
    })
    expect(plan.trialCount).toBe(4)
    expect(plan.waves.map((wave) => wave.members)).toEqual([
      [
        { taskId: 't-1', attempt: 3 },
        { taskId: 't-2', attempt: 1 },
      ],
      [
        { taskId: 't-1', attempt: 1 },
        { taskId: 't-2', attempt: 1 },
      ],
    ])
  })

  it('carries the attempt segment in wave ids when attemptsPerTask > 1', () => {
    const plan = buildTournamentCoverage({
      baselineId: 'baseline',
      shortlist: [],
      tasks: ['t-1'],
      attemptsPerTask: 2,
      batchSize: 1,
      concurrency: 1,
      priorAttempts: () => 0,
    })
    expect(plan.trialCount).toBe(2)
    expect(plan.waves.map((wave) => wave.waveId)).toEqual(['tournament-0-a1-1-1', 'tournament-0-a2-1-1'])
    expect(plan.waves.map((wave) => wave.members[0]!.attempt)).toEqual([1, 2])
  })
})

describe('paired-delta scoring', () => {
  const SEED = 'tournament-score-seed'
  const RUN = 'tournament-score-run'

  it('returns the baseline when every child trails it', () => {
    const score = scoreTournament({
      masterSeed: SEED,
      runId: RUN,
      counter: 1,
      baselineId: 'baseline',
      nodes: [
        { candidateId: 'baseline', deltasPerTask: [0, 0, 0, 0] },
        { candidateId: 'c-0', deltasPerTask: [-1, -1, -1, -1] },
        { candidateId: 'c-1', deltasPerTask: [0, 0, -1, -1] },
      ],
      resamples: 10_000,
    })
    expect(score.championId).toBe('baseline')
    expect(score.receipt.stream).toBe('bootstrap')
    const rows = new Map(score.rows.map((row) => [row.candidateId, row]))
    expect(rows.get('baseline')!.delta).toBe(0)
    expect(rows.get('c-0')!.delta).toBe(-1)
    expect(rows.get('c-0')!.lcb).toBe(-1)
  })

  it('crowns the child with the highest LCB and reports per-row deltas', () => {
    const score = scoreTournament({
      masterSeed: SEED,
      runId: RUN,
      counter: 2,
      baselineId: 'baseline',
      nodes: [
        { candidateId: 'baseline', deltasPerTask: [0, 0, 0, 0] },
        { candidateId: 'c-0', deltasPerTask: [1, 1, 1, 1] },
        { candidateId: 'c-1', deltasPerTask: [1, 1, 0, 0] },
      ],
      resamples: 10_000,
    })
    expect(score.championId).toBe('c-0')
    const byId = new Map(score.rows.map((row) => [row.candidateId, row]))
    expect(byId.get('c-0')!.delta).toBe(1)
    expect(byId.get('c-0')!.lcb).toBe(1)
    expect(byId.get('c-1')!.delta).toBe(0.5)
    // Every row's LCB sits at or below its point estimate.
    for (const row of score.rows) expect(row.lcb).toBeLessThanOrEqual(row.delta + 1e-12)
  })

  it('breaks LCB ties within epsilonPerf by cost, then duration, then hash (specs/03 §10)', () => {
    const equal = [
      { candidateId: 'c-expensive', deltasPerTask: [1, 1, 1, 1], meanCostUsdMicros: 900, medianDurationMs: 1_000 },
      { candidateId: 'c-cheap-slow', deltasPerTask: [1, 1, 1, 1], meanCostUsdMicros: 100, medianDurationMs: 2_000 },
      { candidateId: 'c-cheap-fast', deltasPerTask: [1, 1, 1, 1], meanCostUsdMicros: 100, medianDurationMs: 500 },
    ]
    const baseline = { candidateId: 'baseline', deltasPerTask: [0, 0, 0, 0], meanCostUsdMicros: 100, medianDurationMs: 500 }
    const base = { masterSeed: SEED, runId: RUN, counter: 3, baselineId: 'baseline', resamples: 10_000 }
    const score = scoreTournament({ ...base, nodes: [baseline, ...equal] })
    expect(score.championId).toBe('c-cheap-fast')

    // Same cost and duration: the lexicographically smaller candidate id wins.
    const lex = scoreTournament({
      ...base,
      counter: 4,
      nodes: [
        baseline,
        { candidateId: 'c-zz', deltasPerTask: [1, 1, 1, 1], meanCostUsdMicros: 100, medianDurationMs: 500 },
        { candidateId: 'c-aa', deltasPerTask: [1, 1, 1, 1], meanCostUsdMicros: 100, medianDurationMs: 500 },
      ],
    })
    expect(lex.championId).toBe('c-aa')
  })

  it('is deterministic for the same inputs', () => {
    const input = {
      masterSeed: SEED,
      runId: RUN,
      counter: 5,
      baselineId: 'baseline',
      nodes: [
        { candidateId: 'baseline', deltasPerTask: [0, 0, 0, 0] },
        { candidateId: 'c-0', deltasPerTask: [1, -1, 1, -1] },
      ],
      resamples: 5_000,
    }
    expect(scoreTournament(input)).toEqual(scoreTournament(input))
  })
})

describe('champion triple-hash lock primitive', () => {
  it('is sha256 of the three hashes concatenated in order (hand golden)', () => {
    // sha256('abc') is a well-known digest — the concatenation carries no
    // separators, so the order is part of the contract.
    expect(tripleLockHash('a', 'b', 'c')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('is order-sensitive', () => {
    expect(tripleLockHash('a', 'b', 'c')).not.toBe(tripleLockHash('c', 'b', 'a'))
  })
})
