/**
 * Record the Gate 8 LIVE-PILOT (ADR-030 rehearsal for the K=80 search profile,
 * specs/07 §10, specs/03 §2, specs/04 §4.2): the recorded pilot profile with
 * the SOLVE layer on a REAL networked model too. Both sides live — the
 * proposer through the TCB Unix-socket proxy (Gate 8 remote route) and every
 * solve trial through the token-authenticated gateway on the artifact
 * listener, per-trial receipt-verified and settled into `budget.solver-tokens`.
 *
 * This is the user-requested full-loop rehearsal: K=10 ADMITTED children,
 * §4.1 discovery 6+6≤12 on the run's own §4.2 baseline freeze, real-model
 * expansions of width 3, children rebuilt by the trusted builder and
 * cold-started from the frozen pool — with the recorded-replay capsule
 * defect (attempt 9: every solve trial mechanically reward 0) finally out
 * of the loop. Its purpose is to find problems BEFORE the K=80 search run.
 *
 * PAID: ~50 live solve trials + ~4 live proposals against the real endpoint.
 * Absolute worst case (gateway per-trial stop $0.30 × taskTrials 60 +
 * proposer) ≈ $19; realistically a few dollars. Refuses to start without
 * DSH_GATE8_LIVE_PILOT=confirm.
 *
 * Environment:
 *   DSH_GATE8_LIVE_PILOT=confirm   the paid-run gate
 *   DSH_GATE8_CREDENTIAL           0600 credential (default
 *                                  /root/.config/dsh-evolve-le/zen-compatible.key)
 *   DSH_GATE8_BASE_URL / DSH_GATE8_MODEL   endpoint facts
 *   DSH_GATE8_LIVE_PILOT_RUN_ROOT  an EXISTING run root: skips init, drives the
 *                                  idempotent `resume` (a no-op on a completed
 *                                  run — byte-identity is asserted), verifies
 *                                  from durable evidence. For crash-continue
 *                                  and verify-only re-runs.
 *   GATE8_ARTIFACT_HOST/PORT       docker-bridge listener (172.17.0.1 / 8443)
 *
 * Usage: node --import tsx/esm scripts/record-gate8-live-pilot.ts
 * @module scripts/record-gate8-live-pilot
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

const RUN_ID = process.env['DSH_GATE8_RUN_ID'] ?? 'gate8-live-pilot-t1800-c8-v2'
const pilotDir = resolve(repoRoot, 'evidence/gate8', RUN_ID)
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const HARBOR_BIN = process.env['HARBOR_BIN'] ?? 'harbor'
const HARBOR_VERSION = '0.21.0'
const ARTIFACT_HOST =
  process.env['GATE8_ARTIFACT_HOST'] ?? process.env['GATE6_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT =
  process.env['GATE8_ARTIFACT_PORT'] ?? process.env['GATE6_ARTIFACT_PORT'] ?? '8443'
const MASTER_SEED = process.env['DSH_GATE8_MASTER_SEED'] ?? `${RUN_ID}-master-seed-1`
// Same shape as the recorded pilot (specs/03 §2, ADR-026 sizing): K counts
// ADMITTED non-baseline candidates; discovery 6+6≤12; taskTrials funds every
// admitted child's pool trials.
const K_TARGET = 10
const configuredConcurrentTrials = Number.parseInt(
  process.env['DSH_GATE8_CONCURRENT_TRIALS'] ?? '4',
  10,
)
if (
  !Number.isSafeInteger(configuredConcurrentTrials) ||
  configuredConcurrentTrials < 1 ||
  configuredConcurrentTrials > 8
) {
  throw new Error('DSH_GATE8_CONCURRENT_TRIALS must be an integer from 1 to 8')
}
const CONCURRENT_TRIALS = configuredConcurrentTrials
const DISCOVERY_BATCH = 6
const DISCOVERY_CAP = 12
const MAX_SOLVER_TRIALS = 60
// Solver-token dimension: taskTrials × the gateway's frozen per-trial token
// cap, so the per-trial reservation (floor(S/T) = 2M) always covers a
// maxed-out trial and the dimension can never trip before task-trials.
const SOLVER_TOKENS = 120_000_000
// The one deliberate deviation from the recorded pilot's config: wall clock.
// A live trial runs minutes-to-half-an-hour against the replay's ~4.5 min, so
// the stable-demo 16 h default cannot fund the shape; 48 h keeps the LOOP
// under test. The 16 h acceptance budget is NOT exercised here — that stays
// the K=80 design input the recorded pilot's extrapolation already flagged
// (time side needs trial parallelization).
const WALL_CLOCK_MINUTES = 2880

const credentialPath =
  process.env['DSH_GATE8_CREDENTIAL'] ?? '/root/.config/dsh-evolve-le/zen-compatible.key'
const configuredBaseUrl = process.env['DSH_GATE8_BASE_URL'] ?? 'http://one-api.wattman.cn:805/v1'

/** One-API exposes its OpenAI-compatible surface below `/v1`. */
function normalizeOpenAiBaseUrl(value: string): string {
  const parsed = new URL(value.trim().replace(/\/+$/, ''))
  if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/v1'
  return parsed.toString().replace(/\/$/, '')
}

const baseUrl = normalizeOpenAiBaseUrl(configuredBaseUrl)
const modelName = process.env['DSH_GATE8_MODEL'] ?? 'deepseek-v4-flash'
const MAX_OUTPUT_TOKENS = 131_072
const REPAIR_VERIFIER_IMAGES = process.env['DSH_GATE8_REPAIR_VERIFIERS'] !== '0'

const importBuilt = (builtPath: string) => import(pathToFileURL(resolve(repoRoot, builtPath)).href)

interface CliResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_BIN, ...args], {
      cwd: repoRoot,
      // ~50 live Harbor trials (bootstrap + ≤30 min agent wall clock each) +
      // real-model proposals + capsule builds — up to ~2 days under the 48 h
      // wall-clock budget; the 50 h subprocess ceiling leaves headroom.
      timeout: 180_000_000,
      maxBuffer: 64 << 20,
    })
    return { code: 0, signal: null, stdout, stderr }
  } catch (error) {
    const err = error as {
      code?: number
      signal?: string
      killed?: boolean
      stdout?: string
      stderr?: string
      message: string
    }
    return {
      code: err.code ?? null,
      signal: err.signal ?? null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
    }
  }
}

/** Every text file under a root (binaries read as '' — never a false leak). */
async function walkTextFiles(root: string): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (!entry.name.endsWith('.tar.gz')) {
        out.push({ path, text: await readFile(path, 'utf8').catch(() => '') })
      }
    }
  }
  await walk(root)
  return out
}

async function trialDirs(root: string): Promise<string[]> {
  const out: string[] = []
  for (const job of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!job.isDirectory() || job.name.startsWith('.')) continue
    for (const trial of await readdir(join(root, job.name), { withFileTypes: true })) {
      if (trial.isDirectory() && existsSync(join(root, job.name, trial.name, 'result.json'))) {
        out.push(`${job.name}/${trial.name}`)
      }
    }
  }
  return out
}

async function journalBytes(controllerDir: string): Promise<string> {
  const journalDir = join(controllerDir, 'journal')
  const dir = existsSync(journalDir) ? journalDir : controllerDir
  const names = ((await readdir(dir).catch(() => [])) as string[])
    .filter((name) => name.startsWith('events-') && name.endsWith('.jsonl'))
    .sort()
  let all = ''
  for (const name of names) all += await readFile(join(dir, name), 'utf8')
  return all
}

interface DriveReportDoc {
  runId: string
  phase: string
  stopReason: string
  status: string
  trials: number
  discoveryTrials: number
  admittedNonBaseline: number
  lineageDepthMax: number
  expansionAttempts: number
  consecutiveExpansionFailures: number
  rebuildRejections?: Array<{
    actionId: string
    candidateId: string
    stage: string
    reason: string
  }>
  abandonedIntents?: Array<{ actionId: string; candidateId: string }>
  failurePool: string[]
  stateHash: string
  budget: Record<string, { spent: number; reserved: number }>
}

interface CatalogEntry {
  candidateId: string
  parentCandidateId: string | null
  sourceHash?: string
  tasks: Array<{ opaqueTaskId: string; attempts: number; successes?: number; failures?: number }>
}

interface CapsuleRecord {
  candidateId: string
  archiveSha256: string
  sourceDigest: string
}

async function main(): Promise<void> {
  if (process.env['DSH_GATE8_LIVE_PILOT'] !== 'confirm') {
    console.error(
      'gate8 live-pilot: this script spends real money (~50 live solve trials + live proposals).\n' +
        'Set DSH_GATE8_LIVE_PILOT=confirm to acknowledge, then re-run.',
    )
    process.exit(1)
  }
  if (!existsSync(CLI_BIN)) throw new Error(`CLI not built: ${CLI_BIN}; run pnpm build first`)
  if (!existsSync(TARBALL)) {
    throw new Error(`pinned tarball missing: ${TARBALL}; run pnpm setup:source`)
  }
  const { stdout: harborOut } = await exec(HARBOR_BIN, ['--version']).catch(() => ({ stdout: '' }))
  if (harborOut.trim() !== HARBOR_VERSION) {
    throw new Error(`harbor --version = "${harborOut.trim()}", expected ${HARBOR_VERSION}`)
  }
  await exec('docker', ['info', '--format', '{{.ServerVersion}}']).catch((error: unknown) => {
    throw new Error(`docker unavailable: ${String(error)}`)
  })

  // The REAL credential: 0600, outside the repository, read by the CLI in the
  // controller process only. Its bytes must never appear in any artifact.
  const credentialInfo = await stat(credentialPath).catch(() => undefined)
  if (credentialInfo === undefined || credentialInfo.isDirectory()) {
    throw new Error(`credential ${credentialPath} missing`)
  }
  if ((credentialInfo.mode & 0o077) !== 0) {
    throw new Error(`credential ${credentialPath} mode is not owner-only`)
  }
  const credential = (await readFile(credentialPath, 'utf8')).trim()
  if (credential.length === 0) throw new Error(`credential ${credentialPath} is empty`)

  const failures: string[] = []
  const notes: string[] = []
  const flags: Record<string, boolean> = {}
  const check = (name: string, ok: boolean, detail?: string): boolean => {
    flags[name] = ok
    if (!ok) failures.push(detail === undefined ? name : `${name}: ${detail}`)
    return ok
  }

  // ---- scratch: run root and Harbor jobs stay OUT of the repo ---------------
  // DSH_GATE8_LIVE_PILOT_RUN_ROOT re-enters an EXISTING run root: the drive is
  // the idempotent `resume` (a completed run resumes to byte-identical state —
  // asserted below), so the same entry point crash-continues a half-finished
  // run and re-verifies a finished one. Every check runs on durable evidence.
  const resumeRoot = process.env['DSH_GATE8_LIVE_PILOT_RUN_ROOT']
  if (resumeRoot !== undefined && !existsSync(join(resumeRoot, 'run.config.json'))) {
    throw new Error(`DSH_GATE8_LIVE_PILOT_RUN_ROOT is not a run root: ${resumeRoot}`)
  }
  let scratch = ''
  let runsRoot = ''
  let jobsRoot = ''
  let runRoot = ''
  let verifierImageReceipt: unknown = null
  if (resumeRoot !== undefined) {
    runRoot = resumeRoot
    const frozen = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
      benchmark?: { harbor?: { jobsRoot?: string } }
    }
    jobsRoot = frozen.benchmark?.harbor?.jobsRoot ?? ''
    if (jobsRoot === '') throw new Error('frozen config carries no harbor jobs root')
    notes.push(`re-entry over the existing run root ${runRoot}`)
  } else {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-gate8-live-pilot-'))
    runsRoot = join(scratch, 'runs')
    jobsRoot = join(scratch, 'jobs')
    runRoot = join(runsRoot, RUN_ID)
    await mkdir(jobsRoot, { recursive: true })
    await mkdir(runsRoot, { recursive: true })
  }

  let initDoc: { configHash: string; handles: number } | null = null
  if (resumeRoot !== undefined) {
    const manifest = JSON.parse(await readFile(join(runRoot, 'run-manifest.json'), 'utf8')) as {
      configHash?: string
    }
    initDoc =
      manifest.configHash === undefined ? null : { configHash: manifest.configHash, handles: 0 }
  } else {
    console.log('gate8 live-pilot: extracting pinned terminal-bench 2.1 tasks…')
    await exec('tar', ['-xzf', TARBALL, '-C', scratch])
    const { DATASET_PIN } = await importBuilt('benchmark-adapters/terminal-bench/lib/dataset.js')
    const upstreamTasksRoot = join(scratch, 'tasks-upstream')
    await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), upstreamTasksRoot, {
      recursive: true,
    })
    // Materialize the frozen <=30-minute Terminal-Bench profile. The CLI
    // enforces the same rule again, but keeping excluded tasks out of the
    // staged root also prevents image prefetch or verifier preparation from
    // touching them accidentally.
    const eligibleTasksRoot = join(scratch, 'tasks-eligible')
    await mkdir(eligibleTasksRoot, { recursive: true })
    const { taskAgentTimeoutSec } = await importBuilt(
      'benchmark-adapters/terminal-bench/lib/task-timeout.js',
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
        `gate8 live-pilot: expected 89 upstream tasks with a non-empty >1800s exclusion set; got ${String(allTaskEntries.length)} / ${String(excludedHandles.length)}`,
      )
    }
    let tasksRoot = eligibleTasksRoot
    if (REPAIR_VERIFIER_IMAGES) {
      console.log('gate8 live-pilot: building offline verifier images (no test-time uv downloads)…')
      const { runSplitCeremony } = await importBuilt('packages/dsh-evolve-le/lib/split/ceremony.js')
      const { splitCountsForPopulation } = await importBuilt(
        'packages/dsh-evolve-le/lib/split/ceremony.js',
      )
      const handles = (await readdir(eligibleTasksRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      const ceremony = runSplitCeremony({
        runId: RUN_ID,
        masterSeed: MASTER_SEED,
        handles,
        counts: splitCountsForPopulation(handles.length),
      })
      const { prepareOfflineVerifierTasks } = await importBuilt(
        'benchmark-adapters/terminal-bench/lib/verifier-image.js',
      )
      const prepared = await prepareOfflineVerifierTasks({
        // Keep the pinned source population available to CLI init so it can
        // record the 89→72 exclusion provenance; the allowlist still limits
        // which tasks receive derived verifier images.
        sourceTasksRoot: upstreamTasksRoot,
        outputTasksRoot: join(scratch, 'tasks'),
        // Prepare the first discovery wave before any paid launch. This keeps
        // the initial paid jobs fully offline; later waves are entered only
        // after a real failure signal and can be prepared in a successor run.
        taskAllowlist: ceremony.ceremony.observedHandles.slice(0, DISCOVERY_BATCH),
        dockerBin: 'docker',
      })
      tasksRoot = prepared.tasksRoot
      verifierImageReceipt = prepared.receipt
    } else {
      await cp(upstreamTasksRoot, join(scratch, 'tasks'), { recursive: true })
      tasksRoot = join(scratch, 'tasks')
    }

    // ---- init: pilot profile, BOTH layers on the real route -------------------
    // The config carries ONE zen route, so the endpoint facts are passed once
    // (--model-* spelling); both --proposer-route and --solver-route resolve it.
    console.log(`gate8 live-pilot: dsh-evolve init (proposer + solver → ${modelName})…`)
    const initArgs = [
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      RUN_ID,
      '--master-seed',
      MASTER_SEED,
      '--tasks-root',
      tasksRoot,
      '--baseline-source',
      resolve(repoRoot, 'packages/candidate-baseline'),
      '--jobs-root',
      jobsRoot,
      '--credential-file',
      credentialPath,
      '--harbor-bin',
      HARBOR_BIN,
      '--artifact-host',
      ARTIFACT_HOST,
      '--artifact-port',
      ARTIFACT_PORT,
      '--proposer-route',
      'deepseek/zen-compatible',
      '--solver-route',
      'deepseek/zen-compatible',
      '--model-base-url',
      baseUrl,
      '--model-name',
      modelName,
      '--model-temperature',
      '0',
      '--solver-tokens',
      String(SOLVER_TOKENS),
      '--concurrent-trials',
      String(CONCURRENT_TRIALS),
      '--prefetch-images',
      '--set',
      `kTarget=${String(K_TARGET)}`,
      '--set',
      `maxDiscoveryTrials=${String(DISCOVERY_CAP)}`,
      '--set',
      `discoveryBatchSize=${String(DISCOVERY_BATCH)}`,
      '--set',
      `maxSolverTrials=${String(MAX_SOLVER_TRIALS)}`,
      '--set',
      `taskTrials=${String(MAX_SOLVER_TRIALS)}`,
      '--set',
      `wallClockMinutes=${String(WALL_CLOCK_MINUTES)}`,
    ]
    const init = await cli(initArgs)
    initDoc =
      init.code === 0 ? (JSON.parse(init.stdout) as { configHash: string; handles: number }) : null
    check(
      'initFrozeConfigAndHandles',
      init.code === 0 && initDoc !== null && initDoc.handles === 72,
      `exit ${String(init.code)}: ${init.stderr.slice(0, 400)}`,
    )
    if (init.code !== 0) {
      console.error(`gate8 live-pilot FAILED: init exited ${String(init.code)}`)
      console.error(init.stderr.slice(0, 4000))
      process.exit(1)
    }
    if (verifierImageReceipt !== null) {
      await writeFile(
        join(runRoot, 'verifier-image-receipt.json'),
        `${JSON.stringify(verifierImageReceipt, null, 2)}\n`,
        'utf8',
      )
    }
  }
  const frozenConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
    proposerRoute?: string
    solverRoute?: string
    budget?: { solverTokens?: number; taskTrials?: number }
    modelRoutes?: Array<{
      id: string
      baseUrl?: string
      model?: string
      temperature?: number
      maxOutputTokens?: number
    }>
    search?: Record<string, number>
    sealedAccess?: boolean
    benchmark?: {
      artifactEndpoint?: { host?: string; port?: number }
      harbor?: { concurrentTrials?: number; prefetchImages?: boolean }
    }
  }
  const zenRoute = frozenConfig.modelRoutes?.find((route) => route.id === 'deepseek/zen-compatible')
  check(
    'configRoutesBothLayersLive',
    frozenConfig.proposerRoute === 'deepseek/zen-compatible' &&
      frozenConfig.solverRoute === 'deepseek/zen-compatible' &&
      zenRoute?.baseUrl === baseUrl &&
      zenRoute?.model === modelName &&
      zenRoute?.temperature === 0 &&
      zenRoute?.maxOutputTokens === MAX_OUTPUT_TOKENS &&
      frozenConfig.budget?.solverTokens === SOLVER_TOKENS &&
      frozenConfig.budget?.taskTrials === MAX_SOLVER_TRIALS &&
      frozenConfig.benchmark?.harbor?.concurrentTrials === CONCURRENT_TRIALS &&
      frozenConfig.benchmark?.harbor?.prefetchImages === true &&
      frozenConfig.sealedAccess === false,
    JSON.stringify({
      proposerRoute: frozenConfig.proposerRoute,
      solverRoute: frozenConfig.solverRoute,
      zenRoute,
      budget: frozenConfig.budget,
    }),
  )
  check(
    'artifactEndpointIsFixedOnTheBridge',
    frozenConfig.benchmark?.artifactEndpoint?.port === Number(ARTIFACT_PORT),
    JSON.stringify(frozenConfig.benchmark?.artifactEndpoint ?? null),
  )
  const search = frozenConfig.search ?? {}
  check(
    'configIsThePilotK10Shape',
    search['kTarget'] === K_TARGET &&
      search['maxDiscoveryTrials'] === DISCOVERY_CAP &&
      search['discoveryBatchSize'] === DISCOVERY_BATCH &&
      search['maxSolverTrials'] === MAX_SOLVER_TRIALS,
    JSON.stringify(search),
  )
  // The frozen route hash every receipt (proposer AND solve) must bind to.
  const { solverRoutePlan } = await importBuilt(
    'packages/dsh-evolve-le/lib/proposer/remote-runner.js',
  )
  const { remoteRoutePlanHash } = await importBuilt(
    'packages/dsh-evolve-le/lib/proposer/remote-gateway.js',
  )
  const solvePlan = solverRoutePlan(frozenConfig)
  if (solvePlan === null) {
    console.error('gate8 live-pilot FAILED: frozen config carries no solver plan')
    process.exit(1)
  }
  const routeHash = remoteRoutePlanHash(solvePlan)

  // ---- doctor -----------------------------------------------------------------
  console.log('gate8 live-pilot: dsh-evolve doctor (real docker/harbor/credential checks)…')
  const doctor = await cli(['doctor', '--run-root', runRoot])
  check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
  if (doctor.code !== 0) {
    console.error(`gate8 live-pilot FAILED: doctor exited ${String(doctor.code)}`)
    console.error(doctor.stdout)
    process.exit(1)
  }

  // ---- run: §4.1 discovery + real-model proposals to K=10 + live-solved trials ----
  let runSeconds: number | null = null
  let report: DriveReportDoc | null = null
  console.log(
    'gate8 live-pilot: dsh-evolve run (live-solved trials + REAL model proposals to K=10; many hours)…',
  )
  const runStart = Date.now()
  const run = await cli([resumeRoot !== undefined ? 'resume' : 'run', '--run-root', runRoot])
  runSeconds = Math.round((Date.now() - runStart) / 1000)
  check('runExitZero', run.code === 0, `exit ${String(run.code)}: ${run.stderr.slice(0, 2000)}`)
  report = run.code === 0 ? (JSON.parse(run.stdout) as DriveReportDoc) : null
  if (report === null) {
    console.error(`gate8 live-pilot FAILED: run exited ${String(run.code)}`)
    console.error(run.stderr.slice(0, 4000))
    console.error(`run root kept: ${runRoot}`)
    process.exit(1)
  }
  if (resumeRoot !== undefined) {
    // Re-entry: the wall-clock actual comes from the durable journal, not from
    // this process's stopwatch (§12 budget actuals are evidence-derived).
    const journalDir = join(runRoot, 'controller', 'journal')
    const stamps: number[] = []
    for (const name of ((await readdir(journalDir).catch(() => [])) as string[]).sort()) {
      if (!name.startsWith('events-') || !name.endsWith('.jsonl')) continue
      for (const line of (await readFile(join(journalDir, name), 'utf8')).split('\n')) {
        if (line === '') continue
        stamps.push(new Date((JSON.parse(line) as { occurredAt: string }).occurredAt).getTime())
      }
    }
    if (stamps.length > 0) {
      runSeconds = Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000)
      notes.push(
        `wall-clock re-derived from the controller journal (${String(stamps.length)} events)`,
      )
    }
  }
  console.log(
    `gate8 live-pilot: ${report.stopReason} / ${report.status} — ` +
      `trials=${String(report.trials)} discovery=${String(report.discoveryTrials)} ` +
      `expansions=${String(report.expansionAttempts)} admitted=${String(report.admittedNonBaseline)} ` +
      `depth=${String(report.lineageDepthMax)} pool=${String(report.failurePool.length)} ` +
      `rebuild-rejected=${String((report.rebuildRejections ?? []).length)} ` +
      `abandoned=${String((report.abandonedIntents ?? []).length)}` +
      (runSeconds === null ? '' : ` (${String(runSeconds)}s)`),
  )

  // ---- the pilot shape ----------------------------------------------------------
  check(
    'stopReasonKReached',
    report.stopReason === 'K_REACHED',
    `${report.stopReason} / ${report.status}`,
  )
  if (report.lineageDepthMax < 2) {
    notes.push(
      `lineageDepthMax=${String(report.lineageDepthMax)}: K was reached within one expansion wave; the ≥2-depth bar belongs to the Gate 6 stable-demo profile`,
    )
  }
  check(
    'discoveryHonoredThePreRegisteredProtocol',
    report.discoveryTrials === DISCOVERY_BATCH || report.discoveryTrials === DISCOVERY_CAP,
    `${String(report.discoveryTrials)} discovery trials`,
  )

  // ---- agent participation (rule 7) + LIVE-solver facts per trial ----------------
  const { participationOf, INFRA_RETRYABLE_EXCEPTIONS } = await importBuilt(
    'benchmark-adapters/terminal-bench/lib/normalize.js',
  )
  const { verifySolveReceipts } = await importBuilt('packages/dsh-evolve-le/lib/solver/receipts.js')
  const partTally = { ran: 0, never: 0, unknown: 0 }
  const neverInitializedTrials: string[] = []
  const preLaunchInfraDeaths: Record<string, number> = {}
  const agentProcessDeaths: string[] = []
  const trialParticipation: Array<{
    handle: string
    capsule: string
    state: string
    exceptionType: string | null
  }> = []
  // Per-JOB solve facts. A never-initialized trial (ADR-025 pre-launch infra
  // class) makes zero gateway calls, so its job legitimately has NO receipts
  // file — verification covers every file that EXISTS, and the ran-trial loop
  // below separately requires a ran trial's job to show usage.
  const jobNames = [
    ...new Set(
      (await readdir(jobsRoot, { withFileTypes: true }).catch(() => []))
        .filter((job) => job.isDirectory() && !job.name.startsWith('.'))
        .map((job) => job.name),
    ),
  ]
  const receiptsDir = join(runRoot, 'solve-gateway', 'receipts')
  const solveFacts = new Map<
    string,
    {
      ok: boolean
      requests: number
      errorReceipts: number
      totalTokens: number
      costUsdMicros: number
      problems: string[]
    }
  >()
  for (const name of (await readdir(receiptsDir).catch(() => [] as string[])).filter((name) =>
    name.endsWith('.jsonl'),
  )) {
    const jobName = name.replace(/\.jsonl$/, '')
    const verification = await verifySolveReceipts({
      receiptsPath: join(receiptsDir, name),
      routeHash,
      jobName,
    })
    check(`solveReceipts_${jobName}`, verification.ok, verification.problems.join(';'))
    check(
      `solveReceipts_${jobName}_knownJob`,
      jobNames.includes(jobName),
      `receipts for unknown job ${jobName}`,
    )
    solveFacts.set(jobName, {
      ok: verification.ok,
      requests: verification.usage.requests,
      errorReceipts: verification.errorReceipts,
      totalTokens: verification.usage.totalTokens,
      costUsdMicros: verification.usage.costUsdMicros,
      problems: verification.problems,
    })
  }
  const replayMarkerTrials: string[] = []
  const ranWithoutUsage: string[] = []
  for (const trialPath of await trialDirs(jobsRoot)) {
    const resultPath = join(jobsRoot, trialPath, 'result.json')
    const configPath = join(jobsRoot, trialPath, 'config.json')
    if (!existsSync(resultPath) || !existsSync(configPath)) {
      partTally.unknown += 1
      continue
    }
    const parsed = JSON.parse(await readFile(resultPath, 'utf8')) as {
      task_name?: string
      agent_info?: { version?: string }
      exception_info?: { exception_type?: string } | null
    }
    const handle =
      parsed.task_name?.split('/').filter(Boolean).pop() ??
      (JSON.parse(await readFile(configPath, 'utf8')) as { task?: { path?: string } }).task?.path
        ?.split('/')
        .filter(Boolean)
        .pop()
    const state = participationOf(parsed)
    const exceptionType = parsed.exception_info?.exception_type ?? null
    if (state === 'ran') {
      partTally.ran += 1
      // THE defect this changeset fixes: a ran trial whose trajectory is the
      // recorded replay, or whose job shows zero gateway usage, means the live
      // route never engaged for that trial.
      const jobName = trialPath.split('/')[0] as string
      const trajectoryPath = join(jobsRoot, trialPath, 'agent', 'trajectory.json')
      const trajectory = await readFile(trajectoryPath, 'utf8').catch(() => '')
      if (trajectory.trim() === '' || trajectory.includes('[dsh-evolve-le replay]')) {
        replayMarkerTrials.push(trialPath)
      }
      if ((solveFacts.get(jobName)?.totalTokens ?? 0) === 0) {
        ranWithoutUsage.push(trialPath)
      }
    } else if (state === 'never-initialized') {
      partTally.never += 1
      const label = trialPath.split('/').slice(-2).join('/')
      neverInitializedTrials.push(label)
      if (exceptionType !== null && INFRA_RETRYABLE_EXCEPTIONS.has(exceptionType)) {
        preLaunchInfraDeaths[exceptionType] = (preLaunchInfraDeaths[exceptionType] ?? 0) + 1
      } else {
        agentProcessDeaths.push(`${label} (${exceptionType ?? 'no-exception'})`)
      }
    } else partTally.unknown += 1
    if (handle !== undefined) {
      trialParticipation.push({
        handle,
        capsule: parsed.agent_info?.version ?? '',
        state,
        exceptionType,
      })
    }
  }
  check(
    'noAgentProcessDeath',
    partTally.unknown === 0 && agentProcessDeaths.length === 0,
    `ran=${String(partTally.ran)} never-initialized=${String(partTally.never)} ` +
      `(pre-launch infra: ${JSON.stringify(preLaunchInfraDeaths)}) ` +
      `unknown=${String(partTally.unknown)}; agent-process deaths: ${agentProcessDeaths.slice(0, 5).join(',')}`,
  )
  check(
    'everyRanTrialSolvedLive',
    replayMarkerTrials.length === 0 && ranWithoutUsage.length === 0,
    `replay trajectories: ${replayMarkerTrials.slice(0, 5).join(',')}; ` +
      `ran without gateway usage: ${ranWithoutUsage.slice(0, 5).join(',')}`,
  )

  // ---- §4.2 baseline freeze: pre-registered, pool frozen before proposals --------
  const { runSplitCeremony, splitCountsForPopulation } = await importBuilt(
    'packages/dsh-evolve-le/lib/split/ceremony.js',
  )
  const handles = (
    JSON.parse(await readFile(join(runRoot, 'dataset-handles.json'), 'utf8')) as {
      handles: string[]
    }
  ).handles
  const ceremonyDoc = JSON.parse(await readFile(join(runRoot, 'split-ceremony.json'), 'utf8')) as {
    observedHandles: string[]
  }
  const rederived = runSplitCeremony({
    runId: RUN_ID,
    masterSeed: MASTER_SEED,
    handles,
    counts: splitCountsForPopulation(handles.length),
  })
  check(
    'ceremonyRe_derivesFromSeedAndDataset',
    JSON.stringify(ceremonyDoc.observedHandles) ===
      JSON.stringify(rederived.ceremony.observedHandles),
  )
  const kSample: string[] = rederived.ceremony.observedHandles.slice(0, report.discoveryTrials)
  const catalog = JSON.parse(await readFile(join(runRoot, 'archive-catalog.json'), 'utf8')) as {
    entries: CatalogEntry[]
  }
  const baselineEntry = catalog.entries.find((entry) => entry.parentCandidateId === null)
  const baselineTasks = new Map(
    (baselineEntry?.tasks ?? []).map((task) => [task.opaqueTaskId, task] as const),
  )
  check(
    'baselineRanExactlyThePreRegisteredSample',
    baselineTasks.size === report.discoveryTrials &&
      kSample.every((handle) => baselineTasks.get(handle)?.attempts === 1),
    `${String(baselineTasks.size)} baseline tasks vs discovery ${String(report.discoveryTrials)}`,
  )
  const poolDoc = JSON.parse(await readFile(join(runRoot, 'failure-pool.json'), 'utf8')) as {
    handles: string[]
    frozenFromObservations: number
  }
  check(
    'failurePoolFrozenFromThePilotsOwnBaselineOnly',
    poolDoc.frozenFromObservations === report.discoveryTrials &&
      poolDoc.handles.every((handle) => kSample.includes(handle)),
    JSON.stringify(poolDoc),
  )
  const capsuleRecords: CapsuleRecord[] = []
  for (const entry of await readdir(join(runRoot, 'capsules')).catch(() => [])) {
    if (!entry.endsWith('.json')) continue
    capsuleRecords.push(
      JSON.parse(await readFile(join(runRoot, 'capsules', entry), 'utf8')) as CapsuleRecord,
    )
  }
  const baselineSha =
    capsuleRecords.find((record) => record.candidateId === baselineEntry?.candidateId)
      ?.archiveSha256 ?? ''
  const baselineFreeze = kSample.map((handle) => {
    const own = trialParticipation.filter((t) => t.handle === handle && t.capsule === baselineSha)
    const part = own.every((t) => t.state !== 'ran')
      ? own.some((t) => t.state === 'never-initialized')
        ? 'never-initialized'
        : 'unknown'
      : 'ran'
    return {
      opaqueTaskId: handle,
      attempts: baselineTasks.get(handle)?.attempts ?? 0,
      successes: baselineTasks.get(handle)?.successes ?? 0,
      failures: baselineTasks.get(handle)?.failures ?? 0,
      outcome: (baselineTasks.get(handle)?.successes ?? 0) > 0 ? 'PASS' : 'FAIL',
      agentParticipation: part,
    }
  })
  check(
    'baselineFreezeTrialsAllRanAgents',
    baselineFreeze.every((entry) => entry.agentParticipation === 'ran'),
    JSON.stringify(baselineFreeze.filter((entry) => entry.agentParticipation !== 'ran')),
  )
  // The live baseline is the first HONEST capability signal: a frozen pool of
  // ≥1 failure means the real model actually failed ≥1 of its own tasks, and
  // the freeze must not be the mechanical all-FAIL of the replay capsule.
  const baselinePasses = baselineFreeze.filter((entry) => entry.outcome === 'PASS').length
  notes.push(
    `live baseline freeze: ${String(baselinePasses)}/${String(baselineFreeze.length)} discovery trials PASS with the live solver`,
  )

  // ---- every expansion was a REAL model proposal through the TCB proxy ---------
  const sandboxesRoot = join(runRoot, 'controller', 'sandboxes')
  const sandboxNames = (await readdir(sandboxesRoot).catch(() => [] as string[])).filter((name) =>
    /^prop-\d+$/.test(name),
  )
  check(
    'oneSandboxPerExpansion',
    sandboxNames.length === report.expansionAttempts,
    `${String(sandboxNames.length)} sandboxes vs ${String(report.expansionAttempts)} expansions`,
  )
  const { verifyRemoteReceipts } = await importBuilt(
    'packages/dsh-evolve-le/lib/proposer/remote-gateway.js',
  )
  const proposals: Array<{
    actionId: string
    modelKind: string
    routeHash: string
    receipts: number
    allOk: boolean
    promptTokens: number
    completionTokens: number
    costUsdMicros: number
  }> = []
  let proposerCostMicros = 0
  for (const name of sandboxNames) {
    const sandboxRoot = join(sandboxesRoot, name)
    const supervisor = JSON.parse(await readFile(join(sandboxRoot, 'supervisor.json'), 'utf8')) as {
      model?: { kind?: string; routeId?: string; routeHash?: string; receiptsPath?: string }
    }
    const model = supervisor.model
    const okModel =
      model?.kind === 'remote' &&
      model.routeId === 'deepseek/zen-compatible' &&
      model.routeHash === routeHash
    check(`sandbox_${name}_remote_route_frozen`, okModel, JSON.stringify(model))
    if (model?.receiptsPath === undefined) continue
    const verification = await verifyRemoteReceipts({
      receiptsPath: model.receiptsPath,
      transcriptPath: join(sandboxRoot, 'work', 'transcript.jsonl'),
      routeHash,
    })
    check(
      `sandbox_${name}_receipt_chain_verifies`,
      verification.ok,
      verification.problems.join(';'),
    )
    proposerCostMicros += verification.usage.costUsdMicros
    proposals.push({
      actionId: name,
      modelKind: model.kind ?? '?',
      routeHash: model.routeHash ?? '?',
      receipts: verification.requests,
      allOk: verification.ok,
      promptTokens: verification.usage.promptTokens,
      completionTokens: verification.usage.completionTokens,
      costUsdMicros: verification.usage.costUsdMicros,
    })
  }
  check(
    'realModelDroveEveryExpansion',
    proposals.length === report.expansionAttempts && proposals.length > 0,
    `${String(proposals.length)} verified remote proposals`,
  )
  check(
    'budgetCoversTheAuthoritativeProposerCost',
    (report.budget['usd']?.spent ?? 0) >= proposerCostMicros,
    `usd spent ${String(report.budget['usd']?.spent ?? 0)} < proposer ${String(proposerCostMicros)}`,
  )

  // ---- solver settlement: receipts are the authority (ADR-030 D2) ---------------
  const receiptTotal = [...solveFacts.values()].reduce((sum, fact) => sum + fact.totalTokens, 0)
  const receiptCost = [...solveFacts.values()].reduce((sum, fact) => sum + fact.costUsdMicros, 0)
  const solverBudget = report.budget['solver-tokens'] ?? null
  check(
    'solverTokensSettledExactlyFromReceipts',
    solverBudget !== null &&
      solverBudget.spent === receiptTotal &&
      solverBudget.spent > 0 &&
      solverBudget.reserved === 0,
    `settled ${JSON.stringify(solverBudget)} vs receipts ${String(receiptTotal)} tokens`,
  )
  const tokenDir = join(runRoot, 'solve-gateway', 'tokens')
  const tokenFiles = (await readdir(tokenDir).catch(() => [] as string[])).filter((name) =>
    name.endsWith('.token'),
  )
  check(
    'oneTokenFilePerHarborJob',
    tokenFiles.length === jobNames.length,
    `${String(tokenFiles.length)} tokens vs ${String(jobNames.length)} jobs`,
  )
  const trialTokens = await Promise.all(
    tokenFiles.map((name) =>
      readFile(join(tokenDir, name), 'utf8')
        .then((text) => text.trim())
        .catch(() => ''),
    ),
  )

  // ---- children: K admitted, cold-started, cite raw evidence --------------------
  const children = catalog.entries.filter((entry) => entry.parentCandidateId !== null)
  const unadmittedIds = [
    ...(report.rebuildRejections ?? []).map((entry) => entry.candidateId),
    ...(report.abandonedIntents ?? []).map((entry) => entry.candidateId),
  ]
  const admittedIds = new Set(children.map((child) => child.candidateId))
  check(
    'expansionAccountingDisjoint',
    unadmittedIds.every((id) => !admittedIds.has(id)) &&
      new Set(unadmittedIds).size === unadmittedIds.length,
    `${String((report.rebuildRejections ?? []).length)} rebuild rejections + ${String(
      (report.abandonedIntents ?? []).length,
    )} abandoned, overlap=${String(unadmittedIds.filter((id) => admittedIds.has(id)).length)}`,
  )
  check(
    'admittedChildrenMeetK',
    report.admittedNonBaseline >= K_TARGET && children.length === report.admittedNonBaseline,
    `${String(report.admittedNonBaseline)} admitted (K=${String(K_TARGET)}), ${String(children.length)} catalogued`,
  )
  const depthOf = (entry: CatalogEntry, seen = new Set<string>()): number => {
    if (entry.parentCandidateId === null || seen.has(entry.candidateId)) return 0
    seen.add(entry.candidateId)
    const parent = catalog.entries.find(
      (candidate) => candidate.candidateId === entry.parentCandidateId,
    )
    return parent === undefined ? 1 : depthOf(parent, seen) + 1
  }
  const childDepths = children.map((child) => depthOf(child))
  const poolSet = new Set(report.failurePool)
  const poolCoverage = children.map((child) => ({
    candidateId: child.candidateId,
    poolTrials: child.tasks
      .filter((task) => poolSet.has(task.opaqueTaskId))
      .reduce((total, task) => total + task.attempts, 0),
  }))
  check(
    'everyChildColdStartedFromFrozenPool',
    poolCoverage.length > 0 && poolCoverage.every((child) => child.poolTrials >= 1),
    JSON.stringify(poolCoverage),
  )
  const objectPath = (digest: string): string =>
    join(runRoot, 'objects', 'sha256', digest.slice(0, 2), digest)
  const citing: Array<{ candidateId: string; refs: number; verified: number }> = []
  for (const child of children) {
    const manifestPath = join(
      runRoot,
      'controller',
      'candidates',
      child.candidateId,
      'tree',
      'candidate.json',
    )
    if (!existsSync(manifestPath)) {
      citing.push({ candidateId: child.candidateId, refs: 0, verified: 0 })
      continue
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      proposal?: { evidenceRefs?: string[] }
    }
    const refs = manifest.proposal?.evidenceRefs ?? []
    let verified = 0
    for (const ref of refs) {
      const digest = ref.replace(/^evidence:\/\/export\//, '')
      if (existsSync(objectPath(digest))) verified += 1
    }
    citing.push({ candidateId: child.candidateId, refs: refs.length, verified })
  }
  check(
    'childrenCiteHistoricalRawEvidence',
    citing.length > 0 && citing.every((child) => child.refs > 0 && child.verified === child.refs),
    JSON.stringify(citing),
  )

  // ---- exactly-once external effects --------------------------------------------
  const trials = await trialDirs(jobsRoot)
  check(
    'oneHarborTrialDirPerCommittedTrial',
    trials.length === report.trials,
    `${String(trials.length)} trial dirs vs ${String(report.trials)} trials`,
  )
  const ledgerText = (
    await readFile(join(runRoot, 'harbor-ledger.jsonl'), 'utf8').catch(() => '')
  ).trim()
  const ledgerLines = ledgerText === '' ? 0 : ledgerText.split('\n').length
  check(
    'oneLedgerLinePerLaunch',
    ledgerLines === report.trials,
    `${String(ledgerLines)} ledger lines vs ${String(report.trials)} trials`,
  )
  const journalBefore = await journalBytes(join(runRoot, 'controller'))
  const ledgerBefore = await readFile(join(runRoot, 'controller', 'budget-ledger.jsonl'), 'utf8')
  const reportBefore = await readFile(join(runRoot, 'drive-report.json'), 'utf8')
  const settle = await cli(['resume', '--run-root', runRoot])
  check(
    'secondResumeDuplicatesNothing',
    settle.code === 0 &&
      (await journalBytes(join(runRoot, 'controller'))) === journalBefore &&
      (await readFile(join(runRoot, 'controller', 'budget-ledger.jsonl'), 'utf8')) ===
        ledgerBefore &&
      (await readFile(join(runRoot, 'drive-report.json'), 'utf8')) === reportBefore &&
      (await trialDirs(jobsRoot)).length === trials.length,
    `exit ${String(settle.code)}`,
  )

  // ---- Harbor trials attributed to capsule archives ------------------------------
  const archiveShas = new Set(capsuleRecords.map((record) => record.archiveSha256))
  let attributed = 0
  const unattributed: string[] = []
  for (const job of await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!job.isDirectory() || job.name.startsWith('.')) continue
    for (const trial of await readdir(join(jobsRoot, job.name), { withFileTypes: true })) {
      const configPath = join(jobsRoot, job.name, trial.name, 'config.json')
      if (!trial.isDirectory() || !existsSync(configPath)) continue
      const doc = JSON.parse(await readFile(configPath, 'utf8')) as {
        agent?: { kwargs?: { registry_entry?: { id?: string; version?: string } } }
      }
      const entryPoint = doc.agent?.kwargs?.registry_entry
      attributed += 1
      if (
        entryPoint?.id !== 'dsh-evolve-le-capsule' ||
        !archiveShas.has(entryPoint.version ?? '')
      ) {
        unattributed.push(`${job.name}/${trial.name}`)
      }
    }
  }
  check(
    'normalizedTrialsAttributedToCapsuleArchive',
    attributed === report.trials && unattributed.length === 0,
    `${String(attributed)} attributed, unattributed: ${unattributed.join(',').slice(0, 200)}`,
  )

  // ---- audit + status --------------------------------------------------------------
  console.log('gate8 live-pilot: dsh-evolve audit…')
  const audit = await cli(['audit', '--run-root', runRoot])
  check('auditAllGreen', audit.code === 0 && !audit.stdout.includes('✗'), audit.stdout)
  console.log(audit.stdout.trimEnd())
  const status = await cli(['status', '--run-root', runRoot])
  const statusDoc =
    status.code === 0
      ? (JSON.parse(status.stdout) as {
          phase: string
          stopReason: string
          status: string | null
          controller: { stateHash: string; observationCount: number } | null
        })
      : null
  check(
    'statusFromDurableEvidence',
    statusDoc !== null &&
      statusDoc.controller !== null &&
      statusDoc.controller.observationCount === report.trials &&
      statusDoc.controller.stateHash === report.stateHash &&
      statusDoc.stopReason === report.stopReason &&
      statusDoc.status === report.status,
    status.stdout.slice(0, 600),
  )

  // ---- concealment: sealed/guard invisible; credential AND tokens nowhere --------
  const sealedHandles = rederived.sealedStore.sealedHandles
  const guardHandles = rederived.sealedStore.guardHandles
  const frozenDocNames = [
    'run.config.json',
    'split-ceremony.json',
    'run-manifest.json',
    'image-prefetch.json',
    'failure-pool.json',
    'search-state.json',
    'archive-catalog.json',
    'drive-report.json',
  ]
  const docFiles: Array<{ path: string; text: string }> = []
  for (const name of frozenDocNames) {
    const path = join(runRoot, name)
    if (existsSync(path)) docFiles.push({ path, text: await readFile(path, 'utf8') })
  }
  // The run manifest must carry the solver fields (R1) bound to this route.
  const manifestDoc = JSON.parse(await readFile(join(runRoot, 'run-manifest.json'), 'utf8')) as {
    solverTrack?: string
    solverRouteHash?: string
  }
  check(
    'manifestCarriesSolverTrackAndRouteHash',
    manifestDoc.solverTrack === 'assisted' && manifestDoc.solverRouteHash === routeHash,
    JSON.stringify({
      solverTrack: manifestDoc.solverTrack,
      solverRouteHash: manifestDoc.solverRouteHash,
    }),
  )
  const scanFiles = [
    ...docFiles,
    ...(await walkTextFiles(join(runRoot, 'exports'))),
    ...(await walkTextFiles(join(runRoot, 'controller'))),
    ...(await walkTextFiles(join(runRoot, 'objects'))),
    // receipts ARE evidence (hashed payloads only); tokens/ is excluded by
    // design — it is scanned separately for the leak check below.
    ...(await walkTextFiles(join(runRoot, 'solve-gateway', 'receipts'))),
  ]
  const jobFiles = await walkTextFiles(jobsRoot)
  const allFiles = [...scanFiles, ...jobFiles]
  const leaksIn = (files: Array<{ path: string; text: string }>, names: readonly string[]) =>
    files.filter((file) => names.some((name) => file.text.includes(name)))
  const sealedLeaks = [...leaksIn(scanFiles, sealedHandles), ...leaksIn(jobFiles, sealedHandles)]
  check(
    'sealedAssignmentNeverOnDisk',
    sealedLeaks.length === 0,
    sealedLeaks
      .map((file) => file.path)
      .join(',')
      .slice(0, 300),
  )
  const guardLeaks = leaksIn(scanFiles, guardHandles)
  check(
    'guardInvisibleToProposerAndSelector',
    guardLeaks.length === 0,
    guardLeaks
      .map((file) => file.path)
      .join(',')
      .slice(0, 300),
  )
  check(
    'credentialNeverOnDisk',
    allFiles.filter((file) => file.text.includes(credential)).length === 0,
    'credential bytes found in run/job artifacts',
  )
  const tokenLeaks = allFiles.filter((file) =>
    trialTokens.some((token) => token !== '' && file.text.includes(token)),
  )
  check(
    'trialTokensNeverOutsideTheir0600Files',
    tokenLeaks.length === 0,
    tokenLeaks
      .map((file) => file.path)
      .join(',')
      .slice(0, 300),
  )

  // ---- budget accounting exact --------------------------------------------------
  const taskTrialsBudget = report.budget['task-trials']
  const proposalCalls = report.budget['proposal-calls']
  const usd = report.budget['usd']
  check(
    'budgetAccountingExact',
    taskTrialsBudget !== undefined &&
      taskTrialsBudget.spent === report.trials &&
      taskTrialsBudget.reserved === 0 &&
      proposalCalls !== undefined &&
      proposalCalls.spent === report.expansionAttempts &&
      proposalCalls.reserved === 0 &&
      usd !== undefined &&
      usd.reserved === 0 &&
      usd.spent > 0,
    JSON.stringify(report.budget),
  )

  // ---- evidence out (no secrets, no tokens/, no capsule archives) ----------------
  // PASS-only: a failed gate keeps its evidence in the retained run root and
  // leaves the committed evidence directory untouched.
  console.log(
    failures.length > 0
      ? 'gate8 live-pilot: checks failed — evidence directory untouched (run root kept)'
      : 'gate8 live-pilot: writing evidence…',
  )
  if (failures.length === 0) {
    const evidenceRunRoot = join(pilotDir, 'run')
    const jobsEvidenceRoot = join(pilotDir, 'jobs')
    await rm(evidenceRunRoot, { recursive: true, force: true })
    await rm(jobsEvidenceRoot, { recursive: true, force: true })
    await mkdir(evidenceRunRoot, { recursive: true })
    await mkdir(jobsEvidenceRoot, { recursive: true })
    for (const name of [
      'run.config.json',
      'dataset-handles.json',
      'split-ceremony.json',
      'run-manifest.json',
      'image-prefetch.json',
      'verifier-image-receipt.json',
      'failure-pool.json',
      'search-state.json',
      'drive-report.json',
      'archive-catalog.json',
      'harbor-ledger.jsonl',
    ]) {
      await cp(join(runRoot, name), join(evidenceRunRoot, name)).catch(() => undefined)
    }
    await cp(join(runRoot, 'controller'), join(evidenceRunRoot, 'controller'), {
      recursive: true,
    }).catch(() => undefined)
    for (const name of ['exports', 'objects', 'harbor-plans']) {
      await cp(join(runRoot, name), join(evidenceRunRoot, name), { recursive: true }).catch(
        () => undefined,
      )
    }
    // The solve receipts are evidence (hash-bound, settle authority); tokens/
    // is per-trial state and NEVER copied (ADR-030 evidence boundary).
    await cp(
      join(runRoot, 'solve-gateway', 'receipts'),
      join(evidenceRunRoot, 'solve-gateway', 'receipts'),
      { recursive: true },
    ).catch(() => undefined)
    await mkdir(join(evidenceRunRoot, 'capsules'), { recursive: true })
    for (const record of capsuleRecords) {
      const name = `${record.candidateId}.json`
      await cp(join(runRoot, 'capsules', name), join(evidenceRunRoot, 'capsules', name)).catch(
        () => undefined,
      )
    }
    for (const job of await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!job.isDirectory() || job.name.startsWith('.')) continue
      await cp(join(jobsRoot, job.name), join(jobsEvidenceRoot, job.name), { recursive: true })
    }

    const document = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/gate8-live-pilot/v1',
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      masterSeed: MASTER_SEED,
      configHash: initDoc?.configHash ?? null,
      verificationMode:
        resumeRoot !== undefined
          ? 're-entry (DSH_GATE8_LIVE_PILOT_RUN_ROOT: idempotent resume + verify)'
          : 'fresh run (init + doctor + run + verify)',
      configProfile:
        'recorded pilot K=10 shape with the SOLVE layer live too (ADR-030 rehearsal for the K=80 search profile)',
      route: {
        id: 'deepseek/zen-compatible',
        baseUrl,
        model: modelName,
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        routeHash,
        credentialFile: credentialPath,
        roles: ['proposer', 'solver'],
      },
      dataset: { tarball: 'terminal-bench-2-1-7131e43.tar.gz', handles: handles.length },
      preRegistration: {
        kTarget: K_TARGET,
        discoveryBatch: DISCOVERY_BATCH,
        discoveryCap: DISCOVERY_CAP,
        maxSolverTrials: MAX_SOLVER_TRIALS,
        taskTrials: MAX_SOLVER_TRIALS,
        concurrentTrials: CONCURRENT_TRIALS,
        prefetchImages: true,
        solverTokens: SOLVER_TOKENS,
        wallClockMinutes: WALL_CLOCK_MINUTES,
        wallClockDeviation:
          '48 h instead of the stable-demo 16 h default: live trials run minutes-to-half-an-hour each, and the point of this run is the LOOP, not the 16 h acceptance bar (the recorded pilot already flagged time-side parallelization as the K=80 design input)',
        sample: kSample,
        selectionRule:
          'specs/04 §4.1 protocol over the frozen ceremony order; specs/04 §4.2 requires this run to freeze its OWN baseline',
        seedCommitment: rederived.ceremony.seedCommitment,
      },
      agentParticipation: {
        tally: partTally,
        neverInitializedTrials,
        preLaunchInfraDeaths,
        agentProcessDeaths,
        note: 'per ADR-025 a never-initialized trial is disclosed infra only with a pre-launch exception class; an agent-process death fails the gate. ADR-030 adds: every RAN trial must carry a non-replay trajectory and non-zero gateway usage for its job.',
      },
      baselineFreeze,
      baselineLivePasses: baselinePasses,
      failurePool: poolDoc.handles,
      report,
      runSeconds,
      proposals,
      proposerCostUsdMicros: proposerCostMicros,
      solveUsage: {
        jobs: [...solveFacts.entries()].map(([jobName, fact]) => ({ jobName, ...fact })),
        totalTokens: receiptTotal,
        costUsdMicros: receiptCost,
        settledSolverTokens: solverBudget?.spent ?? null,
        averageTokensPerTrial: report.trials > 0 ? Math.round(receiptTotal / report.trials) : null,
      },
      perTrialSeconds:
        runSeconds !== null && report.trials > 0 ? Math.round(runSeconds / report.trials) : null,
      lineage: { depthMax: report.lineageDepthMax, childDepths },
      poolCoverage,
      capsules: capsuleRecords,
      harborTrialDirs: trials.length,
      attributedTrials: attributed,
      ledgerLines,
      evidenceCitations: citing,
      sealedCount: sealedHandles.length,
      guardCount: guardHandles.length,
      flags,
      notes,
      claimBoundary:
        'live-pilot rehearsal only: full-loop closure (live propose + live solve + rebuild + ' +
        'admission + settlement) at K=10 for the K=80 search run; no sealed unblinding, no ' +
        'sealed/official profile, no leaderboard or SOTA claim, and the 16 h acceptance wall ' +
        'clock was deliberately not exercised (see preRegistration.wallClockDeviation)',
    }
    await writeFile(join(pilotDir, 'live-pilot-run.json'), `${JSON.stringify(document, null, 2)}\n`)
    const documentSha = createHash('sha256')
      .update(await readFile(join(pilotDir, 'live-pilot-run.json')))
      .digest('hex')
    await writeFile(
      join(pilotDir, 'STATUS.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          gate: 8,
          profile: 'live-pilot',
          status: failures.length === 0 ? 'PASS' : 'FAIL',
          failedChecks: failures,
          evidence: 'evidence/gate8/live-pilot/live-pilot-run.json',
          evidenceSha256: documentSha,
          recordedAt: document.generatedAt,
          summary: {
            route: `deepseek/zen-compatible → ${modelName} (proposer + solver)`,
            driverStatus: report.status,
            discoveryTrials: report.discoveryTrials,
            baselineLivePasses: `${String(baselinePasses)}/${String(baselineFreeze.length)}`,
            expansions: report.expansionAttempts,
            admittedChildren: report.admittedNonBaseline,
            lineageDepthMax: report.lineageDepthMax,
            trials: report.trials,
            agentParticipation: `${String(partTally.ran)} ran / ${String(partTally.never)} never-initialized / ${String(partTally.unknown)} unknown`,
            solverTokensSettled: solverBudget?.spent ?? null,
            solveCostUsdMicros: receiptCost,
            proposerCostUsdMicros: proposerCostMicros,
            runSeconds,
          },
        },
        null,
        2,
      )}\n`,
    )
  }
  if (failures.length > 0) {
    console.error(`gate8 live-pilot FAILED: ${failures.join(' | ')}`)
    console.error(`run root kept for diagnosis: ${runRoot}`)
    process.exit(1)
  }
  if (scratch !== '') await rm(scratch, { recursive: true, force: true })
  console.log(
    `gate8 live-pilot: PASS — K=${String(K_TARGET)} admitted over ${String(report.expansionAttempts)} live proposal(s), ` +
      `${String(report.trials)} live-solved trials (baseline ${String(baselinePasses)}/${String(baselineFreeze.length)} PASS), ` +
      `participation ran=${String(partTally.ran)}/never=${String(partTally.never)}, ` +
      `${String(receiptTotal)} solver tokens (${String(receiptCost)} µUSD solve + ${String(proposerCostMicros)} µUSD propose)` +
      (runSeconds === null ? '' : `, ${String(runSeconds)}s`),
  )
}

await main()
