/**
 * Gate 0 process-level quiescence E2E: run the built loader-spike bin under
 * plain Node (no test transform, no tsx), boot the real Cordis Loader from the
 * fixture `cordis.yml`, unload, and assert from the OUTSIDE that
 *
 * - the process exits by itself (event loop drained: a leaked timer, socket,
 *   or referenced handle would hang it into the timeout) with code 0;
 * - the bin's own report says the post-unload Cordis inventory and process
 *   handle census equal the pre-boot snapshots;
 * - the negative default-export fixture fails at boot (exit 2) with the
 *   lost-`inject` error, proving the in-process negative result is not an
 *   artifact of the test runner.
 *
 * Requires `pnpm build` first; fails closed if the bin is missing.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)

const binPath = fileURLToPath(new URL('../lib/bin/loader-spike.js', import.meta.url))
const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const fixture = (name: string): string => resolve(fixturesDir, name)

interface SpikeReport {
  config: string
  phases: {
    before: unknown
    afterBoot: { services?: Array<{ name: string }> }
    afterUnload: unknown
  }
  handles: { before: unknown; afterUnload: unknown }
  timings: { bootMs: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

function runSpike(
  config: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return exec(process.execPath, [binPath, config], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
}

describe('loader-spike subprocess quiescence (plain Node, real Loader)', () => {
  it('exits naturally with quiescent inventories after unload', async () => {
    expect(
      existsSync(binPath),
      `loader-spike bin missing: run \`pnpm build\` first (${binPath})`,
    ).toBe(true)
    const { stdout } = await runSpike(fixture('cordis.baseline.yml'))
    const report = JSON.parse(stdout) as SpikeReport

    expect(report.error).toBeUndefined()
    expect(report.quiescent).toBe(true)
    expect(report.phases.afterUnload).toEqual(report.phases.before)
    expect(report.handles.afterUnload).toEqual(report.handles.before)
    expect(report.phases.afterBoot.services).toContainEqual({
      name: 'dshEvolveProbe',
      fiber: expect.any(String),
    })
    expect(report.timings.bootMs).toBeGreaterThan(0)
  })

  it('fails closed on the negative default-export fixture', async () => {
    expect(
      existsSync(binPath),
      `loader-spike bin missing: run \`pnpm build\` first (${binPath})`,
    ).toBe(true)
    const failure = await runSpike(fixture('cordis.negative.yml')).then(
      () => undefined,
      (error: { stdout?: string; stderr?: string; killed?: boolean; message: string }) => error,
    )
    expect(failure, 'the negative fixture must make the spike exit nonzero').toBeDefined()
    expect(failure?.killed, 'the spike must fail fast, not hang until the timeout').not.toBe(true)
    const report = JSON.parse(failure?.stdout ?? 'null') as SpikeReport | null
    expect(report, 'the failure report must be a parseable JSON document on stdout').not.toBeNull()
    expect(report?.error).toContain('cannot get property "dshEvolveProbe" without inject')
  })
})
