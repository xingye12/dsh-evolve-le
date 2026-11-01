import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { InvocationLog } from '../../src/execution/invocations.js'
import { publishCanonical } from '../../src/execution/evidence.js'
import { canonicalHash, canonicalJson } from '../../src/state/canonical.js'
describe('external effects intent/result replay', () => {
  it('deduplicates result and never blindly reexecutes an ambiguous shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'invocation-log-'))
    const store = await openObjectStore(join(root, 'cas'))
    let effects = 0
    try {
      const log = new InvocationLog({
        root: join(root, 'tools'),
        store,
        executionId: 'execution',
        maxCalls: 4,
        maxBytes: 4096,
      })
      const args = { command: 'echo hi' }
      const perform = async () => {
        effects++
        return { exitCode: 0 }
      }
      expect(await log.invoke('tool-1', 'shell', args, perform)).toEqual({ exitCode: 0 })
      const replay = new InvocationLog({
        root: join(root, 'tools'),
        store,
        executionId: 'execution',
        maxCalls: 4,
        maxBytes: 4096,
      })
      expect(await replay.invoke('tool-1', 'shell', args, perform)).toEqual({ exitCode: 0 })
      expect(effects).toBe(1)
      await replay.assertSettled()
      await expect(
        replay.invoke('tool-1', 'shell', { command: 'different' }, perform),
      ).rejects.toThrow(/args/)
      await publishCanonical(join(root, 'tools', 'tool-2', 'intent.json'), {
        executionId: 'execution',
        invocationId: 'tool-2',
        method: 'shell',
        argsDigest: canonicalHash(args),
        args: await store.put(Buffer.from(canonicalJson(args)), {
          mediaType: 'application/vnd.dsh-evolve-le.tool-arguments+json',
          label: 'DEV_OBSERVED',
        }),
        sequence: 2,
      })
      await expect(replay.assertSettled()).rejects.toThrow(/AMBIGUOUS/)
      await expect(replay.invoke('tool-2', 'shell', args, perform)).rejects.toThrow(/AMBIGUOUS/)
      expect(effects).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
