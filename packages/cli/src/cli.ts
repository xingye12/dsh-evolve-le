/**
 * dsh-evolve-le iteration CLI (Gate 5, specs/07 §7): one command behind the
 * whole closed loop — propose → build → real Loader → Harbor evaluate →
 * normalize → Archive commit — plus the lifecycle around it
 * (`init`, `run`, `resume`, `status`, `audit`, `doctor`).
 *
 * Rules this CLI enforces (CLAUDE.md):
 * - rule 8: credentials are referenced by path, stat'ed by preflight, and
 *   never read, logged, or copied into evidence;
 * - rule 9/§7 Accept: invalid config, missing credential, unavailable
 *   Docker/Harbor, or an unfundable budget stops the run BEFORE the first
 *   paid launch (fail closed, complete finding list);
 * - `status`/`audit` read only durable evidence under the run root — they
 *   never launch, journal, or mutate, and work after process restart;
 * - `run` and `resume` are the same idempotent drive; the durable controller
 *   makes a repeated invocation a no-op, not a duplicate paid effect.
 * @module @dsh-evolve-le/cli
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  defaultRunConfig,
  loadRunConfig,
  remoteProposalRunner,
  validateRunConfig,
  type ProposalRunner,
  type RunConfig,
} from '@dsh-evolve-le/core'
import {
  baselineSourceCheck,
  configCheck,
  credentialChecks,
  dockerCheck,
  harborVersionCheck,
  IterationDriver,
  type PreflightCheck,
  type ProviderBridge,
  runPreflight,
  runRootCheck,
  tasksRootCheck,
} from '@dsh-evolve-le/core'
import { readRunStatus, FakeProvider, type BenchmarkProvider } from '@dsh-evolve-le/core'
import { SPLIT_COUNTS, runSplitCeremony } from '@dsh-evolve-le/core'
import { canonicalHash } from '@dsh-evolve-le/core'
import {
  buildAugmentedCaBundle,
  generateLocalCa,
  HarborProvider,
  startArtifactServer,
  SubmissionLedger,
} from '@dsh-evolve-le/tb-provider'

export const CLI_VERSION = 'dsh-evolve-le/cli/v1'
export const DATASET_HANDLES_PROTOCOL = 'dsh-evolve-le/dataset-handles/v1'
const CA_BUNDLE_CONTAINER = '/opt/dsh-evolve-le/ca-bundle.crt'

export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

/** Parsed option values (single strings, booleans, or repeated strings). */
type CliValues = Record<string, string | boolean | string[] | undefined>

class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

function usage(): string {
  return [
    'dsh-evolve — recursive self-improvement loop behind one command',
    '',
    '  dsh-evolve init    --runs-root DIR --run-id ID --master-seed SEED \\',
    '                    --tasks-root DIR --baseline-source DIR --jobs-root DIR',
    '                    [--credential-file PATH] [--set key=value]…',
    '                    [--proposer-route ID --model-base-url URL --model-name NAME',
    '                     --model-temperature N]   # zen-compatible route',
    '  dsh-evolve run     (--run-root DIR | --runs-root DIR --run-id ID)',
    '                    [--provider terminal-bench|fake] [--fake-failure-period N]',
    '  dsh-evolve resume  (same arguments as run)',
    '  dsh-evolve status  (--run-root DIR | --runs-root DIR --run-id ID)',
    '  dsh-evolve audit   (--run-root DIR | --runs-root DIR --run-id ID)',
    '  dsh-evolve doctor  (--run-root DIR | --runs-root DIR --run-id ID)',
    '',
    'Fail-closed: preflight problems list every failed check and exit non-zero',
    'before any paid launch.',
  ].join('\n')
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** --set key=value overrides for search/budget fields (init). */
function parseSets(values: readonly string[]): Record<string, number> {
  const overrides: Record<string, number> = {}
  for (const value of values) {
    const match = /^([a-zA-Z]+)=(.+)$/.exec(value)
    if (match === null) throw new CliError(`--set expects key=value, got "${value}"`, 2)
    const parsed = Number(match[2])
    if (!Number.isSafeInteger(parsed)) {
      throw new CliError(`--set ${match[1]!}: "${match[2]!}" is not a safe integer`, 2)
    }
    overrides[match[1]!] = parsed
  }
  return overrides
}

function searchBudgetOverrides(
  sets: Record<string, number>,
): Partial<RunConfig['search']> & Partial<RunConfig['budget']> {
  const searchKeys: ReadonlySet<string> = new Set([
    'kTarget',
    'proposalWidth',
    'coldStartTrials',
    'ucbAirAlphaPerMille',
    'shortlistSize',
    'maxSolverTrials',
    'maxDiscoveryTrials',
    'discoveryBatchSize',
    'maxConsecutiveExpansionFailures',
  ])
  const budgetKeys: ReadonlySet<string> = new Set([
    'usd',
    'proposerTokens',
    'proposalCalls',
    'taskTrials',
    'wallClockMinutes',
  ])
  const overrides: Partial<RunConfig['search']> & Partial<RunConfig['budget']> = {}
  for (const [key, value] of Object.entries(sets)) {
    if (searchKeys.has(key) || budgetKeys.has(key)) {
      ;(overrides as Record<string, number>)[key] = value
    } else {
      throw new CliError(`--set ${key}: unknown search/budget field`, 2)
    }
  }
  return overrides
}

/** The frozen handle population under a tasks root (dirs holding task.toml). */
async function enumerateHandles(tasksRoot: string): Promise<string[]> {
  const entries = await readdir(tasksRoot, { withFileTypes: true }).catch(() => {
    throw new CliError(`tasks root ${tasksRoot} does not exist`, 2)
  })
  const handles: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!existsSync(join(tasksRoot, entry.name, 'task.toml'))) continue
    handles.push(entry.name)
  }
  handles.sort()
  const expected = SPLIT_COUNTS.observed + SPLIT_COUNTS.guard + SPLIT_COUNTS.sealed
  if (handles.length !== expected) {
    throw new CliError(
      `tasks root ${tasksRoot} holds ${String(handles.length)} task handles, ` +
        `the pinned ceremony needs exactly ${String(expected)}`,
      2,
    )
  }
  return handles
}

interface RunEnv {
  runRoot: string
  config: RunConfig
  configHash: string
  handles: string[]
}

function resolveRunRoot(values: CliValues): string {
  const runRoot = values['run-root']
  if (typeof runRoot === 'string' && runRoot.length > 0) return resolve(runRoot)
  const runsRoot = values['runs-root']
  const runId = values['run-id']
  if (typeof runsRoot === 'string' && typeof runId === 'string' && runId.length > 0) {
    return join(resolve(runsRoot), runId)
  }
  throw new CliError('pass either --run-root DIR or --runs-root DIR --run-id ID', 2)
}

/** Load + validate the frozen config and handle population of a run root. */
async function loadRunEnv(runRoot: string): Promise<RunEnv> {
  const configPath = join(runRoot, 'run.config.json')
  const result = loadRunConfig(configPath)
  if (!result.ok) {
    throw new CliError(
      `invalid config ${configPath}:\n  - ${result.error.errors.join('\n  - ')}`,
      2,
    )
  }
  const handlesPath = join(runRoot, 'dataset-handles.json')
  if (!existsSync(handlesPath)) {
    throw new CliError(`missing ${handlesPath} (run init first)`, 2)
  }
  const doc = (await readJsonFile(handlesPath)) as { protocol?: string; handles?: unknown }
  if (doc.protocol !== DATASET_HANDLES_PROTOCOL || !Array.isArray(doc.handles)) {
    throw new CliError(`${handlesPath} is not a ${DATASET_HANDLES_PROTOCOL} document`, 2)
  }
  return { runRoot, config: result.config, configHash: result.configHash, handles: doc.handles }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function commandInit(values: CliValues, io: CliIo): Promise<number> {
  const runId = values['run-id']
  const masterSeed = values['master-seed']
  const tasksRoot = values['tasks-root']
  const baselineSource = values['baseline-source']
  const jobsRoot = values['jobs-root']
  for (const [flag, value] of [
    ['--run-id', runId],
    ['--master-seed', masterSeed],
    ['--tasks-root', tasksRoot],
    ['--baseline-source', baselineSource],
    ['--jobs-root', jobsRoot],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0)
      throw new CliError(`init requires ${flag}`, 2)
  }
  const runsRoot = resolve(
    typeof values['runs-root'] === 'string' ? values['runs-root'] : 'evidence/runs',
  )
  const runRoot = join(runsRoot, runId as string)

  const sets = parseSets((values['set'] as string[] | undefined) ?? [])
  const overrides = searchBudgetOverrides(sets)
  const handles = await enumerateHandles(resolve(tasksRoot as string))
  const modelTemperature =
    values['model-temperature'] !== undefined ? Number(values['model-temperature']) : undefined
  if (
    modelTemperature !== undefined &&
    (!Number.isFinite(modelTemperature) || modelTemperature < 0)
  ) {
    throw new CliError(`--model-temperature expects a number ≥ 0`, 2)
  }

  const document = defaultRunConfig({
    runId: runId as string,
    masterSeed: masterSeed as string,
    tasksRoot: resolve(tasksRoot as string),
    baselineSourceDir: resolve(baselineSource as string),
    jobsRoot: resolve(jobsRoot as string),
    ...(typeof values['harbor-bin'] === 'string' ? { harborBin: values['harbor-bin'] } : {}),
    ...(typeof values['harbor-version'] === 'string'
      ? { harborVersion: values['harbor-version'] }
      : {}),
    ...(typeof values['artifact-host'] === 'string'
      ? { artifactHost: values['artifact-host'] }
      : {}),
    ...(values['artifact-port'] !== undefined
      ? { artifactPort: Number(values['artifact-port']) }
      : {}),
    ...(typeof values['proposer-route'] === 'string'
      ? { proposerRoute: values['proposer-route'] }
      : {}),
    ...(typeof values['model-base-url'] === 'string'
      ? { modelBaseUrl: values['model-base-url'] }
      : {}),
    ...(typeof values['model-name'] === 'string' ? { modelName: values['model-name'] } : {}),
    ...(modelTemperature !== undefined ? { modelTemperature } : {}),
    overrides,
  })
  if (typeof values['credential-file'] === 'string') {
    document.modelRoutes = document.modelRoutes.map((route) =>
      route.provider === 'zen-compatible'
        ? { ...route, credentialFile: resolve(values['credential-file'] as string) }
        : route,
    )
  }

  const validated = validateRunConfig(document)
  if (!validated.ok) {
    throw new CliError(
      `generated config is invalid (this is a bug in init defaults/overrides):\n  - ${validated.error.errors.join('\n  - ')}`,
      2,
    )
  }

  const configPath = join(runRoot, 'run.config.json')
  if (existsSync(configPath)) {
    throw new CliError(
      `${configPath} already exists — a run root is frozen at init; start a new run instead`,
      2,
    )
  }
  await writeJsonFile(configPath, document)
  await writeJsonFile(join(runRoot, 'dataset-handles.json'), {
    schemaVersion: 1,
    protocol: DATASET_HANDLES_PROTOCOL,
    tasksRoot: document.benchmark.tasksRoot,
    handles,
    datasetInputHash: `sha256:${canonicalHash(handles)}`,
  })
  io.stdout(
    `${JSON.stringify(
      {
        runRoot,
        configHash: validated.configHash,
        handles: handles.length,
        profile: document.profile,
      },
      null,
      2,
    )}\n`,
  )
  return 0
}

// ---------------------------------------------------------------------------
// run / resume
// ---------------------------------------------------------------------------

/** Pre-launch checks for the real provider path (fail closed, all findings). */
function providerPreflight(env: RunEnv): PreflightCheck[] {
  return [
    configCheck(env.config),
    ...credentialChecks(env.config),
    runRootCheck(env.runRoot),
    baselineSourceCheck(env.config.benchmark.baselineSourceDir),
    tasksRootCheck(env.config.benchmark.tasksRoot, env.handles),
    dockerCheck(),
    harborVersionCheck(env.config.benchmark.harbor.bin, env.config.benchmark.harbor.version),
  ]
}

interface Composition {
  provider: BenchmarkProvider
  bridge: ProviderBridge
  close: () => Promise<void>
}

/** Deterministic fake for tests: every Nth distinct paid trial fails. */
class PeriodicFakeProvider extends FakeProvider {
  private calls = 0
  constructor(private readonly period: number) {
    super({ outcome: 'success' })
  }
  override async launch(request: unknown, idempotencyKey: string) {
    this.calls += 1
    if (this.period > 0 && this.calls % this.period === 0) {
      this.script(idempotencyKey, { outcome: 'failure' })
    }
    return super.launch(request, idempotencyKey)
  }
}

async function composeReal(env: RunEnv, io: CliIo): Promise<Composition> {
  const { config, runRoot } = env
  const capsulesRoot = join(runRoot, 'capsules')
  await mkdir(capsulesRoot, { recursive: true })
  await mkdir(config.benchmark.harbor.jobsRoot, { recursive: true })

  // Local HTTPS artifact endpoint: capsules are content-addressed files under
  // <runRoot>/capsules; the server serves them by digest at request time.
  const tlsDir = join(runRoot, 'tls')
  await mkdir(tlsDir, { recursive: true })
  const tls = await generateLocalCa({ dir: tlsDir, ip: config.benchmark.artifactEndpoint.host })
  const caBundleHost = await buildAugmentedCaBundle({
    dir: tlsDir,
    localCaCertPath: tls.caCertPath,
  })
  const server = await startArtifactServer({
    host: config.benchmark.artifactEndpoint.host,
    port: config.benchmark.artifactEndpoint.port,
    artifactsDir: capsulesRoot,
    tls: { certPath: tls.serverCertPath, keyPath: tls.serverKeyPath },
  })
  io.stderr(`artifact endpoint: ${server.url}\n`)

  const guardMap: Record<string, string> = {}
  const provider = new HarborProvider({
    runId: config.runId,
    harborBin: config.benchmark.harbor.bin,
    harborVersion: config.benchmark.harbor.version,
    tasksRoot: config.benchmark.tasksRoot,
    jobsRoot: config.benchmark.harbor.jobsRoot,
    concurrentTrials: config.benchmark.harbor.concurrentTrials,
    ledger: new SubmissionLedger(join(runRoot, 'harbor-ledger.jsonl')),
    guardMap,
    plansDir: join(runRoot, 'harbor-plans'),
    mounts: [{ source: caBundleHost, target: CA_BUNDLE_CONTAINER }],
    env: { SSL_CERT_FILE: CA_BUNDLE_CONTAINER },
  })
  const bridge: ProviderBridge = {
    async registerCapsule(candidateId, capsule) {
      const expected = join(capsulesRoot, `${capsule.archiveSha256}.tar.gz`)
      if (!existsSync(expected)) {
        throw new CliError(`capsule archive ${expected} missing (driver/provider disagreement)`, 1)
      }
      provider.registerCapsule(candidateId, {
        capsuleArchiveSha256: capsule.archiveSha256,
        archiveUrl: `${server.url}/${capsule.archiveSha256}.tar.gz`,
      })
    },
    async setGuardMap(map) {
      // The provider reads the map at launch time; hand it the live object.
      Object.assign(guardMap, map)
    },
  }
  return { provider, bridge, close: server.close }
}

function composeFake(env: RunEnv, period: number): Composition {
  void env
  const provider = new PeriodicFakeProvider(period)
  return {
    provider,
    bridge: {
      async registerCapsule() {},
      async setGuardMap() {},
    },
    close: async () => undefined,
  }
}

async function commandRun(values: CliValues, io: CliIo): Promise<number> {
  const env = await loadRunEnv(resolveRunRoot(values))
  const providerKind = (values['provider'] as string | undefined) ?? 'terminal-bench'
  if (providerKind !== 'terminal-bench' && providerKind !== 'fake') {
    throw new CliError(`--provider must be terminal-bench or fake, got "${providerKind}"`, 2)
  }
  const fake = providerKind === 'fake'
  const period =
    values['fake-failure-period'] !== undefined ? Number(values['fake-failure-period']) : 0
  if (!Number.isSafeInteger(period) || period < 0) {
    throw new CliError('--fake-failure-period must be a non-negative integer', 2)
  }

  // Fail closed BEFORE any run state or external effect (§7 Accept).
  const checks = fake
    ? [configCheck(env.config), ...credentialChecks(env.config), runRootCheck(env.runRoot)]
    : providerPreflight(env)
  const findings = await runPreflight(checks)
  const failed = findings.filter((finding) => !finding.ok)
  if (failed.length > 0) {
    io.stderr(
      `preflight failed (no launch attempted):\n${findings
        .map((finding) => `  ${finding.ok ? '✓' : '✗'} ${finding.name}: ${finding.detail ?? 'ok'}`)
        .join('\n')}\n`,
    )
    return 2
  }

  const composition = fake ? composeFake(env, period) : await composeReal(env, io)

  // Crash drill (Gate 6 acceptance, specs/07 §8): with
  // DSH_EVOLVE_CRASH_AFTER_OBSERVATION=N the process SIGKILLs itself right
  // after the Nth evaluation observation is durably committed — a real
  // process death at a deterministic safe point, for resume-equivalence
  // evidence. Production runs never set it.
  const crashAfter = Number(process.env['DSH_EVOLVE_CRASH_AFTER_OBSERVATION'] ?? '')
  const crashAt = Number.isSafeInteger(crashAfter) && crashAfter > 0 ? crashAfter : null
  let committedObservations = 0
  const onBoundary =
    crashAt === null
      ? undefined
      : (point: string, actionId: string | null): void => {
          if (point !== 'action-committed' || actionId === null || !actionId.startsWith('eval-')) {
            return
          }
          committedObservations += 1
          if (committedObservations === crashAt) {
            io.stderr(
              `crash drill: SIGKILL after observation ${String(committedObservations)} (${actionId})\n`,
            )
            process.kill(process.pid, 'SIGKILL')
          }
        }

  let report
  try {
    const proposalRunner = await remoteRunnerFor(env)
    const driver = new IterationDriver({
      config: env.config,
      configHash: env.configHash,
      runRoot: env.runRoot,
      handles: env.handles,
      provider: composition.provider,
      bridge: composition.bridge,
      ...(proposalRunner !== undefined ? { proposalRunner } : {}),
      ...(onBoundary !== undefined ? { onBoundary } : {}),
    })
    report = await driver.drive()
  } finally {
    await composition.close().catch(() => undefined)
  }
  io.stdout(`${JSON.stringify(report, null, 2)}\n`)
  return 0
}

/**
 * The proposer route's runner: recorded routes use the default sandbox runner;
 * a zen-compatible proposer route gets the TCB proxy runner (Gate 8). The
 * credential is read here, in the controller process, into memory only — it
 * never reaches a log, receipt, prompt, or artifact (CLAUDE.md rule 8).
 */
async function remoteRunnerFor(env: RunEnv): Promise<ProposalRunner | undefined> {
  const route = env.config.modelRoutes.find(
    (candidate) => candidate.id === env.config.proposerRoute,
  )
  if (route === undefined || route.provider !== 'zen-compatible') return undefined
  if (route.credentialFile === undefined) {
    throw new CliError(`proposer route ${route.id} has no credentialFile (re-init the run)`, 2)
  }
  const credential = (await readFile(route.credentialFile, 'utf8')).trim()
  if (credential.length === 0) throw new CliError(`${route.credentialFile} is empty`, 2)
  return remoteProposalRunner({ route, credential })
}

// ---------------------------------------------------------------------------
// status / audit / doctor
// ---------------------------------------------------------------------------

function controllerConfigOf(env: RunEnv) {
  const { config } = env
  return {
    runId: config.runId,
    budgetLimits: {
      usd: config.budget.usd,
      'proposer-tokens': config.budget.proposerTokens,
      'proposal-calls': config.budget.proposalCalls,
      'task-trials': config.budget.taskTrials,
      'wall-clock-seconds': config.budget.wallClockMinutes * 60,
    },
  }
}

/** Durable-evidence-only status: frozen documents + journal replay, no writes. */
async function commandStatus(values: CliValues, io: CliIo): Promise<number> {
  const env = await loadRunEnv(resolveRunRoot(values))
  const doc = async (name: string): Promise<Record<string, unknown> | null> => {
    const path = join(env.runRoot, name)
    return existsSync(path) ? ((await readJsonFile(path)) as Record<string, unknown>) : null
  }
  const manifest = await doc('run-manifest.json')
  const report = await doc('drive-report.json')
  const pool = await doc('failure-pool.json')
  const searchState = await doc('search-state.json')
  const status = {
    cli: CLI_VERSION,
    runId: env.config.runId,
    runRoot: env.runRoot,
    configHash: env.configHash,
    manifestFrozen: manifest !== null,
    sealedAccess: env.config.sealedAccess,
    phase: (report?.['phase'] as string | undefined) ?? null,
    stopReason: (report?.['stopReason'] as string | undefined) ?? null,
    status: (report?.['status'] as string | undefined) ?? null,
    trials: (report?.['trials'] as number | undefined) ?? 0,
    admittedNonBaseline: (report?.['admittedNonBaseline'] as number | undefined) ?? 0,
    lineageDepthMax: (report?.['lineageDepthMax'] as number | undefined) ?? 0,
    failurePool: (pool?.['handles'] as string[] | undefined) ?? [],
    expansionAttempts: (searchState?.['expansionAttempts'] as number | undefined) ?? 0,
    budget: (report?.['budget'] as Record<string, unknown> | undefined) ?? null,
    controller: null as Record<string, unknown> | null,
  }
  if (existsSync(join(env.runRoot, 'controller'))) {
    const runStatus = await readRunStatus(join(env.runRoot, 'controller'), controllerConfigOf(env))
    status['controller'] = {
      phase: runStatus.phase,
      seq: runStatus.seq,
      stateHash: runStatus.stateHash,
      observationCount: runStatus.observationCount,
      actions: runStatus.actions.length,
      waves: runStatus.waves,
      budget: runStatus.budget,
    }
    status['phase'] = runStatus.phase
  }
  io.stdout(`${JSON.stringify(status, null, 2)}\n`)
  return 0
}

async function commandAudit(values: CliValues, io: CliIo): Promise<number> {
  const env = await loadRunEnv(resolveRunRoot(values))
  const results: Array<{ check: string; ok: boolean; detail: string }> = []
  const add = (check: string, ok: boolean, detail: string): void => {
    results.push({ check, ok, detail })
  }

  // 1. config on disk still validates and hashes to the frozen manifest value.
  const manifestPath = join(env.runRoot, 'run-manifest.json')
  if (!existsSync(manifestPath)) {
    add('run-manifest', false, 'missing (run never started)')
  } else {
    const manifest = (await readJsonFile(manifestPath)) as {
      configHash: string
      config: RunConfig
    }
    const revalidated = validateRunConfig(manifest.config)
    add(
      'manifest-config-valid',
      revalidated.ok,
      revalidated.ok ? 'frozen config document re-validates' : revalidated.error.errors.join('; '),
    )
    add(
      'manifest-config-hash',
      manifest.configHash === env.configHash,
      `manifest ${manifest.configHash} vs disk ${env.configHash}`,
    )
  }

  // 2. split ceremony re-derives from (seed, handles) and matches the freeze.
  const ceremonyPath = join(env.runRoot, 'split-ceremony.json')
  if (!existsSync(ceremonyPath)) {
    add('split-ceremony', false, 'missing')
  } else {
    const frozen = await readJsonFile(ceremonyPath)
    const rederived = runSplitCeremony({
      runId: env.config.runId,
      masterSeed: env.config.masterSeed,
      handles: env.handles,
    })
    add(
      'split-ceremony-rederives',
      canonicalHash(frozen) === canonicalHash(rederived.ceremony),
      'frozen ceremony matches the deterministic re-derivation',
    )
  }

  // 3. failure pool hash.
  const poolPath = join(env.runRoot, 'failure-pool.json')
  if (existsSync(poolPath)) {
    const pool = (await readJsonFile(poolPath)) as { handles: string[]; poolHash: string }
    add(
      'failure-pool-hash',
      pool.poolHash === `sha256:${canonicalHash(pool.handles)}`,
      `${String(pool.handles.length)} handle(s)`,
    )
  }

  // 4. capsule records: archives exist and are content-addressed.
  const capsulesRoot = join(env.runRoot, 'capsules')
  if (existsSync(capsulesRoot)) {
    let checked = 0
    const mismatched: string[] = []
    for (const entry of await readdir(capsulesRoot)) {
      if (!entry.endsWith('.json')) continue
      const record = (await readJsonFile(join(capsulesRoot, entry))) as {
        candidateId: string
        archiveSha256: string
      }
      const archivePath = join(capsulesRoot, `${record.archiveSha256}.tar.gz`)
      if (!existsSync(archivePath)) {
        mismatched.push(`${record.candidateId}: archive missing`)
        continue
      }
      const digest = createHash('sha256')
        .update(await readFile(archivePath))
        .digest('hex')
      checked += 1
      if (digest !== record.archiveSha256) {
        mismatched.push(`${record.candidateId}: archive digest mismatch`)
      }
    }
    add('capsule-archives', mismatched.length === 0, `${String(checked)} archive(s) verified`)
  }

  // 5. durable report agrees with a fresh journal replay (after restart).
  const reportPath = join(env.runRoot, 'drive-report.json')
  const controllerDir = join(env.runRoot, 'controller')
  if (existsSync(controllerDir) && existsSync(reportPath)) {
    const report = (await readJsonFile(reportPath)) as { stateHash: string }
    const replayed = await readRunStatus(controllerDir, controllerConfigOf(env))
    add(
      'drive-report-state-hash',
      report.stateHash === replayed.stateHash,
      `report ${report.stateHash.slice(0, 16)}… vs replay ${replayed.stateHash.slice(0, 16)}…`,
    )
  }

  for (const result of results) {
    io.stdout(`${result.ok ? '✓' : '✗'} ${result.check}: ${result.detail}\n`)
  }
  return results.every((result) => result.ok) ? 0 : 1
}

async function commandDoctor(values: CliValues, io: CliIo): Promise<number> {
  const env = await loadRunEnv(resolveRunRoot(values))
  const providerKind = (values['provider'] as string | undefined) ?? 'terminal-bench'
  const checks =
    providerKind === 'fake'
      ? [configCheck(env.config), ...credentialChecks(env.config), runRootCheck(env.runRoot)]
      : providerPreflight(env)
  const findings = await runPreflight(checks)
  for (const finding of findings) {
    io.stdout(`${finding.ok ? '✓' : '✗'} ${finding.name}: ${finding.detail ?? 'ok'}\n`)
  }
  return findings.every((finding) => finding.ok) ? 0 : 1
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help') {
    io.stdout(`${usage()}\n`)
    return command === undefined ? 2 : 0
  }
  if (command === '--version') {
    io.stdout(`${CLI_VERSION}\n`)
    return 0
  }
  const options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean }> = {
    'run-root': { type: 'string' },
    'runs-root': { type: 'string' },
    'run-id': { type: 'string' },
    'master-seed': { type: 'string' },
    'tasks-root': { type: 'string' },
    'baseline-source': { type: 'string' },
    'jobs-root': { type: 'string' },
    'harbor-bin': { type: 'string' },
    'harbor-version': { type: 'string' },
    'artifact-host': { type: 'string' },
    'artifact-port': { type: 'string' },
    'credential-file': { type: 'string' },
    'proposer-route': { type: 'string' },
    'model-base-url': { type: 'string' },
    'model-name': { type: 'string' },
    'model-temperature': { type: 'string' },
    provider: { type: 'string' },
    'fake-failure-period': { type: 'string' },
    set: { type: 'string', multiple: true },
  }
  let parsed: CliValues
  try {
    parsed = parseArgs({ args: rest, options, strict: true }).values as CliValues
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), 2)
  }
  switch (command) {
    case 'init':
      return commandInit(parsed, io)
    case 'run':
    case 'resume':
      return commandRun(parsed, io)
    case 'status':
      return commandStatus(parsed, io)
    case 'audit':
      return commandAudit(parsed, io)
    case 'doctor':
      return commandDoctor(parsed, io)
    default:
      throw new CliError(`unknown command "${command}"\n\n${usage()}`, 2)
  }
}

/** CLI entry: runCli with process IO and error→exit-code mapping. */
export async function cliMain(argv: readonly string[]): Promise<number> {
  const io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
  try {
    return await runCli(argv, io)
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.message}\n`)
      return error.code
    }
    io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
}
