/**
 * Clade statistics over the canonical-parent tree (specs/03 §3, §5).
 *
 * The archive keeps every admitted candidate; the canonical-parent edges form
 * a tree, and every selection statistic is an aggregate over one node's clade
 * (the node plus all descendants). Donor edges are provenance only and never
 * move outcomes between clades, so no outcome is ever double-counted. Guard
 * observations are excluded from every number and only surface as a count —
 * selectors and proposers both consume dev-observed data exclusively.
 * @module @dsh-evolve-le/core/selection/clade
 */

import type { CandidateState, Observation } from '../state/reducer.js'

/** Decimal places the CMP estimator is compared at (float-agnostic goldens). */
export const CMP_PRECISION = 10

export interface CladeInput {
  candidates: readonly CandidateState[]
  /** All observations; guard entries are excluded here, never upstream. */
  observations: readonly Observation[]
}

export interface CladeEntry {
  candidateId: string
  /** Members of C(a): the candidate and every canonical descendant. */
  members: string[]
  /** Completed development passes inside the clade (dev-observed only). */
  sC: number
  /** Completed development failures inside the clade (dev-observed only). */
  fC: number
  /** S_C / (S_C + F_C); null when the clade has no completed trial. */
  cmpHat: number | null
  /** Guard observations seen for clade members and deliberately excluded. */
  guardObservationsExcluded: number
}

export interface NodeStats {
  candidateId: string
  s: number
  f: number
  guardExcluded: number
}

/**
 * Members of the clade rooted at `rootId` — canonical-parent edges only.
 * Result is canonical (sorted) so downstream hashes are order-insensitive.
 */
export function cladeMembers(candidates: readonly CandidateState[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const candidate of candidates) {
    if (candidate.parentCandidateId === null) continue
    const list = childrenOf.get(candidate.parentCandidateId) ?? []
    list.push(candidate.candidateId)
    childrenOf.set(candidate.parentCandidateId, list)
  }
  const members: string[] = []
  const stack = [rootId]
  const known = new Set(candidates.map((candidate) => candidate.candidateId))
  while (stack.length > 0) {
    const current = stack.pop()!
    if (!known.has(current)) continue
    members.push(current)
    for (const child of childrenOf.get(current) ?? []) stack.push(child)
  }
  return members.sort()
}

/** Per-node dev-observed pass/fail counts (guard excluded and counted). */
export function nodeStats(input: CladeInput): Map<string, NodeStats> {
  const stats = new Map<string, NodeStats>()
  for (const candidate of input.candidates) {
    stats.set(candidate.candidateId, {
      candidateId: candidate.candidateId,
      s: 0,
      f: 0,
      guardExcluded: 0,
    })
  }
  for (const observation of input.observations) {
    const entry = stats.get(observation.candidateId)
    if (entry === undefined) continue
    if (observation.split === 'dev-guard') {
      entry.guardExcluded += 1
      continue
    }
    if (observation.reward === 1) entry.s += 1
    else entry.f += 1
  }
  return stats
}

/** Clade aggregates for every candidate (deterministic candidate order). */
export function cladeStats(input: CladeInput): CladeEntry[] {
  const perNode = nodeStats(input)
  const ordered = [...input.candidates].sort((a, b) =>
    a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
  )
  return ordered.map((candidate) => {
    const members = cladeMembers(input.candidates, candidate.candidateId)
    let sC = 0
    let fC = 0
    let guardExcluded = 0
    for (const member of members) {
      const entry = perNode.get(member)
      if (entry === undefined) continue
      sC += entry.s
      fC += entry.f
      guardExcluded += entry.guardExcluded
    }
    const denominator = sC + fC
    return {
      candidateId: candidate.candidateId,
      members,
      sC,
      fC,
      cmpHat: denominator === 0 ? null : sC / denominator,
      guardObservationsExcluded: guardExcluded,
    }
  })
}

/** Beta parameters for one draw (specs/03 §5 parent, §6 node; tau scales both). */
export function betaParametersFor(input: { sC: number; fC: number; tau: number }): {
  alpha: number
  beta: number
} {
  if (!Number.isFinite(input.tau) || input.tau <= 0) {
    throw new Error(`clade: tau must be positive, got ${String(input.tau)}`)
  }
  return { alpha: input.tau * (1 + input.sC), beta: input.tau * (1 + input.fC) }
}
