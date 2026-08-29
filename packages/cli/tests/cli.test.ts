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
import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const CLI_MAIN = join(repoRoot, 'packages', 'cli', 'src', 'main.ts')
const BASELINE_SOURCE = join(repoRoot, 'packages', 'candidate-baseline')
const exec = promisify(execFile)

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      ['--import', 'tsx/esm', CLI_MAIN, ...args],
      { cwd: repoRoot, timeout: 570_000, maxBuffer: 32 << 20 },
    )
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message }
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

describe('dsh-evolve CLI', () => {
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

  it('run --provider fake reaches K through the real builder and sandbox', async () => {
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
  }, 570_000)

  it('resume duplicates nothing: journal bytes and report are unchanged', async () => {
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
  }, 570_000)

  it('status after the run replays the journal in a fresh process', async () => {
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
  })

  it('audit passes on the honest run root and fails closed on tampering', async () => {
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
  })

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
      '--credential-file',
      credential,
      '--proposer-route',
      'deepseek/zen-compatible',
    ])
    expect(run.code).toBe(2)
    expect(run.stderr).toContain('baseUrl')
    expect(existsSync(join(runsRoot, 'cli-zen-broken', 'run.config.json'))).toBe(false)
  })
})
