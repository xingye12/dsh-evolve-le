/**
 * Selection-module contract tests (Gate 5, specs/03 §5–7 + §15, specs/06 §9).
 *
 * Golden tests here are hand-computed on a fixed small tree:
 *
 * ```text
 * baseline ── a ── a1
 *         └── b
 * ```
 *
 * dev-observed outcomes (reward): baseline 1 pass / 1 fail, a 0/2, a1 1/0,
 * b 2/0; one dev-guard observation on a1 must be excluded from every number.
 */
import { describe, expect, it } from 'vitest'
import {
  betaParametersFor,
  cladeMembers,
  cladeStats,
  CMP_PRECISION,
} from '../src/selection/clade.js'
import { betaSample, drawParentThompson, drawNodeThompson } from '../src/selection/thompson.js'
import { shouldExpand, UCB_AIR_ALPHA } from '../src/selection/ucbair.js'
import type { CandidateState, Observation } from '../src/state/reducer.js'
import { drawWords } from '../src/state/rng.js'

const RUN = 'sel-test'

function candidate(id: string, parent: string | null): CandidateState {
  return {
    candidateId: id,
    sourceHash: `sha256:${id.padEnd(64, '0').slice(0, 64)}`,
    parentCandidateId: parent,
    proposalActionId: null,
    status: 'admitted',
  }
}

const TREE = [
  candidate('baseline', null),
  candidate('a', 'baseline'),
  candidate('a1', 'a'),
  candidate('b', 'baseline'),
]

function observation(
  candidateId: string,
  task: string,
  reward: 0 | 1,
  split: Observation['split'] = 'dev-observed',
): Observation {
  return {
    actionId: `${candidateId}-${task}-${split}`,
    candidateId,
    opaqueTaskId: task,
    split,
    attempt: 1,
    outcome: reward === 1 ? 'success' : 'failure',
    reward,
    costUsdMicros: null,
    durationMs: null,
  }
}

const OBSERVATIONS = [
  observation('baseline', 't1', 1),
  observation('baseline', 't2', 0),
  observation('a', 't1', 0),
  observation('a', 't2', 0),
  observation('a1', 't1', 1),
  observation('b', 't1', 1),
  observation('b', 't2', 1),
  // Guard observation on a1: invisible to every selection number.
  observation('a1', 'g1', 1, 'dev-guard'),
]

describe('clade statistics (specs/03 §5)', () => {
  it('clade membership follows canonical-parent edges only', () => {
    expect(cladeMembers(TREE, 'baseline')).toEqual(['a', 'a1', 'b', 'baseline'])
    expect(cladeMembers(TREE, 'a')).toEqual(['a', 'a1'])
    expect(cladeMembers(TREE, 'a1')).toEqual(['a1'])
    expect(cladeMembers(TREE, 'b')).toEqual(['b'])
  })

  it('hand-computed S_C / F_C / CMP_hat per clade', () => {
    const stats = new Map(
      cladeStats({ candidates: TREE, observations: OBSERVATIONS }).map((entry) => [
        entry.candidateId,
        entry,
      ]),
    )
    // C(baseline) = {baseline, a, a1, b}: S=1+0+1+2=4, F=1+2+0+0=3 → 4/7.
    expect(stats.get('baseline')).toMatchObject({ sC: 4, fC: 3 })
    expect(stats.get('baseline')?.cmpHat).toBeCloseTo(4 / 7, CMP_PRECISION)
    // C(a) = {a, a1}: S=1, F=2 → 1/3.
    expect(stats.get('a')).toMatchObject({ sC: 1, fC: 2 })
    expect(stats.get('a')?.cmpHat).toBeCloseTo(1 / 3, CMP_PRECISION)
    // C(a1) = {a1}: S=1, F=0 → 1.
    expect(stats.get('a1')?.cmpHat).toBe(1)
    // C(b) = {b}: S=2, F=0 → 1.
    expect(stats.get('b')?.cmpHat).toBe(1)
  })

  it('CMP_hat is undefined when the clade has no completed trial', () => {
    const empty = cladeStats({
      candidates: [candidate('x', null)],
      observations: [],
    })
    expect(empty[0]).toMatchObject({ sC: 0, fC: 0, cmpHat: null })
  })

  it('donor edges never move outcomes between clades (no double count)', () => {
    // b "donates" to a1 — donor provenance is not a parent edge (specs/03 §3).
    const withDonor = [...TREE, candidate('d', 'b')]
    const stats = new Map(
      cladeStats({ candidates: withDonor, observations: OBSERVATIONS }).map((entry) => [
        entry.candidateId,
        entry,
      ]),
    )
    // C(a) unchanged by the donor subtree d.
    expect(stats.get('a')).toMatchObject({ sC: 1, fC: 2 })
    // C(b) now includes d (its child), still excludes a1's outcomes.
    expect(stats.get('b')).toMatchObject({ sC: 2, fC: 0 })
  })

  it('guard observations are excluded and counted, never aggregated', () => {
    const stats = new Map(
      cladeStats({ candidates: TREE, observations: OBSERVATIONS }).map((entry) => [
        entry.candidateId,
        entry,
      ]),
    )
    // The root clade aggregates exactly the 7 dev-observed trials (the guard
    // trial on a1 never enters s/f anywhere)…
    expect(stats.get('baseline')).toMatchObject({ sC: 4, fC: 3 })
    // …and every clade containing a1 reports the exclusion count instead.
    expect(stats.get('a1')?.guardObservationsExcluded).toBe(1)
    expect(stats.get('a')?.guardObservationsExcluded).toBe(1)
    expect(stats.get('baseline')?.guardObservationsExcluded).toBe(1)
    expect(stats.get('b')?.guardObservationsExcluded).toBe(0)
  })

  it('Beta parameters are tau-scaled (tau=1 default)', () => {
    // theta_clade(a) ~ Beta(tau*(1+S_C), tau*(1+F_C)) (specs/03 §5).
    expect(betaParametersFor({ sC: 4, fC: 3, tau: 1 })).toEqual({ alpha: 5, beta: 4 })
    expect(betaParametersFor({ sC: 4, fC: 3, tau: 2 })).toEqual({ alpha: 10, beta: 8 })
    // Node draw uses Beta(1+s, 1+f) — the tau-free variant (specs/03 §6).
    expect(betaParametersFor({ sC: 1, fC: 0, tau: 1 })).toEqual({ alpha: 2, beta: 1 })
  })
})

describe('Thompson draws (specs/03 §5–6, specs/06 §9)', () => {
  it('is a pure function of the seed, run and population (replay)', () => {
    const first = drawParentThompson({
      masterSeed: 'seed-1',
      runId: RUN,
      counter: 1,
      tau: 1,
      candidates: TREE,
      observations: OBSERVATIONS,
    })
    const second = drawParentThompson({
      masterSeed: 'seed-1',
      runId: RUN,
      counter: 1,
      tau: 1,
      candidates: TREE,
      observations: OBSERVATIONS,
    })
    expect(second.winner).toBe(first.winner)
    expect(second.thetas).toEqual(first.thetas)
    expect(second.receipt.raw).toEqual(first.receipt.raw)
    expect(second.receipt.inputHash).toBe(first.receipt.inputHash)

    const other = drawParentThompson({
      masterSeed: 'seed-2',
      runId: RUN,
      counter: 1,
      tau: 1,
      candidates: TREE,
      observations: OBSERVATIONS,
    })
    expect(other.receipt.raw).not.toEqual(first.receipt.raw)
  })

  it('draws every candidate over many seeds; winners are always in the population', () => {
    const winners = new Set<string>()
    for (let counter = 1; counter <= 200; counter += 1) {
      const draw = drawParentThompson({
        masterSeed: 'seed-1',
        runId: RUN,
        counter,
        tau: 1,
        candidates: TREE,
        observations: OBSERVATIONS,
      })
      winners.add(draw.winner)
      expect(TREE.some((entry) => entry.candidateId === draw.winner)).toBe(true)
    }
    expect(winners.size).toBeGreaterThan(1)
  })

  it('receipt carries the scheduler stream, counter and canonical input hash', () => {
    const draw = drawParentThompson({
      masterSeed: 's',
      runId: RUN,
      counter: 7,
      tau: 1,
      candidates: TREE,
      observations: OBSERVATIONS,
    })
    expect(draw.receipt.stream).toBe('scheduler-thompson')
    expect(draw.receipt.counter).toBe(7)
    // Population order is canonical (sorted by candidate id) in the input hash.
    const reordered = drawParentThompson({
      masterSeed: 's',
      runId: RUN,
      counter: 7,
      tau: 1,
      candidates: [...TREE].reverse(),
      observations: [...OBSERVATIONS].reverse(),
    })
    expect(reordered.receipt.inputHash).toBe(draw.receipt.inputHash)
    expect(reordered.winner).toBe(draw.winner)
  })

  it('node draws use Beta(1+s, 1+f) over eligible nodes', () => {
    const draw = drawNodeThompson({
      masterSeed: 's',
      runId: RUN,
      counter: 3,
      candidates: TREE,
      observations: OBSERVATIONS,
    })
    expect(draw.parameters.map((p) => p.candidateId)).toEqual(['a', 'a1', 'b', 'baseline'])
    // a: s=0,f=2 → Beta(1,3); a1: s=1,f=0 (guard excluded) → Beta(2,1).
    expect(draw.parameters.find((p) => p.candidateId === 'a')).toMatchObject({ alpha: 1, beta: 3 })
    expect(draw.parameters.find((p) => p.candidateId === 'a1')).toMatchObject({ alpha: 2, beta: 1 })
    expect(TREE.some((entry) => entry.candidateId === draw.winner)).toBe(true)
  })

  it('betaSample is deterministic and moment-correct', () => {
    const words = drawWords({
      masterSeed: 'm',
      runId: RUN,
      stream: 'scheduler-thompson',
      counter: 1,
      words: 256,
    })
    expect(betaSample(2, 2, words)).toBe(betaSample(2, 2, words))
    // Beta(2,2) mean 0.5, Beta(2,5) mean 2/7 — sampled over 512 fresh draws.
    let sum22 = 0
    let sum25 = 0
    const draws = 512
    for (let index = 0; index < draws; index += 1) {
      const w = drawWords({
        masterSeed: 'm',
        runId: RUN,
        stream: 'scheduler-thompson',
        counter: 1000 + index,
        words: 64,
      })
      sum22 += betaSample(2, 2, w)
      sum25 += betaSample(2, 5, w)
    }
    expect(sum22 / draws).toBeGreaterThan(0.4)
    expect(sum22 / draws).toBeLessThan(0.6)
    expect(sum25 / draws).toBeGreaterThan(2 / 7 - 0.06)
    expect(sum25 / draws).toBeLessThan(2 / 7 + 0.06)
    expect(betaSample(1, 1, words)).toBeGreaterThan(0)
    expect(betaSample(1, 1, words)).toBeLessThan(1)
  })
})

describe('UCB-Air expansion decision (specs/03 §7)', () => {
  it('alpha default is 0.6', () => {
    expect(UCB_AIR_ALPHA).toBe(0.6)
  })

  it('hand-computed thresholds with no pending work', () => {
    // T counts admitted candidates including baseline.
    // N=0,P=0,T=1: 0^0.6=0 < 1 → evaluate (forced baseline cold start).
    expect(
      shouldExpand({
        completedTrials: 0,
        pendingEvaluations: 0,
        admittedCandidates: 1,
        kTarget: 3,
      }),
    ).toBe(false)
    // N=1,P=0,T=1: 1 >= 1 → expand.
    expect(
      shouldExpand({
        completedTrials: 1,
        pendingEvaluations: 0,
        admittedCandidates: 1,
        kTarget: 3,
      }),
    ).toBe(true)
    // N=3,P=0,T=2 (baseline+child): 3^0.6 ≈ 1.933 < 2 → evaluate.
    expect(
      shouldExpand({
        completedTrials: 3,
        pendingEvaluations: 0,
        admittedCandidates: 2,
        kTarget: 3,
      }),
    ).toBe(false)
    // N=4: 4^0.6 = 2.297… >= 2 → expand.
    expect(
      shouldExpand({
        completedTrials: 4,
        pendingEvaluations: 0,
        admittedCandidates: 2,
        kTarget: 3,
      }),
    ).toBe(true)
  })

  it('pending evaluations count into the left side', () => {
    // N=0 but P_eval=2, T=1: 2^0.6 ≈ 1.516 >= 1 → expand.
    expect(
      shouldExpand({
        completedTrials: 0,
        pendingEvaluations: 2,
        admittedCandidates: 1,
        kTarget: 3,
      }),
    ).toBe(true)
    // N=1, P=1, T=2: 2^0.6 ≈ 1.516 < 2 → evaluate.
    expect(
      shouldExpand({
        completedTrials: 1,
        pendingEvaluations: 1,
        admittedCandidates: 2,
        kTarget: 3,
      }),
    ).toBe(false)
  })

  it('never expands past K, regardless of pressure', () => {
    expect(
      shouldExpand({
        completedTrials: 10_000,
        pendingEvaluations: 0,
        admittedCandidates: 4,
        kTarget: 3,
      }),
    ).toBe(false)
  })

  it('alpha is configurable and off-by-one checked', () => {
    // alpha=1: (N+P) >= T exactly at N=T-1.
    expect(
      shouldExpand({
        completedTrials: 1,
        pendingEvaluations: 0,
        admittedCandidates: 2,
        kTarget: 3,
        alpha: 1,
      }),
    ).toBe(false)
    expect(
      shouldExpand({
        completedTrials: 2,
        pendingEvaluations: 0,
        admittedCandidates: 2,
        kTarget: 3,
        alpha: 1,
      }),
    ).toBe(true)
  })

  it('proposal attempts are never counted as N (inputs are explicit)', () => {
    // The formula only consumes completed trials and pending evaluations;
    // expansion attempts are a different counter the caller keeps (specs/03 §7).
    const draw = shouldExpand({
      completedTrials: 1,
      pendingEvaluations: 0,
      admittedCandidates: 1,
      kTarget: 3,
    })
    expect(draw).toBe(true)
  })
})
