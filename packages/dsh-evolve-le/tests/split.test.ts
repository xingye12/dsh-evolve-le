/**
 * Split-ceremony contract tests (Gate 5, specs/04 §3, specs/06 §9).
 *
 * 89 pinned task handles are split deterministically into 48 observed /
 * 12 guard / 29 sealed from the 'split' RNG stream. The controller-visible
 * ceremony document must carry observed handles, opaque guard ids, the sealed
 * Merkle root and count — and nothing that identifies a sealed or guard task.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { runSplitCeremony, SPLIT_COUNTS, SPLIT_PROTOCOL } from '../src/split/ceremony.js'

const HANDLES = Array.from(
  { length: 89 },
  (_unused, index) => `task-${String(index + 1).padStart(3, '0')}`,
)

describe('split ceremony (specs/04 §3)', () => {
  it('default counts are 48/12/29 over the pinned 89-task set', () => {
    expect(SPLIT_COUNTS).toEqual({ observed: 48, guard: 12, sealed: 29 })
    expect(HANDLES).toHaveLength(89)
  })

  it('assigns every handle exactly once across the three splits', () => {
    const { ceremony, sealedStore } = runSplitCeremony({
      runId: 'split-test',
      masterSeed: 'seed-1',
      handles: HANDLES,
    })
    const all = [
      ...ceremony.observedHandles,
      ...sealedStore.guardHandles,
      ...sealedStore.sealedHandles,
    ]
    expect(new Set(all).size).toBe(89)
    expect(all.every((handle) => HANDLES.includes(handle))).toBe(true)
  })

  it('is deterministic for the same seed and population order-independent', () => {
    const a = runSplitCeremony({ runId: 'split-test', masterSeed: 'seed-1', handles: HANDLES })
    const b = runSplitCeremony({
      runId: 'split-test',
      masterSeed: 'seed-1',
      handles: [...HANDLES].reverse(),
    })
    expect(b.ceremony).toEqual(a.ceremony)
    expect(b.sealedStore).toEqual(a.sealedStore)
    const c = runSplitCeremony({ runId: 'split-test', masterSeed: 'seed-2', handles: HANDLES })
    expect(c.ceremony.sealedRoot).not.toBe(a.ceremony.sealedRoot)
  })

  it('conceals guard and sealed identities from the controller view', () => {
    const { ceremony } = runSplitCeremony({
      runId: 'split-test',
      masterSeed: 'seed-1',
      handles: HANDLES,
    })
    const serialized = JSON.stringify(ceremony)
    // No sealed store, no guard→handle mapping, only opaque ids surface.
    expect(ceremony.guardOpaqueIds).toHaveLength(12)
    expect(ceremony.guardOpaqueIds.every((id) => /^guard-[0-9]{2}$/.test(id))).toBe(true)
    expect(ceremony.sealedCount).toBe(29)
    expect(serialized).not.toContain('"guardHandles"')
    expect(serialized).not.toContain('"sealedHandles"')
    // Every observed handle is a real handle; no observed handle leaks into
    // the sealed or guard stores.
    expect(ceremony.observedHandles).toHaveLength(48)
    const { sealedStore } = runSplitCeremony({
      runId: 'split-test',
      masterSeed: 'seed-1',
      handles: HANDLES,
    })
    for (const handle of ceremony.observedHandles) {
      expect(sealedStore.sealedHandles).not.toContain(handle)
      expect(Object.values(sealedStore.guardMap)).not.toContain(handle)
    }
  })

  it('sealed root is the merkle root over the sealed handles', () => {
    const { ceremony, sealedStore } = runSplitCeremony({
      runId: 'split-test',
      masterSeed: 'seed-1',
      handles: HANDLES,
    })
    // leaf = sha256(handle), parents = sha256(left || right), odd node paired
    // with itself.
    let level = [...sealedStore.sealedHandles]
      .sort()
      .map((handle) => createHash('sha256').update(handle, 'utf8').digest('hex'))
    while (level.length > 1) {
      const next: string[] = []
      for (let index = 0; index < level.length; index += 2) {
        const left = level[index]!
        const right = index + 1 < level.length ? level[index + 1]! : left
        next.push(createHash('sha256').update(`${left}${right}`, 'utf8').digest('hex'))
      }
      level = next
    }
    expect(ceremony.sealedRoot).toBe(level[0])
  })

  it('receipt carries protocol, dataset input hash and seed commitment', () => {
    const { ceremony } = runSplitCeremony({
      runId: 'split-test',
      masterSeed: 'seed-1',
      handles: HANDLES,
    })
    expect(ceremony.protocol).toBe(SPLIT_PROTOCOL)
    expect(ceremony.runId).toBe('split-test')
    // Commitment binds the master seed to the dataset and protocol without
    // revealing the seed (specs/04 §3.3).
    const expectedCommitment = createHash('sha256')
      .update(`seed-1\0${ceremony.datasetInputHash}\0${SPLIT_PROTOCOL}`)
      .digest('hex')
    expect(ceremony.seedCommitment).toBe(expectedCommitment)
  })

  it('fails closed on a population that cannot fill the splits', () => {
    expect(() =>
      runSplitCeremony({ runId: 'r', masterSeed: 's', handles: HANDLES.slice(0, 88) }),
    ).toThrow(/population/)
  })
})
