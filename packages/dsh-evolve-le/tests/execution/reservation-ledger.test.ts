import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { PersistentResourceAdmission } from '../../src/execution/reservation-ledger.js'
import { makeSpec } from './fixtures.js'
describe('cross-process executor resource ledger', () => {
  it('admits one concurrent proposal, reserves independent test resources and survives reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resource-ledger-'))
    const cap = {
      slots: 1,
      memoryBytes: 1024 * 1024 * 1024,
      cpuMillis: 4000,
      pids: 1000,
      bytes: 1024 * 1024 * 1024,
      inodes: 10000,
    }
    const pools = { proposal: cap, test: cap, validator: cap }
    try {
      const a = new PersistentResourceAdmission({ root, pools }),
        b = new PersistentResourceAdmission({ root, pools })
      const first = makeSpec(),
        second = makeSpec()
      second.executionId = 'second'
      const result = await Promise.all([a.reserve(first), b.reserve(second)])
      expect(result.filter(Boolean)).toHaveLength(1)
      const winner = result[0] ? first : second,
        loser = result[0] ? second : first
      expect(await new PersistentResourceAdmission({ root, pools }).reserve(winner)).toBe(true)
      expect(await b.reserve(loser)).toBe(false)
      const test = makeSpec()
      test.executionId = 'test'
      test.kind = 'test'
      delete test.gateway
      test.mounts = test.mounts.filter((m) => m.target !== '/gateway')
      expect(await b.reserve(test)).toBe(true)
      await a.release(winner.executionId)
      await a.release(winner.executionId)
      expect(await b.reserve(loser)).toBe(true)
      await expect(
        b.reserve({ ...loser, limits: { ...loser.limits, pids: loser.limits.pids + 1 } }),
      ).rejects.toThrow(/drift/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
