import { afterAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cleanupFixtureDirs,
  fakeBridge,
  fakeSandboxRunner,
  makeDriver,
  newRun,
  HANDLES,
} from './fixture.js'
import { FakeProvider } from '../../src/controller/provider.js'
import { canonicalHash } from '../../src/state/canonical.js'
import { runSplitCeremony } from '../../src/split/ceremony.js'
import type { ObjectRef } from '../../src/state/object-store.js'
afterAll(cleanupFixtureDirs)
describe('v4 driver lifecycle and parent export', () => {
  it('exports snapshot-bound parent reports and overviews, replays with no expansion attribution calls', async () => {
    const fx = await newRun('dsh-driver-debugger-v4-', { maxSolverTrials: 10 })
    fx.config.agentDebugger = {
      protocol: 'v4',
      route: fx.config.modelRoutes[0]!.id,
      maxInputBytes: 16384,
      maxOutputTokens: 1024,
      requestTimeoutMs: 10000,
    }
    fx.config.budget.attributionCalls = 1
    fx.config.budget.attributionTokens = 10000
    fx.configHash = 'sha256:' + canonicalHash(fx.config)
    const provider = new FakeProvider({ outcome: 'failure' })
    const runner = fakeSandboxRunner()
    const driver = makeDriver(fx, provider, fakeBridge(), runner, {
      failureAttributor: {
        async attribute() {
          throw Error('expansion attribution forbidden')
        },
      },
    })
    const report = await driver.drive()
    expect(report.stopReason).toBe('K_REACHED')
    expect(runner.exportDirs).toHaveLength(1)
    const manifest = JSON.parse(
      await readFile(join(runner.exportDirs[0]!, 'manifest.json'), 'utf8'),
    ) as { objects: (ObjectRef & { path: string })[] }
    const indexRef = manifest.objects.find(
      (r) => r.mediaType === 'application/vnd.dsh-evolve-le.failure-index+json',
    )!
    const index = JSON.parse(await readFile(join(runner.exportDirs[0]!, indexRef.path), 'utf8'))
    expect(index.protocol).toBe('dsh-evolve-le/failure-index/v4')
    expect(index.overviewDigest).toMatch(/^sha256:/)
    expect(index.entries).toHaveLength(2)
    expect(
      index.entries.every(
        (e: { candidateId: string }) => e.candidateId === index.subjectCandidateId,
      ),
    ).toBe(true)
    const overviewRef = manifest.objects.find((r) => `sha256:${r.digest}` === index.overviewDigest)!
    const overview = JSON.parse(
      await readFile(join(runner.exportDirs[0]!, overviewRef.path), 'utf8'),
    )
    expect(overview.observationWatermark).toBe(index.observationWatermark)
    expect(overview.failedTrials).toBe(2)
    expect(
      manifest.objects.filter(
        (r) => r.mediaType === 'application/vnd.dsh-evolve-le.failure-report+json',
      ),
    ).toHaveLength(2)
    expect(manifest.objects.some((r) => r.label === 'DEV_GUARD' || r.label === 'SEALED')).toBe(
      false,
    )
    const before = provider.counters.launchEffects.length
    const replay = await driver.drive()
    expect(replay.trials).toBe(report.trials)
    expect(provider.counters.launchEffects).toHaveLength(before)
    expect(runner.exportDirs).toHaveLength(1)
    const runManifest = JSON.parse(await readFile(join(fx.runRoot, 'run-manifest.json'), 'utf8'))
    expect(runManifest.debuggerProfile).toMatchObject({ maxEvents: 60, maxInstances: 12 })
    expect(runManifest.debuggerProtocol).toBe('dsh-evolve-le/agent-debugger/v4')
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    expect(JSON.stringify(overview)).not.toContain(ceremony.ceremony.guardOpaqueIds[0])
  }, 120000)
})
