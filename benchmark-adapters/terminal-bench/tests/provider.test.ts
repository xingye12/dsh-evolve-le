/**
 * Provider contract tests (Gate 2, specs/07 §4): pin the planning surface —
 * inventory identity, inline ACP registry entry, Harbor JobConfig shape,
 * idempotency key sensitivity, and the ledger's no-second-paid-trial
 * guarantee — against committed fixtures. The shapes bind to harbor 0.21.0
 * source (`JobConfig`, `AgentConfig.kwargs`, `AcpRegistryEntry`,
 * `AcpBinaryTarget`); when upstream changes them, these tests are the tripwire.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ACP_CMD,
  DATASET_PIN,
  SubmissionLedger,
  buildAcpRegistryEntry,
  buildJobConfig,
  buildTaskInventory,
  idempotencyKey,
  jobNameForKey,
  planSubmission,
  selectTasks,
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

const FIXTURE_TASKS = join(import.meta.dirname, 'fixtures/tasks')
const CAPSULE = 'a'.repeat(64)
const ARCHIVE_URL = 'https://172.17.0.1:8443/artifacts/capsule.tar.gz'

async function stageFixtureTask(tasksRoot: string, handle: string): Promise<void> {
  await mkdir(join(tasksRoot, handle), { recursive: true })
  await writeFile(
    join(tasksRoot, handle, 'task.toml'),
    await readFile(join(FIXTURE_TASKS, `${handle}/task.toml`), 'utf8'),
  )
}

describe('task inventory', () => {
  it('scans task dirs into a deterministic, content-addressed inventory', async () => {
    const tasksRoot = await freshScratch('dsh-inv-clean-')
    await stageFixtureTask(tasksRoot, 'alpha')
    await stageFixtureTask(tasksRoot, 'beta')
    const first = await buildTaskInventory(tasksRoot)
    const second = await buildTaskInventory(tasksRoot)
    expect(first.tasks.map((task) => task.handle)).toEqual(['alpha', 'beta'])
    expect(first.tasks.every((task) => /^[0-9a-f]{64}$/.test(task.digest))).toBe(true)
    expect(first.inventorySha256).toBe(second.inventorySha256)
    expect(first.dataset).toEqual({
      id: DATASET_PIN.id,
      upstream: DATASET_PIN.upstream,
      commit: DATASET_PIN.commit,
      tarballSha256: DATASET_PIN.tarballSha256,
    })
    // A one-byte content change must move the task digest and the inventory.
    const mutated = await freshScratch('dsh-inv-')
    await stageFixtureTask(mutated, 'alpha')
    await writeFile(
      join(mutated, 'alpha', 'task.toml'),
      `${await readFile(join(FIXTURE_TASKS, 'alpha/task.toml'), 'utf8')}\n# drift\n`,
    )
    const mutatedInventory = await buildTaskInventory(mutated)
    expect(mutatedInventory.tasks[0]?.digest).not.toBe(
      first.tasks.find((task) => task.handle === 'alpha')?.digest,
    )
  })

  it('fails closed on a partial task set (directory without task.toml)', async () => {
    await expect(buildTaskInventory(FIXTURE_TASKS)).rejects.toThrow(/not-a-task/)
  })

  it('selects by handle and refuses unknown handles', async () => {
    const tasksRoot = await freshScratch('dsh-select-')
    await stageFixtureTask(tasksRoot, 'alpha')
    await stageFixtureTask(tasksRoot, 'beta')
    const inventory = await buildTaskInventory(tasksRoot)
    const selected = selectTasks(inventory, ['beta', 'alpha'])
    expect(selected.map((task) => task.handle)).toEqual(['beta', 'alpha'])
    expect(() => selectTasks(inventory, ['gamma'])).toThrow(/unknown task handle gamma/)
    expect(() => selectTasks(inventory, [])).toThrow(/empty task selection/)
  })
})

describe('inline ACP registry entry', () => {
  it('binds capsule identity into the entry Harbor records per trial', () => {
    const entry = buildAcpRegistryEntry({
      capsuleArchiveSha256: CAPSULE,
      archiveUrl: ARCHIVE_URL,
    })
    expect(entry.version).toBe(CAPSULE)
    expect(entry.distribution.binary['linux-x86_64']).toEqual({
      archive: ARCHIVE_URL,
      cmd: ACP_CMD,
      args: [],
      checksum: CAPSULE,
    })
  })

  it('rejects non-HTTPS archives and non-hex digests (harbor validators)', () => {
    expect(() =>
      buildAcpRegistryEntry({ capsuleArchiveSha256: CAPSULE, archiveUrl: 'http://x/c.tar.gz' }),
    ).toThrow(/HTTPS/)
    expect(() =>
      buildAcpRegistryEntry({ capsuleArchiveSha256: 'zz', archiveUrl: ARCHIVE_URL }),
    ).toThrow(/sha256/)
  })
})

describe('harbor job config', () => {
  const entry = buildAcpRegistryEntry({
    capsuleArchiveSha256: CAPSULE,
    archiveUrl: ARCHIVE_URL,
  })

  it('generates a JobConfig that round-trips through YAML', () => {
    const plan = buildJobConfig({
      jobName: 'dsh-fixedname0001',
      jobsDir: '/tmp/jobs',
      taskPaths: ['/tasks/alpha', '/tasks/beta'],
      registryEntry: entry,
      attempts: 2,
      concurrentTrials: 1,
      mounts: [
        { source: '/host/ca-certificates.crt', target: '/etc/ssl/certs/ca-certificates.crt' },
      ],
    })
    const round: Record<string, unknown> = parseYaml(plan.yaml) as Record<string, unknown>
    expect(round['job_name']).toBe('dsh-fixedname0001')
    expect(round['n_attempts']).toBe(2)
    expect(round['n_concurrent_trials']).toBe(1)
    expect(round['environment']).toEqual({
      type: 'docker',
      mounts: [
        {
          type: 'bind',
          source: '/host/ca-certificates.crt',
          target: '/etc/ssl/certs/ca-certificates.crt',
          read_only: true,
        },
      ],
    })
    const agents = round['agents'] as {
      name: string
      model_name?: string
      kwargs: Record<string, unknown>
    }[]
    expect(agents).toHaveLength(1)
    expect(agents[0]?.name).toBe('acp')
    // No model_name: the replay capsule routes to no external model, and a
    // requested model would force harbor's set_model path (SDK 0.25.1 cannot
    // serve it — the first real E2E run proved this failure mode).
    expect(agents[0]?.model_name).toBeUndefined()
    expect(agents[0]?.kwargs['permission_mode']).toBe('deny')
    expect(agents[0]?.kwargs['auth_policy']).toBe('disabled')
    // The inline registry entry survives the YAML round-trip byte-identically.
    expect(agents[0]?.kwargs['registry_entry'] as unknown).toEqual(entry)
    expect(round['tasks']).toEqual([{ path: '/tasks/alpha' }, { path: '/tasks/beta' }])
    expect(plan.plannedTrials).toBe(4)
    // Pre-registered infra retry + setup headroom (ADR-028): exactly one
    // retry, restricted to the normalizer's INFRA_RETRYABLE_EXCEPTIONS set so
    // the plan and the observation classification share one source of truth.
    expect(round['agent_setup_timeout_multiplier']).toBe(5)
    expect(round['retry']).toEqual({
      max_retries: 1,
      include_exceptions: [
        'AgentSetupTimeoutError',
        'EnvironmentStartTimeoutError',
        'HealthcheckError',
        'SandboxBuildFailedError',
      ],
    })
  })

  it('omits the mounts key entirely when no mounts are needed', () => {
    const plan = buildJobConfig({
      jobName: 'dsh-x',
      jobsDir: '/tmp/jobs',
      taskPaths: ['/tasks/alpha'],
      registryEntry: entry,
      attempts: 1,
      concurrentTrials: 1,
    })
    const round = parseYaml(plan.yaml) as { environment: unknown }
    expect(round.environment).toEqual({ type: 'docker' })
  })
})

describe('idempotency key and ledger', () => {
  const base = {
    runId: 'gate2-dev',
    capsuleArchiveSha256: CAPSULE,
    inventorySha256: 'b'.repeat(64),
    handles: ['alpha', 'beta'],
    attempts: 1,
    harborVersion: '0.21.0',
  }

  it('is stable for identical inputs and sensitive to every paid-outcome input', () => {
    const key = idempotencyKey(base)
    expect(idempotencyKey({ ...base, handles: ['beta', 'alpha'] })).toBe(key) // order-insensitive
    expect(idempotencyKey(base)).not.toBe(idempotencyKey({ ...base, runId: 'other' }))
    expect(key).not.toBe(idempotencyKey({ ...base, capsuleArchiveSha256: 'c'.repeat(64) }))
    expect(key).not.toBe(idempotencyKey({ ...base, inventorySha256: 'd'.repeat(64) }))
    expect(key).not.toBe(idempotencyKey({ ...base, attempts: 2 }))
    expect(key).not.toBe(idempotencyKey({ ...base, harborVersion: '0.22.0' }))
  })

  it('reserves once: a second submit with the same key is existing, never new', async () => {
    const dir = await freshScratch('dsh-ledger-')
    const ledger = new SubmissionLedger(join(dir, 'ledger.jsonl'))
    const key = idempotencyKey(base)
    const first = await ledger.reserve({
      key,
      runId: base.runId,
      jobName: jobNameForKey(key),
      jobDir: join(dir, 'jobs', jobNameForKey(key)),
      capsuleArchiveSha256: base.capsuleArchiveSha256,
      inventorySha256: base.inventorySha256,
      handles: base.handles,
      attempts: base.attempts,
      harborVersion: base.harborVersion,
    })
    expect(first.status).toBe('new')
    const second = await ledger.reserve({
      key,
      runId: base.runId,
      jobName: jobNameForKey(key),
      jobDir: join(dir, 'jobs', jobNameForKey(key)),
      capsuleArchiveSha256: base.capsuleArchiveSha256,
      inventorySha256: base.inventorySha256,
      handles: base.handles,
      attempts: base.attempts,
      harborVersion: base.harborVersion,
    })
    expect(second.status).toBe('existing')
    expect(second.entry).toEqual(first.entry)
    // Append-only: exactly one line per reservation.
    const text = await readFile(join(dir, 'ledger.jsonl'), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
  })
})

describe('planSubmission', () => {
  it('plans a job and re-plans identically (existing, same job dir)', async () => {
    const tasksRoot = await freshScratch('dsh-plan-tasks-')
    await stageFixtureTask(tasksRoot, 'alpha')
    const jobsRoot = await freshScratch('dsh-plan-jobs-')
    const ledgerPath = join(jobsRoot, 'ledger.jsonl')

    const input = {
      runId: 'gate2-dev',
      tasksRoot,
      handles: ['alpha'],
      capsuleArchiveSha256: CAPSULE,
      archiveUrl: ARCHIVE_URL,
      jobsRoot,
      harborVersion: '0.21.0',
    }
    const first = await planSubmission({ ...input, ledger: new SubmissionLedger(ledgerPath) })
    expect(first.status).toBe('new')
    const second = await planSubmission({ ...input, ledger: new SubmissionLedger(ledgerPath) })
    expect(second.status).toBe('existing')
    expect(second.jobName).toBe(first.jobName)
    expect(second.jobDir).toBe(first.jobDir)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(first.jobPlan.plannedTrials).toBe(1)

    // The job config embeds the capsule identity in the registry entry.
    const parsed = parseYaml(first.jobPlan.yaml) as {
      agents: { kwargs: { registry_entry: { version: string } } }[]
    }
    expect(parsed.agents[0]?.kwargs.registry_entry.version).toBe(CAPSULE)
  })

  it('refuses handles outside the inventory', async () => {
    const dir = await freshScratch('dsh-plan-miss-')
    await stageFixtureTask(dir, 'alpha')
    await expect(
      planSubmission({
        runId: 'gate2-dev',
        tasksRoot: dir,
        handles: ['not-in-inventory'],
        capsuleArchiveSha256: CAPSULE,
        archiveUrl: ARCHIVE_URL,
        jobsRoot: dir,
        harborVersion: '0.21.0',
        ledger: new SubmissionLedger(join(dir, 'ledger.jsonl')),
      }),
    ).rejects.toThrow(/not in inventory/)
  })
})
