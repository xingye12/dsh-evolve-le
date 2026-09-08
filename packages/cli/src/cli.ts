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
  RunConfigError,
  TERMINAL_BENCH_MAX_AGENT_TIMEOUT_SEC,
  loadRunConfig,
  LIVE_ROUTE_REQUEST_TIMEOUT_MS,
  openSolveGateway,
  remoteProposalRunner,
  SOLVE_CLIENT_REQUEST_TIMEOUT_MS,
  solverRoutePlan,
  validateRunConfig,
  type ProposalRunner,
  type RemoteRoutePlan,
  type RunConfig,
  type SolveGateway,
} from '@dsh-evolve-le/core'
import {
  baselineSourceCheck,
  configCheck,
  credentialChecks,
  dockerCheck,
  harborVersionCheck,
  IterationDriver,
  nativeDshCatalogCheck,
  proposalWorkerIdentityCheck,
  type IterationDriverInput,
  type PreflightCheck,
  type ProviderBridge,
  runPreflight,
  runRootCheck,
  searchCalibrationCheck,
  tasksRootCheck,
} from '@dsh-evolve-le/core'
import { readRunStatus, FakeProvider, type BenchmarkProvider } from '@dsh-evolve-le/core'
import { sealedEvaluate, SEALED_PLAN_PROTOCOL, type SealedPlanDoc } from '@dsh-evolve-le/core'
import {
  SPLIT_COUNTS,
  runSplitCeremony,
  splitCountsForPopulation,
  type SealedSplitStore,
  type SplitCounts,
} from '@dsh-evolve-le/core'
import { canonicalHash } from '@dsh-evolve-le/core'
import {
  buildAugmentedCaBundle,
  generateLocalCa,
  HarborProvider,
  prefetchTaskImages,
  startArtifactServer,
  SubmissionLedger,
  buildTaskInventory,
} from '@dsh-evolve-le/tb-provider'

export const CLI_VERSION = 'dsh-evolve-le/cli/v1'
export const DATASET_HANDLES_PROTOCOL = 'dsh-evolve-le/dataset-handles/v1'
const CA_BUNDLE_CONTAINER = '/opt/dsh-evolve-le/ca-bundle.crt'
/** Where each trial's solve-gateway token is bind-mounted read-only. */
const SOLVE_TOKEN_CONTAINER = '/run/dsh-solve/token'

function documentMaxAgentTimeoutSec(): number {
  return TERMINAL_BENCH_MAX_AGENT_TIMEOUT_SEC
}

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
    '                    [--candidate-protocol legacy-v1|tree-v2]',
    '                    [--profile stable-demo|terminal-bench-formal]',
    '                    [--legacy-baseline-source DIR]',
    '                    --native-dsh-catalog-root DIR --native-dsh-closure-sha256 SHA256',
    '                    [--credential-file PATH] [--set key=value]…',
    '                    [--proposer-route ID --model-base-url URL --model-name NAME',
    '                     --model-temperature N]   # zen-compatible route',
    '                    [--solver-route ID --solver-tokens N --concurrent-trials N',
    '                     --prefetch-images]   # live solve (ADR-030);',
    '                     --solver-base-url/--solver-model/--solver-temperature configure',
    '                     the zen route when the solver is the role selecting it',
    '  dsh-evolve run     (--run-root DIR | --runs-root DIR --run-id ID)',
    '                    [--provider terminal-bench|fake] [--fake-failure-period N]',
    '                    [--sealed-plan-file PATH]   # required on terminal-bench-formal',
    '  dsh-evolve resume  (same arguments as run)',
    '  dsh-evolve status  (--run-root DIR | --runs-root DIR --run-id ID)',
    '  dsh-evolve audit   (--run-root DIR | --runs-root DIR --run-id ID)',
    '  dsh-evolve doctor  (--run-root DIR | --runs-root DIR --run-id ID)',
    '  dsh-evolve sealed-evaluate --run-root DIR --sealed-store FILE \\',
    '                    --sealed-plan FILE --candidate-lock-hash SHA256 \\',
    '                    [--provider terminal-bench|fake] [--jobs-root DIR] \\',
    '                    [--concurrency N] [--critical-findings N]',
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

function searchBudgetOverrides(sets: Record<string, number>): Partial<RunConfig['search']> &
  Partial<RunConfig['budget']> & {
    baselineTaskCount?: number
    baselineAttemptsPerTask?: number
    baselineBatchSize?: number
  } {
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
    // ADR-042: flat carriers composed into search.benchmarkBaseline by
    // defaultRunConfig; all three must be set together.
    'baselineTaskCount',
    'baselineAttemptsPerTask',
    'baselineBatchSize',
    // ADR-049: flat carriers composed into search.tournament by
    // defaultRunConfig; all four must be set together.
    'tournamentMinEligibilityTrials',
    'tournamentCoverageAttemptsPerTask',
    'tournamentMaxTrials',
    'tournamentBootstrapResamples',
  ])
  const budgetKeys: ReadonlySet<string> = new Set([
    'usd',
    'proposerTokens',
    'proposalCalls',
    'taskTrials',
    'wallClockMinutes',
    // ADR-030: valid only in a config that also sets solverRoute (semantic
    // check in run-config.ts rejects the unpaired document).
    'solverTokens',
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
async function enumerateHandles(
  tasksRoot: string,
  maxAgentTimeoutSec: number,
): Promise<{
  handles: string[]
  sourceTaskCount: number
  excludedHandles: string[]
  counts: SplitCounts
}> {
  try {
    const inventory = await buildTaskInventory(tasksRoot, { maxAgentTimeoutSec })
    const handles = inventory.tasks.map((task) => task.handle)
    const selection = inventory.selection
    if (selection === undefined)
      throw new CliError('task inventory did not record its eligibility policy', 2)
    return {
      handles,
      sourceTaskCount: selection.sourceTaskCount,
      excludedHandles: selection.excludedHandles,
      counts: splitCountsForPopulation(handles.length),
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    const provenanceHint = detail.includes('no task directories')
      ? '; pinned ceremony needs exactly 89 source task handles'
      : ''
    throw new CliError(`cannot build eligible task inventory: ${detail}${provenanceHint}`, 2)
  }
}

interface RunEnv {
  runRoot: string
  config: RunConfig
  configHash: string
  handles: string[]
  splitCounts: SplitCounts
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
  const countsValue = (doc as { splitCounts?: unknown }).splitCounts
  const splitCounts =
    countsValue !== undefined && typeof countsValue === 'object' && countsValue !== null
      ? (countsValue as SplitCounts)
      : SPLIT_COUNTS
  return {
    runRoot,
    config: result.config,
    configHash: result.configHash,
    handles: doc.handles,
    splitCounts,
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function commandInit(values: CliValues, io: CliIo): Promise<number> {
  const runId = values['run-id']
  const masterSeed = values['master-seed']
  const tasksRoot = values['tasks-root']
  const baselineSource = values['baseline-source']
  const candidateProtocol = values['candidate-protocol']
  const legacyBaselineSource = values['legacy-baseline-source']
  const jobsRoot = values['jobs-root']
  const nativeDshCatalogRoot = values['native-dsh-catalog-root']
  const nativeDshClosureSha256 = values['native-dsh-closure-sha256']
  for (const [flag, value] of [
    ['--run-id', runId],
    ['--master-seed', masterSeed],
    ['--tasks-root', tasksRoot],
    ['--baseline-source', baselineSource],
    ['--jobs-root', jobsRoot],
    ['--native-dsh-catalog-root', nativeDshCatalogRoot],
    ['--native-dsh-closure-sha256', nativeDshClosureSha256],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0)
      throw new CliError(`init requires ${flag}`, 2)
  }
  const runsRoot = resolve(
    typeof values['runs-root'] === 'string' ? values['runs-root'] : 'evidence/runs',
  )
  const runRoot = join(runsRoot, runId as string)

  // ADR-049: the profile selects the protocol class — stable-demo never
  // enters the tournament, terminal-bench-formal runs the full
  // ADR-045..049 protocol (baseline matrix + tournament/champion + sealed).
  const profile = values['profile']
  if (profile !== undefined && profile !== 'stable-demo' && profile !== 'terminal-bench-formal') {
    throw new CliError('--profile expects stable-demo or terminal-bench-formal', 2)
  }

  const sets = parseSets((values['set'] as string[] | undefined) ?? [])
  const overrides = searchBudgetOverrides(sets)
  const eligibility = await enumerateHandles(
    resolve(tasksRoot as string),
    documentMaxAgentTimeoutSec(),
  )
  const handles = eligibility.handles
  const modelTemperature =
    values['model-temperature'] !== undefined ? Number(values['model-temperature']) : undefined
  if (
    modelTemperature !== undefined &&
    (!Number.isFinite(modelTemperature) || modelTemperature < 0)
  ) {
    throw new CliError(`--model-temperature expects a number ≥ 0`, 2)
  }

  // ADR-030 solver flags. The config carries ONE zen-compatible route, so the
  // --solver-* endpoint flags write the same fields --model-* writes — pass
  // one spelling, never both (a silent collision would freeze an endpoint
  // nobody chose).
  for (const [solverFlag, modelFlag] of [
    ['--solver-base-url', 'model-base-url'],
    ['--solver-model', 'model-name'],
    ['--solver-temperature', 'model-temperature'],
  ] as const) {
    if (values[solverFlag.slice(2)] !== undefined && values[modelFlag] !== undefined) {
      throw new CliError(`${solverFlag} and --${modelFlag} name the same field; pass one`, 2)
    }
  }
  const solverTemperature =
    values['solver-temperature'] !== undefined ? Number(values['solver-temperature']) : undefined
  if (
    solverTemperature !== undefined &&
    (!Number.isFinite(solverTemperature) || solverTemperature < 0)
  ) {
    throw new CliError('--solver-temperature expects a number ≥ 0', 2)
  }
  let solverTokens: number | undefined
  if (values['solver-tokens'] !== undefined) {
    solverTokens = Number(values['solver-tokens'])
    if (!Number.isSafeInteger(solverTokens) || solverTokens < 1) {
      throw new CliError('--solver-tokens expects an integer ≥ 1', 2)
    }
  }
  let concurrentTrials: number | undefined
  if (values['concurrent-trials'] !== undefined) {
    concurrentTrials = Number(values['concurrent-trials'])
    if (!Number.isSafeInteger(concurrentTrials) || concurrentTrials < 1 || concurrentTrials > 12) {
      throw new CliError('--concurrent-trials expects an integer from 1 to 12', 2)
    }
  }

  // ADR-042: defaultRunConfig throws RunConfigError on a partial benchmark
  // baseline; surface it as a clean CLI usage error, not a stack trace.
  let document: ReturnType<typeof defaultRunConfig>
  try {
    document = defaultRunConfig({
      runId: runId as string,
      masterSeed: masterSeed as string,
      tasksRoot: resolve(tasksRoot as string),
      baselineSourceDir: resolve(baselineSource as string),
      ...(typeof candidateProtocol === 'string'
        ? { candidateProtocol: candidateProtocol as RunConfig['candidateProtocol'] }
        : {}),
      ...(typeof profile === 'string' ? { profile: profile as RunConfig['profile'] } : {}),
      ...(typeof legacyBaselineSource === 'string'
        ? { legacyBaselineSourceDir: resolve(legacyBaselineSource) }
        : {}),
      jobsRoot: resolve(jobsRoot as string),
      nativeDshCatalogRoot: resolve(nativeDshCatalogRoot as string),
      nativeDshDependencyClosureSha256: nativeDshClosureSha256 as string,
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
      ...(typeof values['trial-container-proxy'] === 'string'
        ? {
            trialContainerProxy: {
              httpProxy: values['trial-container-proxy'],
              noProxy:
                typeof values['trial-container-no-proxy'] === 'string'
                  ? values['trial-container-no-proxy']
                  : 'localhost,127.0.0.1,172.17.0.1,host.docker.internal',
            },
          }
        : {}),
      ...(typeof values['proposer-route'] === 'string'
        ? { proposerRoute: values['proposer-route'] }
        : {}),
      ...(typeof values['model-base-url'] === 'string'
        ? { modelBaseUrl: values['model-base-url'] }
        : {}),
      ...(typeof values['model-name'] === 'string' ? { modelName: values['model-name'] } : {}),
      ...(modelTemperature !== undefined ? { modelTemperature } : {}),
      ...(typeof values['solver-route'] === 'string'
        ? { solverRoute: values['solver-route'] }
        : {}),
      ...(solverTokens !== undefined ? { solverTokens } : {}),
      ...(concurrentTrials !== undefined ? { concurrentTrials } : {}),
      ...(values['prefetch-images'] === true ? { prefetchImages: true } : {}),
      ...(typeof values['solver-base-url'] === 'string'
        ? { modelBaseUrl: values['solver-base-url'] }
        : {}),
      ...(typeof values['solver-model'] === 'string' ? { modelName: values['solver-model'] } : {}),
      ...(solverTemperature !== undefined ? { modelTemperature: solverTemperature } : {}),
      overrides,
    })
  } catch (error) {
    if (error instanceof RunConfigError) throw new CliError(error.message, 2)
    throw error
  }
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

  // The native DSH closure is a frozen run input. Verify it before any run
  // document exists so a typo or mutable catalog cannot create a dead run.
  const nativeFindings = await runPreflight([nativeDshCatalogCheck(document)])
  const nativeFailure = nativeFindings.find((finding) => !finding.ok)
  if (nativeFailure !== undefined) {
    throw new CliError(
      `cannot freeze native DSH runtime: ${nativeFailure.detail ?? 'catalog validation failed'}`,
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
    splitCounts: eligibility.counts,
    selection: {
      maxAgentTimeoutSec: documentMaxAgentTimeoutSec(),
      sourceTaskCount: eligibility.sourceTaskCount,
      excludedHandles: eligibility.excludedHandles,
    },
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
  const checks: PreflightCheck[] = [
    configCheck(env.config),
    nativeDshCatalogCheck(env.config),
    proposalWorkerIdentityCheck(),
    ...credentialChecks(env.config),
    runRootCheck(env.runRoot),
    baselineSourceCheck(env.config.benchmark.baselineSourceDir),
    tasksRootCheck(env.config.benchmark.tasksRoot, env.handles),
    // specs/03 §2: the envelope must structurally reach K under its frozen
    // gate before any paid launch. The ADR-045 k80 formal profile passes
    // (alpha=0.8 → 240 + 15 = 255 ≤ 400); a 0.6-alpha k80 still fails
    // closed here (1501 > 400), exactly as the clause mandates.
    searchCalibrationCheck(env.config, env.handles),
    dockerCheck(),
    harborVersionCheck(env.config.benchmark.harbor.bin, env.config.benchmark.harbor.version),
  ]
  if (env.config.benchmark.legacyBaselineSourceDir !== undefined) {
    checks.push(baselineSourceCheck(env.config.benchmark.legacyBaselineSourceDir))
  }
  return checks
}

/** Preconditions shared by every provider before the trusted builder runs. */
function candidateAdmissionPreflight(env: RunEnv): PreflightCheck[] {
  const checks: PreflightCheck[] = [
    configCheck(env.config),
    nativeDshCatalogCheck(env.config),
    proposalWorkerIdentityCheck(),
    ...credentialChecks(env.config),
    runRootCheck(env.runRoot),
    baselineSourceCheck(env.config.benchmark.baselineSourceDir),
    tasksRootCheck(env.config.benchmark.tasksRoot, env.handles),
  ]
  if (env.config.benchmark.legacyBaselineSourceDir !== undefined) {
    checks.push(baselineSourceCheck(env.config.benchmark.legacyBaselineSourceDir))
  }
  return checks
}

interface Composition {
  provider: BenchmarkProvider
  bridge: ProviderBridge
  imagePrefetchReceipt?: IterationDriverInput['imagePrefetchReceipt']
  verifierImageReceipt?: IterationDriverInput['verifierImageReceipt']
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

  // A prefetched Harbor image can still contain a verifier that downloads
  // uv/pytest after startup. Live solver runs must bind the run-scoped repair
  // receipt produced before init; check it before any image operation so a
  // malformed run stops without pulling or launching anything.
  let verifierImageReceipt: IterationDriverInput['verifierImageReceipt']
  const verifierReceiptPath = join(runRoot, 'verifier-image-receipt.json')
  if (existsSync(verifierReceiptPath)) {
    const receipt = await readJsonFile(verifierReceiptPath)
    const value = receipt as { protocol?: unknown; tasks?: unknown }
    if (
      value.protocol !== 'dsh-evolve-le/verifier-image/v1' ||
      !Array.isArray(value.tasks) ||
      value.tasks.length === 0
    ) {
      throw new CliError(`invalid verifier image receipt ${verifierReceiptPath}`, 2)
    }
    verifierImageReceipt = {
      protocol: value.protocol,
      path: 'verifier-image-receipt.json',
      sha256: `sha256:${canonicalHash(receipt)}`,
      taskCount: value.tasks.length,
    }
    io.stderr(`using ${String(value.tasks.length)} prebuilt offline verifier image(s)\n`)
  } else if (config.solverRoute !== undefined) {
    throw new CliError(
      'live solver requires verifier-image-receipt.json; prepare derived offline verifier images before launch',
      2,
    )
  }

  // Live solver runs warm every pinned task image before Harbor can launch a
  // job. Docker's host cache is shared by all concurrent jobs; the receipt
  // freezes image IDs so resume verifies/reuses the same bytes without pulls.
  let imagePrefetchReceipt: IterationDriverInput['imagePrefetchReceipt']
  if (config.solverRoute !== undefined && config.benchmark.harbor.prefetchImages !== false) {
    const receipt = await prefetchTaskImages({
      runId: config.runId,
      tasksRoot: config.benchmark.tasksRoot,
      handles: env.handles,
      receiptPath: join(runRoot, 'image-prefetch.json'),
      dockerBin: 'docker',
    })
    imagePrefetchReceipt = {
      protocol: receipt.protocol,
      path: 'image-prefetch.json',
      sha256: `sha256:${canonicalHash(receipt)}`,
      imageCount: receipt.images.length,
    }
    io.stderr(`prefetched ${String(receipt.images.length)} Harbor task image(s)\n`)
  }

  // Local HTTPS artifact endpoint: capsules are content-addressed files under
  // <runRoot>/capsules; the server serves them by digest at request time.
  const tlsDir = join(runRoot, 'tls')
  await mkdir(tlsDir, { recursive: true })
  const tls = await generateLocalCa({ dir: tlsDir, ip: config.benchmark.artifactEndpoint.host })
  const caBundleHost = await buildAugmentedCaBundle({
    dir: tlsDir,
    localCaCertPath: tls.caCertPath,
  })
  // ADR-030: a configured solver route opens the token-authenticated solve
  // gateway on the SAME listener. ready() replays every existing receipt
  // chain and fails closed here — before the listener is up and before any
  // new spend — so a poisoned chain never serves a trial.
  const solvePlan = solverRoutePlan(config)
  const solveRoute =
    solvePlan === null
      ? undefined
      : config.modelRoutes.find((candidate) => candidate.id === config.solverRoute)
  if (solvePlan !== null && solveRoute === undefined) {
    throw new CliError(`solver route ${config.solverRoute ?? ''} is not in the route table`, 2)
  }
  const gateway = solvePlan === null ? null : await solveGatewayFor(env, solvePlan)
  const server = await startArtifactServer({
    host: config.benchmark.artifactEndpoint.host,
    port: config.benchmark.artifactEndpoint.port,
    artifactsDir: capsulesRoot,
    tls: { certPath: tls.serverCertPath, keyPath: tls.serverKeyPath },
    ...(gateway !== null ? { handler: gateway.handler } : {}),
  })
  io.stderr(`artifact endpoint: ${server.url}\n`)

  const guardMap: Record<string, string> = {}
  const provider = new HarborProvider({
    runId: config.runId,
    harborBin: config.benchmark.harbor.bin,
    harborVersion: config.benchmark.harbor.version,
    tasksRoot: config.benchmark.tasksRoot,
    maxAgentTimeoutSec: config.benchmark.maxAgentTimeoutSec,
    jobsRoot: config.benchmark.harbor.jobsRoot,
    concurrentTrials: config.benchmark.harbor.concurrentTrials,
    ledger: new SubmissionLedger(join(runRoot, 'harbor-ledger.jsonl')),
    guardMap,
    plansDir: join(runRoot, 'harbor-plans'),
    // The apt 502 retry dropped-in here for attempt 8 was falsified in
    // production and reverted (ADR-028 falsification amendment): apt 2.6.1
    // does not retry HTTP-status failures under Acquire::Retries. Retry now
    // lives under the client in the trial egress forwarder (host infra).
    mounts: [{ source: caBundleHost, target: CA_BUNDLE_CONTAINER }],
    env: {
      SSL_CERT_FILE: CA_BUNDLE_CONTAINER,
      // ADR-028 second amendment: give the trial container's pre-launch apt
      // bootstrap the host's fast egress path. no_proxy must exclude the
      // artifact/solve-gateway listener or the capsule's gateway traffic
      // would hairpin through the proxy.
      ...(config.benchmark.trialContainerProxy !== undefined
        ? {
            http_proxy: config.benchmark.trialContainerProxy.httpProxy,
            https_proxy: config.benchmark.trialContainerProxy.httpProxy,
            HTTP_PROXY: config.benchmark.trialContainerProxy.httpProxy,
            HTTPS_PROXY: config.benchmark.trialContainerProxy.httpProxy,
            no_proxy: config.benchmark.trialContainerProxy.noProxy,
            NO_PROXY: config.benchmark.trialContainerProxy.noProxy,
          }
        : {}),
    },
    ...(gateway !== null && solvePlan !== null
      ? {
          solveGateway: {
            routeId: solvePlan.routeId,
            nativeProvider: solveRoute!.provider,
            nativeModel: solvePlan.model,
            nativeMaxTokens: solveRoute!.maxOutputTokens,
            url: server.url,
            routeHash: gateway.routeHash,
            containerTokenPath: SOLVE_TOKEN_CONTAINER,
            enroll: (jobName: string) => gateway.enrollTrial(jobName),
          },
          solveUsage: (jobName: string) => gateway.terminalFact(jobName),
        }
      : {}),
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
  return {
    provider,
    bridge,
    ...(imagePrefetchReceipt !== undefined ? { imagePrefetchReceipt } : {}),
    ...(verifierImageReceipt !== undefined ? { verifierImageReceipt } : {}),
    // Listener first, gateway second: the gateway's close flushes every
    // receipt chain only after no container can reach the endpoint anymore.
    close: async () => {
      await server.close()
      if (gateway !== null) await gateway.close()
    },
  }
}

/**
 * The solver route's gateway (ADR-030): reads the route credential into
 * memory exactly like remoteRunnerFor — it never reaches a log, receipt,
 * prompt, or artifact (CLAUDE.md rule 8). State lives under
 * <runRoot>/solve-gateway; tokens/ is 0600 root-only and never evidence.
 */
async function solveGatewayFor(env: RunEnv, plan: RemoteRoutePlan): Promise<SolveGateway> {
  const routeId = env.config.solverRoute
  const route = env.config.modelRoutes.find((candidate) => candidate.id === routeId)
  if (route === undefined) {
    throw new CliError(`solver route ${routeId ?? ''} is not in the route table`, 2)
  }
  if (route.credentialFile === undefined) {
    throw new CliError(`solver route ${route.id} has no credentialFile (re-init the run)`, 2)
  }
  const credential = (await readFile(route.credentialFile, 'utf8')).trim()
  if (credential.length === 0) throw new CliError(`${route.credentialFile} is empty`, 2)
  const gateway = openSolveGateway({
    stateDir: join(env.runRoot, 'solve-gateway'),
    plan,
    credential,
    requestTimeoutMs: LIVE_ROUTE_REQUEST_TIMEOUT_MS,
    // ADR-033: the whole retry loop must finish inside the in-container
    // client's fixed 660s per-request budget minus a 10s reply margin, so the
    // client never races the gateway's retries.
    retryTotalBudgetMs: SOLVE_CLIENT_REQUEST_TIMEOUT_MS - 10_000,
  })
  await gateway.ready()
  return gateway
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

  // ADR-048/049: the formal profile's driver demands the pre-registered
  // sealed plan receipt before any external effect (the lock doc binds its
  // hash). The record script pre-registers sealed-plan.json; the CLI re-hashes
  // the file bytes and hands the receipt to the driver.
  let sealedPlanReceipt: IterationDriverInput['sealedPlanReceipt']
  if (env.config.profile === 'terminal-bench-formal') {
    const planFile = values['sealed-plan-file']
    if (typeof planFile !== 'string' || planFile.length === 0) {
      throw new CliError(
        'run with profile terminal-bench-formal requires --sealed-plan-file (the pre-registered sealed plan)',
        2,
      )
    }
    const raw = await readFile(planFile, 'utf8').catch(() => null)
    let plan: unknown = null
    if (raw !== null) {
      try {
        plan = JSON.parse(raw)
      } catch {
        plan = null
      }
    }
    if (
      plan === null ||
      typeof plan !== 'object' ||
      (plan as { protocol?: unknown }).protocol !== SEALED_PLAN_PROTOCOL
    ) {
      throw new CliError(`${planFile} is not a ${SEALED_PLAN_PROTOCOL} sealed plan`, 1)
    }
    sealedPlanReceipt = {
      protocol: SEALED_PLAN_PROTOCOL,
      path: 'sealed-plan.json',
      sha256: `sha256:${canonicalHash(plan)}`,
    }
  }

  // Fail closed BEFORE any run state or external effect (§7 Accept).
  const checks = fake ? candidateAdmissionPreflight(env) : providerPreflight(env)
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
      splitCounts: env.splitCounts,
      provider: composition.provider,
      bridge: composition.bridge,
      ...(composition.imagePrefetchReceipt !== undefined
        ? { imagePrefetchReceipt: composition.imagePrefetchReceipt }
        : {}),
      ...(composition.verifierImageReceipt !== undefined
        ? { verifierImageReceipt: composition.verifierImageReceipt }
        : {}),
      ...(proposalRunner !== undefined ? { proposalRunner } : {}),
      ...(onBoundary !== undefined ? { onBoundary } : {}),
      ...(sealedPlanReceipt !== undefined ? { sealedPlanReceipt } : {}),
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
  // Live reasoning-model turns exceed the 120s proxy default (Gate 8 smoke).
  return remoteProposalRunner({
    route,
    credential,
    requestTimeoutMs: LIVE_ROUTE_REQUEST_TIMEOUT_MS,
  })
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
      // Mirrors the driver's map (ADR-030 D2): the dimension rides along only
      // in solver-token runs, so status/audit of replay runs replay unchanged.
      ...(config.budget.solverTokens !== undefined
        ? { 'solver-tokens': config.budget.solverTokens }
        : {}),
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
      imagePrefetchReceipt?: IterationDriverInput['imagePrefetchReceipt']
      verifierImageReceipt?: IterationDriverInput['verifierImageReceipt']
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
    if (manifest.imagePrefetchReceipt !== undefined) {
      const receiptPath = join(env.runRoot, manifest.imagePrefetchReceipt.path)
      const receipt = existsSync(receiptPath) ? await readJsonFile(receiptPath) : null
      const pathIsBound = manifest.imagePrefetchReceipt.path === 'image-prefetch.json'
      add(
        'image-prefetch-receipt-hash',
        pathIsBound &&
          receipt !== null &&
          manifest.imagePrefetchReceipt.sha256 === `sha256:${canonicalHash(receipt)}`,
        !pathIsBound
          ? `${manifest.imagePrefetchReceipt.path} is outside the run-scoped receipt name`
          : receipt === null
            ? `${manifest.imagePrefetchReceipt.path} missing`
            : `${String(manifest.imagePrefetchReceipt.imageCount)} image(s)`,
      )
    } else if (
      env.config.solverRoute !== undefined &&
      env.config.benchmark.harbor.prefetchImages === true
    ) {
      add(
        'image-prefetch-receipt-hash',
        false,
        'live solver config requires a manifest-bound image-prefetch receipt',
      )
    }
    if (manifest.verifierImageReceipt !== undefined) {
      const receiptPath = join(env.runRoot, manifest.verifierImageReceipt.path)
      const receipt = existsSync(receiptPath) ? await readJsonFile(receiptPath) : null
      const pathIsBound = manifest.verifierImageReceipt.path === 'verifier-image-receipt.json'
      add(
        'verifier-image-receipt-hash',
        pathIsBound &&
          receipt !== null &&
          manifest.verifierImageReceipt.sha256 === `sha256:${canonicalHash(receipt)}` &&
          manifest.verifierImageReceipt.taskCount ===
            ((receipt as { tasks?: unknown[] }).tasks?.length ?? -1),
        !pathIsBound
          ? `${manifest.verifierImageReceipt.path} is outside the run-scoped receipt name`
          : receipt === null
            ? `${manifest.verifierImageReceipt.path} missing`
            : `${String(manifest.verifierImageReceipt.taskCount)} task image(s)`,
      )
    } else if (env.config.solverRoute !== undefined) {
      add(
        'verifier-image-receipt-hash',
        false,
        'live solver config requires a manifest-bound offline verifier image receipt',
      )
    }
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
      counts: env.splitCounts,
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
  const checks = providerKind === 'fake' ? candidateAdmissionPreflight(env) : providerPreflight(env)
  const findings = await runPreflight(checks)
  for (const finding of findings) {
    io.stdout(`${finding.ok ? '✓' : '✗'} ${finding.name}: ${finding.detail ?? 'ok'}\n`)
  }
  return findings.every((finding) => finding.ok) ? 0 : 1
}

// ---------------------------------------------------------------------------
// sealed-evaluate (ADR-048)
// ---------------------------------------------------------------------------

/**
 * Sealed provider composition (ADR-048): the same artifact endpoint, CA
 * mounts, and egress environment as a search run, so the locked champion and
 * baseline capsules execute exactly as registered. Phase 3 opens no solve
 * gateway — TODO(Phase 5 smoke): a live-solver run must add the gateway here
 * (the in-trial client fails closed without it, which would bias verdicts).
 */
async function composeSealed(
  env: RunEnv,
  store: SealedSplitStore,
  plan: SealedPlanDoc,
  jobsRoot: string,
  io: CliIo,
): Promise<{ provider: BenchmarkProvider; close: () => Promise<void> }> {
  const { config, runRoot } = env
  const capsulesRoot = join(runRoot, 'capsules')
  await mkdir(capsulesRoot, { recursive: true })
  await mkdir(jobsRoot, { recursive: true })
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
  const provider = new HarborProvider({
    runId: config.runId,
    harborBin: config.benchmark.harbor.bin,
    harborVersion: config.benchmark.harbor.version,
    tasksRoot: config.benchmark.tasksRoot,
    maxAgentTimeoutSec: config.benchmark.maxAgentTimeoutSec,
    jobsRoot,
    concurrentTrials: config.benchmark.harbor.concurrentTrials,
    ledger: new SubmissionLedger(join(runRoot, 'sealed-harbor-ledger.jsonl')),
    guardMap: store.guardMap,
    sealedMap: store.sealedMap,
    plansDir: join(runRoot, 'sealed-harbor-plans'),
    mounts: [{ source: caBundleHost, target: CA_BUNDLE_CONTAINER }],
    env: {
      SSL_CERT_FILE: CA_BUNDLE_CONTAINER,
      ...(config.benchmark.trialContainerProxy !== undefined
        ? {
            http_proxy: config.benchmark.trialContainerProxy.httpProxy,
            https_proxy: config.benchmark.trialContainerProxy.httpProxy,
            HTTP_PROXY: config.benchmark.trialContainerProxy.httpProxy,
            HTTPS_PROXY: config.benchmark.trialContainerProxy.httpProxy,
            no_proxy: config.benchmark.trialContainerProxy.noProxy,
            NO_PROXY: config.benchmark.trialContainerProxy.noProxy,
          }
        : {}),
    },
  })
  // Register the two sealed identities from the trusted capsule records the
  // driver wrote before the lock froze them.
  const lockPath = join(runRoot, 'candidate-lock.json')
  if (!existsSync(lockPath)) {
    await server.close()
    throw new CliError('candidate-lock.json missing (run never locked a champion)', 2)
  }
  const lock = (await readJsonFile(lockPath)) as { winnerId?: unknown }
  const baselineId = (plan as { baselineId?: unknown }).baselineId
  if (typeof lock.winnerId !== 'string' || lock.winnerId.length === 0) {
    await server.close()
    throw new CliError('candidate-lock.json has no winnerId', 2)
  }
  if (typeof baselineId !== 'string' || baselineId.length === 0) {
    await server.close()
    throw new CliError('sealed plan has no baselineId (fail closed before any launch)', 2)
  }
  const register = async (candidateId: string): Promise<void> => {
    const recordPath = join(capsulesRoot, `${candidateId}.json`)
    if (!existsSync(recordPath)) {
      throw new CliError(`capsule record ${recordPath} missing`, 2)
    }
    const record = (await readJsonFile(recordPath)) as { archiveSha256?: unknown }
    if (typeof record.archiveSha256 !== 'string' || record.archiveSha256.length === 0) {
      throw new CliError(`capsule record ${recordPath} has no archiveSha256`, 2)
    }
    const archivePath = join(capsulesRoot, `${record.archiveSha256}.tar.gz`)
    if (!existsSync(archivePath)) {
      throw new CliError(`capsule archive ${archivePath} missing`, 2)
    }
    provider.registerCapsule(candidateId, {
      capsuleArchiveSha256: record.archiveSha256,
      archiveUrl: `${server.url}/${record.archiveSha256}.tar.gz`,
    })
  }
  await register(lock.winnerId)
  await register(baselineId)
  io.stderr(`sealed artifact endpoint: ${server.url}\n`)
  return { provider, close: async () => server.close() }
}

/**
 * Run (or resume/replay) the pre-registered sealed evaluation from a run root
 * that stopped at CANDIDATE_LOCKED (ADR-048). The plan is NOT validated here:
 * the runner's phase gate must come first (a non-locked root fails closed
 * before any plan problem matters), and its integrity gates verdict the rest.
 */
async function commandSealedEvaluate(values: CliValues, io: CliIo): Promise<number> {
  const sealedStorePath = values['sealed-store']
  const sealedPlanPath = values['sealed-plan']
  const candidateLockHash = values['candidate-lock-hash']
  if (
    typeof sealedStorePath !== 'string' ||
    typeof sealedPlanPath !== 'string' ||
    typeof candidateLockHash !== 'string' ||
    candidateLockHash.length === 0
  ) {
    throw new CliError(
      `sealed-evaluate requires --run-root DIR, --sealed-store FILE, --sealed-plan FILE and --candidate-lock-hash SHA256\n\n${usage()}`,
      2,
    )
  }
  if (!/^[0-9a-f]{64}$/.test(candidateLockHash)) {
    throw new CliError('--candidate-lock-hash must be 64-hex', 2)
  }
  const env = await loadRunEnv(resolveRunRoot(values))
  const store = (await readJsonFile(resolve(sealedStorePath))) as SealedSplitStore
  for (const [name, value] of [
    ['guardMap', store.guardMap],
    ['sealedMap', store.sealedMap],
  ] as const) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new CliError(`--sealed-store has no ${name} object`, 2)
    }
  }
  const plan = (await readJsonFile(resolve(sealedPlanPath))) as SealedPlanDoc
  const providerKind = (values['provider'] as string | undefined) ?? 'terminal-bench'
  if (providerKind !== 'terminal-bench' && providerKind !== 'fake') {
    throw new CliError(`--provider must be terminal-bench or fake, got "${providerKind}"`, 2)
  }
  const concurrency = values['concurrency'] !== undefined ? Number(values['concurrency']) : 2
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new CliError('--concurrency must be an integer in 1..12', 2)
  }
  let criticalFindings: number | undefined
  if (values['critical-findings'] !== undefined) {
    criticalFindings = Number(values['critical-findings'])
    if (!Number.isSafeInteger(criticalFindings) || criticalFindings < 0) {
      throw new CliError('--critical-findings must be a non-negative integer', 2)
    }
  }
  const jobsRoot = resolve(
    typeof values['jobs-root'] === 'string'
      ? values['jobs-root']
      : join(env.runRoot, 'sealed-jobs'),
  )
  const config = controllerConfigOf(env)

  let close: (() => Promise<void>) | null = null
  let provider: BenchmarkProvider
  if (providerKind === 'fake') {
    provider = new FakeProvider({ outcome: 'success' })
  } else {
    const composition = await composeSealed(env, store, plan, jobsRoot, io)
    provider = composition.provider
    close = composition.close
  }
  try {
    const result = await sealedEvaluate({
      runRoot: env.runRoot,
      config,
      masterSeed: env.config.masterSeed,
      plan,
      candidateLockHash,
      provider,
      concurrency,
      jobsRoot,
      ...(criticalFindings !== undefined ? { criticalFindings } : {}),
    })
    io.stdout(
      `${JSON.stringify(
        { verdict: result.verdict, revealed: result.revealed, phase: result.phase, jobsRoot },
        null,
        2,
      )}\n`,
    )
    return 0
  } finally {
    if (close !== null) await close()
  }
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
    'candidate-protocol': { type: 'string' },
    'legacy-baseline-source': { type: 'string' },
    'jobs-root': { type: 'string' },
    'native-dsh-catalog-root': { type: 'string' },
    'native-dsh-closure-sha256': { type: 'string' },
    'harbor-bin': { type: 'string' },
    'harbor-version': { type: 'string' },
    'artifact-host': { type: 'string' },
    'artifact-port': { type: 'string' },
    'trial-container-proxy': { type: 'string' },
    'trial-container-no-proxy': { type: 'string' },
    'credential-file': { type: 'string' },
    'proposer-route': { type: 'string' },
    'model-base-url': { type: 'string' },
    'model-name': { type: 'string' },
    'model-temperature': { type: 'string' },
    'solver-route': { type: 'string' },
    'solver-base-url': { type: 'string' },
    'solver-model': { type: 'string' },
    'solver-temperature': { type: 'string' },
    'solver-tokens': { type: 'string' },
    'concurrent-trials': { type: 'string' },
    'prefetch-images': { type: 'boolean' },
    profile: { type: 'string' },
    'sealed-plan-file': { type: 'string' },
    provider: { type: 'string' },
    'fake-failure-period': { type: 'string' },
    set: { type: 'string', multiple: true },
    'sealed-store': { type: 'string' },
    'sealed-plan': { type: 'string' },
    'candidate-lock-hash': { type: 'string' },
    concurrency: { type: 'string' },
    'critical-findings': { type: 'string' },
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
    case 'sealed-evaluate':
      return commandSealedEvaluate(parsed, io)
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
