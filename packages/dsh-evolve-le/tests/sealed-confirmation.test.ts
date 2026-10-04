/** Contract for the independent, non-promoting y2-style confirmation path. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeProvider } from '../src/controller/provider.js'
import { sealedConfirm, SEALED_CONFIRMATION_PROTOCOL } from '../src/sealed/confirmation.js'
import { generateSealedPlan } from '../src/sealed/plan.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class RecordingProvider extends FakeProvider {
  readonly requests: unknown[] = []
  override async launch(request: unknown, key: string): Promise<{ externalJobId: string }> {
    this.requests.push(request)
    return super.launch(request, key)
  }
}

function plan(runId = 'confirmation-1') {
  return generateSealedPlan({
    runId,
    masterSeed: 'confirmation-test-seed',
    baselineId: 'baseline',
    taskIds: ['sealed-01', 'sealed-02'],
    kSealed: 1,
    budget: { wallClockMinutes: 10, usdMicros: 1_000_000, solverTokens: 1_000_000 },
  })
}

describe('sealed confirmation', () => {
  it('runs only the fixed baseline and challenger, persists an immutable non-promoting result, and resumes', async () => {
    const jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-confirmation-'))
    dirs.push(jobsRoot)
    const provider = new RecordingProvider({ outcome: 'success' })
    const input = {
      runId: 'confirmation-1',
      masterSeed: 'confirmation-test-seed',
      plan: plan(),
      baselineId: 'baseline',
      candidateId: 'y2',
      provider,
      jobsRoot,
      concurrency: 2,
      clock: () => '2026-01-01T00:00:00.000Z',
    }

    const first = await sealedConfirm(input)
    expect(first.protocol).toBe('dsh-evolve-le/sealed-confirmation-results/v1')
    expect(first.disposition).toBe('CONFIRMATION_COMPLETE_NO_PROMOTION')
    expect(first.candidateId).toBe('y2')
    expect(provider.counters.launchEffects).toHaveLength(4)
    expect(provider.requests.map((request) => (request as { candidateId: string }).candidateId).sort()).toEqual([
      'baseline',
      'baseline',
      'y2',
      'y2',
    ])
    expect(JSON.parse(await readFile(join(jobsRoot, 'confirmation-manifest.json'), 'utf8'))).toMatchObject({
      protocol: SEALED_CONFIRMATION_PROTOCOL,
      promotion: false,
      candidateId: 'y2',
    })

    await sealedConfirm(input)
    expect(provider.counters.launchEffects).toHaveLength(4)
  })

  it('fails before a paid effect when the plan identity does not bind the fixed baseline', async () => {
    const jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-confirmation-'))
    dirs.push(jobsRoot)
    const provider = new RecordingProvider({ outcome: 'success' })
    await expect(sealedConfirm({
      runId: 'confirmation-1',
      masterSeed: 'confirmation-test-seed',
      plan: plan(),
      baselineId: 'another-baseline',
      candidateId: 'y2',
      provider,
      jobsRoot,
      concurrency: 1,
    })).rejects.toThrow('manifest/plan identity mismatch')
    expect(provider.counters.launchEffects).toHaveLength(0)
  })
})
