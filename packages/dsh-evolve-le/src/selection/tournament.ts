/**
 * Champion tournament (ADR-047, specs/03 §10–11): eligibility, the q10
 * shortlist draw, the deterministic node-major coverage plan, paired-delta
 * scoring with the 90% cluster-bootstrap LCB and the specs/03 §10
 * tie-break, and the champion triple-hash lock primitive. Pure modules —
 * the driver journals receipts and feeds the results into the reducer
 * (`dev-champion` → `candidate.locked` → `locked` → CANDIDATE_LOCKED).
 * @module @dsh-evolve-le/core/selection/tournament
 */
import { createHash } from 'node:crypto'
import type { CandidateState, Observation } from '../state/reducer.js'
import { drawNodeThompson, type ThompsonDraw } from './thompson.js'
import { clusterBootstrapLcb, type BootstrapLcbResult } from './bootstrap.js'

/** Pre-registered tournament envelope (ADR-047; the formal K=80 run). */
export const TOURNAMENT_DEFAULTS = {
  /** Committed observations an admitted child needs to be eligible (§11). */
  minEligibilityTrials: 12,
  /** Coverage attempts per development task (§11). */
  coverageAttemptsPerTask: 1,
  /** Tournament trial budget: top-up + coverage must both fit (§11). */
  maxTrials: 360,
  /** Cluster-bootstrap resamples for the 90% LCB (§11 step 5). */
  bootstrapResamples: 100_000,
  /** LCB percentile of the resample-mean distribution. */
  confidencePercentile: 10,
  /** LCB tie window for the specs/03 §10 tie-break. */
  epsilonPerf: 0.01,
} as const

export interface TournamentConfig {
  minEligibilityTrials: number
  coverageAttemptsPerTask: number
  maxTrials: number
  bootstrapResamples: number
}

export interface TournamentEligibilityNode {
  candidateId: string
  observationCount: number
  artifactsComplete: boolean
}

/** Eligible children: ≥ minEligibilityTrials observations + complete
 * artifacts, canonical order, never the baseline (the driver adds it as
 * node 0 — specs/03 §11 step 2). */
export function eligibleTournamentNodes(input: {
  baselineId: string
  nodes: readonly TournamentEligibilityNode[]
  minEligibilityTrials: number
}): TournamentEligibilityNode[] {
  return input.nodes
    .filter(
      (node) =>
        node.candidateId !== input.baselineId &&
        node.observationCount >= input.minEligibilityTrials &&
        node.artifactsComplete,
    )
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0))
}

/** specs/03 §11 tie-break within the draw: sha256(id || seed || counter),
 * descending (larger digest wins). */
function drawTieBreak(candidateId: string, masterSeed: string, counter: number): string {
  return createHash('sha256').update(`${candidateId}||${masterSeed}||${counter}`).digest('hex')
}

/**
 * q10(Beta(1+s, 1+f)) shortlist over the eligible population on the
 * dedicated `'tournament'` RNG stream (ADR-047, specs/03 §11 step 3):
 * nodes ranked by their drawn theta, ties broken by the hash tie-break,
 * capped at `shortlistSize` (which caps at the population size).
 */
export function drawTournamentShortlist(input: {
  masterSeed: string
  runId: string
  counter: number
  candidates: readonly CandidateState[]
  observations: readonly Observation[]
  shortlistSize: number
}): { shortlist: string[]; draw: ThompsonDraw } {
  if (input.candidates.length === 0) throw new Error('tournament: empty node population')
  const draw = drawNodeThompson({
    masterSeed: input.masterSeed,
    runId: input.runId,
    counter: input.counter,
    candidates: input.candidates,
    observations: input.observations,
    stream: 'tournament',
  })
  const ranked = draw.parameters
    .map((entry, index) => ({ id: entry.candidateId, theta: draw.thetas[index]! }))
    .sort((a, b) => {
      if (b.theta !== a.theta) return b.theta - a.theta
      const tieA = drawTieBreak(a.id, input.masterSeed, input.counter)
      const tieB = drawTieBreak(b.id, input.masterSeed, input.counter)
      return tieA < tieB ? 1 : tieA > tieB ? -1 : 0
    })
  const shortlist = ranked.slice(0, Math.min(input.shortlistSize, ranked.length)).map((e) => e.id)
  return { shortlist, draw }
}

export interface TournamentCoverageInput {
  baselineId: string
  /** The shortlist in draw order; nodes run baseline first (§11 step 4). */
  shortlist: readonly string[]
  tasks: readonly string[]
  attemptsPerTask: number
  batchSize: number
  concurrency: number
  /** Committed attempts for (node, task) before the tournament started. */
  priorAttempts: (candidateId: string, taskId: string) => number
}

export interface TournamentCoverageMember {
  taskId: string
  attempt: number
}

export interface TournamentCoverageWave {
  waveId: string
  nodeIdx: number
  members: TournamentCoverageMember[]
}

export interface TournamentCoveragePlan {
  nodes: string[]
  tasks: string[]
  trialCount: number
  waves: TournamentCoverageWave[]
}

/**
 * Node-major coverage plan (specs/03 §11 step 4): for each node (baseline
 * first), each attempt, each batch, each concurrency chunk — a wave whose
 * members carry `priorAttempts + attemptOffset` attempt numbers, so the
 * driver's action ids stay unique across the search phase. Wave ids:
 * `tournament-<nodeIdx>-<batch>-<wave>` with one attempt per task, and
 * `tournament-<nodeIdx>-a<attempt>-<batch>-<wave>` otherwise.
 */
export function buildTournamentCoverage(input: TournamentCoverageInput): TournamentCoveragePlan {
  const nodes = [input.baselineId, ...input.shortlist]
  const waves: TournamentCoverageWave[] = []
  const batchCount = Math.ceil(input.tasks.length / input.batchSize)
  nodes.forEach((nodeId, nodeIdx) => {
    for (let attempt = 1; attempt <= input.attemptsPerTask; attempt += 1) {
      for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
        const batch = input.tasks.slice(
          batchIndex * input.batchSize,
          Math.min((batchIndex + 1) * input.batchSize, input.tasks.length),
        )
        for (let offset = 0; offset < batch.length; offset += input.concurrency) {
          const chunk = batch.slice(offset, offset + input.concurrency)
          const waveIndex = Math.floor(offset / input.concurrency) + 1
          const attemptSegment = input.attemptsPerTask === 1 ? '' : `-a${attempt}`
          waves.push({
            waveId: `tournament-${nodeIdx}${attemptSegment}-${batchIndex + 1}-${waveIndex}`,
            nodeIdx,
            members: chunk.map((taskId) => ({
              taskId,
              attempt: input.priorAttempts(nodeId, taskId) + attempt,
            })),
          })
        }
      }
    }
  })
  return {
    nodes,
    tasks: [...input.tasks],
    trialCount: nodes.length * input.tasks.length * input.attemptsPerTask,
    waves,
  }
}

export interface TournamentScoreNode {
  candidateId: string
  /** Paired task deltas against the baseline (one per development task). */
  deltasPerTask: readonly number[]
  /** Tie-break facts (specs/03 §10); undefined = no cost attribution. */
  meanCostUsdMicros?: number
  medianDurationMs?: number
}

export interface TournamentScoreRow {
  candidateId: string
  delta: number
  lcb: number
  meanCostUsdMicros?: number
  medianDurationMs?: number
  /** The row's bootstrap receipt (counter = input counter + row index);
   * the driver journals every row's receipt, not only the champion's. */
  receipt: BootstrapLcbResult['receipt']
}

export interface TournamentScore {
  championId: string
  rows: TournamentScoreRow[]
  /** The champion row's bootstrap receipt (counter = input counter + row
   * index; one receipt per row is journaled by the driver). */
  receipt: BootstrapLcbResult['receipt']
}

/**
 * Paired-delta scoring (specs/03 §11 steps 5–6): per node, Delta = mean of
 * the task deltas and a 90% cluster-bootstrap LCB (cluster = task). The
 * champion is the highest LCB among baseline + shortlist; within
 * epsilonPerf of the top LCB, the specs/03 §10 tie-break applies: lower
 * mean cost, then lower median duration, then the lexicographically
 * smaller candidate id. The baseline wins by default: its delta is zero
 * and a child whose LCB is not strictly higher loses.
 */
export function scoreTournament(input: {
  masterSeed: string
  runId: string
  counter: number
  baselineId: string
  nodes: readonly TournamentScoreNode[]
  resamples: number
  percentile?: number
}): TournamentScore {
  if (input.nodes.length === 0) throw new Error('tournament: empty scoring population')
  const percentile = input.percentile ?? TOURNAMENT_DEFAULTS.confidencePercentile
  const rows: Array<TournamentScoreRow & { receipt: BootstrapLcbResult['receipt'] }> =
    input.nodes.map((node, index) => {
      const result = clusterBootstrapLcb({
        masterSeed: input.masterSeed,
        runId: input.runId,
        counter: input.counter + index,
        deltas: node.deltasPerTask,
        resamples: input.resamples,
        percentile,
      })
      return {
        candidateId: node.candidateId,
        delta: result.mean,
        lcb: result.lcb,
        ...(node.meanCostUsdMicros !== undefined
          ? { meanCostUsdMicros: node.meanCostUsdMicros }
          : {}),
        ...(node.medianDurationMs !== undefined ? { medianDurationMs: node.medianDurationMs } : {}),
        receipt: result.receipt,
      }
    })
  // Champion: highest LCB; rows within epsilonPerf of the top LCB are
  // decided by the specs/03 §10 tie-break (cost → duration → hash). The
  // baseline's delta is zero, so a child must actually beat it.
  const topLcb = Math.max(...rows.map((row) => row.lcb))
  const contenders = rows.filter((row) => row.lcb >= topLcb - TOURNAMENT_DEFAULTS.epsilonPerf)
  const champion = [...contenders].sort((a, b) => (tieBreaksBetter(a, b) ? -1 : 1))[0]!
  return {
    championId: champion.candidateId,
    rows: rows.map((row) => ({
      candidateId: row.candidateId,
      delta: row.delta,
      lcb: row.lcb,
      ...(row.meanCostUsdMicros !== undefined ? { meanCostUsdMicros: row.meanCostUsdMicros } : {}),
      ...(row.medianDurationMs !== undefined ? { medianDurationMs: row.medianDurationMs } : {}),
      receipt: row.receipt,
    })),
    receipt: champion.receipt,
  }
}

function tieBreaksBetter(a: TournamentScoreRow, b: TournamentScoreRow): boolean {
  const costA = a.meanCostUsdMicros ?? Number.POSITIVE_INFINITY
  const costB = b.meanCostUsdMicros ?? Number.POSITIVE_INFINITY
  if (costA !== costB) return costA < costB
  const durationA = a.medianDurationMs ?? Number.POSITIVE_INFINITY
  const durationB = b.medianDurationMs ?? Number.POSITIVE_INFINITY
  if (durationA !== durationB) return durationA < durationB
  return a.candidateId < b.candidateId
}

/** sha256(sourceHash || capsuleHash || manifestHash) — concatenation with
 * no separators, order-sensitive (ADR-047 step 2). */
export function tripleLockHash(
  sourceHash: string,
  capsuleHash: string,
  manifestHash: string,
): string {
  return createHash('sha256').update(`${sourceHash}${capsuleHash}${manifestHash}`).digest('hex')
}
