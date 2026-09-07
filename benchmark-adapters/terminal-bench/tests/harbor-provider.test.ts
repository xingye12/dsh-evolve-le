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
 * - a second attempt is its own paid identity (ADR-046): distinct ledger key
 *   and job, still n_attempts: 1 (one Harbor job = one trial).
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

  it('rejects unknown candidates and malformed requests; each attempt is its own paid identity (ADR-046)', async () => {
    const { provider, harbor } = await newProvider()
    await expect(provider.launch({ ...REQUEST, candidateId: 'ghost' }, 'eval-g1')).rejects.toThrow(
      /no registered capsule/,
    )
    await expect(provider.launch({ candidateId: 'baseline' }, 'eval-x')).rejects.toThrow(
      /not an evaluation request/,
    )
    await expect(provider.launch({ ...REQUEST, attempt: 0 }, 'eval-a0')).rejects.toThrow(
      /positive safe integer/,
    )
    // ADR-046 (49×2 matrix): attempt 2 is a DISTINCT paid identity — its own
    // ledger key and its own job — while one Harbor job stays one task × one
    // attempt (n_attempts: 1, preserving the one-job-one-trial invariant).
    const a1 = await provider.launch(REQUEST, 'eval-a1')
    const a2 = await provider.launch({ ...REQUEST, attempt: 2 }, 'eval-a2')
    expect(a2.externalJobId).not.toBe(a1.externalJobId)
    expect(harbor.runs).toHaveLength(2)
    // Re-launch with the same controller key + attempt re-uses the job.
    const again = await provider.launch({ ...REQUEST, attempt: 2 }, 'eval-a2')
    expect(again.externalJobId).toBe(a2.externalJobId)
    expect(harbor.runs).toHaveLength(2)
    const config = parseYaml(await readFile(harbor.runs[1]!, 'utf8')) as { n_attempts?: number }
    expect(config.n_attempts ?? 1).toBe(1)
    // A different action key on the SAME attempt still collides (fail closed).
    await expect(provider.launch({ ...REQUEST, attempt: 2 }, 'eval-a3')).rejects.toThrow(
      /paid identity collision/,
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

describe('HarborProvider solve gateway (ADR-030)', () => {
  const ROUTE_HASH = 'b'.repeat(64)
  const TOKEN_VALUE = 'd'.repeat(64)

  /** Verification fact shaped exactly like core's verifySolveReceipts result. */
  const verification = (over: Partial<{ ok: boolean; problems: string[] }> = {}) => ({
    ok: over.ok ?? true,
    problems: over.problems ?? [],
    requests: 2,
    errorReceipts: 1,
    usage: {
      requests: 2,
      promptTokens: 82,
      completionTokens: 14,
      totalTokens: 96,
      costUsdMicros: 456,
    },
  })

  async function newSolveProvider(
    script: TrialScript = {},
    solveUsage?: (jobName: string) => Promise<unknown>,
    nativeRoute?: { provider: string; model: string; maxTokens?: number },
  ) {
    const tasksRoot = await freshScratch('dsh-hp-solve-tasks-')
    await stageTask(tasksRoot, 'alpha')
    const jobsRoot = await freshScratch('dsh-hp-solve-jobs-')
    const ledger = new SubmissionLedger(join(jobsRoot, 'ledger.jsonl'))
    const harbor = fakeHarbor(script)
    const stateDir = join(jobsRoot, 'solve-gateway')
    const enrollments: string[] = []
    const tokenWrites: string[] = []
    const provider = new HarborProvider({
      runId: 'gate5-solve',
      harborBin: 'harbor',
      harborVersion: '0.21.0',
      tasksRoot,
      jobsRoot,
      concurrentTrials: 1,
      ledger,
      runHarbor: harbor.runner,
      mounts: [{ source: '/host/ca.crt', target: '/etc/ssl/certs/dsh-ca.crt' }],
      env: { SSL_CERT_FILE: '/etc/ssl/certs/dsh-ca.crt' },
      solveGateway: {
        routeId: 'deepseek/zen-compatible',
        ...(nativeRoute === undefined ? {} : { nativeProvider: nativeRoute.provider }),
        ...(nativeRoute === undefined ? {} : { nativeModel: nativeRoute.model }),
        ...(nativeRoute?.maxTokens === undefined ? {} : { nativeMaxTokens: nativeRoute.maxTokens }),
        url: 'https://172.17.0.1:8443',
        routeHash: ROUTE_HASH,
        containerTokenPath: '/run/dsh-solve/token',
        // Idempotent enrollment, mirroring openSolveGateway.enrollTrial: the
        // token file is written once and reused on every later call.
        enroll: async (jobName: string) => {
          enrollments.push(jobName)
          const tokensDir = join(stateDir, 'tokens')
          await mkdir(tokensDir, { recursive: true })
          const tokenFilePath = join(tokensDir, `${jobName}.token`)
          const existing = await readFile(tokenFilePath, 'utf8').catch(() => null)
          if (existing === null) {
            tokenWrites.push(jobName)
            await writeFile(tokenFilePath, `${TOKEN_VALUE}\n`, 'utf8')
          }
          return { tokenFilePath }
        },
      },
      solveUsage: solveUsage ?? (async () => verification()),
    })
    provider.registerCapsule('baseline', {
      capsuleArchiveSha256: CAPSULE,
      archiveUrl: 'https://172.17.0.1:8443/artifacts/capsule.tar.gz',
    })
    return { provider, harbor, jobsRoot, enrollments, tokenWrites }
  }

  it('mounts the per-trial token and the task-derived agent deadline read-only/evidenced', async () => {
    const { provider, jobsRoot, tokenWrites } = await newSolveProvider()
    const { externalJobId } = await provider.launch(REQUEST, 'eval-s1')
    expect(tokenWrites).toEqual([externalJobId])

    const yaml = await readFile(join(jobsRoot, '.plans', `${externalJobId}.yaml`), 'utf8')
    const round = parseYaml(yaml) as {
      environment: {
        mounts: { source: string; target: string; read_only: boolean }[]
        env: Record<string, string>
      }
    }
    const tokenMount = round.environment.mounts.find(
      (mount) => mount.target === '/run/dsh-solve/token',
    )
    expect(tokenMount).toEqual({
      type: 'bind',
      source: join(jobsRoot, 'solve-gateway', 'tokens', `${externalJobId}.token`),
      target: '/run/dsh-solve/token',
      read_only: true,
    })
    expect(Object.keys(round.environment.env).sort()).toEqual([
      'DSH_SOLVE_AGENT_TIMEOUT_MS',
      'DSH_SOLVE_GATEWAY_ROUTE_HASH',
      'DSH_SOLVE_GATEWAY_TOKEN_FILE',
      'DSH_SOLVE_GATEWAY_URL',
      'SSL_CERT_FILE',
    ])
    // alpha's TB `[agent].timeout_sec = 600`; Harbor applies the frozen 3x
    // multiplier, and the capsule will reserve its own teardown allowance.
    expect(round.environment.env['DSH_SOLVE_AGENT_TIMEOUT_MS']).toBe('1800000')
    // CLAUDE.md rule 8: the token VALUE never reaches the job config.
    expect(yaml).not.toContain(TOKEN_VALUE)
  })

  it('passes the frozen native DSH route to live trials without exposing credentials', async () => {
    const { provider, jobsRoot } = await newSolveProvider({}, undefined, {
      provider: 'zen-compatible',
      model: 'deepseek-v4-flash',
      maxTokens: 131072,
    })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-native-env')
    const yaml = await readFile(join(jobsRoot, '.plans', `${externalJobId}.yaml`), 'utf8')
    const round = parseYaml(yaml) as { environment: { env: Record<string, string> } }
    expect(round.environment.env).toMatchObject({
      DSH_NATIVE_PROVIDER: 'zen-compatible',
      DSH_NATIVE_MODEL: 'deepseek-v4-flash',
      DSH_NATIVE_MAX_TOKENS: '131072',
    })
    expect(yaml).not.toContain(TOKEN_VALUE)
  })

  it('re-launch enrolls no second token and spawns harbor once', async () => {
    const { provider, harbor, tokenWrites } = await newSolveProvider()
    const first = await provider.launch(REQUEST, 'eval-s1')
    const second = await provider.launch(REQUEST, 'eval-s1')
    expect(second.externalJobId).toBe(first.externalJobId)
    expect(harbor.runs).toHaveLength(1)
    // Enrollment is idempotent per jobName: one token file, ever.
    expect(tokenWrites).toEqual([first.externalJobId])
  })

  it('collect appends the receipt-verified solver block and settles solverTokens', async () => {
    const { provider } = await newSolveProvider({ reward: 1, costUsd: 0.02 })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-s2')
    const terminal = await provider.collect(externalJobId)
    expect(terminal.solverTokens).toBe(96)
    const fact = JSON.parse(terminal.trajectory.toString('utf8')) as {
      solver: {
        routeId: string
        routeHash: string
        requests: number
        promptTokens: number
        completionTokens: number
        totalTokens: number
        costUsdMicros: number
        errorReceipts: number
        problems: string[]
      }
    }
    expect(fact.solver).toEqual({
      routeId: 'deepseek/zen-compatible',
      routeHash: ROUTE_HASH,
      requests: 2,
      promptTokens: 82,
      completionTokens: 14,
      totalTokens: 96,
      costUsdMicros: 456,
      errorReceipts: 1,
      problems: [],
    })
    // Byte-stable across repeated collects (no timestamps, no gateway memory).
    const again = await provider.collect(externalJobId)
    expect(again.trajectory.toString('utf8')).toBe(terminal.trajectory.toString('utf8'))
  })

  it('a never-booted trial (env-start timeout) collects a zero-usage solver block, not a throw (F6)', async () => {
    // K=10 attempt 1: a trial that died EnvironmentStartTimeoutError never ran
    // the ACP handshake, so it can never have called the gateway — the
    // receipts file legitimately does not exist. The solver block records the
    // honest zero (the driver still classifies the observation 'missing'
    // infra-dead per ADR-028); the fail-closed throw stays reserved for trials
    // whose agent DID run. ADR-040 receipt-first: the never-booted record only
    // downgrades a FAILED chain (missing file) to the honest zero.
    const { provider } = await newSolveProvider(
      { exceptionType: 'EnvironmentStartTimeoutError' },
      async () =>
        verification({ ok: false, problems: ['receipts file missing: receipts/dsh-f6.jsonl'] }),
    )
    const { externalJobId } = await provider.launch(REQUEST, 'eval-f6')
    const terminal = await provider.collect(externalJobId)
    expect(terminal.outcome).toBe('missing')
    expect(terminal.solverTokens).toBe(0)
    const fact = JSON.parse(terminal.trajectory.toString('utf8')) as {
      trial: { outcome: { agentParticipation: string } }
      solver: { requests: number; totalTokens: number; problems: string[] }
    }
    expect(fact.trial.outcome.agentParticipation).toBe('never-initialized')
    expect(fact.solver).toMatchObject({ requests: 0, totalTokens: 0, problems: [] })
    // Byte-stable across repeated collects, like every other terminal fact.
    const again = await provider.collect(externalJobId)
    expect(again.trajectory.toString('utf8')).toBe(terminal.trajectory.toString('utf8'))
  })

  it('a KILLED live trial yields its full receipt figures, not the heuristic zero (ADR-040)', async () => {
    // Attempt 13: AgentTimeoutError at 45 min — Harbor's kill discards the
    // capsule report (no ACP initialize record), so the participation
    // heuristic says 'never-initialized', but the gateway recorded every
    // request. The verified chain is the authority: full figures settle.
    const { provider } = await newSolveProvider({ exceptionType: 'AgentTimeoutError' })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-killed')
    const terminal = await provider.collect(externalJobId)
    const fact = JSON.parse(terminal.trajectory.toString('utf8')) as {
      trial: { outcome: { agentParticipation: string } }
      solver: {
        routeId: string
        routeHash: string
        requests: number
        promptTokens: number
        completionTokens: number
        totalTokens: number
        costUsdMicros: number
        errorReceipts: number
        problems: string[]
      }
    }
    // The heuristic still records what Harbor saw; the chain still settles.
    expect(fact.trial.outcome.agentParticipation).toBe('never-initialized')
    expect(fact.solver).toEqual({
      routeId: 'deepseek/zen-compatible',
      routeHash: ROUTE_HASH,
      requests: 2,
      promptTokens: 82,
      completionTokens: 14,
      totalTokens: 96,
      costUsdMicros: 456,
      errorReceipts: 1,
      problems: [],
    })
    expect(terminal.solverTokens).toBe(96)
    // Byte-stable across repeated collects, like every other terminal fact.
    const again = await provider.collect(externalJobId)
    expect(again.trajectory.toString('utf8')).toBe(terminal.trajectory.toString('utf8'))
  })

  it('a ran trial still fails closed on a missing receipts file (F6 converse)', async () => {
    // The zero-usage carve-out is gated on the participation fact, not on
    // "collect would fail": a trial whose agent answered the ACP handshake
    // MUST have receipts, and their absence is an attribution failure.
    const { provider } = await newSolveProvider({ reward: 1 }, async () =>
      verification({ ok: false, problems: ['receipts file missing: receipts/dsh-x.jsonl'] }),
    )
    const { externalJobId } = await provider.launch(REQUEST, 'eval-f6b')
    await expect(provider.collect(externalJobId)).rejects.toThrow(
      /solver receipts failed verification: receipts file missing/,
    )
  })

  it('collect fails closed when the receipt chain does not verify', async () => {
    const tasksRoot = await freshScratch('dsh-hp-gap-tasks-')
    await stageTask(tasksRoot, 'alpha')
    const jobsRoot = await freshScratch('dsh-hp-gap-jobs-')
    const provider = new HarborProvider({
      runId: 'gate5-gap',
      harborBin: 'harbor',
      harborVersion: '0.21.0',
      tasksRoot,
      jobsRoot,
      concurrentTrials: 1,
      ledger: new SubmissionLedger(join(jobsRoot, 'ledger.jsonl')),
      runHarbor: fakeHarbor().runner,
      solveGateway: {
        routeId: 'deepseek/zen-compatible',
        url: 'https://172.17.0.1:8443',
        routeHash: ROUTE_HASH,
        containerTokenPath: '/run/dsh-solve/token',
        enroll: async (jobName: string) => ({
          tokenFilePath: join(jobsRoot, 'solve-gateway', 'tokens', `${jobName}.token`),
        }),
      },
      solveUsage: async () =>
        verification({ ok: false, problems: ['receipts/dsh-x.jsonl: sequence gap at req-2'] }),
    })
    provider.registerCapsule('baseline', {
      capsuleArchiveSha256: CAPSULE,
      archiveUrl: 'https://172.17.0.1:8443/artifacts/capsule.tar.gz',
    })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-g1')
    await expect(provider.collect(externalJobId)).rejects.toThrow(
      /solver receipts failed verification: .*sequence gap/,
    )
  })

  it('unconfigured stays byte-identical to the replay behavior (solverTokens null, no solver key)', async () => {
    const { provider } = await newProvider({ reward: 1 })
    const { externalJobId } = await provider.launch(REQUEST, 'eval-a1')
    const terminal = await provider.collect(externalJobId)
    expect(terminal.solverTokens).toBeNull()
    const fact = JSON.parse(terminal.trajectory.toString('utf8')) as Record<string, unknown>
    expect('solver' in fact).toBe(false)
  })

  it('rejects half-configured solve wiring at construction', async () => {
    const tasksRoot = await freshScratch('dsh-hp-half-tasks-')
    await stageTask(tasksRoot, 'alpha')
    const jobsRoot = await freshScratch('dsh-hp-half-jobs-')
    const base = {
      runId: 'gate5-half',
      harborBin: 'harbor',
      harborVersion: '0.21.0',
      tasksRoot,
      jobsRoot,
      concurrentTrials: 1,
      ledger: new SubmissionLedger(join(jobsRoot, 'ledger.jsonl')),
      runHarbor: fakeHarbor().runner,
    }
    expect(
      () =>
        new HarborProvider({
          ...base,
          solveGateway: {
            routeId: 'deepseek/zen-compatible',
            url: 'https://172.17.0.1:8443',
            routeHash: ROUTE_HASH,
            containerTokenPath: '/run/dsh-solve/token',
            enroll: async (jobName: string) => ({
              tokenFilePath: join(jobsRoot, 'solve-gateway', 'tokens', `${jobName}.token`),
            }),
          },
        }),
    ).toThrow(/solveUsage is missing/)
    expect(() => new HarborProvider({ ...base, solveUsage: async () => verification() })).toThrow(
      /solveGateway is missing/,
    )
  })
})
