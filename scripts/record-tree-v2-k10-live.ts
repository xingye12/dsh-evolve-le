/**
 * Record the tree-v2 K=10 LIVE run (specs/07, docs/tree-v2-implementation-spec.md,
 * ADR-041/042): the scale rehearsal before the K=80 search — the first paid run of
 * the tree-v2 protocol at the Gate 8 pilot's search envelope with BOTH the
 * solver and the proposer on the real networked model route
 * (deepseek/zen-compatible). The run starts from the tree-v2 migration root
 * (packages/candidate-tree-v2-baseline, bound to the legacy v1 baseline by the
 * frozen tree-v2-migration.json receipt, resultsInherited:false) and drives the
 * full loop: benchmark baseline matrix (ADR-042, specs/04 §4.2 — 24 observed
 * tasks × 1 attempt, zero-success pool freeze) → live proposals → trusted
 * rebuilds → cold-start trials, until K=10 admitted candidates or a
 * pre-registered stop.
 *
 * This is a PAID run: it talks to the real model endpoint for every solver
 * trial AND every proposal call. It refuses to start without the explicit
 * confirmation env var, and it fails closed (exit 1) on any violation —
 * including any evidence artifact that contains the credential or a per-trial
 * gateway token (CLAUDE.md rule 8).
 *
 * Cost bound (pre-registered profile k10, scripts/lib/tree-v2-live-profile.ts):
 * maxSolverTrials=60 and taskTrials=60 cap solver work — of those 60, the
 * pre-registered baseline matrix funds 24 up front (ADR-042) and the search
 * draws the rest; each trial is independently capped by the solve gateway's
 * frozen per-trial stop (48 requests / 2M tokens / $0.30) → solver worst case
 * $18.00. Proposer work is capped by proposalCalls=20 with the run-level
 * proposerTokens=20M ceiling; at the route's frozen price ($0.14/$0.28 per
 * Mtok) 20M tokens ≈ $5.60 worst case. solverTokens=120M funds each of the 60
 * trials at exactly the gateway per-trial cap (2M), so the dimension can
 * never trip before task-trials and a heavy trial's settle can never exceed
 * its reservation (the attempt-1 crash). Total worst case ≈ $23.60, far under
 * the $500 acceptance ceiling; realistic spend ≈ $12–18 (attempt 1's 14
 * search trials cost $2.27 ≈ $0.16/trial, and the matrix adds ~24 baseline
 * trials on top of a handful of successful expansions).
 *
 * Environment:
 *   DSH_TREE_V2_LIVE_CONFIRM  must be exactly `confirm` (the paid-run gate)
 *   DSH_TREE_V2_CREDENTIAL    path to the 0600 credential file
 *                             (default /root/.config/dsh-evolve-le/zen-compatible.key)
 *   DSH_TREE_V2_BASE_URL      OpenAI-compatible base URL
 *   DSH_TREE_V2_MODEL         exact model id
 *   TREE_V2_ARTIFACT_HOST/PORT  docker-bridge listener the containers reach
 *                             (defaults 172.17.0.1 / 8443, as in the pilot)
 * The credential content is read by the CLI into memory only and never
 * appears in any document, log, receipt, or artifact.
 *
 * Usage: node --import tsx/esm scripts/record-tree-v2-k10-live.ts
 * @module scripts/record-tree-v2-k10-live
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'
import { proposalEvidenceCopies } from './lib/evidence-copy-set.ts'
import {
  TREE_V2_LIVE_PROFILES,
  REGISTERED_TERMINAL_STOP_REASONS,
  buildTreeV2InitArgs,
  harborUsageReportedWhenCapsuleCompleted,
  receiptChainCoversTrial,
  requireLiveConfirmation,
  trialShapeWithinPreRegisteredEnvelope,
} from './lib/tree-v2-live-profile.ts'

const exec = promisify(execFile)

const evidenceDir = resolve(repoRoot, 'evidence/tree-v2/k10-live')
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const ARTIFACT_HOST = process.env['TREE_V2_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT = Number(process.env['TREE_V2_ARTIFACT_PORT'] ?? '8443')
// ADR-028 second amendment: trial containers reach the host's loopback-only
// egress proxy through a socat forwarder bound to the docker0 gateway
// (host-side environment, not protocol). Empty/unset = no proxy injection.
const TRIAL_CONTAINER_PROXY = process.env['TREE_V2_TRIAL_CONTAINER_PROXY'] ?? ''
const RUN_ID = 'tree-v2-k10-live'
const MASTER_SEED = 'tree-v2-k10-live-master-seed-1'
const PROFILE = TREE_V2_LIVE_PROFILES.k10
// The native DSH runtime lock materialized by docs/configuration.md §Native
// DSH runtime lock (pinned upstream, built copy in scratch, inspected lock).
const NATIVE_DSH_CATALOG_ROOT = '/root/vibe/dsh/scratch/native-dsh-catalog'
const NATIVE_DSH_LOCK = join(NATIVE_DSH_CATALOG_ROOT, 'native-dsh.lock.json')
const TREE_V2_BASELINE = resolve(repoRoot, 'packages/candidate-tree-v2-baseline')
const LEGACY_BASELINE = resolve(repoRoot, 'packages/candidate-baseline')

const credentialPath =
  process.env['DSH_TREE_V2_CREDENTIAL'] ?? '/root/.config/dsh-evolve-le/zen-compatible.key'
// ADR-033 amendment (2026-09-05): one-api retired; the official DeepSeek
// endpoint serves the same model. The launcher pins this explicitly.
const baseUrl = process.env['DSH_TREE_V2_BASE_URL'] ?? 'https://api.deepseek.com/v1'
const modelName = process.env['DSH_TREE_V2_MODEL'] ?? 'deepseek-v4-flash'

// --- 0. The paid-run gate -----------------------------------------------------
requireLiveConfirmation(process.env['DSH_TREE_V2_LIVE_CONFIRM'])
if (!existsSync(TARBALL)) {
  throw new Error(`pinned tarball missing at ${TARBALL}; run \`pnpm setup:source\` first`)
}
if (!existsSync(CLI_BIN)) {
  throw new Error(`built CLI missing at ${CLI_BIN}; run \`pnpm -s build\` from the repo root first`)
}
if (!existsSync(NATIVE_DSH_LOCK)) {
  throw new Error(
    `native DSH lock missing at ${NATIVE_DSH_LOCK}; materialize the catalog per docs/configuration.md first`,
  )
}
const nativeLock = JSON.parse(await readFile(NATIVE_DSH_LOCK, 'utf8')) as {
  dependencyClosureSha256?: string
}
if (
  typeof nativeLock.dependencyClosureSha256 !== 'string' ||
  !/^[0-9a-f]{64}$/.test(nativeLock.dependencyClosureSha256)
) {
  throw new Error(`native DSH lock at ${NATIVE_DSH_LOCK} carries no dependencyClosureSha256`)
}
const nativeDshClosureSha256 = nativeLock.dependencyClosureSha256

const failures: string[] = []
const check = (name: string, ok: boolean, detail?: string): boolean => {
  if (!ok) failures.push(detail === undefined ? name : `${name}: ${detail}`)
  return ok
}

// --- 1. Credential: 0600 file outside the repository ---------------------------
const credentialInfo = await stat(credentialPath).catch(() => undefined)
if (
  !check(
    'credential file exists outside the repository',
    credentialInfo !== undefined && !credentialInfo.isDirectory(),
    credentialPath,
  )
) {
  console.error(`tree-v2 k10 live FAILED: credential ${credentialPath} missing`)
  process.exit(1)
}
if ((credentialInfo!.mode & 0o077) !== 0) {
  console.error(
    `tree-v2 k10 live FAILED: credential ${credentialPath} mode ${credentialInfo!.mode.toString(8)} is not owner-only`,
  )
  process.exit(1)
}
const credential = (await readFile(credentialPath, 'utf8')).trim()
if (credential.length === 0) {
  console.error(`tree-v2 k10 live FAILED: credential ${credentialPath} is empty`)
  process.exit(1)
}

// --- 2. Scratch OUTSIDE the repo; the pinned task set --------------------------
// The run root carries solve-gateway/tokens/ (0600 per-trial secrets): it is
// state, never evidence, so the whole tree lives in scratch and only
// sanitized copies land under evidence/.
const scratch = await mkdtemp(join('/root/vibe/dsh/scratch/', 'dsh-tree-v2-k10-live-'))
const runsRoot = resolve(scratch, 'runs')
const jobsRoot = resolve(scratch, 'jobs')
const runRoot = join(runsRoot, RUN_ID)
console.log('tree-v2 k10 live: extracting pinned terminal-bench 2.1 tasks…')
await exec('tar', ['-xzf', TARBALL, '-C', scratch])
const { DATASET_PIN } = await import(
  pathToFileURL(resolve(repoRoot, 'benchmark-adapters/terminal-bench/lib/dataset.js')).href
)
const upstreamTasksRoot = join(scratch, 'tasks-upstream')
await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), upstreamTasksRoot, {
  recursive: true,
})
// Materialize the frozen ≤30-minute Terminal-Bench profile (the same
// 89→72 exclusion the Gate 8 pilot recorded). The CLI enforces the rule
// again at init; keeping excluded tasks out of the staged root also keeps
// image prefetch and verifier preparation from touching them.
const eligibleTasksRoot = join(scratch, 'tasks-eligible')
await mkdir(eligibleTasksRoot, { recursive: true })
const { taskAgentTimeoutSec } = await import(
  pathToFileURL(resolve(repoRoot, 'benchmark-adapters/terminal-bench/lib/task-timeout.js')).href
)
const allTaskEntries = (await readdir(upstreamTasksRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))
const excludedHandles: string[] = []
for (const entry of allTaskEntries) {
  const source = join(upstreamTasksRoot, entry.name)
  if ((await taskAgentTimeoutSec(source)) > 1_800) {
    excludedHandles.push(entry.name)
    continue
  }
  await cp(source, join(eligibleTasksRoot, entry.name), { recursive: true })
}
if (excludedHandles.length === 0 || allTaskEntries.length !== 89) {
  throw new Error(
    `tree-v2 k10 live: expected 89 upstream tasks with a non-empty >1800s exclusion set; got ${String(allTaskEntries.length)} / ${String(excludedHandles.length)}`,
  )
}
// Live solver runs refuse to launch without derived offline verifier images
// (cli.ts composeReal): a prefetched Harbor image can still carry a verifier
// that downloads uv/pytest at test time. ADR-042 (specs/04 §4.2): prepare the
// FULL pre-registered benchmark baseline matrix (24 observed tasks in frozen
// ceremony order) before any paid launch — the driver runs every matrix
// trial before the zero-success pool freezes, so every matrix handle needs
// its derived verifier image up front (the stable-demo §4.1 two-batch
// discovery of ADR-041 is replaced for this profile).
if (PROFILE.benchmarkBaseline === undefined) {
  throw new Error('tree-v2 k10 live: the k10 profile must pre-register its benchmark baseline')
}
console.log('tree-v2 k10 live: building offline verifier images (no test-time downloads)…')
const { runSplitCeremony, splitCountsForPopulation } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/split/ceremony.js')).href
)
const eligibleHandles = (await readdir(eligibleTasksRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
const ceremony = runSplitCeremony({
  runId: RUN_ID,
  masterSeed: MASTER_SEED,
  handles: eligibleHandles,
  counts: splitCountsForPopulation(eligibleHandles.length),
})
const { prepareOfflineVerifierTasks } = await import(
  pathToFileURL(resolve(repoRoot, 'benchmark-adapters/terminal-bench/lib/verifier-image.js')).href
)
const prepared = await prepareOfflineVerifierTasks({
  // Keep the pinned source population available to CLI init so it can record
  // the 89→72 exclusion provenance; the allowlist limits which tasks receive
  // derived verifier images.
  sourceTasksRoot: upstreamTasksRoot,
  outputTasksRoot: join(scratch, 'tasks'),
  taskAllowlist: ceremony.ceremony.observedHandles.slice(0, PROFILE.benchmarkBaseline.taskCount),
  dockerBin: 'docker',
})
const tasksRoot = prepared.tasksRoot
const verifierImageReceipt = prepared.receipt

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_BIN, ...args], {
      cwd: repoRoot,
      // The pre-registered envelope is 16 h wall clock; give the process
      // wrapper 17 h so the run's own budget trips first and the report
      // lands as data, not as a killed process.
      timeout: 61_200_000,
      maxBuffer: 64 << 20,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message: string }
    return { code: err.code ?? null, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message }
  }
}

/** Harbor layout: <jobsRoot>/<job>/<trial>/result.json (as in the pilot). */
async function trialPaths(root: string): Promise<Array<{ jobName: string; trialName: string }>> {
  const out: Array<{ jobName: string; trialName: string }> = []
  for (const job of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!job.isDirectory() || job.name.startsWith('.')) continue
    for (const trial of await readdir(join(root, job.name), { withFileTypes: true }).catch(
      () => [],
    )) {
      if (
        trial.isDirectory() &&
        existsSync(join(root, job.name, trial.name, 'result.json'))
      ) {
        out.push({ jobName: job.name, trialName: trial.name })
      }
    }
  }
  return out
}

// --- 3. init: BOTH routes live on the real model -------------------------------
console.log(`tree-v2 k10 live: dsh-evolve init (solver+proposer route → ${modelName})…`)
const initArgs = buildTreeV2InitArgs(PROFILE, {
  runsRoot,
  runId: RUN_ID,
  masterSeed: MASTER_SEED,
  tasksRoot,
  treeV2BaselineSource: TREE_V2_BASELINE,
  legacyBaselineSource: LEGACY_BASELINE,
  jobsRoot,
  nativeDshCatalogRoot: NATIVE_DSH_CATALOG_ROOT,
  nativeDshClosureSha256,
  credentialFile: credentialPath,
  modelBaseUrl: baseUrl,
  modelName,
  artifactHost: ARTIFACT_HOST,
  artifactPort: ARTIFACT_PORT,
  ...(TRIAL_CONTAINER_PROXY !== '' ? { trialContainerProxy: TRIAL_CONTAINER_PROXY } : {}),
})
const init = await cli(initArgs)
if (init.code !== 0) {
  console.error(`tree-v2 k10 live FAILED: init exited ${String(init.code)}`)
  console.error(init.stderr.slice(0, 4000))
  process.exit(1)
}
// Bind the run-scoped verifier-image receipt BEFORE doctor/run: composeReal
// refuses a live solver without it (fail closed before any image operation).
await writeFile(
  join(runRoot, 'verifier-image-receipt.json'),
  `${JSON.stringify(verifierImageReceipt, null, 2)}\n`,
  'utf8',
)
const initDoc = JSON.parse(init.stdout) as { configHash: string; handles: number }
check(
  'initFrozeAllHandles',
  initDoc.handles > 0 && /^sha256:[0-9a-f]{64}$/.test(initDoc.configHash),
  JSON.stringify(initDoc),
)
const frozenConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
  candidateProtocol?: string
  solverRoute?: string
  proposerRoute?: string
  search?: {
    kTarget?: number
    coldStartTrials?: number
    shortlistSize?: number
    maxSolverTrials?: number
    maxDiscoveryTrials?: number
    discoveryBatchSize?: number
    proposalWidth?: number
    benchmarkBaseline?: { taskCount?: number; attemptsPerTask?: number; batchSize?: number }
  }
  budget?: { solverTokens?: number; taskTrials?: number; wallClockMinutes?: number }
  benchmark?: {
    baselineSourceDir?: string
    legacyBaselineSourceDir?: string
    artifactEndpoint?: { host?: string; port?: number }
    trialContainerProxy?: { httpProxy?: string; noProxy?: string }
  }
  nativeDsh?: { catalogRoot?: string; dependencyClosureSha256?: string }
}
check(
  'configIsTreeV2WithBothRoutesLive',
  frozenConfig.candidateProtocol === 'tree-v2' &&
    frozenConfig.solverRoute === 'deepseek/zen-compatible' &&
    frozenConfig.proposerRoute === 'deepseek/zen-compatible',
  JSON.stringify({
    candidateProtocol: frozenConfig.candidateProtocol,
    solverRoute: frozenConfig.solverRoute,
    proposerRoute: frozenConfig.proposerRoute,
  }),
)
check(
  'configMatchesThePreRegisteredK10Profile',
  frozenConfig.search?.kTarget === PROFILE.kTarget &&
    frozenConfig.search?.coldStartTrials === PROFILE.coldStartTrials &&
    frozenConfig.search?.shortlistSize === PROFILE.shortlistSize &&
    frozenConfig.search?.maxSolverTrials === PROFILE.maxSolverTrials &&
    frozenConfig.search?.maxDiscoveryTrials === PROFILE.maxDiscoveryTrials &&
    frozenConfig.search?.discoveryBatchSize === PROFILE.discoveryBatchSize &&
    frozenConfig.search?.proposalWidth === PROFILE.proposalWidth &&
    frozenConfig.search?.benchmarkBaseline?.taskCount === PROFILE.benchmarkBaseline?.taskCount &&
    frozenConfig.search?.benchmarkBaseline?.attemptsPerTask ===
      PROFILE.benchmarkBaseline?.attemptsPerTask &&
    frozenConfig.search?.benchmarkBaseline?.batchSize === PROFILE.benchmarkBaseline?.batchSize &&
    frozenConfig.budget?.solverTokens === PROFILE.solverTokens &&
    frozenConfig.budget?.taskTrials === PROFILE.taskTrials &&
    frozenConfig.budget?.wallClockMinutes === PROFILE.wallClockMinutes,
  JSON.stringify({ search: frozenConfig.search, budget: frozenConfig.budget }),
)
check(
  'configBindsTheMigrationRootAndLegacyBaseline',
  frozenConfig.benchmark?.baselineSourceDir === TREE_V2_BASELINE &&
    frozenConfig.benchmark?.legacyBaselineSourceDir === LEGACY_BASELINE,
  JSON.stringify(frozenConfig.benchmark ?? null),
)
check(
  'configBindsTheNativeDshRuntimeLock',
  frozenConfig.nativeDsh?.catalogRoot === NATIVE_DSH_CATALOG_ROOT &&
    frozenConfig.nativeDsh?.dependencyClosureSha256 === nativeDshClosureSha256,
  JSON.stringify(frozenConfig.nativeDsh ?? null),
)
// The gateway rides the artifact listener, so the frozen endpoint must be a
// fixed reachable address, not an ephemeral port.
check(
  'artifactEndpointIsFixedOnTheBridge',
  frozenConfig.benchmark?.artifactEndpoint?.port === ARTIFACT_PORT,
  JSON.stringify(frozenConfig.benchmark?.artifactEndpoint ?? null),
)
// ADR-028 second amendment: when the launch requested proxy injection, the
// frozen config must record exactly that pair (credential-free), and a config
// frozen WITHOUT it must never gain it silently at run time.
check(
  'trialContainerProxyMatchesTheLaunchRequest',
  TRIAL_CONTAINER_PROXY === ''
    ? frozenConfig.benchmark?.trialContainerProxy === undefined
    : frozenConfig.benchmark?.trialContainerProxy?.httpProxy === TRIAL_CONTAINER_PROXY &&
        typeof frozenConfig.benchmark?.trialContainerProxy?.noProxy === 'string',
  JSON.stringify(frozenConfig.benchmark?.trialContainerProxy ?? null),
)
// The gateway opens with exactly this plan; the receipts must bind its hash.
const { solverRoutePlan } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/proposer/remote-runner.js')).href
)
const { remoteRoutePlanHash } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/proposer/remote-gateway.js')).href
)
const solvePlan = solverRoutePlan(frozenConfig)
if (solvePlan === null) {
  console.error('tree-v2 k10 live FAILED: frozen config carries no solver plan')
  process.exit(1)
}
const routeHash = remoteRoutePlanHash(solvePlan)

// --- 4. doctor + run: the full tree-v2 loop, live --------------------------------
console.log('tree-v2 k10 live: dsh-evolve doctor…')
const doctor = await cli(['doctor', '--run-root', runRoot])
check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
if (doctor.code !== 0) {
  console.error(`tree-v2 k10 live FAILED: doctor exited ${String(doctor.code)}`)
  console.error(doctor.stdout)
  process.exit(1)
}

console.log(
  `tree-v2 k10 live: dsh-evolve run (live solver + live proposer via ${modelName}; K=${String(PROFILE.kTarget)})…`,
)
const runStart = Date.now()
const run = await cli(['run', '--run-root', runRoot])
const runSeconds = Math.round((Date.now() - runStart) / 1000)
if (run.code !== 0) {
  console.error(`tree-v2 k10 live FAILED: run exited ${String(run.code)}`)
  console.error(run.stderr.slice(0, 4000))
  console.error(`scratch kept for diagnosis: ${scratch}`)
  process.exit(1)
}
const report = JSON.parse(run.stdout) as {
  stopReason: string
  status: string
  trials: number
  discoveryTrials: number
  expansionAttempts: number
  admittedNonBaseline: number
  failurePool: string[]
  budget: Record<string, { spent: number; reserved: number }>
}
console.log(
  `tree-v2 k10 live: ${report.stopReason} / ${report.status} — trials=${String(report.trials)} expansions=${String(report.expansionAttempts)} (${String(runSeconds)}s)`,
)

// The pre-registered envelope is the only funded shape (ADR-040): discovery
// batch + one cold start per admitted node + ordinary UCB-Air evaluations,
// inside the profile caps and the wave-snapshot admission overshoot bound.
const envelope = trialShapeWithinPreRegisteredEnvelope(
  {
    trials: report.trials,
    discoveryTrials: report.discoveryTrials,
    expansionAttempts: report.expansionAttempts,
    admittedNonBaseline: report.admittedNonBaseline,
    proposalCalls: report.budget['proposal-calls']?.spent ?? -1,
  },
  PROFILE,
)
check('trialCountWithinThePreRegisteredEnvelope', envelope.ok, envelope.detail)
check('stopReasonIsARegisteredTerminalState', REGISTERED_TERMINAL_STOP_REASONS.includes(report.stopReason), report.stopReason)
const solverBudget = report.budget['solver-tokens'] ?? null
check(
  'solverTokensSettledFromReceipts',
  solverBudget !== null && solverBudget.spent > 0 && solverBudget.reserved === 0,
  JSON.stringify(solverBudget),
)
check(
  'usdSettledPriced',
  (report.budget['usd']?.spent ?? 0) > 0 && (report.budget['usd']?.reserved ?? -1) === 0,
  JSON.stringify(report.budget['usd']),
)
const proposalCalls = report.budget['proposal-calls']
check(
  'proposerCallsSettled',
  proposalCalls !== undefined &&
    proposalCalls.spent === report.expansionAttempts &&
    proposalCalls.reserved === 0,
  JSON.stringify(proposalCalls ?? null),
)

// --- 5. The migration receipt + every Harbor trial's receipt chain -------------
const migrationPath = join(runRoot, 'tree-v2-migration.json')
const migration = existsSync(migrationPath)
  ? (JSON.parse(await readFile(migrationPath, 'utf8')) as {
      protocol?: string
      legacySourceDigest?: string
      treeV2SourceDigest?: string
      resultsInherited?: boolean
    })
  : null
check(
  'migrationReceiptFrozenWithNoInheritedResults',
  migration !== null &&
    migration.protocol === 'dsh-evolve-le/tree-v2-migration-binding/v1' &&
    migration.resultsInherited === false &&
    typeof migration.legacySourceDigest === 'string' &&
    typeof migration.treeV2SourceDigest === 'string',
  migrationPath,
)

const trials = await trialPaths(jobsRoot)
const jobNames = [...new Set(trials.map((trial) => trial.jobName))]
check(
  'trialDirsMatchReport',
  trials.length === report.trials && jobNames.length === report.trials,
  `${String(trials.length)} trial dirs (${jobNames.join(',')}) vs report ${String(report.trials)}`,
)
const { verifySolveReceipts } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/solver/receipts.js')).href
)
interface TrialFact {
  jobName: string
  trialName: string
  taskName: string | null
  reward: number | null
  agentResult: { n_input_tokens?: number | null; cost_usd?: number | null } | null
  trajectoryBytes: number
  receipts: { ok: boolean; requests: number; totalTokens: number; costUsdMicros: number }
  resultPath: string
  trajectoryPath: string
  receiptsPath: string
}
const trialFacts: TrialFact[] = []
for (const trial of trials) {
  const resultPath = join(jobsRoot, trial.jobName, trial.trialName, 'result.json')
  const trajectoryPath = join(jobsRoot, trial.jobName, trial.trialName, 'agent', 'trajectory.json')
  const receiptsPath = join(runRoot, 'solve-gateway', 'receipts', `${trial.jobName}.jsonl`)
  const parsed = existsSync(resultPath)
    ? (JSON.parse(await readFile(resultPath, 'utf8')) as {
        task_name?: string
        verifier_result?: { rewards?: { reward?: number } }
        exception_info?: unknown
        agent_result?: {
          n_input_tokens?: number | null
          cost_usd?: number | null
          metadata?: { acp?: { initialize?: unknown } } | null
        }
      })
    : null
  const trajectoryText = existsSync(trajectoryPath)
    ? await readFile(trajectoryPath, 'utf8')
    : ''
  // Each trajectory must be non-empty AND must not be the recorded replay
  // (the deterministic '[dsh-evolve-le replay]' marker).
  check(
    `trajectoryNonEmpty (${trial.jobName}/${trial.trialName})`,
    trajectoryText.trim().length > 0,
    trajectoryPath,
  )
  check(
    `trajectoryIsNotRecordedReplay (${trial.jobName}/${trial.trialName})`,
    !trajectoryText.includes('[dsh-evolve-le replay]'),
    'the solve layer served the recorded replay; the live route never engaged',
  )
  const verification = await verifySolveReceipts({
    receiptsPath,
    routeHash,
    jobName: trial.jobName,
  })
  check(
    `receiptChainVerifies (${trial.jobName}, routeHash ${routeHash.slice(0, 16)}…)`,
    verification.ok,
    verification.problems.join('; '),
  )
  // ADR-040 usage attribution: the TCB receipt chain is the authority for
  // every live trial's spend. Harbor's capsule report is a cross-check only
  // where upstream preserves it — an AgentTimeoutError kill discards the
  // report but not the chain (attempt 13's 262,250-token trial).
  const agentResult = parsed?.agent_result ?? null
  const initializeRecord = parsed?.agent_result?.metadata?.acp?.initialize
  const neverInitialized =
    (initializeRecord === null || initializeRecord === undefined) &&
    parsed?.exception_info !== null &&
    parsed?.exception_info !== undefined
  const receiptCover = receiptChainCoversTrial({
    chainVerified: verification.ok,
    chainRequests: verification.usage.requests,
    neverInitialized,
  })
  check(
    `receiptChainCoversEveryLiveTrial (${trial.jobName}/${trial.trialName})`,
    receiptCover.ok,
    receiptCover.detail,
  )
  const harborUsage = harborUsageReportedWhenCapsuleCompleted({
    capsuleCompleted: (parsed?.agent_result?.metadata ?? null) !== null,
    harborUsagePositive:
      (agentResult?.n_input_tokens ?? 0) > 0 && (agentResult?.cost_usd ?? 0) > 0,
  })
  check(
    `harborUsageReportedWhenCapsuleCompleted (${trial.jobName}/${trial.trialName})`,
    harborUsage.ok,
    harborUsage.detail,
  )
  trialFacts.push({
    jobName: trial.jobName,
    trialName: trial.trialName,
    taskName: parsed?.task_name ?? null,
    reward: parsed?.verifier_result?.rewards?.reward ?? null,
    agentResult: agentResult ?? null,
    trajectoryBytes: Buffer.byteLength(trajectoryText, 'utf8'),
    receipts: {
      ok: verification.ok,
      requests: verification.usage.requests,
      totalTokens: verification.usage.totalTokens,
      costUsdMicros: verification.usage.costUsdMicros,
    },
    resultPath,
    trajectoryPath,
    receiptsPath,
  })
}
// The settle authority: the solver-tokens dimension must equal the sum of
// every trial's receipt-verified figures, to the token.
const receiptTotal = trialFacts.reduce((sum, fact) => sum + fact.receipts.totalTokens, 0)
check(
  'receiptUsageMatchesSettlement',
  solverBudget !== null && receiptTotal === solverBudget.spent,
  `receipts ${String(receiptTotal)} vs settled ${String(solverBudget?.spent)}`,
)
const tokenFiles = (
  await readdir(join(runRoot, 'solve-gateway', 'tokens')).catch(() => [] as string[])
).filter((name) => name.endsWith('.token'))
check(
  'oneTokenFilePerTrial',
  tokenFiles.length === trials.length,
  tokenFiles.join(','),
)
const trialTokens = await Promise.all(
  tokenFiles.map((name) =>
    readFile(join(runRoot, 'solve-gateway', 'tokens', name), 'utf8').then((text) => text.trim()),
  ),
)

// --- 6. Evidence: sanitized copies first, then the redaction scan --------------
const artifactsDir = resolve(evidenceDir, 'artifacts')
await mkdir(artifactsDir, { recursive: true })
const artifactCopies: Array<[string, string]> = []
for (const [index, fact] of trialFacts.entries()) {
  const tag = `t${index + 1}-${fact.jobName}`
  artifactCopies.push(
    [fact.receiptsPath, `${tag}-solve-receipts.jsonl`],
    [fact.resultPath, `${tag}-trial-result.json`],
    [fact.trajectoryPath, `${tag}-trajectory.json`],
  )
}
artifactCopies.push(
  [join(runRoot, 'run-manifest.json'), 'run-manifest.json'],
  [join(runRoot, 'drive-report.json'), 'drive-report.json'],
  [migrationPath, 'tree-v2-migration.json'],
  [join(runRoot, 'verifier-image-receipt.json'), 'verifier-image-receipt.json'],
  [join(runRoot, 'image-prefetch.json'), 'image-prefetch.json'],
)
// ADR-043: the proposal saga's receipts — validation summaries with
// per-child rejection reasons, proposal bundles, transcripts, gateway/remote
// receipts, worker verdicts — must survive the scratch deletion (rule 7).
artifactCopies.push(...(await proposalEvidenceCopies(runRoot)))
for (const [source, name] of artifactCopies) {
  await cp(source, resolve(artifactsDir, name)).catch(() => undefined)
}

// REDACTION (rule 8), asserted over every artifact this run record writes —
// the document itself is scanned as the exact bytes it will land as.
const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
const document = {
  gate: 'tree-v2',
  kind: 'k10-live-run',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repositoryHead: head.stdout.trim(),
  },
  protocol: {
    candidateProtocol: 'tree-v2',
    migration: {
      protocol: migration?.protocol ?? null,
      legacySourceDigest: migration?.legacySourceDigest ?? null,
      treeV2SourceDigest: migration?.treeV2SourceDigest ?? null,
      resultsInherited: migration?.resultsInherited ?? null,
    },
    treeV2BaselineSource: TREE_V2_BASELINE,
    legacyBaselineSource: LEGACY_BASELINE,
  },
  profile: { name: 'k10', ...PROFILE },
  route: {
    id: 'deepseek/zen-compatible',
    baseUrl,
    model: modelName,
    temperature: 0,
    routeHash,
    credentialFile: credentialPath,
    roles: ['solver', 'proposer'],
  },
  nativeDsh: {
    catalogRoot: NATIVE_DSH_CATALOG_ROOT,
    dependencyClosureSha256: nativeDshClosureSha256,
  },
  taskPopulation: {
    upstreamTasks: allTaskEntries.length,
    excludedOverThirtyMinutes: excludedHandles,
    eligibleTasks: eligibleHandles.length,
    verifierImagesPrepared: verifierImageReceipt.tasks.length,
  },
  budgets: {
    usd: report.budget['usd'] ?? null,
    'solver-tokens': solverBudget,
    'task-trials': report.budget['task-trials'] ?? null,
    'proposal-calls': proposalCalls ?? null,
    'proposer-tokens': report.budget['proposer-tokens'] ?? null,
  },
  run: {
    runId: RUN_ID,
    configHash: initDoc.configHash,
    stopReason: report.stopReason,
    status: report.status,
    trials: report.trials,
    discoveryTrials: report.discoveryTrials,
    expansionAttempts: report.expansionAttempts,
    seconds: runSeconds,
  },
  trials: trialFacts.map((fact) => ({
    jobName: fact.jobName,
    trialName: fact.trialName,
    taskName: fact.taskName,
    reward: fact.reward,
    agentResult: fact.agentResult,
    trajectoryBytes: fact.trajectoryBytes,
    receipts: fact.receipts,
  })),
  receipts: {
    routeHash,
    totalRequests: trialFacts.reduce((sum, fact) => sum + fact.receipts.requests, 0),
    totalTokens: receiptTotal,
    costUsdMicros: trialFacts.reduce((sum, fact) => sum + fact.receipts.costUsdMicros, 0),
  },
  coveredBySuites: [
    'packages/dsh-evolve-le/tests/tree-v2.test.ts',
    'packages/dsh-evolve-le/tests/tree-v2-live-profile.test.ts',
    'packages/dsh-evolve-le/tests/builder.test.ts',
    'packages/dsh-evolve-le/tests/solve-gateway.test.ts',
  ],
}
// Provisional document = exactly the bytes that would land, with the failure
// list so far; the scan below can only append static check names, so the
// rebuilt final document stays byte-equivalent where it matters.
const provisional = JSON.stringify({ ...document, failures }, null, 2)
const artifactTexts = await Promise.all(
  (await readdir(artifactsDir).catch(() => [] as string[]))
    .sort()
    .map((name) => readFile(join(artifactsDir, name), 'utf8').catch(() => '')),
)
const everyText = [provisional, ...artifactTexts]
check('noCredentialInAnyArtifact', everyText.every((text) => !text.includes(credential)))
for (const token of trialTokens) {
  if (token !== '') {
    check(
      'noTrialTokenInAnyArtifact',
      everyText.every((text) => !text.includes(token)),
    )
  }
}

// --- 7. Final documents: the failure list is complete before allPassed ---------
const finalDocument = { ...document, failures }
const documentPath = resolve(evidenceDir, 'k10-live-run.json')
await mkdir(evidenceDir, { recursive: true })
await writeFile(documentPath, `${JSON.stringify(finalDocument, null, 2)}\n`)
const allPassed = failures.length === 0
const documentSha = createHash('sha256').update(await readFile(documentPath)).digest('hex')
await writeFile(
  resolve(evidenceDir, 'STATUS.json'),
  `${JSON.stringify(
    {
      gate: 'tree-v2',
      kind: 'k10-live-run-status',
      generatedAt: document.generatedAt,
      environment: document.environment,
      summary: {
        route: `solver+proposer deepseek/zen-compatible → ${modelName}`,
        protocol: 'tree-v2 (migration root, resultsInherited:false)',
        profile: 'k10',
        stopReason: report.stopReason,
        trials: report.trials,
        discoveryTrials: report.discoveryTrials,
        expansionAttempts: report.expansionAttempts,
        tasks: trialFacts.map((fact) => fact.taskName ?? '?'),
        rewards: trialFacts.map((fact) => fact.reward),
        requests: document.receipts.totalRequests,
        totalTokens: document.receipts.totalTokens,
        costUsdMicros: document.receipts.costUsdMicros,
        seconds: runSeconds,
      },
      allPassed,
      evidence: {
        run: { path: 'evidence/tree-v2/k10-live/k10-live-run.json', sha256: documentSha },
      },
    },
    null,
    2,
  )}\n`,
)
if (!allPassed) {
  console.error(`tree-v2 k10 live FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  console.error(`scratch kept for diagnosis: ${scratch}`)
  process.exit(1)
}
await rm(scratch, { recursive: true, force: true })
console.log(
  `tree-v2 k10 live: stop=${report.stopReason} trials=${String(report.trials)} ` +
    `expansions=${String(report.expansionAttempts)} via ${modelName}; ` +
    `${String(document.receipts.totalRequests)} requests, ${String(document.receipts.totalTokens)} tokens, ` +
    `${String(document.receipts.costUsdMicros)} µUSD (${String(runSeconds)}s)`,
)
