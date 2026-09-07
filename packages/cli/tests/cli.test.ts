/**
 * CLI contract tests (Gate 5, specs/07 §7 Accept): the closed loop behind one
 * command, driven as real subprocesses through the bin entry.
 *
 * Pins:
 * - `init` freezes a validated config + the 89-handle population and refuses
 *   to overwrite a frozen run root;
 * - `run --provider fake` reaches propose → build (REAL trusted builder) →
 *   REAL one-shot sandbox → evaluate → stop at K, exit 0;
 * - `resume` re-runs nothing: the controller journal is byte-identical and
 *   the drive report is unchanged (repeat submit duplicates nothing);
 * - `status` reads only durable evidence and works in a fresh process both
 *   before and after the run;
 * - `audit` re-derives every frozen document and fails closed on tampering;
 * - preflight failures (missing credential) stop `run` BEFORE any state is
 *   created or effect attempted, with the complete finding list.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inspectNativeDshRuntime } from '../../dsh-evolve-le/src/builder/staging.js'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const CLI_MAIN = join(repoRoot, 'packages', 'cli', 'src', 'main.ts')
const BASELINE_SOURCE = join(repoRoot, 'packages', 'candidate-baseline')
const DSH_SOURCE = join(repoRoot, 'deepseek-harness')
const exec = promisify(execFile)
const suppliedNativeCatalog = process.env.DSH_NATIVE_TEST_CATALOG_ROOT
const defaultNativeCatalog = '/tmp/dsh-native-materialize-current'
const nativeCatalogRoot =
  suppliedNativeCatalog !== undefined && suppliedNativeCatalog.length > 0
    ? suppliedNativeCatalog
    : defaultNativeCatalog
const nativeTestEnabled = existsSync(join(nativeCatalogRoot, 'package.json'))
const proposalWorkerIdentityAvailable =
  existsSync('/usr/bin/setpriv') &&
  spawnSync('/usr/bin/setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', 'true'], {
    stdio: 'ignore',
    timeout: 10_000,
  }).status === 0

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface NativeDshLock {
  catalogRoot: string
  dependencyClosureSha256: string
}

let nativeDshLock: NativeDshLock | undefined

async function materializeNativeDshCatalog(): Promise<NativeDshLock> {
  if (nativeTestEnabled) {
    const inspectionRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-native-inspection-'))
    dirs.push(inspectionRoot)
    const runtime = await inspectNativeDshRuntime(nativeCatalogRoot, inspectionRoot)
    return {
      catalogRoot: runtime.catalogRoot,
      dependencyClosureSha256: runtime.dependencyClosureSha256,
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-native-catalog-'))
  const catalogRoot = join(root, 'catalog')
  const inspectionRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-native-inspection-'))
  dirs.push(root, inspectionRoot)
  await cp(DSH_SOURCE, catalogRoot, {
    recursive: true,
    dereference: false,
    filter: (source) =>
      !source.endsWith('/.git') &&
      !source.includes('/.git/') &&
      !source.endsWith('/node_modules') &&
      !source.includes('/node_modules/'),
  })
  await exec('pnpm', ['install', '--offline', '--frozen-lockfile'], {
    cwd: catalogRoot,
    timeout: 570_000,
    maxBuffer: 32 << 20,
  })
  await exec('pnpm', ['run', 'build:lib'], {
    cwd: catalogRoot,
    timeout: 570_000,
    maxBuffer: 32 << 20,
  })
  const runtime = await inspectNativeDshRuntime(catalogRoot, inspectionRoot)
  return {
    catalogRoot: runtime.catalogRoot,
    dependencyClosureSha256: runtime.dependencyClosureSha256,
  }
}

beforeAll(async () => {
  nativeDshLock = nativeTestEnabled
    ? await materializeNativeDshCatalog()
    : { catalogRoot: '', dependencyClosureSha256: '' }
}, 570_000)

function nativeDshArgs(): string[] {
  if (nativeDshLock === undefined) throw new Error('native DSH catalog has not been materialized')
  return [
    '--native-dsh-catalog-root',
    nativeDshLock.catalogRoot,
    '--native-dsh-closure-sha256',
    nativeDshLock.dependencyClosureSha256,
  ]
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function cli(args: readonly string[]): Promise<CliResult> {
  const outputRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-output-'))
  dirs.push(outputRoot)
  const stdoutPath = join(outputRoot, 'stdout')
  const stderrPath = join(outputRoot, 'stderr')
  const stdoutFile = await open(stdoutPath, 'w')
  const stderrFile = await open(stderrPath, 'w')
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx/esm', CLI_MAIN, ...args], {
        cwd: repoRoot,
        stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
      })
      child.once('error', reject)
      child.once('close', (exitCode) => resolve(exitCode ?? 1))
    })
    await Promise.all([stdoutFile.close(), stderrFile.close()])
    return {
      code,
      stdout: await readFile(stdoutPath, 'utf8'),
      stderr: await readFile(stderrPath, 'utf8'),
    }
  } catch (error) {
    await Promise.all([stdoutFile.close(), stderrFile.close()])
    return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
  }
}

async function makeTasksRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cli-tasks-'))
  dirs.push(root)
  for (let index = 1; index <= 89; index += 1) {
    const handle = `task-${String(index).padStart(3, '0')}`
    await mkdir(join(root, handle), { recursive: true })
    await writeFile(join(root, handle, 'task.toml'), '[task]\nname = "synthetic"\n')
  }
  return root
}

async function journalBytes(controllerDir: string): Promise<string> {
  const files: string[] = []
  for (const entry of await readdir(controllerDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entry.name)
  }
  files.sort()
  let all = ''
  for (const name of files) all += await readFile(join(controllerDir, name), 'utf8')
  return all
}

describe.skipIf(!nativeTestEnabled)('dsh-evolve CLI', () => {
  let runsRoot: string
  let tasksRoot: string
  let jobsRoot: string
  let credential: string
  const runId = 'cli-e2e'
  const runRoot = () => join(runsRoot, runId)
  const initArgs = () => [
    'init',
    '--runs-root',
    runsRoot,
    '--run-id',
    runId,
    '--master-seed',
    'cli-e2e-master-seed',
    '--tasks-root',
    tasksRoot,
    '--baseline-source',
    BASELINE_SOURCE,
    '--jobs-root',
    jobsRoot,
    ...nativeDshArgs(),
    '--credential-file',
    credential,
    '--set',
    'kTarget=1',
    '--set',
    'maxDiscoveryTrials=2',
    '--set',
    'discoveryBatchSize=2',
    '--set',
    'maxSolverTrials=4',
  ]

  beforeAll(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-runs-'))
    jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-jobs-'))
    credential = join(runsRoot, 'zen.key')
    await writeFile(credential, 'PLACEHOLDER—zen route is not used by the recorded proposer\n', {
      mode: 0o600,
    })
    await chmod(credential, 0o600)
    dirs.push(runsRoot, jobsRoot)
    tasksRoot = await makeTasksRoot()
  })

  it('init freezes config + handles; a second init refuses to overwrite', async () => {
    const first = await cli(initArgs())
    expect(first.code).toBe(0)
    const summary = JSON.parse(first.stdout) as { configHash: string; handles: number }
    expect(summary.handles).toBe(89)
    expect(summary.configHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(existsSync(join(runRoot(), 'run.config.json'))).toBe(true)
    expect(existsSync(join(runRoot(), 'dataset-handles.json'))).toBe(true)

    const second = await cli(initArgs())
    expect(second.code).toBe(2)
    expect(second.stderr).toContain('already exists')
  })

  it('status before any run is durable-evidence-only and graceful', async () => {
    const status = await cli(['status', '--run-root', runRoot()])
    expect(status.code).toBe(0)
    const doc = JSON.parse(status.stdout) as {
      manifestFrozen: boolean
      controller: unknown
      configHash: string
    }
    expect(doc.manifestFrozen).toBe(false)
    expect(doc.controller).toBeNull()
    expect(doc.configHash).toMatch(/^sha256:/)
  })

  it.skipIf(proposalWorkerIdentityAvailable)(
    'refuses to launch a fake-provider proposal as root when uid drop is unavailable',
    async () => {
      const run = await cli([
        'run',
        '--run-root',
        runRoot(),
        '--provider',
        'fake',
        '--fake-failure-period',
        '2',
      ])
      expect(run.code).toBe(2)
      expect(run.stderr).toContain('proposal-worker-identity')
      expect(existsSync(join(runRoot(), 'controller'))).toBe(false)
      expect(existsSync(join(runRoot(), 'run-manifest.json'))).toBe(false)
    },
  )

  it.skipIf(!proposalWorkerIdentityAvailable)(
    'run --provider fake reaches K through the real builder and sandbox',
    async () => {
      const run = await cli([
        'run',
        '--run-root',
        runRoot(),
        '--provider',
        'fake',
        '--fake-failure-period',
        '2',
      ])
      expect(run.code).toBe(0)
      const report = JSON.parse(run.stdout) as {
        stopReason: string
        phase: string
        trials: number
        admittedNonBaseline: number
        expansionAttempts: number
        failurePool: string[]
        stateHash: string
      }
      // The 2nd fake trial fails → pool frozen; one real expansion admits a
      // child (real sandbox + trusted rebuild); Gate 6 semantics: K stops only
      // after the child's q0 cold-start trial from the frozen pool.
      expect(report.stopReason).toBe('K_REACHED')
      expect(report.phase).toBe('SEARCHING')
      expect(report.trials).toBe(3)
      expect(report.admittedNonBaseline).toBe(1)
      expect(report.expansionAttempts).toBe(1)
      expect(report.failurePool).toHaveLength(1)
      expect(report.stateHash).toMatch(/^[0-9a-f]{64}$/)
    },
    570_000,
  )

  it.skipIf(!proposalWorkerIdentityAvailable)(
    'resume duplicates nothing: journal bytes and report are unchanged',
    async () => {
      const before = await journalBytes(join(runRoot(), 'controller'))
      const reportBefore = await readFile(join(runRoot(), 'drive-report.json'), 'utf8')

      const resume = await cli([
        'resume',
        '--run-root',
        runRoot(),
        '--provider',
        'fake',
        '--fake-failure-period',
        '2',
      ])
      expect(resume.code).toBe(0)
      const report = JSON.parse(resume.stdout) as { stopReason: string; trials: number }
      expect(report.stopReason).toBe('K_REACHED')
      expect(report.trials).toBe(3)

      const after = await journalBytes(join(runRoot(), 'controller'))
      expect(after).toBe(before)
      const reportAfter = await readFile(join(runRoot(), 'drive-report.json'), 'utf8')
      expect(reportAfter).toBe(reportBefore)
    },
    570_000,
  )

  it.skipIf(!proposalWorkerIdentityAvailable)(
    'status after the run replays the journal in a fresh process',
    async () => {
      const status = await cli(['status', '--run-root', runRoot()])
      expect(status.code).toBe(0)
      const doc = JSON.parse(status.stdout) as {
        phase: string
        stopReason: string
        admittedNonBaseline: number
        controller: { stateHash: string; observationCount: number; phase: string } | null
      }
      expect(doc.stopReason).toBe('K_REACHED')
      expect(doc.phase).toBe('SEARCHING')
      expect(doc.admittedNonBaseline).toBe(1)
      expect(doc.controller?.observationCount).toBe(3)
      expect(doc.controller?.stateHash).toMatch(/^[0-9a-f]{64}$/)
    },
  )

  it.skipIf(!proposalWorkerIdentityAvailable)(
    'audit passes on the honest run root and fails closed on tampering',
    async () => {
      const audit = await cli(['audit', '--run-root', runRoot()])
      expect(audit.code).toBe(0)
      expect(audit.stdout).toContain('✓ split-ceremony-rederives')
      expect(audit.stdout).toContain('✓ manifest-config-hash')
      expect(audit.stdout).toContain('✓ drive-report-state-hash')
      expect(audit.stdout).not.toContain('✗')

      // Tampered copy: a forged failure pool must not audit clean.
      const tampered = join(runsRoot, 'cli-e2e-tampered')
      await rm(tampered, { recursive: true, force: true })
      await cp(runRoot(), tampered, { recursive: true })
      const poolPath = join(tampered, 'failure-pool.json')
      const pool = JSON.parse(await readFile(poolPath, 'utf8')) as { handles: string[] }
      pool.handles.push('task-999')
      await writeFile(poolPath, `${JSON.stringify(pool, null, 2)}\n`)
      const failed = await cli(['audit', '--run-root', tampered])
      expect(failed.code).toBe(1)
      expect(failed.stdout).toContain('✗ failure-pool-hash')
    },
    570_000,
  )

  it('doctor lists every failed check and run fails closed before any state', async () => {
    // A run root whose credential file has been removed since init.
    const brokenRoot = join(runsRoot, 'cli-e2e-broken')
    await mkdir(brokenRoot, { recursive: true })
    await cp(join(runRoot(), 'run.config.json'), join(brokenRoot, 'run.config.json'))
    await cp(join(runRoot(), 'dataset-handles.json'), join(brokenRoot, 'dataset-handles.json'))
    await rm(credential, { force: true })

    const doctor = await cli(['doctor', '--run-root', brokenRoot, '--provider', 'fake'])
    expect(doctor.code).toBe(1)
    expect(doctor.stdout).toContain('✗ credential:')

    const run = await cli(['run', '--run-root', brokenRoot, '--provider', 'fake'])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('preflight failed')
    expect(run.stderr).toContain('credential:')
    // Fail-closed means no run state was created at all.
    expect(existsSync(join(brokenRoot, 'controller'))).toBe(false)
    expect(existsSync(join(brokenRoot, 'run-manifest.json'))).toBe(false)

    // Restore the credential for any later assertions.
    await writeFile(credential, 'PLACEHOLDER—zen route is not used by the recorded proposer\n', {
      mode: 0o600,
    })
  })

  it('unknown commands and malformed init fail closed with usage', async () => {
    const unknown = await cli(['frobnicate'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown command')

    const short = await exec('node', ['--version'])
    expect(short.stdout.trim().length).toBeGreaterThan(0)
    const badInit = await cli([
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      'bad-handle-count',
      '--master-seed',
      'cli-e2e-master-seed',
      '--tasks-root',
      jobsRoot, // no task.toml dirs
      '--baseline-source',
      BASELINE_SOURCE,
      '--jobs-root',
      jobsRoot,
      ...nativeDshArgs(),
    ])
    expect(badInit.code).toBe(2)
    expect(badInit.stderr).toContain('needs exactly 89')
  })

  it('init with a zen-compatible proposer route freezes the endpoint facts', async () => {
    const run = await cli([
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      'cli-zen',
      '--master-seed',
      'cli-zen-master-seed',
      '--tasks-root',
      tasksRoot,
      '--baseline-source',
      BASELINE_SOURCE,
      '--jobs-root',
      jobsRoot,
      ...nativeDshArgs(),
      '--credential-file',
      credential,
      '--proposer-route',
      'deepseek/zen-compatible',
      '--model-base-url',
      'http://127.0.0.1:9/v1',
      '--model-name',
      'deepseek-v4-flash',
      '--model-temperature',
      '0',
    ])
    expect(run.code).toBe(0)
    const configPath = join(runsRoot, 'cli-zen', 'run.config.json')
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw) as {
      proposerRoute: string
      modelRoutes: Array<{ id: string; baseUrl?: string; model?: string; temperature?: number }>
    }
    expect(config.proposerRoute).toBe('deepseek/zen-compatible')
    const route = config.modelRoutes.find((candidate) => candidate.id === 'deepseek/zen-compatible')
    expect(route?.baseUrl).toBe('http://127.0.0.1:9/v1')
    expect(route?.model).toBe('deepseek-v4-flash')
    expect(route?.temperature).toBe(0)
    // The credential is referenced by path only — its content never freezes.
    expect(raw).toContain('zen.key')
    expect(raw).not.toContain('PLACEHOLDER')
  })

  it('init fails closed when the zen-compatible proposer route lacks endpoint facts', async () => {
    const run = await cli([
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      'cli-zen-broken',
      '--master-seed',
      'cli-zen-master-seed',
      '--tasks-root',
      tasksRoot,
      '--baseline-source',
      BASELINE_SOURCE,
      '--jobs-root',
      jobsRoot,
      ...nativeDshArgs(),
      '--credential-file',
      credential,
      '--proposer-route',
      'deepseek/zen-compatible',
    ])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('baseUrl')
    expect(existsSync(join(runsRoot, 'cli-zen-broken', 'run.config.json'))).toBe(false)
  })

  it('sealed-evaluate reports usage when the sealed inputs are missing (ADR-048)', async () => {
    const bare = await cli(['sealed-evaluate', '--run-root', runRoot()])
    expect(bare.code).toBe(2)
    expect(bare.stderr).toContain('sealed-evaluate requires')
    expect(bare.stderr).toContain('--candidate-lock-hash')
    // The command itself exists — this is a usage error, not dispatch.
    expect(bare.stderr).not.toContain('unknown command')
  })

  it('sealed-evaluate fails closed on a run root that never locked a champion', async () => {
    const store = join(runsRoot, 'cli-sealed-store.json')
    await writeFile(
      store,
      `${JSON.stringify(
        { guardMap: {}, guardHandles: [], sealedHandles: [], sealedMap: {} },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    )
    const plan = join(runsRoot, 'cli-sealed-plan.json')
    await writeFile(plan, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, { mode: 0o600 })

    const run = await cli([
      'sealed-evaluate',
      '--run-root',
      runRoot(),
      '--sealed-store',
      store,
      '--sealed-plan',
      plan,
      '--candidate-lock-hash',
      'ab'.repeat(32),
      '--provider',
      'fake',
    ])
    // The e2e root (cli-e2e) stopped at K_REACHED with no champion lock: the
    // runner must refuse to touch it and report the integrity error.
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('CANDIDATE_LOCKED')
  }, 120_000)

  it('init accepts --profile terminal-bench-formal with the tournament carriers (ADR-049)', async () => {
    const run = await cli([
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      'cli-formal',
      '--master-seed',
      'cli-formal-master-seed',
      '--tasks-root',
      tasksRoot,
      '--baseline-source',
      BASELINE_SOURCE,
      '--jobs-root',
      jobsRoot,
      ...nativeDshArgs(),
      '--credential-file',
      credential,
      '--profile',
      'terminal-bench-formal',
      '--set',
      'maxSolverTrials=400',
      '--set',
      'baselineTaskCount=49',
      '--set',
      'baselineAttemptsPerTask=2',
      '--set',
      'baselineBatchSize=8',
      '--set',
      'tournamentMinEligibilityTrials=12',
      '--set',
      'tournamentCoverageAttemptsPerTask=1',
      '--set',
      'tournamentMaxTrials=360',
      '--set',
      'tournamentBootstrapResamples=100000',
    ])
    expect(run.code).toBe(0)
    const config = JSON.parse(
      await readFile(join(runsRoot, 'cli-formal', 'run.config.json'), 'utf8'),
    ) as {
      profile?: string
      search?: {
        benchmarkBaseline?: { taskCount?: number }
        tournament?: Record<string, number>
      }
    }
    expect(config.profile).toBe('terminal-bench-formal')
    expect(config.search?.benchmarkBaseline?.taskCount).toBe(49)
    expect(config.search?.tournament).toEqual({
      minEligibilityTrials: 12,
      coverageAttemptsPerTask: 1,
      maxTrials: 360,
      bootstrapResamples: 100_000,
    })
  }, 120_000)

  it('init rejects an unknown --profile value', async () => {
    const run = await cli([
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      'cli-profile-bad',
      '--master-seed',
      'cli-profile-bad-seed',
      '--tasks-root',
      tasksRoot,
      '--baseline-source',
      BASELINE_SOURCE,
      '--jobs-root',
      jobsRoot,
      ...nativeDshArgs(),
      '--credential-file',
      credential,
      '--profile',
      'champion-only',
    ])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('--profile expects')
    expect(existsSync(join(runsRoot, 'cli-profile-bad', 'run.config.json'))).toBe(false)
  })

  it('run refuses a formal profile without the pre-registered sealed plan file (ADR-049)', async () => {
    const run = await cli(['run', '--run-root', join(runsRoot, 'cli-formal'), '--provider', 'fake'])
    // Fail closed BEFORE any composition: no sealed plan receipt, no launch.
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('sealed-plan-file')
  }, 120_000)

  it('run rejects a sealed plan file with the wrong protocol before any launch (ADR-049)', async () => {
    const bogus = join(runsRoot, 'cli-formal-bogus-plan.json')
    await writeFile(bogus, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`)
    const run = await cli([
      'run',
      '--run-root',
      join(runsRoot, 'cli-formal'),
      '--provider',
      'fake',
      '--sealed-plan-file',
      bogus,
    ])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('sealed-plan')
  }, 120_000)
})

describe.skipIf(!nativeTestEnabled)('dsh-evolve CLI: solver route (ADR-030)', () => {
  let runsRoot: string
  let tasksRoot: string
  let jobsRoot: string
  let credential: string

  beforeAll(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-solve-runs-'))
    tasksRoot = await makeTasksRoot()
    jobsRoot = await mkdtemp(join(tmpdir(), 'dsh-cli-solve-jobs-'))
    credential = join(runsRoot, 'zen.key')
    await writeFile(credential, 'SOLVE-TEST-CREDENTIAL-NEVER-IN-EVIDENCE\n', { mode: 0o600 })
    await chmod(credential, 0o600)
    dirs.push(runsRoot, jobsRoot)
  })

  const baseInit = (runId: string, extra: readonly string[]): readonly string[] => [
    'init',
    '--runs-root',
    runsRoot,
    '--run-id',
    runId,
    '--master-seed',
    'cli-solve-master-seed',
    '--tasks-root',
    tasksRoot,
    '--baseline-source',
    BASELINE_SOURCE,
    '--jobs-root',
    jobsRoot,
    ...nativeDshArgs(),
    '--credential-file',
    credential,
    ...extra,
  ]

  it('init with the solver flags freezes a validated solver config', async () => {
    const run = await cli(
      baseInit('cli-solve-1', [
        '--solver-route',
        'deepseek/zen-compatible',
        '--solver-base-url',
        'http://127.0.0.1:9/v1',
        '--solver-model',
        'deepseek-v4-flash',
        '--solver-temperature',
        '0',
        '--solver-tokens',
        '12345',
      ]),
    )
    expect(run.code).toBe(0)
    const raw = await readFile(join(runsRoot, 'cli-solve-1', 'run.config.json'), 'utf8')
    const config = JSON.parse(raw) as {
      solverRoute?: string
      budget: { solverTokens?: number }
      benchmark: { harbor: { concurrentTrials?: number; prefetchImages?: boolean } }
      modelRoutes: Array<{ id: string; baseUrl?: string; model?: string; temperature?: number }>
    }
    expect(config.solverRoute).toBe('deepseek/zen-compatible')
    expect(config.budget.solverTokens).toBe(12_345)
    expect(config.benchmark.harbor.concurrentTrials).toBe(4)
    expect(config.benchmark.harbor.prefetchImages).toBe(true)
    const route = config.modelRoutes.find((route) => route.id === 'deepseek/zen-compatible')
    expect(route?.baseUrl).toBe('http://127.0.0.1:9/v1')
    expect(route?.model).toBe('deepseek-v4-flash')
    expect(route?.temperature).toBe(0)
    // Rule 8: the credential content never freezes; only its path does.
    expect(raw).toContain('zen.key')
    expect(raw).not.toContain('SOLVE-TEST-CREDENTIAL')
  })

  it('init without solver flags stays byte-identical to the pre-solver document', async () => {
    const first = await cli(baseInit('cli-solve-plain-a', []))
    const second = await cli(baseInit('cli-solve-plain-b', []))
    expect(first.code).toBe(0)
    expect(second.code).toBe(0)
    const a = await readFile(join(runsRoot, 'cli-solve-plain-a', 'run.config.json'), 'utf8')
    const b = await readFile(join(runsRoot, 'cli-solve-plain-b', 'run.config.json'), 'utf8')
    // The document embeds resolved absolute paths and the run id; normalize
    // exactly those before demanding identical bytes.
    const normalize = (text: string, id: string): string =>
      text.replaceAll(runsRoot, '<runs-root>').replaceAll(id, '<run-id>')
    expect(normalize(a, 'cli-solve-plain-a')).toBe(normalize(b, 'cli-solve-plain-b'))
    const config = JSON.parse(a) as {
      solverRoute?: unknown
      budget: Record<string, unknown>
    }
    expect('solverRoute' in config).toBe(false)
    expect('solverTokens' in config.budget).toBe(false)
  })

  it('accepts --set solverTokens= paired with a solver route, rejects unknown --set keys', async () => {
    const ok = await cli(
      baseInit('cli-solve-set-ok', [
        '--solver-route',
        'deepseek/zen-compatible',
        '--solver-base-url',
        'http://127.0.0.1:9/v1',
        '--solver-model',
        'deepseek-v4-flash',
        '--solver-temperature',
        '0',
        '--set',
        'solverTokens=777',
      ]),
    )
    expect(ok.code).toBe(0)
    const config = JSON.parse(
      await readFile(join(runsRoot, 'cli-solve-set-ok', 'run.config.json'), 'utf8'),
    ) as { budget: { solverTokens?: number } }
    expect(config.budget.solverTokens).toBe(777)

    const bogus = await cli(baseInit('cli-solve-set-bad', ['--set', 'bogus=1']))
    expect(bogus.code).toBe(2)
    expect(bogus.stderr).toContain('unknown search/budget field')
    expect(existsSync(join(runsRoot, 'cli-solve-set-bad', 'run.config.json'))).toBe(false)
  })

  it('rejects an unpaired solverTokens budget and a non-positive --solver-tokens', async () => {
    const unpaired = await cli(baseInit('cli-solve-unpaired', ['--set', 'solverTokens=100']))
    expect(unpaired.code).toBe(2)
    expect(unpaired.stderr).toContain('budget.solverTokens is set but solverRoute is missing')
    expect(existsSync(join(runsRoot, 'cli-solve-unpaired', 'run.config.json'))).toBe(false)

    const zero = await cli(
      baseInit('cli-solve-zero', [
        '--solver-route',
        'deepseek/zen-compatible',
        '--solver-tokens',
        '0',
      ]),
    )
    expect(zero.code).toBe(2)
    expect(zero.stderr).toContain('--solver-tokens expects an integer')
  })

  it('rejects endpoint flags given in both spellings (same field, one value)', async () => {
    const run = await cli(
      baseInit('cli-solve-alias', [
        '--solver-base-url',
        'http://127.0.0.1:9/v1',
        '--model-base-url',
        'http://127.0.0.1:10/v1',
      ]),
    )
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('name the same field')
    expect(existsSync(join(runsRoot, 'cli-solve-alias', 'run.config.json'))).toBe(false)
  })

  it('composes the three benchmark baseline carriers into search.benchmarkBaseline (ADR-042)', async () => {
    // A matrix that fits the default stable-demo cap (8 + 3×1 ≤ maxSolverTrials);
    // a 24-task matrix against the 15-trial default must be rejected by the
    // semantic check, which is exercised in run-config.test.ts.
    const ok = await cli(
      baseInit('cli-baseline-ok', [
        '--set',
        'baselineTaskCount=8',
        '--set',
        'baselineAttemptsPerTask=1',
        '--set',
        'baselineBatchSize=4',
      ]),
    )
    expect(ok.code).toBe(0)
    const config = JSON.parse(
      await readFile(join(runsRoot, 'cli-baseline-ok', 'run.config.json'), 'utf8'),
    ) as {
      search: {
        benchmarkBaseline?: { taskCount?: number; attemptsPerTask?: number; batchSize?: number }
      }
    }
    expect(config.search.benchmarkBaseline).toEqual({
      taskCount: 8,
      attemptsPerTask: 1,
      batchSize: 4,
    })

    const partial = await cli(baseInit('cli-baseline-partial', ['--set', 'baselineTaskCount=24']))
    expect(partial.code).toBe(2)
    expect(partial.stderr).toContain(
      'baselineTaskCount, baselineAttemptsPerTask and baselineBatchSize together',
    )
    expect(existsSync(join(runsRoot, 'cli-baseline-partial', 'run.config.json'))).toBe(false)
  })
})
