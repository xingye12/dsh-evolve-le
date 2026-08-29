/**
 * State snapshots (specs/06 §5): snapshots only accelerate startup. A
 * snapshot is usable iff its schema, run binding, reducer version, recorded
 * state hash, and `(seq, lastEventHash)` chain position all match the
 * journal's committed prefix; anything else — missing, corrupt, stale, from
 * another reducer version — falls back to genesis replay. A snapshot can
 * never authorize state the journal cannot reproduce: `loadState` folds the
 * remaining committed events on top and the equivalence tests compare the
 * result against a full replay.
 *
 * Files are `snapshots/state-<seq>-<statehash>.json`, published atomically
 * (staged write → fsync → rename → directory fsync) and immutable once
 * written.
 * @module @dsh-evolve-le/core/state/snapshot
 */

import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, parseCanonicalJson } from './canonical.js'
import type { JournalEvent } from './journal.js'
import {
  initialState,
  REDUCER_VERSION,
  reduceEvent,
  stateHashOf,
  type ReducerConfig,
  type RunState,
} from './reducer.js'

export const SNAPSHOT_DIR = 'snapshots'

export interface StateSnapshot {
  schemaVersion: 1
  reducerVersion: string
  runId: string
  seq: number
  lastEventHash: string
  stateHash: string
  state: RunState
}

export function snapshotFileName(seq: number, stateHash: string): string {
  return `state-${seq}-${stateHash}.json`
}

/**
 * Fold the committed events into state from genesis. This is the
 * authoritative state — a snapshot is only a cache over exactly this fold.
 */
export function replayToState(events: JournalEvent[], config: ReducerConfig): RunState {
  let state = initialState(config)
  for (const event of events) {
    state = reduceEvent(state, event as never, config)
  }
  return state
}

/** Write one snapshot atomically; returns the published path + hash. */
export async function writeSnapshot(
  runDir: string,
  state: RunState,
): Promise<{ path: string; stateHash: string }> {
  const stateHash = stateHashOf(state)
  const dir = join(runDir, SNAPSHOT_DIR)
  const name = snapshotFileName(state.seq, stateHash)
  const path = join(dir, name)
  const snapshot: StateSnapshot = {
    schemaVersion: 1,
    reducerVersion: REDUCER_VERSION,
    runId: state.runId,
    seq: state.seq,
    lastEventHash: state.lastEventHash,
    stateHash,
    state,
  }
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `${name}.tmp`)
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(`${canonicalJson(snapshot)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
  const dirHandle = await open(dir, 'r')
  try {
    await dirHandle.sync()
  } finally {
    await dirHandle.close()
  }
  return { path, stateHash }
}

/**
 * Find the newest usable snapshot: canonical bytes, exact field set, current
 * reducer version and run, a journal event at that seq with the same hash,
 * and a recorded state hash that still matches its own content. Snapshots
 * that fail any check are skipped, not trusted.
 */
export async function loadLatestSnapshot(
  runDir: string,
  config: ReducerConfig,
  committed: JournalEvent[],
): Promise<StateSnapshot | null> {
  const dir = join(runDir, SNAPSHOT_DIR)
  const names = (await readdir(dir).catch(() => [])).filter(
    (name) => name.startsWith('state-') && name.endsWith('.json'),
  )
  const bySeqDesc = names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  for (const name of bySeqDesc) {
    const snapshot = await parseSnapshot(join(dir, name))
    if (snapshot === null) continue
    if (snapshot.reducerVersion !== REDUCER_VERSION) continue
    if (snapshot.runId !== config.runId) continue
    const event = committed[snapshot.seq - 1]
    if (event === undefined) continue
    if (event.seq !== snapshot.seq || event.eventHash !== snapshot.lastEventHash) continue
    if (stateHashOf(snapshot.state) !== snapshot.stateHash) continue
    return snapshot
  }
  return null
}

/** Parse + structurally validate one snapshot file; null when unusable. */
async function parseSnapshot(path: string): Promise<StateSnapshot | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (text === null) return null
  let raw: unknown
  try {
    raw = parseCanonicalJson(text.endsWith('\n') ? text.slice(0, -1) : text)
  } catch {
    return null
  }
  const record = raw as Record<string, unknown> | null
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'lastEventHash,reducerVersion,runId,schemaVersion,seq,state,stateHash') return null
  if (record['schemaVersion'] !== 1) return null
  const seq = record['seq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null
  if (typeof record['lastEventHash'] !== 'string' || typeof record['stateHash'] !== 'string') {
    return null
  }
  const state = record['state'] as Record<string, unknown> | null
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return null
  for (const field of [
    'actions',
    'waves',
    'candidates',
    'observations',
    'rngReceipts',
    'budget',
    'budgetByAction',
    'externalJobs',
  ] as const) {
    const value = state[field]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  }
  if (state['runId'] !== record['runId']) return null
  return record as unknown as StateSnapshot
}

/**
 * Resolve the authoritative state: resume from a valid snapshot when one
 * matches the committed prefix, else replay from genesis. Either way the
 * same events are folded, so the result equals a full replay.
 */
export async function loadState(
  runDir: string,
  config: ReducerConfig,
  committed: JournalEvent[],
): Promise<{ state: RunState; resumedFromSnapshot: boolean; stateHash: string }> {
  const snapshot = await loadLatestSnapshot(runDir, config, committed)
  if (snapshot !== null) {
    let state = snapshot.state
    for (const event of committed.slice(state.seq)) {
      state = reduceEvent(state, event as never, config)
    }
    return { state, resumedFromSnapshot: true, stateHash: stateHashOf(state) }
  }
  const state = replayToState(committed, config)
  return { state, resumedFromSnapshot: false, stateHash: stateHashOf(state) }
}
