/**
 * Harbor BenchmarkProvider adapter contract tests (Gate 5, specs/07 §7):
 * the controller port implemented over planning + a real `harbor run` spawn.
 * The harbor binary is stubbed at the runner seam with a fake that
 * materializes the terminal job directory from the generated JobConfig — the
 * planning, ledger, status-probe, and normalization paths are the real ones.
 *
 * Pins (CLAUDE.md rules 7–8):
 * - launch is idempotent per controller key: one harbor spawn, ever.
 * - a second controller key on the same paid identity fails closed.
 * - guard launches resolve opaque ids through the TCB-only guard map.
 * - protocol-invalid jobs throw on collect instead of scoring quietly.
 * - collect is pure re-normalization: repeated calls return identical bytes.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ACP_AGENT_ID,
  HarborProvider,
  SubmissionLedger,
  TERMINAL_FACT_PROTOCOL,
} from '../src/index.js'

const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

const CAPSULE = 'a'.repeat(64)
const GUARD_TASKS = join(import.meta.dirname, 'fixtures/tasks')

interface TrialScript {
  reward?: number
  /** Override agent_info.version to force a protocol-invalid attribution. */
  agentVersion?: string
  exceptionType?: string
  costUsd?: number | null
  dropTrajectory?: boolean
}

/**
 * Fake `harbor run`: read the generated JobConfig, then lay down the terminal
 * job directory exactly as harbor 0.21.0 would — job-level result.json as the
 * terminal marker, one trial directory attributed through its config.json.
 */
function fakeHarbor(script: TrialScript = {}) {
  const runs: string[] = []
  const runner = async (configPath: string, jobDir: string): Promise<void> => {
    runs.push(configPath)
    const config = parseYaml(await readFile(configPath, 'utf8')) as {
      tasks: { path: string }[]
      agents: { kwargs: { registry_entry: { version: string } } }[]
    }
    const taskPath = config.tasks[0]?.path ?? ''
    const capsule = script.agentVersion ?? config.agents[0]?.kwargs.registry_entry.version ?? ''
    const trialName = 'trial-01-abcdef'
    const trialDir = join(jobDir, trialName)
    await mkdir(trialDir, { recursive: true })
    await writeFile(
      join(trialDir, 'config.json'),
      JSON.stringify({ task: { path: taskPath }, agent: { name: 'acp' } }),
      'utf8',
    )
    await writeFile(
      join(trialDir, 'result.json'),
      JSON.stringify({
        task_name: taskPath.split('/').pop(),
        trial_name: trialName,
        agent_info: { name: ACP_AGENT_ID, version: capsule },
        verifier_result: { rewards: { reward: script.reward ?? 1 } },
        exception_info:
          script.exceptionType === undefined ? null : { exception_type: script.exceptionType },
        agent_result: {
          n_input_tokens: 1000,
          n_output_tokens: 200,
          cost_usd: script.costUsd === null || script.costUsd === undefined ? null : script.costUsd,
        },
        agent_execution: {
          started_at: '2026-01-01T00:00:00Z',
          finished_at: '2026-01-01T00:01:40Z',
        },
        verifier: { started_at: '2026-01-01T00:01:40Z', finished_at: '2026-01-01T00:02:00Z' },
      }),
      'utf8',
    )
    if (script.dropTrajectory !== true) {
      await mkdir(join(trialDir, 'agent'), { recursive: true })
      await writeFile(
        join(trialDir, 'agent', 'trajectory.json'),
        JSON.stringify({ steps: [{ role: 'agent', content: 'ok' }] }),
        'utf8',
      )
    }
    await writeFile(join(jobDir, 'result.json'), JSON.stringify({ trials: 1 }), 'utf8')
  }
  return { runner, runs }
}

async function stageTask(tasksRoot: string, handle: string): Promise<void> {
  await mkdir(join(tasksRoot, handle), { recursive: true })
  await writeFile(
    join(tasksRoot, handle, 'task.toml'),
    await readFile(join(GUARD_TASKS, 'alpha/task.toml'), 'utf8'),
  )
}

async function newProvider(script?: TrialScript) {
  const tasksRoot = await freshScratch('dsh-hp-tasks-')
  await stageTask(tasksRoot, 'alpha')
  await stageTask(tasksRoot, 'beta')
  const jobsRoot = await freshScratch('dsh-hp-jobs-')
  const ledger = new SubmissionLedger(join(jobsRoot, 'ledger.jsonl'))
  const harbor = fakeHarbor(script)
  const provider = new HarborProvider({
    runId: 'gate5-test',
    harborBin: 'harbor',
    harborVersion: '0.21.0',
    tasksRoot,
    jobsRoot,
    concurrentTrials: 1,
    ledger,
    guardMap: { 'guard-01': 'beta' },
    runHarbor: harbor.runner,
  })
  provider.registerCapsule('baseline', {
    capsuleArchiveSha256: CAPSULE,
    archiveUrl: 'https://172.17.0.1:8443/artifacts/capsule.tar.gz',
  })
  return { provider, harbor, jobsRoot }
}

const REQUEST = {
  candidateId: 'baseline',
  opaqueTaskId: 'alpha',
  attempt: 1,
  split: 'dev-observed' as const,
}

describe('HarborProvider launch', () => {
  it('plans one job per evaluation action and spawns harbor exactly once', async () => {
    const { provider, harbor } = await newProvider()
    const { externalJobId } = await provider.launch(REQUEST, 'eval-a1')
    expect(externalJobId).toMatch(/^dsh-[0-9a-f]{24}$/)
    expect(harbor.runs).toHaveLength(1)
    expect(provider.launchEffects).toEqual([externalJobId])
  })

  it('re-launch with the same controller key re-uses the job (no second spawn)', async () => {
    const { provider, harbor } = await newProvider()
    const first = await provider.launch(REQUEST, 'eval-a1')
    const second = await provider.launch(REQUEST, 'eval-a1')
    expect(second.externalJobId).toBe(first.externalJobId)
    expect(harbor.runs).toHaveLength(1)
  })

  it('fails closed when a different action hits an already-paid identity', async () => {
    const { provider } = await newProvider()
    await provider.launch(REQUEST, 'eval-a1')
    await expect(provider.launch(REQUEST, 'eval-a2')).rejects.toThrow(/paid identity collision/)
  })

  it('fails closed on unknown candidates, second attempts, and bad requests', async () => {
    const { provider } = await newProvider()
    await expect(provider.launch({ ...REQUEST, candidateId: 'ghost' }, 'eval-g1')).rejects.toThrow(
      /no registered capsule/,
    )
    await expect(provider.launch({ ...REQUEST, attempt: 2 }, 'eval-a2')).rejects.toThrow(
      /one paid trial per/,
    )
    await expect(provider.launch({ candidateId: 'baseline' }, 'eval-x')).rejects.toThrow(
      /not an evaluation request/,
    )
  })
})

describe('HarborProvider guard concealment', () => {
  it('resolves guard opaque ids through the TCB-only guard map', async () => {
    const { provider, jobsRoot } = await newProvider()
    const { externalJobId } = await provider.launch(
      { ...REQUEST, opaqueTaskId: 'guard-01', split: 'dev-guard' },
      'eval-g1',
    )
    // The ledger (TCB evidence) records the real handle; the controller-side
    // request and the terminal fact never do.
    const text = await readFile(join(jobsRoot, 'ledger.jsonl'), 'utf8')
    expect(text).toContain('"beta"')
    expect(text).not.toContain('guard-01')
    const terminal = await provider.collect(externalJobId)
    const fact = terminal.trajectory.toString('utf8')
    // The fact carries the opaque id the controller named…
    expect(fact).toContain('guard-01')
    // …and never the real guard handle.
    expect(fact).not.toContain('beta')
    expect(JSON.parse(fact).trial.taskName).toBe('guard-01')
  })

  it('fails closed when no guard mapping exists', async () => {
    const { provider } = await newProvider()
    await expect(
      provider.launch({ ...REQUEST, opaqueTaskId: 'guard-99', split: 'dev-guard' }, 'eval-g2'),
    ).rejects.toThrow(/no guard mapping/)
  })
})

describe('HarborProvider inspect', () => {
  it('reports RUNNING then SUCCEEDED from the job directory alone', async () => {
    const { provider } = await newProvider()
    // Reserve without running harbor: the plan exists, the job dir is empty.
    const pre = await provider.inspectByKey('eval-a1')
    expect(pre).toBeNull()
    const { externalJobId } = await provider.launch(REQUEST, 'eval-a1')
    expect(await provider.inspect(externalJobId)).toEqual({ status: 'SUCCEEDED' })
    expect(await provider.inspectByKey('eval-a1')).toEqual({
      externalJobId,
      status: 'SUCCEEDED',
    })
    expect(await provider.inspect('dsh-nonexistent')).toEqual({ status: 'UNKNOWN' })
  })
})

describe('HarborProvider collect', () => {
  it('folds the single trial into the controller terminal fact', async () => {
    const { provider } = await newProvider({ reward: 1, costUsd: 0.0125 })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-a1')
    const terminal = await provider.collect(externalJobId)
    expect(terminal.outcome).toBe('success')
    expect(terminal.costUsdMicros).toBe(12_500)
    expect(terminal.durationMs).toBe(100_000)
    const fact = JSON.parse(terminal.trajectory.toString('utf8')) as {
      protocol: string
      trial: { status: string; outcome: { reward: number } }
    }
    expect(fact.protocol).toBe(TERMINAL_FACT_PROTOCOL)
    expect(fact.trial.status).toBe('pass')
    expect(fact.trial.outcome.reward).toBe(1)
  })

  it('maps verifier failure and infra-retryable trials to reward-less outcomes', async () => {
    const failing = await newProvider({ reward: 0 })
    const failJob = await failing.provider.launch(REQUEST, 'eval-f1')
    expect((await failing.provider.collect(failJob.externalJobId)).outcome).toBe('failure')

    const infra = await newProvider({ exceptionType: 'EnvironmentStartTimeoutError' })
    const infraJob = await infra.provider.launch(REQUEST, 'eval-i1')
    expect((await infra.provider.collect(infraJob.externalJobId)).outcome).toBe('missing')
  })

  it('throws on protocol-invalid jobs instead of scoring them', async () => {
    const { provider } = await newProvider({ agentVersion: 'f'.repeat(64) })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-bad')
    await expect(provider.collect(externalJobId)).rejects.toThrow(/protocol-invalid/)
  })

  it('is pure re-normalization: repeated collects return identical bytes', async () => {
    const { provider } = await newProvider()
    const { externalJobId } = await provider.launch(REQUEST, 'eval-a1')
    const first = await provider.collect(externalJobId)
    const second = await provider.collect(externalJobId)
    expect(second.trajectory.toString('utf8')).toBe(first.trajectory.toString('utf8'))
    expect(second.outcome).toBe(first.outcome)
  })

  it('fails closed on unknown jobs', async () => {
    const { provider } = await newProvider()
    await expect(provider.collect('dsh-doesnotexist')).rejects.toThrow(/unknown job/)
  })
})
