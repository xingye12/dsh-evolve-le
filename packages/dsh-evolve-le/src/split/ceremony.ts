/**
 * Deterministic split ceremony (specs/04 §3, specs/06 §9).
 *
 * The pinned 89-task population is split once, before any candidate
 * evaluation, from the run's master seed via the dedicated 'split' RNG
 * stream: 48 DEV_OBSERVED handles, 12 DEV_GUARD handles (opaque ids to the
 * controller), 29 SEALED handles. The controller-visible ceremony document
 * carries the observed handles, opaque guard ids, the sealed Merkle root and
 * count — never a sealed or guard identity. The identity mapping lives in a
 * sealed-store document the caller must persist root-only (0600, outside the
 * evidence tree); without the separate secret service this is the documented
 * degraded deployment (specs/04 §3.3: a different Unix account/volume with
 * read-only ACL, never JSON-field hiding in the same process).
 *
 * Stratification: difficulty bins require the optional pre-split calibration
 * whose per-task results must stay in the sealed store (specs/04 §3.2); this
 * implementation takes the second documented option — public-metadata
 * stratification only, and with no metadata strata supplied it degenerates to
 * a single stratum with a seeded permutation. Strata can be supplied later
 * without changing the concealment contract.
 * @module @dsh-evolve-le/core/split/ceremony
 */

import { createHash } from 'node:crypto'
import { canonicalHash } from '../state/canonical.js'
import { permutationOf } from '../state/rng.js'

export const SPLIT_PROTOCOL = 'dsh-evolve-le/split-ceremony/v1'

export const SPLIT_COUNTS = { observed: 48, guard: 12, sealed: 29 } as const

export interface SplitCeremonyInput {
  runId: string
  masterSeed: string
  /** Full task-handle population (the pinned 89, any order). */
  handles: readonly string[]
  /** Optional public-metadata strata (handle → stratum key). */
  strata?: ReadonlyMap<string, string>
  counts?: typeof SPLIT_COUNTS
}

/** Controller-visible ceremony receipt — no sealed or guard identity. */
export interface SplitCeremony {
  schemaVersion: 1
  protocol: typeof SPLIT_PROTOCOL
  runId: string
  /** Canonical hash over the sorted handle population (input binding). */
  datasetInputHash: string
  /** sha256(seed || datasetInputHash || protocol) — binds, never reveals. */
  seedCommitment: string
  observedHandles: string[]
  guardOpaqueIds: string[]
  sealedCount: number
  sealedRoot: string
  /** Stratum keys used, in canonical order (single stratum when empty). */
  strata: string[]
}

/** Secret side: identities for guard/sealed assignments. Never exported. */
export interface SealedSplitStore {
  guardMap: Record<string, string>
  guardHandles: string[]
  sealedHandles: string[]
}

export function runSplitCeremony(input: SplitCeremonyInput): {
  ceremony: SplitCeremony
  sealedStore: SealedSplitStore
} {
  const counts = input.counts ?? SPLIT_COUNTS
  const unique = [...new Set(input.handles)].sort()
  const total = counts.observed + counts.guard + counts.sealed
  if (unique.length !== total) {
    throw new Error(
      `split: population of ${String(unique.length)} unique handles cannot fill ${String(total)} slots`,
    )
  }
  if (unique.length !== input.handles.length) {
    throw new Error('split: duplicate handles in the population')
  }

  const strata = input.strata ?? new Map<string, string>()
  const stratumKeys = [...new Set(unique.map((handle) => strata.get(handle) ?? 'all'))].sort()

  // Per-stratum permutation from one continuous counter range; within a
  // stratum the population is canonically sorted, so enumeration order of the
  // input can never change the mapping (specs/04 §3.2).
  const assigned: string[] = []
  let counter = 1
  for (const key of stratumKeys) {
    const members = unique.filter((handle) => (strata.get(handle) ?? 'all') === key)
    const { order } = permutationOf({
      masterSeed: input.masterSeed,
      runId: input.runId,
      stream: 'split',
      counter,
      size: members.length,
    })
    counter += members.length + 1
    for (const index of order) assigned.push(members[index]!)
  }

  const observed = assigned.slice(0, counts.observed).sort()
  const guard = assigned.slice(counts.observed, counts.observed + counts.guard).sort()
  const sealed = assigned.slice(counts.observed + counts.guard).sort()

  const datasetInputHash = canonicalHash({ handles: unique })
  const guardMap: Record<string, string> = {}
  guard.forEach((handle, index) => {
    guardMap[`guard-${String(index + 1).padStart(2, '0')}`] = handle
  })

  const ceremony: SplitCeremony = {
    schemaVersion: 1,
    protocol: SPLIT_PROTOCOL,
    runId: input.runId,
    datasetInputHash,
    seedCommitment: createHash('sha256')
      .update(`${input.masterSeed}\0${datasetInputHash}\0${SPLIT_PROTOCOL}`)
      .digest('hex'),
    observedHandles: observed,
    guardOpaqueIds: Object.keys(guardMap),
    sealedCount: sealed.length,
    sealedRoot: merkleRoot(sealed),
    strata: stratumKeys,
  }
  return {
    ceremony,
    sealedStore: {
      guardMap,
      guardHandles: guard,
      sealedHandles: sealed,
    },
  }
}

/** Merkle root over sorted handles: leaf = sha256(handle), pairwise sha256. */
function merkleRoot(handles: readonly string[]): string {
  if (handles.length === 0) {
    return createHash('sha256').update('', 'utf8').digest('hex')
  }
  let level = [...handles].sort().map((handle) => hashHex(handle))
  while (level.length > 1) {
    const next: string[] = []
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!
      const right = index + 1 < level.length ? level[index + 1]! : left
      next.push(hashHex(`${left}${right}`))
    }
    level = next
  }
  return level[0]!
}

function hashHex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
