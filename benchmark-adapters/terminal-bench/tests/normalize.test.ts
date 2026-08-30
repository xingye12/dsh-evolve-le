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
    expect(trial?.outcome).toMatchObject({
      category: 'reward',
      reward: 1,
      agentParticipation: 'ran',
    })
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
      agentNeverInitialized: 0,
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

  it('agent never booted: FAIL in the denominator AND flagged never-initialized (Gate 8 defect)', async () => {
    // The exact shape of the lost Gate 8 pilot trials: the capsule entrypoint
    // died at `exec: node: not found` before one ACP byte, yet the verifier
    // still ran and scored 0. Reward-wise this MUST stay a FAIL (rule 7:
    // fail closed, nothing dropped) — but the machine fact "the agent never
    // spoke the protocol" must be classifiable, or a 10/10 infra-dead
    // baseline masquerades as a capability result.
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__neverboot', resultFile: 'never-booted.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome).toMatchObject({
      category: 'exception',
      reward: 0,
      exceptionType: 'NonZeroAgentExitCodeError',
      agentParticipation: 'never-initialized',
    })
    expect(artifact.trials[0]?.outcome.reason).toContain('exec: node: not found')
    expect(artifact.counts).toMatchObject({
      fail: 1,
      denominator: 1,
      passRate: 0,
      valid: true,
      agentNeverInitialized: 1,
    })
  })

  it('agent setup timeout: pre-launch infra (ADR-025), never-initialized, not a capability FAIL', async () => {
    // Harbor raises AgentSetupTimeoutError inside agent.setup() — the venv /
    // pip bootstrap that runs BEFORE the agent process is launched — so the
    // candidate cannot cause or influence it. It is the same pre-start phase
    // family as EnvironmentStartTimeoutError (specs/04 §6: "sandbox
    // provisioning 在 agent 启动前失败"), hence INFRA_RETRYABLE, and the
    // participation fact stays never-initialized so it can never masquerade
    // as a capability result. Observed live in two Gate 8 pilot attempts.
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__setupTimeout', resultFile: 'agent-setup-timeout.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('infra_retryable')
    expect(artifact.trials[0]?.outcome).toMatchObject({
      category: 'exception',
      exceptionType: 'AgentSetupTimeoutError',
      agentParticipation: 'never-initialized',
    })
    expect(artifact.counts).toMatchObject({
      fail: 0,
      infraRetryable: 1,
      valid: true,
      agentNeverInitialized: 1,
    })
  })

  it('clock skew: a negative agent_execution delta is unknown duration, never a poisoned observation', async () => {
    // Live Gate 8 attempt-6 defect: harbor stamps agent_execution from the
    // ACP agent container's clock, the verifier from the host's — the agent
    // finished 958ms BEFORE it started, the negative delta rode into the
    // observation, and the reducer's non-negative invariant bricked the
    // whole run root. Duration is usage metadata, never a reward fact: the
    // honest normalized value is null (unknown), and the trial classifies
    // exactly as the same-shaped nop would.
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__clockskew1', resultFile: 'agent-clock-skew.json' }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.status).toBe('fail')
    expect(artifact.trials[0]?.outcome).toMatchObject({ category: 'reward', reward: 0 })
    expect(artifact.trials[0]?.usage).toMatchObject({ agentExecutionMs: null, verifierMs: null })
    expect(artifact.counts).toMatchObject({ fail: 1, valid: true })
  })

  it('records without a result.json carry unknown participation', async () => {
    const { jobDir, identity } = await stageJob(
      [{ trialName: 'extract-elf__nores', withResult: false }],
      { handles: ['extract-elf'] },
    )
    const artifact = await normalizeJob(normalizeInput(jobDir, identity))
    expect(artifact.trials[0]?.outcome.agentParticipation).toBe('unknown')
    expect(artifact.counts.agentNeverInitialized).toBe(0)
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
