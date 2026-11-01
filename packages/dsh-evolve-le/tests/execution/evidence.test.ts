import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openObjectStore, objectPath } from '../../src/state/object-store.js'
import { openExecutionEvidence } from '../../src/execution/evidence.js'
import { makeSpec } from './fixtures.js'
const roots: string[] = []
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true })
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'execution-evidence-'))
  roots.push(root)
  const store = await openObjectStore(join(root, 'cas'))
  const facts = await store.put(Buffer.from('{}'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  const spec = makeSpec()
  spec.inputs = [facts]
  spec.policy = facts
  spec.reservation = facts
  spec.gateway = { route: facts, authorization: facts }
  return { root, store, facts, spec }
}
describe('durable execution evidence', () => {
  it('keeps failed committed execution distinct from cleanup and reopens same bundle', async () => {
    const { root, store, facts, spec } = await setup()
    const e = await openExecutionEvidence(root, store, spec)
    await e.record('RESERVED', 'reservation', facts)
    await e.record('STOPPED', 'no-target', facts)
    await e.record('EXPORTED', 'failure-export', facts)
    const ref = await e.commit('FAILED', [facts], 'provisioning failed')
    await e.record('COMMITTED', 'manifest-published', ref)
    await e.record('CLEANED', 'cleanup', facts)
    const replay = await openExecutionEvidence(root, store, spec)
    expect(await replay.committed()).toEqual(ref)
    expect(replay.phase).toBe('CLEANED')
    expect(await replay.commit('FAILED', [facts], 'provisioning failed')).toEqual(ref)
  })
  it('rejects skipped success, illegal transitions and duplicate launch', async () => {
    const { root, store, facts, spec } = await setup()
    const e = await openExecutionEvidence(root, store, spec)
    await expect(e.record('RUNNING', 'start', facts)).rejects.toThrow(/transition/)
    await e.record('RESERVED', 'reservation', facts)
    await expect(e.commit('SUCCEEDED', [])).rejects.toThrow()
    await e.record('STOPPED', 'no-target', facts)
    await e.record('EXPORTED', 'failure-export', facts)
    await expect(e.commit('SUCCEEDED', [])).rejects.toThrow(/RUNNING/)
  })
  it('detects changed spec and corruption of any reachable artifact', async () => {
    const { root, store, facts, spec } = await setup()
    const e = await openExecutionEvidence(root, store, spec)
    await e.record('RESERVED', 'reservation', facts)
    await e.record('STOPPED', 'no-target', facts)
    await e.record('EXPORTED', 'failure-export', facts)
    await e.commit('FAILED', [facts], 'failed')
    const other = structuredClone(spec)
    other.maxElapsedMs++
    await expect(openExecutionEvidence(root, store, other)).rejects.toThrow(/conflict/)
    await writeFile(objectPath(store.root, facts.digest), 'corrupt')
    await expect(openExecutionEvidence(root, store, spec)).rejects.toThrow()
  })
})
