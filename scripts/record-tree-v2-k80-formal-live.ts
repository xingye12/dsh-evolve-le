/**
 * Record the tree-v2 K=80 FORMAL run — the ADR-045..049 full protocol
 * (specs/03 §2 terminal-bench-formal envelope): the guard-inclusive 49×1
 * benchmark baseline matrix (39 observed + 10 guard opaque, ADR-046/049 —
 * the ADR-057 successor-only repair3 calibration: one attempt per
 * development handle, results labeled 49×1),
 * the champion tournament with triple-hash lock (ADR-047), and — only when
 * the driver stops at CHAMPION_LOCKED — the pre-registered sealed evaluation
 * (ADR-048: 23 sealed tasks × 5 attempts × 2 sides = 230 trials, 95% CI,
 * one-shot reveal). Both the solver and the proposer run on the real
 * networked model route (deepseek/zen-compatible): alpha=0.8 pre-registered
 * (final gate ceil(80^1.25)=240, minimumTrials 255 ≤ 400), a 400-trial
 * search envelope, a 360-trial tournament envelope, a 76h wall clock
 * (3600 search + 960 tournament — the ADR-058 phased amendment of the
 * specs/00 §6.3 16h objective; ADR-048 had set the search share at 1800,
 * which the post-ADR-054 cadence projection cannot reach K=80 under), and
 * a separate
 * 12h / ~$33 / 460M-token sealed budget. The run starts from the tree-v2
 * migration root (packages/candidate-tree-v2-baseline, bound to the legacy
 * v1 baseline by the frozen tree-v2-migration.json receipt,
 * resultsInherited:false).
 *
 * This is the FORMAL protocol run (scope.formal:true): its sealed verdict is
 * the one-shot final evaluation. The sealed plan is generated here BEFORE
 * init — the baseline id pre-derives from the canonical source digest, so
 * the plan (and its hash, which the driver freezes into the champion lock)
 * is bound before any paid trial exists. The runner-up is never evaluated:
 * the sealed evaluation launches only the locked champion and the baseline.
 *
 * Concealment (ADR-046/048): the sealed split store persists 0600 in the
 * scratch root, OUTSIDE the evidence tree, and is never journaled. Guard and
 * sealed trial artifacts are sanitized before any evidence copy: guard task
 * names are replaced by their opaque ids, sealed artifacts are never copied
 * (aggregates only), and every evidence-bound byte is scanned for canary
 * tokens, guard names, sealed names, the credential, and per-trial gateway
 * tokens (CLAUDE.md rule 8, specs/05 §10–11).
 *
 * This is a PAID run: it talks to the real model endpoint for every solver
 * trial AND every proposal call. It refuses to start without the explicit
 * confirmation env var, and it fails closed (exit 1) on any violation.
 *
 * Cost bound (pre-registered profile k80, scripts/lib/tree-v2-live-profile.ts):
 * taskTrials 760 spans both paid phases (search ≤ 400 + tournament ≤ 360);
 * solverTokens 1 520M funds every trial at the frozen 2M gateway cap;
 * proposalCalls 60 / proposerTokens 60M cap proposer work; the ADR-056
 * debugger adds attributionCalls 80 / attributionTokens 16M on top. The
 * honest total (baseline 49 + cold starts + evaluations + tournament +
 * sealed 230) is ≈ 875–977 trials / ≈ $136–152 at the measured per-trial
 * pace — inside the $500 acceptance ceiling.
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
 * The script is resume-capable: every expensive step re-checks its outputs
 * (tasks extraction, verifier images, init, run, sealed evaluation), so a
 * process death mid-run restarts with `run` replaced by `resume` and the
 * sealed evaluation resumes from its 0600 trial rows.
 *
 * Usage: DSH_TREE_V2_FORMAL_VARIANT=repair5 node --import tsx/esm scripts/record-tree-v2-k80-formal-live.ts
 * @module scripts/record-tree-v2-k80-formal-live
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'
import { proposalEvidenceCopies } from './lib/evidence-copy-set.ts'
import {
  imagePrefetchAttestation,
  restrictedTaskNameHits,
  restrictedTaskNameRedactions,
  sanitizeRestrictedTaskNames,
} from './lib/evidence-sanitization.ts'
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

/**
 * A stopped formal run is immutable.  The selector makes the successor an
 * explicit fresh identity instead of resuming repair3 under altered code.
 * Defaulting to repair3 preserves the original command's meaning for audit
 * and its final-record guard still prevents an overwritten formal document.
 */
const FORMAL_RUNS = {
  repair3: {
    runId: 'tree-v2-k80-formal-repair-3',
    masterSeed: 'tree-v2-k80-formal-repair-3-master-seed-1',
    profileName: 'k80Repair3',
    evidenceDirectory: 'evidence/tree-v2/k80-formal-repair-3',
    scratch: '/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-3',
    profileLabel: '49×1 baseline calibration (ADR-057); 60h search wall clock (ADR-058)',
    statusProfile:
      'k80Repair3 / terminal-bench-formal (ADR-057 successor-only 49×1; ADR-058 60h search)',
  },
  repair4: {
    runId: 'tree-v2-k80-formal-repair-4',
    masterSeed: 'tree-v2-k80-formal-repair-4-master-seed-1',
    profileName: 'k80Repair4',
    evidenceDirectory: 'evidence/tree-v2/k80-formal-repair-4',
    scratch: '/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-4',
    profileLabel:
      '49×1 baseline calibration; v2 solve observations, 48-step proposer, 32k debugger (ADR-063)',
    statusProfile:
      'k80Repair4 / terminal-bench-formal (ADR-063 successor-only v2 observations; 48-step proposer; 32k debugger)',
  },
  repair5: {
    runId: 'tree-v2-k80-formal-repair-5',
    masterSeed: 'tree-v2-k80-formal-repair-5-master-seed-1',
    profileName: 'k80Repair5',
    evidenceDirectory: 'evidence/tree-v2/k80-formal-repair-5',
    scratch: '/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-5',
    profileLabel:
      '49×1 baseline; v2 solve observations; offline ACP bootstrap and 12-network preflight (ADR-064)',
    statusProfile:
      'k80Repair5 / terminal-bench-formal (ADR-064 successor-only offline ACP bootstrap and Docker network-capacity preflight)',
  },
  repair6: {
    runId: 'tree-v2-k80-formal-repair-6',
    masterSeed: 'tree-v2-k80-formal-repair-6-master-seed-1',
    profileName: 'k80Repair6',
    evidenceDirectory: 'evidence/tree-v2/k80-formal-repair-6',
    scratch: '/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-6',
    profileLabel:
      '49×1 baseline; 150-request live solve; executable solve-policy child gate (ADR-066)',
    statusProfile:
      'k80Repair6 / terminal-bench-formal (ADR-066 successor-only 150-request solve and strategy-first proposer admission)',
  },
} as const
const requestedVariant = process.env['DSH_TREE_V2_FORMAL_VARIANT'] ?? 'repair3'
if (!(requestedVariant in FORMAL_RUNS)) {
  throw new Error(
    `tree-v2 k80 formal: DSH_TREE_V2_FORMAL_VARIANT must be repair3, repair4, repair5, or repair6, got ${requestedVariant}`,
  )
}
const formalRun = FORMAL_RUNS[requestedVariant as keyof typeof FORMAL_RUNS]
const evidenceDir = resolve(repoRoot, formalRun.evidenceDirectory)
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const ARTIFACT_HOST = process.env['TREE_V2_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT = Number(process.env['TREE_V2_ARTIFACT_PORT'] ?? '8443')
// ADR-028 second amendment: trial containers reach the host's loopback-only
// egress proxy through a socat forwarder bound to the docker0 gateway
// (host-side environment, not protocol). Empty/unset = no proxy injection.
const TRIAL_CONTAINER_PROXY = process.env['TREE_V2_TRIAL_CONTAINER_PROXY'] ?? ''
const EGRESS_PROBE_URL =
  process.env['TREE_V2_EGRESS_PROBE_URL'] ??
  'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease'
const EGRESS_FORWARDER = resolve(repoRoot, 'scripts/lib/trial-egress-forwarder.py')
const RUN_ID = formalRun.runId
const MASTER_SEED = formalRun.masterSeed
// ADR-057 successor-only repair3 protocol: a fresh identity once more — the
// 49×1 baseline calibration, the ADR-054 q0 wave fix and the ADR-056
// bounded LLM Agent Debugger all change the runtime, so this is never a
// mutation of any earlier formal manifest. The 12-way wave width and the
// 49×1×12 matrix ride the pre-registered k80Repair3 profile; no paid launch
// occurs without this script's confirmation gate.
const PROFILE = TREE_V2_LIVE_PROFILES[formalRun.profileName]
// The native DSH runtime lock materialized by docs/configuration.md §Native
// DSH runtime lock (pinned upstream, built copy in scratch, inspected lock).
const NATIVE_DSH_CATALOG_ROOT = '/root/vibe/dsh/scratch/native-dsh-catalog'
const NATIVE_DSH_LOCK = join(NATIVE_DSH_CATALOG_ROOT, 'native-dsh.lock.json')
const TREE_V2_BASELINE = resolve(repoRoot, 'packages/candidate-tree-v2-baseline')
const LEGACY_BASELINE = resolve(repoRoot, 'packages/candidate-baseline')

// ADR-048 pre-registered sealed envelope (the plan carries it; the run
// config never does — sealed access stays false for the driver).
const SEALED_BUDGET = { wallClockMinutes: 720, usdMicros: 33_000_000, solverTokens: 460_000_000 }
const K_SEALED = 5
/** Information-flow monitor canary family size (driver default, Gate 4). */
const CANARY_COUNT = 4

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
// One formal run, one record: a previous final document means this run was
// already recorded (fail closed rather than overwrite the one-shot record).
if (existsSync(resolve(evidenceDir, 'k80-formal-run.json'))) {
  throw new Error(
    `formal record already exists at ${resolve(evidenceDir, 'k80-formal-run.json')}; refusing to re-record`,
  )
}

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
  console.error(`tree-v2 k80 formal FAILED: credential ${credentialPath} missing`)
  process.exit(1)
}
if ((credentialInfo!.mode & 0o077) !== 0) {
  console.error(
    `tree-v2 k80 formal FAILED: credential ${credentialPath} mode ${credentialInfo!.mode.toString(8)} is not owner-only`,
  )
  process.exit(1)
}
const credential = (await readFile(credentialPath, 'utf8')).trim()
if (credential.length === 0) {
  console.error(`tree-v2 k80 formal FAILED: credential ${credentialPath} is empty`)
  process.exit(1)
}

// --- 2. Scratch (FIXED path — resumable across process death) -----------------
// The run root carries solve-gateway/tokens/ (0600 per-trial secrets) and the
// sealed split store (0600): it is state, never evidence, so the whole tree
// lives in scratch and only sanitized copies land under evidence/. The path
// is fixed (not mkdtemp) so a killed process resumes the same run.
const scratch = formalRun.scratch
await mkdir(scratch, { recursive: true })
const runsRoot = resolve(scratch, 'runs')
const jobsRoot = resolve(scratch, 'jobs')
const runRoot = join(runsRoot, RUN_ID)
const sealedStorePath = join(scratch, 'sealed-store.json')

// A configured container proxy is a pre-launch dependency, not a candidate
// signal.  Before the first paid action (and before a P0 resume) exercise the
// exact docker0 listener with a 12-way HEAD probe.  The forwarder itself
// retries transient 5xx responses; a bad result stops before a Harbor job is
// created.  Do not demand the probe when there is no configured proxy, and do
// not rerun it during post-run evidence collection.
if (TRIAL_CONTAINER_PROXY !== '' && !existsSync(join(runRoot, 'drive-report.json'))) {
  const proxy = new URL(TRIAL_CONTAINER_PROXY)
  if (proxy.protocol !== 'http:' || proxy.username !== '' || proxy.password !== '') {
    throw new Error(
      'tree-v2 k80 formal: trial container proxy must be credential-free http://HOST:PORT',
    )
  }
  const { stdout, stderr } = await exec('python3', [
    EGRESS_FORWARDER,
    '--probe-proxy',
    TRIAL_CONTAINER_PROXY,
    '--probe-url',
    EGRESS_PROBE_URL,
    '--probe-parallel',
    '12',
  ])
  if (!stdout.includes('probe: OK') || stderr !== '') {
    throw new Error('tree-v2 k80 formal: trial egress preflight did not pass')
  }
  console.log('tree-v2 k80 formal: 12-way trial-egress preflight passed')
}

/** Harbor layout: <jobsRoot>/<job>/<trial>/result.json (as in the pilot). */
async function trialPaths(root: string): Promise<Array<{ jobName: string; trialName: string }>> {
  const out: Array<{ jobName: string; trialName: string }> = []
  for (const job of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!job.isDirectory() || job.name.startsWith('.')) continue
    for (const trial of await readdir(join(root, job.name), { withFileTypes: true }).catch(
      () => [],
    )) {
      if (trial.isDirectory() && existsSync(join(root, job.name, trial.name, 'result.json'))) {
        out.push({ jobName: job.name, trialName: trial.name })
      }
    }
  }
  return out
}

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

async function cli(args: readonly string[], timeoutMs: number): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_BIN, ...args], {
      cwd: repoRoot,
      // The pre-registered envelope is 76 h wall clock (3600 search + 960
      // tournament, ADR-058); give the process wrapper 77 h so the run's own
      // budget trips first and the report lands as data, not as a killed
      // process.
      timeout: timeoutMs,
      maxBuffer: 64 << 20,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message: string }
    return { code: err.code ?? null, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message }
  }
}

// --- 3. Task extraction + eligibility (idempotent) -----------------------------
console.log('tree-v2 k80 formal: extracting pinned terminal-bench 2.1 tasks…')
const { DATASET_PIN } = await import(
  pathToFileURL(resolve(repoRoot, 'benchmark-adapters/terminal-bench/lib/dataset.js')).href
)
const upstreamTasksRoot = join(scratch, 'tasks-upstream')
const eligibleTasksRoot = join(scratch, 'tasks-eligible')
if (!existsSync(join(upstreamTasksRoot, 'task.toml'))) {
  if (!existsSync(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir))) {
    await exec('tar', ['-xzf', TARBALL, '-C', scratch])
  }
  await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), upstreamTasksRoot, {
    recursive: true,
  })
}
// Materialize the frozen ≤30-minute Terminal-Bench profile (the same
// 89→72 exclusion the Gate 8 pilot recorded). The CLI enforces the rule
// again at init; keeping excluded tasks out of the staged root also keeps
// image prefetch and verifier preparation from touching them.
if (!existsSync(join(eligibleTasksRoot, 'task.toml'))) {
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
      `tree-v2 k80 formal: expected 89 upstream tasks with a non-empty >1800s exclusion set; got ${String(allTaskEntries.length)} / ${String(excludedHandles.length)}`,
    )
  }
}

// --- 4. Split ceremony + sealed store + sealed plan (deterministic) ------------
const { runSplitCeremony, splitCountsForPopulation } = (await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/split/ceremony.js')).href
)) as typeof import('../packages/dsh-evolve-le/lib/split/ceremony.js')
const eligibleHandles = (await readdir(eligibleTasksRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
check(
  'eligiblePopulationIsTheFrozen72',
  eligibleHandles.length === 72,
  `${String(eligibleHandles.length)} eligible tasks (pre-registered: 72)`,
)
const ceremony = runSplitCeremony({
  runId: RUN_ID,
  masterSeed: MASTER_SEED,
  handles: eligibleHandles,
  counts: splitCountsForPopulation(eligibleHandles.length),
})
const sealedStore = ceremony.sealedStore
check(
  'splitCountsMatchThePreRegistration',
  ceremony.ceremony.observedHandles.length === 39 &&
    ceremony.ceremony.guardOpaqueIds.length === 10 &&
    ceremony.ceremony.sealedCount === 23,
  `observed=${String(ceremony.ceremony.observedHandles.length)} guard=${String(ceremony.ceremony.guardOpaqueIds.length)} sealed=${String(ceremony.ceremony.sealedCount)} (pre-registered 39/10/23)`,
)
if (PROFILE.benchmarkBaseline === undefined || PROFILE.tournament === undefined) {
  throw new Error('tree-v2 k80 formal: the k80 profile must pre-register baseline + tournament')
}
check(
  'devVerifierAllowlistCoversTheWholeMatrix',
  ceremony.ceremony.observedHandles.slice(0, PROFILE.benchmarkBaseline.taskCount).length +
    sealedStore.guardHandles.slice(0, 10).length ===
    49,
  '39 observed + 10 guard real names',
)

// Persist the sealed store 0600 — never journaled, never copied to evidence.
await writeFile(sealedStorePath, `${JSON.stringify(sealedStore, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
})
const sealedStoreInfo = await stat(sealedStorePath)
check(
  'sealedStoreIsOwnerOnly',
  (sealedStoreInfo.mode & 0o077) === 0,
  `${sealedStorePath} mode ${sealedStoreInfo.mode.toString(8)}`,
)

// The sealed plan pre-derives BEFORE init: the baseline id is the canonical
// source digest identity, so the plan (and its hash, frozen into the
// champion lock) is bound before any paid trial exists.
const { captureCanonicalSource, candidateIdFromDigest } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/candidate/canonical.js')).href
)
const { stageDeclaredSource } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/builder/staging.js')).href
)
const { generateSealedPlan, verifySealedPlanDraws, SEALED_PLAN_PROTOCOL } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/sealed/plan.js')).href
)
// The builder identity (pipeline.ts stage 1): candidateIdFromDigest over the
// canonical capture of the DECLARED-entries staging — the working tree's
// lib/ build output never stages and must not enter the identity here.
const baselineStageRoot = join(scratch, 'baseline-stage')
await rm(baselineStageRoot, { recursive: true, force: true })
const stagedBaselineSource = join(baselineStageRoot, 'source')
await stageDeclaredSource(TREE_V2_BASELINE, stagedBaselineSource)
const baselineId = candidateIdFromDigest(
  (await captureCanonicalSource(stagedBaselineSource)).sha256,
)
const sealedPlan = generateSealedPlan({
  runId: RUN_ID,
  masterSeed: MASTER_SEED,
  baselineId,
  taskIds: Object.keys(sealedStore.sealedMap).sort(),
  kSealed: K_SEALED,
  budget: SEALED_BUDGET,
})
verifySealedPlanDraws(sealedPlan, MASTER_SEED)
const { canonicalHash } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/state/canonical.js')).href
)
const sealedPlanHash = `sha256:${canonicalHash(sealedPlan)}`
check(
  'sealedPlanIsThePreRegisteredShape',
  sealedPlan.taskCount === 23 && sealedPlan.trials.length === 230 && sealedPlan.kSealed === 5,
  `${String(sealedPlan.taskCount)} tasks × ${String(sealedPlan.kSealed)} × 2 = ${String(sealedPlan.trials.length)} trials (pre-registered 23/5/230)`,
)

// --- 5. Verifier images: 49 development tasks (matrix) + 23 sealed ------------
console.log('tree-v2 k80 formal: building offline verifier images (no test-time downloads)…')
const { prepareOfflineVerifierTasks } = await import(
  pathToFileURL(resolve(repoRoot, 'benchmark-adapters/terminal-bench/lib/verifier-image.js')).href
)
const devAllowlist = [
  ...ceremony.ceremony.observedHandles.slice(0, PROFILE.benchmarkBaseline.taskCount),
  ...sealedStore.guardHandles.slice(0, 10),
]
const devPrepared = await prepareOfflineVerifierTasks({
  // Keep the pinned source population available to CLI init so it can record
  // the 89→72 exclusion provenance; the allowlist limits which tasks receive
  // derived verifier images.
  sourceTasksRoot: upstreamTasksRoot,
  outputTasksRoot: join(scratch, 'tasks'),
  taskAllowlist: devAllowlist,
  dockerBin: 'docker',
})
const tasksRoot = devPrepared.tasksRoot
const verifierImageReceipt = devPrepared.receipt
check(
  'devVerifierReceiptCovers49RealTasks',
  verifierImageReceipt.tasks.length === 49,
  `${String(verifierImageReceipt.tasks.length)} derived images`,
)
// The 23 sealed tasks get their derived verifier images in a SEPARATE root
// (their names must not join the development receipt that lands in evidence
// via the manifest hash); the dirs are copied over the staged root after the
// champion locks, before the sealed evaluation.
const sealedPrepared = await prepareOfflineVerifierTasks({
  sourceTasksRoot: upstreamTasksRoot,
  outputTasksRoot: join(scratch, 'tasks-sealed'),
  taskAllowlist: sealedStore.sealedHandles,
  dockerBin: 'docker',
})
const sealedVerifierReceipt = sealedPrepared.receipt
check(
  'sealedVerifierReceiptCovers23RealTasks',
  sealedVerifierReceipt.tasks.length === 23,
  `${String(sealedVerifierReceipt.tasks.length)} derived images`,
)
const tasksSealedRoot = sealedPrepared.tasksRoot

// --- 6. init (once): BOTH routes live on the real model -----------------------
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
let initDoc: { configHash: string; handles: number; profile?: string } | null = null
if (!existsSync(join(runRoot, 'run.config.json'))) {
  console.log(`tree-v2 k80 formal: dsh-evolve init (solver+proposer route → ${modelName})…`)
  const init = await cli(initArgs, 600_000)
  if (init.code !== 0) {
    console.error(`tree-v2 k80 formal FAILED: init exited ${String(init.code)}`)
    console.error(init.stderr.slice(0, 4000))
    process.exit(1)
  }
  initDoc = JSON.parse(init.stdout) as { configHash: string; handles: number; profile?: string }
  check(
    'initFrozeAllHandles',
    initDoc.handles === 72 && /^sha256:[0-9a-f]{64}$/.test(initDoc.configHash),
    JSON.stringify(initDoc),
  )
  check(
    'initFrozeTheFormalProfile',
    initDoc.profile === 'terminal-bench-formal',
    JSON.stringify(initDoc),
  )
} else {
  console.log('tree-v2 k80 formal: run root already initialized (resume); skipping init')
}
// Bind the run-scoped verifier-image receipt BEFORE doctor/run: composeReal
// refuses a live solver without it (fail closed before any image operation).
await writeFile(
  join(runRoot, 'verifier-image-receipt.json'),
  `${JSON.stringify(verifierImageReceipt, null, 2)}\n`,
  'utf8',
)
// The pre-registered sealed plan rides the 0600 run-root file the driver's
// receipt references; the same bytes drive the sealed-evaluate later.
await writeFile(join(runRoot, 'sealed-plan.json'), `${JSON.stringify(sealedPlan, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
})
const frozenConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
  candidateProtocol?: string
  profile?: string
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
    ucbAirAlphaPerMille?: number
    benchmarkBaseline?: { taskCount?: number; attemptsPerTask?: number; batchSize?: number }
    tournament?: {
      minEligibilityTrials?: number
      coverageAttemptsPerTask?: number
      maxTrials?: number
      bootstrapResamples?: number
    }
  }
  budget?: {
    solverTokens?: number
    taskTrials?: number
    wallClockMinutes?: number
    wallClockSearchMinutes?: number
    proposalCalls?: number
    proposerTokens?: number
    attributionTokens?: number
    attributionCalls?: number
  }
  agentDebugger?: {
    route?: string
    maxOutputTokens?: number
    requestTimeoutMs?: number
    maxInputBytes?: number
  }
  benchmark?: {
    baselineSourceDir?: string
    legacyBaselineSourceDir?: string
    artifactEndpoint?: { host?: string; port?: number }
    trialContainerProxy?: { httpProxy?: string; noProxy?: string }
    harbor?: { concurrentTrials?: number }
  }
  nativeDsh?: { catalogRoot?: string; dependencyClosureSha256?: string }
}
check(
  'configIsTreeV2FormalWithBothRoutesLive',
  frozenConfig.candidateProtocol === 'tree-v2' &&
    frozenConfig.profile === 'terminal-bench-formal' &&
    frozenConfig.solverRoute === 'deepseek/zen-compatible' &&
    frozenConfig.proposerRoute === 'deepseek/zen-compatible',
  JSON.stringify({
    candidateProtocol: frozenConfig.candidateProtocol,
    profile: frozenConfig.profile,
    solverRoute: frozenConfig.solverRoute,
    proposerRoute: frozenConfig.proposerRoute,
  }),
)
// ADR-045/049: the k80 profile pre-registers alpha=0.8, the proposal budgets,
// the wave width, the guard-inclusive 49×1×12 matrix (ADR-057) AND the
// tournament envelope — every one of them must freeze verbatim. ADR-056
// adds the debugger envelope and the attribution budgets to the same gate.
check(
  'configMatchesThePreRegisteredK80Profile',
  frozenConfig.search?.kTarget === PROFILE.kTarget &&
    frozenConfig.search?.coldStartTrials === PROFILE.coldStartTrials &&
    frozenConfig.search?.shortlistSize === PROFILE.shortlistSize &&
    frozenConfig.search?.maxSolverTrials === PROFILE.maxSolverTrials &&
    frozenConfig.search?.maxDiscoveryTrials === PROFILE.maxDiscoveryTrials &&
    frozenConfig.search?.discoveryBatchSize === PROFILE.discoveryBatchSize &&
    frozenConfig.search?.proposalWidth === PROFILE.proposalWidth &&
    frozenConfig.search?.ucbAirAlphaPerMille === PROFILE.ucbAirAlphaPerMille &&
    frozenConfig.search?.benchmarkBaseline?.taskCount === PROFILE.benchmarkBaseline?.taskCount &&
    frozenConfig.search?.benchmarkBaseline?.attemptsPerTask ===
      PROFILE.benchmarkBaseline?.attemptsPerTask &&
    frozenConfig.search?.benchmarkBaseline?.batchSize === PROFILE.benchmarkBaseline?.batchSize &&
    frozenConfig.search?.tournament?.minEligibilityTrials ===
      PROFILE.tournament?.minEligibilityTrials &&
    frozenConfig.search?.tournament?.coverageAttemptsPerTask ===
      PROFILE.tournament?.coverageAttemptsPerTask &&
    frozenConfig.search?.tournament?.maxTrials === PROFILE.tournament?.maxTrials &&
    frozenConfig.search?.tournament?.bootstrapResamples ===
      PROFILE.tournament?.bootstrapResamples &&
    frozenConfig.budget?.solverTokens === PROFILE.solverTokens &&
    frozenConfig.budget?.taskTrials === PROFILE.taskTrials &&
    frozenConfig.budget?.wallClockMinutes === PROFILE.wallClockMinutes &&
    frozenConfig.budget?.wallClockSearchMinutes === PROFILE.wallClockSearchMinutes &&
    frozenConfig.budget?.proposalCalls === PROFILE.proposalCalls &&
    frozenConfig.budget?.proposerTokens === PROFILE.proposerTokens &&
    frozenConfig.benchmark?.harbor?.concurrentTrials === PROFILE.concurrentTrials &&
    frozenConfig.agentDebugger?.route === PROFILE.agentDebugger?.route &&
    frozenConfig.agentDebugger?.maxOutputTokens === PROFILE.agentDebugger?.maxOutputTokens &&
    frozenConfig.agentDebugger?.requestTimeoutMs === PROFILE.agentDebugger?.requestTimeoutMs &&
    frozenConfig.agentDebugger?.maxInputBytes === PROFILE.agentDebugger?.maxInputBytes &&
    frozenConfig.budget?.attributionTokens === PROFILE.attributionTokens &&
    frozenConfig.budget?.attributionCalls === PROFILE.attributionCalls,
  JSON.stringify({
    search: frozenConfig.search,
    budget: frozenConfig.budget,
    harbor: frozenConfig.benchmark?.harbor,
    agentDebugger: frozenConfig.agentDebugger ?? null,
  }),
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
  console.error('tree-v2 k80 formal FAILED: frozen config carries no solver plan')
  process.exit(1)
}
const routeHash = remoteRoutePlanHash(solvePlan)

// --- 7. doctor + run/resume: the full tree-v2 loop, live ------------------------
console.log('tree-v2 k80 formal: dsh-evolve doctor…')
const doctor = await cli(['doctor', '--run-root', runRoot], 600_000)
check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
if (doctor.code !== 0) {
  console.error(`tree-v2 k80 formal FAILED: doctor exited ${String(doctor.code)}`)
  console.error(doctor.stdout)
  process.exit(1)
}

const sealedPlanFile = join(runRoot, 'sealed-plan.json')
const command = existsSync(join(runRoot, 'drive-report.json')) ? 'resume' : 'run'
console.log(
  `tree-v2 k80 formal: dsh-evolve ${command} (live solver + live proposer via ${modelName}; K=${String(PROFILE.kTarget)})…`,
)
const runStart = Date.now()
const run = await cli(
  [command, '--run-root', runRoot, '--sealed-plan-file', sealedPlanFile],
  277_200_000,
)
const runSeconds = Math.round((Date.now() - runStart) / 1000)
if (run.code !== 0) {
  console.error(`tree-v2 k80 formal FAILED: ${command} exited ${String(run.code)}`)
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
  tournamentTrials?: number
  shortlist?: string[]
  championId?: string
  championLockHash?: string
}
console.log(
  `tree-v2 k80 formal: ${report.stopReason} / ${report.status} — trials=${String(report.trials)} tournament=${String(report.tournamentTrials ?? 0)} expansions=${String(report.expansionAttempts)} (${String(runSeconds)}s)`,
)

// The pre-registered envelope is the only funded shape (ADR-040/049): the
// guard-inclusive benchmark baseline matrix + cold starts per admitted node +
// ordinary UCB-Air evaluations + the champion tournament, inside the
// per-phase caps (search ≤ 400, tournament ≤ 360, total ≤ 760) and the
// wave-snapshot admission overshoot bound (ADR-045: K + shortlist − 1 = 84).
const envelope = trialShapeWithinPreRegisteredEnvelope(
  {
    trials: report.trials,
    discoveryTrials: report.discoveryTrials,
    expansionAttempts: report.expansionAttempts,
    admittedNonBaseline: report.admittedNonBaseline,
    proposalCalls: report.budget['proposal-calls']?.spent ?? -1,
    ...(report.tournamentTrials !== undefined ? { tournamentTrials: report.tournamentTrials } : {}),
  },
  PROFILE,
)
check('trialCountWithinThePreRegisteredEnvelope', envelope.ok, envelope.detail)
check(
  'stopReasonIsARegisteredTerminalState',
  REGISTERED_TERMINAL_STOP_REASONS.includes(report.stopReason),
  report.stopReason,
)
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
// ADR-056: the debugger's separate dimensions must settle inside their
// pre-registered budgets with nothing left in flight.
const attributionCalls = report.budget['attribution-calls']
check(
  'attributionCallsSettledWithinBudget',
  attributionCalls !== undefined &&
    attributionCalls.reserved === 0 &&
    attributionCalls.spent <= (PROFILE.attributionCalls ?? 0),
  JSON.stringify(attributionCalls ?? null),
)
const attributionTokens = report.budget['attribution-tokens']
check(
  'attributionTokensSettledWithinBudget',
  attributionTokens !== undefined &&
    attributionTokens.reserved === 0 &&
    attributionTokens.spent <= (PROFILE.attributionTokens ?? 0),
  JSON.stringify(attributionTokens ?? null),
)

// --- 8. The migration receipt + every Harbor trial's receipt chain -------------
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
const totalPaidTrials = report.trials + (report.tournamentTrials ?? 0)
check(
  'trialDirsMatchReportIncludingTournament',
  trials.length === totalPaidTrials && jobNames.length === totalPaidTrials,
  `${String(trials.length)} trial dirs (${jobNames.join(',')}) vs report ${String(report.trials)} + tournament ${String(report.tournamentTrials ?? 0)}`,
)
const { verifySolveReceipts } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/solver/receipts.js')).href
)
const guardNameToOpaque = new Map<string, string>(
  Object.entries(sealedStore.guardMap).map(([opaqueId, handle]) => [handle, opaqueId]),
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
  originalResultSha256: string
  sanitized: boolean
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
  const trajectoryText = existsSync(trajectoryPath) ? await readFile(trajectoryPath, 'utf8') : ''
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
  // report but not the chain.
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
    harborUsagePositive: (agentResult?.n_input_tokens ?? 0) > 0 && (agentResult?.cost_usd ?? 0) > 0,
  })
  check(
    `harborUsageReportedWhenCapsuleCompleted (${trial.jobName}/${trial.trialName})`,
    harborUsage.ok,
    harborUsage.detail,
  )
  const rawTaskName = parsed?.task_name ?? null
  const guardOpaqueId = rawTaskName !== null ? guardNameToOpaque.get(rawTaskName) : undefined
  trialFacts.push({
    jobName: trial.jobName,
    trialName: trial.trialName,
    taskName: guardOpaqueId !== undefined ? guardOpaqueId : rawTaskName,
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
    originalResultSha256: existsSync(resultPath)
      ? createHash('sha256')
          .update(await readFile(resultPath))
          .digest('hex')
      : '',
    sanitized: guardOpaqueId !== undefined,
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
check('oneTokenFilePerTrial', tokenFiles.length === trials.length, tokenFiles.join(','))
const trialTokens = await Promise.all(
  tokenFiles.map((name) =>
    readFile(join(runRoot, 'solve-gateway', 'tokens', name), 'utf8').then((text) => text.trim()),
  ),
)

// --- 9. Champion lock facts (CHAMPION_LOCKED path) -----------------------------
interface CandidateLockDocShape {
  protocol?: string
  runId?: string
  winnerId?: string
  sourceHash?: string
  archiveSha256?: string
  runManifestHash?: string
  sealedPlanHash?: string
  tripleHash?: string
}
let lockDoc: CandidateLockDocShape | null = null
if (report.stopReason === 'CHAMPION_LOCKED') {
  check(
    'championFactsPresentOnTheReport',
    report.championId !== undefined &&
      report.championLockHash !== undefined &&
      report.tournamentTrials !== undefined &&
      report.tournamentTrials > 0 &&
      Array.isArray(report.shortlist) &&
      report.shortlist.length > 0,
    JSON.stringify({
      championId: report.championId,
      championLockHash: report.championLockHash,
      tournamentTrials: report.tournamentTrials,
      shortlist: report.shortlist,
    }),
  )
  const lockPath = join(runRoot, 'candidate-lock.json')
  lockDoc = existsSync(lockPath)
    ? (JSON.parse(await readFile(lockPath, 'utf8')) as CandidateLockDocShape)
    : null
  check(
    'candidateLockMatchesTheReport',
    lockDoc !== null &&
      lockDoc.protocol === 'dsh-evolve-le/candidate-lock/v1' &&
      lockDoc.runId === RUN_ID &&
      lockDoc.winnerId === report.championId &&
      lockDoc.tripleHash === report.championLockHash,
    lockPath,
  )
  check(
    'candidateLockBindsTheSealedPlan',
    lockDoc?.sealedPlanHash === sealedPlanHash,
    `${String(lockDoc?.sealedPlanHash)} vs ${sealedPlanHash}`,
  )
} else if (report.stopReason === 'NO_DEVELOPMENT_IMPROVEMENT') {
  check(
    'noImprovementCarriesTheTournamentFacts',
    report.tournamentTrials !== undefined &&
      report.tournamentTrials > 0 &&
      Array.isArray(report.shortlist),
    JSON.stringify({ tournamentTrials: report.tournamentTrials, shortlist: report.shortlist }),
  )
}

// --- 10. Information-flow monitor + concealment receipts (ADR-046/048) ---------
const { deriveCanaryTokens, scanForCanary } = await import(
  pathToFileURL(resolve(repoRoot, 'packages/dsh-evolve-le/lib/proposer/canary.js')).href
)
const monitorTokens = [
  ...ceremony.ceremony.guardOpaqueIds.flatMap((opaqueId) =>
    deriveCanaryTokens({
      masterSeed: MASTER_SEED,
      runId: RUN_ID,
      principal: `guard:${opaqueId}`,
      count: CANARY_COUNT,
    }),
  ),
  ...deriveCanaryTokens({
    masterSeed: MASTER_SEED,
    runId: RUN_ID,
    principal: 'sealed:sweep',
    count: CANARY_COUNT,
  }),
]
const monitorPath = join(runRoot, 'info-flow-monitor.json')
const monitorDoc = existsSync(monitorPath)
  ? (JSON.parse(await readFile(monitorPath, 'utf8')) as {
      protocol?: string
      runId?: string
      result?: 'clean' | 'aborted'
      checkedEvents?: number
      tokenFingerprints?: string[]
      hits?: unknown[]
    })
  : null
if (monitorDoc !== null) {
  check(
    'monitorReceiptIsWellFormed',
    monitorDoc.protocol === 'dsh-evolve-le/info-flow-monitor/v1' &&
      monitorDoc.runId === RUN_ID &&
      (monitorDoc.result === 'clean' || monitorDoc.result === 'aborted'),
    monitorPath,
  )
}
check(
  'monitorResultMatchesTheStopReason',
  (report.stopReason === 'SAFETY_ABORTED') === (monitorDoc?.result === 'aborted'),
  `stop=${report.stopReason} monitor=${String(monitorDoc?.result ?? 'absent')}`,
)
check(
  'monitorTokensAreDeterministic',
  monitorDoc === null ||
    monitorDoc.tokenFingerprints === undefined ||
    monitorDoc.tokenFingerprints.length === monitorTokens.length,
  `${String(monitorDoc?.tokenFingerprints?.length ?? 'absent')} fingerprints vs ${String(monitorTokens.length)} derived`,
)

// --- 11. Evidence: sanitized copies first, then the redaction scan --------------
const artifactsDir = resolve(evidenceDir, 'artifacts')
await mkdir(artifactsDir, { recursive: true })
const artifactCopies: Array<[string, string]> = []
const restrictedNameRedactions = restrictedTaskNameRedactions(
  guardNameToOpaque,
  sealedStore.sealedHandles,
)
const sanitizeEvidenceText = (text: string, surface: string): string => {
  const sanitized = sanitizeRestrictedTaskNames(text, restrictedNameRedactions)
  const residual = restrictedTaskNameHits(sanitized, restrictedNameRedactions)
  if (residual.length > 0) {
    throw new Error(
      `evidence sanitation left restricted task name(s) on ${surface}: ${residual.join(', ')}`,
    )
  }
  return sanitized
}
const copySanitizedArtifact = async (source: string, name: string): Promise<void> => {
  if (!existsSync(source)) return
  // Every public evidence artifact is a derived UTF-8 representation.  The
  // protected source bytes and their hashes stay in the run root; copying raw
  // bytes here was the bypass that leaked task_name fields (ADR-052).
  const safeName = sanitizeEvidenceText(name, `artifact filename ${name}`)
  const text = sanitizeEvidenceText(await readFile(source, 'utf8'), `artifact ${safeName}`)
  await writeFile(resolve(artifactsDir, safeName), text, 'utf8')
}
for (const [index, fact] of trialFacts.entries()) {
  const tag = `t${index + 1}-${fact.jobName}`
  for (const [source, name] of [
    [fact.receiptsPath, `${tag}-solve-receipts.jsonl`],
    [fact.resultPath, `${tag}-trial-result.json`],
    [fact.trajectoryPath, `${tag}-trajectory.json`],
  ] as const) {
    // Harbor's guard results name their resolved task in several fields;
    // proposal objects and future artifact families can do likewise.  Route
    // all of them through the same redactor, not a guard-only special case.
    await copySanitizedArtifact(source, name)
  }
}
artifactCopies.push(
  [join(runRoot, 'run-manifest.json'), 'run-manifest.json'],
  [join(runRoot, 'drive-report.json'), 'drive-report.json'],
  [migrationPath, 'tree-v2-migration.json'],
  [monitorPath, 'info-flow-monitor.json'],
)
const imagePrefetchPath = join(runRoot, 'image-prefetch.json')
if (existsSync(imagePrefetchPath)) {
  await writeFile(
    resolve(artifactsDir, 'image-prefetch.attestation.json'),
    `${JSON.stringify(imagePrefetchAttestation(await readFile(imagePrefetchPath)), null, 2)}\n`,
    'utf8',
  )
}
if (existsSync(join(runRoot, 'candidate-lock.json'))) {
  // Content hashes only (winner id, source/archive hashes, lock triple) —
  // no task identity of any kind.
  artifactCopies.push([join(runRoot, 'candidate-lock.json'), 'candidate-lock.json'])
}
// ADR-049: the verifier-image receipt names all 49 development tasks — ten
// of them guard handles — so it never lands in evidence; the record carries
// its manifest-bound hash only. Same for the sealed verifier receipt and the
// dataset-handles document (all 72 names).
// ADR-043: the proposal saga's receipts — validation summaries with
// per-child rejection reasons, proposal bundles, transcripts, gateway/remote
// receipts, worker verdicts — must survive the scratch deletion (rule 7).
artifactCopies.push(...(await proposalEvidenceCopies(runRoot)))
for (const [source, name] of artifactCopies) {
  await copySanitizedArtifact(source, name)
}

// --- 12. Sealed evaluation (only from the champion lock) ------------------------
const sealedJobsRoot = join(runRoot, 'sealed-jobs')
interface SealedVerdictDocShape {
  schemaVersion?: number
  protocol?: string
  planHash?: string
  candidateLockHash?: string
  verdict?: string
  deltaPerMille?: number
  ciLowerPerMille?: number
  ciUpperPerMille?: number
  completenessPerMille?: number
  criticalFindings?: number
  resultsSha256?: string
}
let sealedOutcome: {
  evaluated: boolean
  reason?: string
  verdict?: string
  revealed?: boolean
  phase?: string
  verdictDoc?: SealedVerdictDocShape
  score?: {
    taskCount?: number
    plannedTrials?: number
    completeness?: number
    missingTrials?: number
    delta?: number
    ciLower?: number
    ciUpper?: number
  }
  costUsdMicros?: number
  solverTokens?: number
  revealCount?: number
} = { evaluated: false }
if (report.stopReason === 'CHAMPION_LOCKED') {
  // The sealed tasks' derived verifier images staged pre-run now replace the
  // plain copies in the frozen tasks root (the derived task.toml points at
  // the offline image; the frozen config binds handles, not image content).
  for (const handle of sealedStore.sealedHandles) {
    await cp(join(tasksSealedRoot, handle), join(tasksRoot, handle), { recursive: true })
  }
  console.log(
    `tree-v2 k80 formal: dsh-evolve sealed-evaluate (230 trials, ${String(K_SEALED)} attempts × 2 sides)…`,
  )
  const sealedRunStart = Date.now()
  const sealed = await cli(
    [
      'sealed-evaluate',
      '--run-root',
      runRoot,
      '--sealed-store',
      sealedStorePath,
      '--sealed-plan',
      sealedPlanFile,
      '--candidate-lock-hash',
      String(report.championLockHash),
      '--provider',
      'terminal-bench',
      '--concurrency',
      String(PROFILE.concurrentTrials),
    ],
    46_800_000,
  )
  const sealedSeconds = Math.round((Date.now() - sealedRunStart) / 1000)
  if (sealed.code !== 0) {
    console.error(`tree-v2 k80 formal FAILED: sealed-evaluate exited ${String(sealed.code)}`)
    console.error(sealed.stderr.slice(0, 4000))
    console.error(`scratch kept for diagnosis: ${scratch}`)
    process.exit(1)
  }
  const sealedCli = JSON.parse(sealed.stdout) as {
    verdict: string
    revealed: boolean
    phase: string
    jobsRoot: string
  }
  check(
    'sealedVerdictIsARegisteredTerminalState',
    ['SEALED_PROMOTED', 'SEALED_REJECTED', 'PROMISING_NOT_CONFIRMED', 'PROTOCOL_INVALID'].includes(
      sealedCli.verdict,
    ),
    sealedCli.verdict,
  )
  const resultsPath = join(sealedJobsRoot, 'results.json')
  const verdictPath = join(sealedJobsRoot, 'verdict.json')
  const resultsDoc = existsSync(resultsPath)
    ? (JSON.parse(await readFile(resultsPath, 'utf8')) as {
        planHash?: string
        candidateLockHash?: string
        championId?: string
        verdict?: string
        score?: {
          taskCount?: number
          plannedTrials?: number
          completeness?: number
          missingTrials?: number
          delta?: number
          ciLower?: number
          ciUpper?: number
        }
        criticalFindings?: number
        trials?: Array<{ costUsdMicros?: number; solverTokens?: number }>
      })
    : null
  const verdictDoc = existsSync(verdictPath)
    ? (JSON.parse(await readFile(verdictPath, 'utf8')) as SealedVerdictDocShape)
    : null
  const totalCost = (resultsDoc?.trials ?? []).reduce(
    (sum, row) => sum + (typeof row.costUsdMicros === 'number' ? row.costUsdMicros : 0),
    0,
  )
  const totalSealedTokens = (resultsDoc?.trials ?? []).reduce(
    (sum, row) => sum + (typeof row.solverTokens === 'number' ? row.solverTokens : 0),
    0,
  )
  // One-shot reveal (ADR-048): exactly one `sealed.revealed` journal event.
  const journalDir = join(runRoot, 'journal')
  let revealCount = 0
  for (const name of await readdir(journalDir).catch(() => [] as string[])) {
    if (!name.endsWith('.jsonl')) continue
    const lines = (await readFile(join(journalDir, name), 'utf8')).split('\n')
    for (const line of lines) {
      if (line.trim() === '') continue
      const event = JSON.parse(line) as { type?: string }
      if (event.type === 'sealed.revealed') revealCount += 1
    }
  }
  if (sealedCli.verdict === 'PROTOCOL_INVALID') {
    // An integrity failure moved the phase without launches, results or a
    // reveal — the honest terminal shape of that verdict.
    check(
      'protocolInvalidLeftNoResultsAndNoReveal',
      resultsDoc === null &&
        verdictDoc === null &&
        revealCount === 0 &&
        sealedCli.revealed === false,
      `results=${String(resultsDoc !== null)} verdict=${String(verdictDoc !== null)} reveals=${String(revealCount)}`,
    )
  } else {
    check(
      'sealedResultsExistAndBindThePlan',
      resultsDoc !== null &&
        resultsDoc.planHash === sealedPlanHash &&
        resultsDoc.candidateLockHash === report.championLockHash &&
        resultsDoc.championId === report.championId,
      resultsPath,
    )
    check(
      'sealedVerdictDocBindsTheResults',
      verdictDoc !== null &&
        verdictDoc.protocol === 'dsh-evolve-le/sealed-verdict/v1' &&
        verdictDoc.planHash === sealedPlanHash &&
        verdictDoc.candidateLockHash === report.championLockHash &&
        verdictDoc.verdict === sealedCli.verdict,
      verdictPath,
    )
    check(
      'sealedRevealHappenedExactlyOnce',
      revealCount === 1 && sealedCli.revealed === true,
      `journal reveals=${String(revealCount)}, cli revealed=${String(sealedCli.revealed)}`,
    )
    // Sealed rows stay 0600 and never reach evidence — the record carries
    // the verdict document (aggregate only) and per-dimension totals.
    for (const name of ['results.json', 'verdict.json', 'sealed-start.json']) {
      const path = join(sealedJobsRoot, name)
      const info = existsSync(path) ? await stat(path) : null
      check(
        `sealedFileIsOwnerOnly (${name})`,
        info !== null && (info.mode & 0o077) === 0,
        `${path} mode ${String(info?.mode.toString(8) ?? 'missing')}`,
      )
    }
    // The verdict document is the aggregate disclosure: verdict, per-mille
    // delta/CI/completeness, critical findings, and the results sha256 — no
    // per-task rows. Copy it; never the results or trial rows.
    await cp(verdictPath, resolve(artifactsDir, 'sealed-verdict.json')).catch(() => undefined)
  }
  sealedOutcome = {
    evaluated: true,
    verdict: sealedCli.verdict,
    revealed: sealedCli.revealed,
    phase: sealedCli.phase,
    // Aggregates ONLY (ADR-048): the per-task rows and per-trial rows stay
    // in the 0600 sealed-jobs tree and are never serialized here.
    verdictDoc: verdictDoc ?? undefined,
    score:
      resultsDoc?.score !== undefined
        ? {
            taskCount: resultsDoc.score.taskCount,
            plannedTrials: resultsDoc.score.plannedTrials,
            completeness: resultsDoc.score.completeness,
            missingTrials: resultsDoc.score.missingTrials,
            delta: resultsDoc.score.delta,
            ciLower: resultsDoc.score.ciLower,
            ciUpper: resultsDoc.score.ciUpper,
          }
        : undefined,
    costUsdMicros: totalCost,
    solverTokens: totalSealedTokens,
    revealCount,
  }
  console.log(
    `tree-v2 k80 formal: sealed verdict ${sealedCli.verdict} / ${sealedCli.phase} (${String(sealedSeconds)}s, ${String(totalCost)} µUSD)`,
  )
} else {
  sealedOutcome = {
    evaluated: false,
    reason: `stop reason ${report.stopReason}: the sealed plan stays sealed (ADR-048 — sealed access only after the champion lock)`,
  }
}

// REDACTION (rule 8) + concealment (ADR-046/048), asserted over every
// artifact this run record writes — the document itself is scanned as the
// exact bytes it will land as. Sealed real names must NEVER appear; guard
// real names must NEVER appear (sanitized copies carry opaque ids).
const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
const document = {
  gate: 'tree-v2',
  kind: 'k80-formal-run',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repositoryHead: head.stdout.trim(),
  },
  protocol: {
    candidateProtocol: 'tree-v2',
    runProfile: 'terminal-bench-formal',
    migration: {
      protocol: migration?.protocol ?? null,
      legacySourceDigest: migration?.legacySourceDigest ?? null,
      treeV2SourceDigest: migration?.treeV2SourceDigest ?? null,
      resultsInherited: migration?.resultsInherited ?? null,
    },
    treeV2BaselineSource: TREE_V2_BASELINE,
    legacyBaselineSource: LEGACY_BASELINE,
  },
  // The FORMAL protocol run (CLAUDE.md rule 6): ADR-045..049 in full; its
  // sealed verdict is the one-shot final evaluation.
  scope: {
    formal: true,
    rehearsal: null,
    phasedWallClock: {
      searchMinutes: 3600,
      tournamentMinutes: 960,
      sealedMinutes: SEALED_BUDGET.wallClockMinutes,
      totalMinutes: 3600 + 960 + SEALED_BUDGET.wallClockMinutes,
      specs00Amendment: 'ADR-058',
    },
  },
  profile: {
    name: formalRun.profileName,
    label: formalRun.profileLabel,
    ...PROFILE,
  },
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
    upstreamTasks: 89,
    eligibleTasks: 72,
    splitCounts: {
      observed: ceremony.ceremony.observedHandles.length,
      guard: ceremony.ceremony.guardOpaqueIds.length,
      sealed: ceremony.ceremony.sealedCount,
    },
    devVerifierImagesPrepared: verifierImageReceipt.tasks.length,
    sealedVerifierImagesPrepared: sealedVerifierReceipt.tasks.length,
  },
  sealedPreRegistration: {
    protocol: SEALED_PLAN_PROTOCOL,
    planHash: sealedPlanHash,
    baselineId,
    taskCount: sealedPlan.taskCount,
    kSealed: sealedPlan.kSealed,
    plannedTrials: sealedPlan.trials.length,
    seedCommitment: sealedPlan.seedCommitment,
    budget: sealedPlan.budget,
    generatedBeforeInit: true,
  },
  budgets: {
    usd: report.budget['usd'] ?? null,
    'solver-tokens': solverBudget,
    'task-trials': report.budget['task-trials'] ?? null,
    'proposal-calls': proposalCalls ?? null,
    'proposer-tokens': report.budget['proposer-tokens'] ?? null,
    'attribution-calls': attributionCalls ?? null,
    'attribution-tokens': attributionTokens ?? null,
  },
  run: {
    runId: RUN_ID,
    stopReason: report.stopReason,
    status: report.status,
    trials: report.trials,
    discoveryTrials: report.discoveryTrials,
    tournamentTrials: report.tournamentTrials ?? null,
    expansionAttempts: report.expansionAttempts,
    seconds: runSeconds,
    shortlist: report.shortlist ?? null,
    championId: report.championId ?? null,
    championLockHash: report.championLockHash ?? null,
    candidateLock: lockDoc,
  },
  trials: trialFacts.map((fact) => ({
    jobName: fact.jobName,
    trialName: fact.trialName,
    taskName: fact.taskName,
    reward: fact.reward,
    agentResult: fact.agentResult,
    trajectoryBytes: fact.trajectoryBytes,
    receipts: fact.receipts,
    originalResultSha256: fact.originalResultSha256,
    sanitized: fact.sanitized,
  })),
  receipts: {
    routeHash,
    totalRequests: trialFacts.reduce((sum, fact) => sum + fact.receipts.requests, 0),
    totalTokens: receiptTotal,
    costUsdMicros: trialFacts.reduce((sum, fact) => sum + fact.receipts.costUsdMicros, 0),
  },
  informationFlow: {
    monitorProtocol: 'dsh-evolve-le/info-flow-monitor/v1',
    monitorResult: monitorDoc?.result ?? 'absent',
    monitorCheckedEvents: monitorDoc?.checkedEvents ?? null,
    canaryFamilies: ceremony.ceremony.guardOpaqueIds.length + 1,
    canaryCountPerFamily: CANARY_COUNT,
  },
  concealment: {
    guardTrialsSanitized: trialFacts.filter((fact) => fact.sanitized).length,
    guardOpaqueIdsRecorded: true,
    sealedRowsNeverInEvidence: true,
    // ADR-049: the receipts name all 49 development + 23 sealed tasks, so
    // they never land in evidence — the record carries their content hashes
    // only (the development one is manifest-bound and doctor-verified).
    devVerifierReceiptHash: `sha256:${canonicalHash(verifierImageReceipt)}`,
    devVerifierReceiptTaskCount: verifierImageReceipt.tasks.length,
    sealedVerifierReceiptHash: `sha256:${canonicalHash(sealedVerifierReceipt)}`,
    sealedVerifierReceiptTaskCount: sealedVerifierReceipt.tasks.length,
    sealedStorePersistedOutsideEvidence: true,
  },
  sealed: sealedOutcome,
  coveredBySuites: [
    'packages/dsh-evolve-le/tests/tree-v2.test.ts',
    'packages/dsh-evolve-le/tests/tree-v2-live-profile.test.ts',
    'packages/dsh-evolve-le/tests/builder.test.ts',
    'packages/dsh-evolve-le/tests/solve-gateway.test.ts',
    'packages/dsh-evolve-le/tests/calibration.test.ts',
    'packages/dsh-evolve-le/tests/iteration/preflight.test.ts',
    'packages/dsh-evolve-le/tests/bootstrap.test.ts',
    'packages/dsh-evolve-le/tests/tournament.test.ts',
    'packages/dsh-evolve-le/tests/sealed.test.ts',
    'packages/dsh-evolve-le/tests/sealed-evaluate.test.ts',
    'packages/dsh-evolve-le/tests/agent-debugger.test.ts',
    'packages/dsh-evolve-le/tests/iteration/driver.test.ts',
    'packages/cli/tests/cli.test.ts',
    'benchmark-adapters/terminal-bench/tests/diagnostic-bundle.test.ts',
    'scripts/tests/evidence-sanitization.test.ts',
    'scripts/tests/k80-formal-recorder-concealment.test.ts',
  ],
}
// Provisional document = exactly the bytes that would land, with the failure
// list so far; the scan below can only append static check names, so the
// rebuilt final document stays byte-equivalent where it matters.
const provisional = sanitizeEvidenceText(
  JSON.stringify({ ...document, failures }, null, 2),
  'formal record document',
)
const artifactNames = (await readdir(artifactsDir).catch(() => [] as string[])).sort()
const artifactTexts = await Promise.all(
  artifactNames.map((name) => readFile(join(artifactsDir, name), 'utf8').catch(() => '')),
)
const everyText = [provisional, ...artifactNames, ...artifactTexts]
check(
  'noCredentialInAnyArtifact',
  everyText.every((text) => !text.includes(credential)),
)
for (const token of trialTokens) {
  if (token !== '') {
    check(
      'noTrialTokenInAnyArtifact',
      everyText.every((text) => !text.includes(token)),
    )
  }
}
const canaryHits = everyText.flatMap((text) => scanForCanary(text, monitorTokens))
check(
  'noCanaryTokenInAnyArtifact',
  canaryHits.length === 0,
  `${String(canaryHits.length)} canary fingerprint(s) in evidence`,
)
const guardLeak = everyText.flatMap((text) =>
  restrictedTaskNameHits(
    text,
    restrictedNameRedactions.filter((entry) => entry.replacement.startsWith('guard:')),
  ),
)
check(
  'noGuardTaskNameInAnyArtifact',
  guardLeak.length === 0,
  `${String(guardLeak.length)} guard name(s) in evidence`,
)
const sealedLeak = everyText.flatMap((text) =>
  restrictedTaskNameHits(
    text,
    restrictedNameRedactions.filter((entry) => entry.replacement.startsWith('sealed:')),
  ),
)
check(
  'noSealedTaskNameInAnyArtifact',
  sealedLeak.length === 0,
  `${String(sealedLeak.length)} sealed name(s) in evidence`,
)

// --- 13. Final documents: the failure list is complete before allPassed --------
const finalDocument = { ...document, failures }
const documentPath = resolve(evidenceDir, 'k80-formal-run.json')
await mkdir(evidenceDir, { recursive: true })
await writeFile(
  documentPath,
  `${sanitizeEvidenceText(JSON.stringify(finalDocument, null, 2), 'final formal record')}\n`,
)
const allPassed = failures.length === 0
const documentSha = createHash('sha256')
  .update(await readFile(documentPath))
  .digest('hex')
const statusDocument = {
  gate: 'tree-v2',
  kind: 'k80-formal-run-status',
  generatedAt: document.generatedAt,
  environment: document.environment,
  summary: {
    route: `solver+proposer deepseek/zen-compatible → ${modelName}`,
    protocol: 'tree-v2 (migration root, resultsInherited:false)',
    profile: formalRun.statusProfile,
    scope: 'formal',
    stopReason: report.stopReason,
    trials: report.trials,
    discoveryTrials: report.discoveryTrials,
    tournamentTrials: report.tournamentTrials ?? null,
    expansionAttempts: report.expansionAttempts,
    tasks: trialFacts.map((fact) => fact.taskName ?? '?'),
    rewards: trialFacts.map((fact) => fact.reward),
    requests: document.receipts.totalRequests,
    totalTokens: document.receipts.totalTokens,
    costUsdMicros: document.receipts.costUsdMicros,
    seconds: runSeconds,
    sealedVerdict: sealedOutcome.evaluated ? (sealedOutcome.verdict ?? null) : null,
    sealedPhase: sealedOutcome.evaluated ? (sealedOutcome.phase ?? null) : null,
    sealedCostUsdMicros: sealedOutcome.evaluated ? (sealedOutcome.costUsdMicros ?? null) : null,
  },
  allPassed,
  evidence: {
    run: {
      path: `${formalRun.evidenceDirectory}/k80-formal-run.json`,
      sha256: documentSha,
    },
  },
}
await writeFile(
  resolve(evidenceDir, 'STATUS.json'),
  `${sanitizeEvidenceText(JSON.stringify(statusDocument, null, 2), 'formal status document')}\n`,
)
if (!allPassed) {
  console.error(`tree-v2 k80 formal FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  console.error(`scratch kept for diagnosis: ${scratch}`)
  process.exit(1)
}
await rm(scratch, { recursive: true, force: true })
console.log(
  `tree-v2 k80 formal: stop=${report.stopReason} trials=${String(report.trials)} ` +
    `tournament=${String(report.tournamentTrials ?? 0)} expansions=${String(report.expansionAttempts)} via ${modelName}; ` +
    `sealed=${sealedOutcome.evaluated ? sealedOutcome.verdict : 'not-eligible'}; ` +
    `${String(document.receipts.totalRequests)} requests, ${String(document.receipts.totalTokens)} tokens, ` +
    `${String(document.receipts.costUsdMicros)} µUSD (${String(runSeconds)}s)`,
)
