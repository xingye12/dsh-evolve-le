/**
 * Archive catalog over dev-observed evidence (specs/06 §11, specs/05 §10,
 * specs/03 §9). The proposer's donorCandidates and failure-mode priors come
 * from this catalog only — never from the artifact store, and never from
 * guard observations: every stat here is derived exclusively from
 * `dev-observed` splits, with the excluded guard count recorded so the
 * omission is visible rather than silent.
 * @module @dsh-evolve-le/core/proposer/catalog
 */

import type { CandidateState, Observation, RunState } from '../state/reducer.js'

export const CATALOG_VERSION = 'dsh-evolve-le/archive-catalog/v1'

/** Statuses that make a candidate visible in the archive catalog. */
export const CATALOG_STATUSES: readonly string[] = [
  'admitted',
  'dev-champion',
  'locked',
  'sealed-evaluated',
  'promoted',
]

export interface CatalogTaskStats {
  opaqueTaskId: string
  attempts: number
  successes: number
  failures: number
}

export interface CatalogEntry {
  candidateId: string
  sourceHash: string
  parentCandidateId: string | null
  proposalActionId: string | null
  status: string
  /** Per-task dev-observed outcomes (opaque task ids only). */
  tasks: CatalogTaskStats[]
  totalAttempts: number
  totalSuccesses: number
  totalFailures: number
  /** Guard observations deliberately excluded from every number above. */
  guardObservationsExcluded: number
}

export interface ArchiveCatalog {
  schemaVersion: 1
  catalogVersion: typeof CATALOG_VERSION
  runId: string
  createdFromStateHash?: string
  entries: CatalogEntry[]
}

/** Aggregate dev-observed observations for one candidate into task stats. */
function statsFor(
  candidateId: string,
  observations: readonly Observation[],
): { tasks: CatalogTaskStats[]; guardExcluded: number } {
  const byTask = new Map<string, CatalogTaskStats>()
  let guardExcluded = 0
  for (const observation of observations) {
    if (observation.candidateId !== candidateId) continue
    if (observation.split === 'dev-guard') {
      guardExcluded += 1
      continue
    }
    const stats =
      byTask.get(observation.opaqueTaskId) ??
      ({
        opaqueTaskId: observation.opaqueTaskId,
        attempts: 0,
        successes: 0,
        failures: 0,
      } satisfies CatalogTaskStats)
    stats.attempts += 1
    if (observation.reward === 1) stats.successes += 1
    else stats.failures += 1
    byTask.set(observation.opaqueTaskId, stats)
  }
  const tasks = [...byTask.values()].sort((a, b) =>
    a.opaqueTaskId < b.opaqueTaskId ? -1 : a.opaqueTaskId > b.opaqueTaskId ? 1 : 0,
  )
  return { tasks, guardExcluded }
}

function entryFor(candidate: CandidateState, observations: readonly Observation[]): CatalogEntry {
  const { tasks, guardExcluded } = statsFor(candidate.candidateId, observations)
  return {
    candidateId: candidate.candidateId,
    sourceHash: candidate.sourceHash,
    parentCandidateId: candidate.parentCandidateId,
    proposalActionId: candidate.proposalActionId,
    status: candidate.status,
    tasks,
    totalAttempts: tasks.reduce((sum, task) => sum + task.attempts, 0),
    totalSuccesses: tasks.reduce((sum, task) => sum + task.successes, 0),
    totalFailures: tasks.reduce((sum, task) => sum + task.failures, 0),
    guardObservationsExcluded: guardExcluded,
  }
}

/**
 * Build the archive catalog from run state. Only candidates with an
 * archive-worthy status appear; `registered` (not yet admitted) and
 * `rejected` candidates are invisible to proposers, and every number is
 * dev-observed only. The result is deterministic for a given state — it is
 * content-addressed when published into an export.
 */
export function buildArchiveCatalog(
  state: RunState,
  options: { createdFromStateHash?: string } = {},
): ArchiveCatalog {
  const observations = Object.values(state.observations)
  const entries = Object.values(state.candidates)
    .filter((candidate) => (CATALOG_STATUSES as readonly string[]).includes(candidate.status))
    .sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1))
    .map((candidate) => entryFor(candidate, observations))
  const catalog: ArchiveCatalog = {
    schemaVersion: 1,
    catalogVersion: CATALOG_VERSION,
    runId: state.runId,
    entries,
  }
  if (options.createdFromStateHash !== undefined) {
    catalog.createdFromStateHash = options.createdFromStateHash
  }
  return catalog
}

/** Serialize a catalog deterministically (object store input). */
export function catalogBytes(catalog: ArchiveCatalog): Buffer {
  return Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
}
