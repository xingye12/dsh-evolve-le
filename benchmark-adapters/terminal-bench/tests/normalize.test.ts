/**
 * Normalizer contract tests (Gate 2, specs/07 §4; CLAUDE.md rule 7): the
 * committed fixture TrialResults model every outcome class the acceptance
 * names — golden (reward 1 → pass), nop (reward 0 → fail), broken agent
 * (timeout exception → fail), broken environment (pre-registered infra
 * exception → infra_retryable), missing reward (→ fail), missing result.json
 * (→ fail, never dropped), wrong capsule attribution (→ protocol_invalid,
 * run invalid), and an unplanned extra trial (→ plan-mismatch). Plus the
 * re-parse determinism contract: normalizing the same raw directory twice
 * from scratch yields the identical artifact hash.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeJob, type RunArtifact } from '../src/normalize.js'
import { ACP_AGENT_ID } from '../src/registry.js'

const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

const FIXTURES = join(import.meta.dirname, 'fixtures/trial-results')
const CAPSULE = 'a'.repeat(64)
const INVENTORY = 'b'.repeat(64)

interface StageOptions {
  resultFile?: string
  withResult?: boolean
  /** Harbor writes agent/trajectory.json for every completed agent turn. */
  withTrajectory?: boolean
  trialName: string
  handle?: string
}

/** Assemble a synthetic Harbor job directory from committed fixtures. */
async function stageJob(
  stages: StageOptions[],
  options: { handles: string[]; attempts?: number },
): Promise<{ jobDir: string; identity: RunArtifact['identity'] }> {
  const jobDir = await freshScratch('dsh-norm-job-')
  for (const stage of stages) {
    const trialDir = join(jobDir, stage.trialName)
    await mkdir(trialDir, { recursive: true })
    const config = JSON.parse(await readFile(join(FIXTURES, 'trial-config.json'), 'utf8')) as {
      task: { path: string }
      trial_name: string
    }
    config.task.path = `/tasks/${stage.handle ?? 'extract-elf'}`
    config.trial_name = stage.trialName
    await writeFile(join(trialDir, 'config.json'), JSON.stringify(config))
    if ((stage.withResult ?? true) && stage.resultFile !== undefined) {
      const raw = JSON.parse(await readFile(join(FIXTURES, stage.resultFile), 'utf8')) as Record<
        string,
        unknown
      >
      raw['trial_name'] = stage.trialName
      const taskPath = `/tasks/${stage.handle ?? 'extract-elf'}`
      ;(raw as { task_id?: { path?: string } }).task_id = { path: taskPath }
      await writeFile(join(trialDir, 'result.json'), JSON.stringify(raw, null, 2))
    }
    if (stage.withTrajectory ?? true) {
      await mkdir(join(trialDir, 'agent'), { recursive: true })
      await writeFile(
        join(trialDir, 'agent', 'trajectory.json'),
        await readFile(join(FIXTURES, 'trajectory.json')),
      )
    }
  }
  return {
    jobDir,
    identity: {
      runId: 'gate2-dev',
      capsuleArchiveSha256: CAPSULE,
      inventorySha256: INVENTORY,
      handles: options.handles,
      attempts: options.attempts ?? 1,
      harborVersion: '0.21.0',
    },
  }
}

function normalizeInput(jobDir: string, identity: RunArtifact['identity']) {
  return {
    jobDir,
    jobName: 'dsh-fixture',
    idempotencyKey: 'c'.repeat(64),
    identity,
  }
}

describe('trial normalization — outcome classes', () => {
  it('golden: reward 1 passes and carries usage/reconciliation fields', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__golden1', resultFile: 'golden.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    const trial = artifact.trials[0]
    expect(trial?.status).toBe('pass')
    expect(trial?.outcome).toMatchObject({ category: 'reward', reward: 1 })
    expect(trial?.agentInfo).toEqual({ name: ACP_AGENT_ID, version: CAPSULE })
    expect(trial?.usage).toMatchObject({
      agentExecutionMs: 40_000,
      verifierMs: 12_000,
      nInputTokens: 1200,
      nOutputTokens: 340,
      costUsd: 0.0021,
    })
    expect(trial?.resultDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(artifact.counts).toMatchObject({
      pass: 1,
      fail: 0,
      infraRetryable: 0,
      protocolInvalid: 0,
      valid: true,
      denominator: 1,
      passRate: 1,
    })
  })

  it('nop: reward 0 fails (stays in the denominator)', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__nop0001', resultFile: 'nop.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome).toMatchObject({ category: 'reward', reward: 0 })
    expect(artifact.counts).toMatchObject({ fail: 1, denominator: 1, passRate: 0, valid: true })
  })

  it('broken agent: timeout exception is a candidate-attributable FAIL', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__broken1', resultFile: 'broken-agent.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome).toMatchObject({
      category: 'exception',
      exceptionType: 'AgentTimeoutError',
    })
    expect(artifact.counts.valid).toBe(true)
  })

  it('broken environment: pre-registered infra exception is INFRA_RETRYABLE, not FAIL', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__envfail', resultFile: 'env-infra.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('infra_retryable')
    expect(artifact.trials[0]?.outcome).toMatchObject({
      exceptionType: 'EnvironmentStartTimeoutError',
    })
    expect(artifact.counts).toMatchObject({ fail: 0, infraRetryable: 1, valid: true })
  })

  it('missing reward key: FAIL by default, never dropped', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__noreward', resultFile: 'no-reward.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome.category).toBe('missing-reward')
  })

  it('missing trajectory: explicit FAIL — a completed turn without ATIF evidence is unauditable', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__notraj', resultFile: 'nop.json', withTrajectory: false }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome).toMatchObject({
      category: 'missing-trajectory',
      reward: 0,
    })
    expect(artifact.counts).toMatchObject({ denominator: 1, fail: 1, valid: true })
  })

  it('exception trials keep their classification without a trajectory (no agent turn ran)', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__envfail', resultFile: 'env-infra.json', withTrajectory: false }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('infra_retryable')
    expect(artifact.trials[0]?.outcome.category).toBe('exception')
  })

  it('missing result.json: FAIL recorded with the trial name', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__nores', withResult: false }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome.category).toBe('missing-result')
    expect(artifact.trials[0]?.trialName).toBe('extract-elf__nores')
    expect(artifact.counts).toMatchObject({ denominator: 1, fail: 1, valid: true })
  })

  it('missing trial directory: synthesized FAIL keeps the denominator whole', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__nop0001', resultFile: 'nop.json' }],
      { handles: ['extract-elf'], attempts: 2 },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.plannedTrials).toBe(2)
    expect(artifact.trials).toHaveLength(2)
    expect(artifact.trials[1]?.outcome.category).toBe('missing-trial')
    expect(artifact.trials[1]?.trialName).toBeNull()
    expect(artifact.counts).toMatchObject({ denominator: 2, fail: 2, valid: true, passRate: 0 })
  })

  it('wrong capsule version: PROTOCOL_INVALID and the whole run is invalid', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__wrongcap', resultFile: 'wrong-capsule.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('protocol_invalid')
    expect(artifact.trials[0]?.outcome.category).toBe('attribution')
    expect(artifact.counts.valid).toBe(false)
    expect(artifact.counts.passRate).toBeNull()
  })

  it('unplanned extra trial: plan-mismatch PROTOCOL_INVALID', async () => {
    const { jobDir, identity } = await stageJob(
      [
        { trialName: 'extract-elf__golden1', resultFile: 'golden.json' },
        { trialName: 'some-other-task__zzz', resultFile: 'golden.json', handle: 'some-other-task' },
      ],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    const extra = artifact.trials.find((trial) => trial.identity.handle === 'some-other-task')
    expect(extra?.status).toBe('protocol_invalid')
    expect(extra?.outcome.category).toBe('plan-mismatch')
    expect(artifact.counts.valid).toBe(false)
  })

  it('unattributable trial dir (no config.json): plan-mismatch, kept not dropped', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__golden1', resultFile: 'golden.json' }],
      { handles: ['extract-elf'] },
    )
    await mkdir(join(jobDir, 'mystery__trial'))
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    const mystery = artifact.trials.find((trial) =>
      trial.identity.handle.startsWith('unattributed:'),
    )
    expect(mystery?.status).toBe('protocol_invalid')
    expect(artifact.counts.valid).toBe(false)
  })
})

describe('normalizer determinism', () => {
  it('re-parsing the same raw job dir from scratch yields the identical hash', async () => {
    const { jobDir, identity } = await stageJob(
      [
        { trialName: 'extract-elf__golden1', resultFile: 'golden.json' },
        { trialName: 'extract-elf__nop0001', resultFile: 'nop.json' },
      ],
      { handles: ['extract-elf'], attempts: 2 },
    )
    const first = await normalizeJob(normalizeInput(jobDir, identity))
    const second = await normalizeJob(normalizeInput(jobDir, identity))
    expect(second.artifactSha256).toBe(first.artifactSha256)
    expect(second.artifactSha256).toMatch(/^[0-9a-f]{64}$/)
    // The canonical document is what the digest covers: stable, key-sorted.
    expect(JSON.stringify(second.trials) === JSON.stringify(first.trials)).toBe(true)
  })
})
