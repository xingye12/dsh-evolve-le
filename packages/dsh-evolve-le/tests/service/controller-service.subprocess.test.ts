/**
 * Gate 3 controller-service subprocess E2E (specs/07 §5 acceptance:
 * "controller unload flush 后无 worker/process handle"): run the built
 * controller-spike bin under plain Node against the real Cordis Loader
 * composition. The bin drives a full evaluation wave through the
 * `dshEvolveController` service, unloads the Loader (the service's async
 * flush disposer is awaited by dispose), and must
 *
 * - exit by itself with code 0 (a leaked worker/process handle would hang
 *   the event loop into the timeout);
 * - report the pre-boot and post-unload Cordis inventories and process
 *   handle censuses equal;
 * - leave the writer lock released and a snapshot covering the final seq.
 *
 * Requires `pnpm build` first; fails closed if the bin is missing.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

const binPath = fileURLToPath(new URL('../../lib/bin/controller-spike.js', import.meta.url))
const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url))

interface SpikeReport {
  config: string
  phases: {
    before: unknown
    afterBoot: unknown
    afterUnload: unknown
  }
  handles: { before: unknown; afterUnload: unknown }
  flush: {
    lockReleased: boolean
    snapshotFiles: string[]
    finalSeq: number
    actions: Array<{ actionId: string; status: string }>
    stateHash: string
  }
  quiescent: boolean
  error?: string
}

describe('controller-service unload flush (real Loader, plain Node)', () => {
  it('flushes on unload: lock released, snapshot durable, no leaked handle', async () => {
    expect(
      existsSync(binPath),
      `controller-spike bin missing: run \`pnpm build\` first (${binPath})`,
    ).toBe(true)
    const evidence = await mkdtemp(join(tmpdir(), 'dsh-ctl-spike-'))
    try {
      const { stdout } = await exec(
        process.execPath,
        [binPath, resolve(fixturesDir, 'cordis.controller-service.yml'), evidence],
        { timeout: 60_000, maxBuffer: 1 << 20 },
      )
      const report = JSON.parse(stdout) as SpikeReport

      expect(report.error).toBeUndefined()
      expect(report.quiescent).toBe(true)
      // Cordis inventory and process handles are back to the pre-boot state.
      expect(report.phases.afterUnload).toEqual(report.phases.before)
      expect(report.handles.afterUnload).toEqual(report.handles.before)
      // The service booted (its runtime registered) before unloading.
      expect(JSON.stringify(report.phases.afterBoot)).not.toBe(JSON.stringify(report.phases.before))
      // Flush artifacts on disk.
      expect(report.flush.lockReleased).toBe(true)
      expect(report.flush.snapshotFiles.length).toBeGreaterThan(0)
      expect(report.flush.actions).toEqual([
        { actionId: 'a1', status: 'COMMITTED' },
        { actionId: 'a2', status: 'COMMITTED' },
      ])
      expect(report.flush.stateHash).toMatch(/^[0-9a-f]{64}$/)
      expect(report.flush.finalSeq).toBeGreaterThan(0)
    } finally {
      await rm(evidence, { recursive: true, force: true })
    }
  })
})
