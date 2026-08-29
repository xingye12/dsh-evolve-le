/**
 * Snapshot contract tests (Gate 3, specs/06 §5): a snapshot is only a cache.
 * Resume-from-snapshot must equal full replay; corrupt, stale, foreign, or
 * hash-mismatched snapshots are skipped and genesis replay takes over.
 */
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { replayEvents, stateHashOf } from '../../src/state/reducer.js'
import { SNAPSHOT_DIR, loadState, writeSnapshot } from '../../src/state/snapshot.js'
import { openScenario, runEvaluationAction } from './helpers.js'

async function committedScenario(prefix: string) {
  const opened = await openScenario(prefix)
  await opened.scenario.emit('run.phase.changed', { to: 'PREFLIGHT', reason: 'test' })
  await opened.scenario.emit('wave.planned', {
    waveId: 'w1',
    split: 'dev-observed',
    members: ['a1', 'a2'],
  })
  for (let index = 1; index <= 2; index += 1) {
    await runEvaluationAction(opened.scenario, {
      actionId: `a${index}`,
      waveId: 'w1',
      candidateId: `cand-${index}`,
      opaqueTaskId: `task-${index}`,
      outcome: index === 1 ? 'success' : 'timeout',
    })
  }
  return opened
}

describe('snapshot equivalence', () => {
  it('resume from snapshot equals full replay', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-eq-')
    const events = await scenario.state()
    const full = replayEvents(events as never, scenario.reducerConfig)
    const written = await writeSnapshot(scenario.runDir, full)
    expect(written.stateHash).toBe(stateHashOf(full))
    // More events after the snapshot: resume folds the tail on top.
    await scenario.emit('run.phase.changed', { to: 'CALIBRATED', reason: 'calibrated' })
    const tail = await scenario.state()
    const resumed = await loadState(scenario.runDir, scenario.reducerConfig, tail)
    const replayed = await loadState(scenario.runDir, scenario.reducerConfig, tail)
    expect(resumed.resumedFromSnapshot).toBe(true)
    expect(resumed.stateHash).toBe(stateHashOf(replayEvents(tail as never, scenario.reducerConfig)))
    expect(resumed.state).toEqual(replayEvents(tail as never, scenario.reducerConfig))
    void replayed
    await scenario.close()
    await cleanup()
  })

  it('snapshots are canonical single-line documents under snapshots/', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-fmt-')
    const events = await scenario.state()
    const state = replayEvents(events as never, scenario.reducerConfig)
    const { path } = await writeSnapshot(scenario.runDir, state)
    expect(path.startsWith(join(scenario.runDir, SNAPSHOT_DIR))).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.trimEnd().split('\n')).toHaveLength(1)
    expect(text).toContain('"reducerVersion":"dsh-evolve-le/reducer/v1"')
    await scenario.close()
    await cleanup()
  })
})

describe('snapshot fallback (never trust, always verify)', () => {
  it('falls back to genesis replay when no snapshot exists', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-none-')
    const events = await scenario.state()
    const loaded = await loadState(scenario.runDir, scenario.reducerConfig, events)
    expect(loaded.resumedFromSnapshot).toBe(false)
    expect(loaded.stateHash).toBe(
      stateHashOf(replayEvents(events as never, scenario.reducerConfig)),
    )
    await scenario.close()
    await cleanup()
  })

  it('skips a corrupt snapshot file', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-corrupt-')
    const events = await scenario.state()
    const state = replayEvents(events as never, scenario.reducerConfig)
    const { path } = await writeSnapshot(scenario.runDir, state)
    await writeFile(path, '{"schemaVersion":1,"reducerVersion":"dsh-evolve-le/reducer/v1"')
    const loaded = await loadState(scenario.runDir, scenario.reducerConfig, events)
    expect(loaded.resumedFromSnapshot).toBe(false)
    expect(loaded.stateHash).toBe(stateHashOf(state))
    await scenario.close()
    await cleanup()
  })

  it('skips a snapshot whose state content was tampered with', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-tamper-')
    const events = await scenario.state()
    const state = replayEvents(events as never, scenario.reducerConfig)
    const { path } = await writeSnapshot(scenario.runDir, state)
    // Flip the phase inside the snapshot: hash no longer covers content.
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"phase":"PREFLIGHT"', '"phase":"RELEASED"'))
    const loaded = await loadState(scenario.runDir, scenario.reducerConfig, events)
    expect(loaded.resumedFromSnapshot).toBe(false)
    expect(loaded.state.phase).toBe('PREFLIGHT')
    await scenario.close()
    await cleanup()
  })

  it('ignores a snapshot from a shorter journal prefix (stale tail)', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-stale-')
    const events = await scenario.state()
    const state = replayEvents(events as never, scenario.reducerConfig)
    await writeSnapshot(scenario.runDir, state)
    // Truncate the committed view (e.g. HEAD was rolled back): the snapshot
    // seq no longer resolves to a committed event → genesis replay.
    const truncated = events.slice(0, 3)
    const loaded = await loadState(scenario.runDir, scenario.reducerConfig, truncated)
    expect(loaded.resumedFromSnapshot).toBe(false)
    expect(loaded.state.seq).toBe(3)
    await scenario.close()
    await cleanup()
  })

  it('snapshot files are never rewritten in place', async () => {
    const { scenario, cleanup } = await committedScenario('dsh-snap-immutable-')
    const events = await scenario.state()
    const state = replayEvents(events as never, scenario.reducerConfig)
    const first = await writeSnapshot(scenario.runDir, state)
    await scenario.emit('run.phase.changed', { to: 'CALIBRATED', reason: 'calibrated' })
    const tailEvents = await scenario.state()
    const nextState = replayEvents(tailEvents as never, scenario.reducerConfig)
    const second = await writeSnapshot(scenario.runDir, nextState)
    expect(second.path).not.toBe(first.path)
    const earlier = await readFile(first.path, 'utf8')
    expect(earlier).toContain('"phase":"PREFLIGHT"')
    await rm(second.path)
    await scenario.close()
    await cleanup()
  })
})
