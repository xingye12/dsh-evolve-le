/**
 * Record the Gate 8 pilot profile (specs/07 §10, specs/03 §2, specs/04 §4.2):
 * a fresh development-only run over the pinned Terminal-Bench 2.1 dataset
 * whose proposer is a REAL networked model through the TCB proxy route.
 * K = 10 ADMITTED non-baseline candidates (specs/03 §2: K always counts
 * candidates through the full build/admission pipeline — never the discovery
 * sample size), reached by real-model expansions of width W_p=3; the pilot
 * freezes its OWN §4.2 baseline first via the §4.1 discovery protocol
 * (first batch 6 observed handles in the frozen ceremony order, second batch
 * 6 only when the first shows no failure, hard cap 12 trials):
 *
 *   1. `init` freezes a run config with proposerRoute = zen-compatible
 *      (endpoint/model/temperature + the 0600 credential path OUTSIDE the
 *      repo), kTarget=10, maxDiscoveryTrials=12, discoveryBatchSize=6,
 *      maxSolverTrials=60 (ADR-026, from the measured attempt-5 curve: 6
 *      batch-1 freeze + ≤12 q0 cold starts + ~2.8 pool trials per admitted
 *      child ≈ 49; the ADR-025 cap of 48 exhausted at 12 admitted children
 *      with 2 q0s unfunded, which specs/03 §6 forbids as a terminal state);
 *   2. baseline discovery runs §4.1 batches on real Harbor trials and freezes
 *      the failure pool at the first batch boundary with ≥1 failure — this
 *      IS the §4.2 baseline freeze for the pilot;
 *   3. every expansion is a REAL model proposal: uid+netns sandbox, TCB proxy
 *      receipts, controller receipt-chain verification, authoritative usage;
 *   4. children rebuild through the trusted builder (capsule self-contained:
 *      the pinned node runtime rides at runtime/node — TB task images ship
 *      no node), cold-start from the frozen pool, and cite the raw evidence
 *      objects they came from;
 *   5. every trial's agent participation is classified from harbor's ACP
 *      bookkeeping: a FAIL whose agent never initialized must carry a
 *      pre-launch phase exception (ADR-025) — an agent-process death (the
 *      original `exec: node: not found` defect) fails the gate, and the
 *      §4.2 baseline freeze must be all-ran;
 *   6. exactly-once external effects, hash-chain audit, sealed/guard
 *      invisibility, exact budget accounting, and the credential never on
 *      disk in any run or job artifact (CLAUDE.md rule 8);
 *   7. timing/usage actuals recorded for the budget extrapolation the pilot
 *      exists to produce (specs/04 §12).
 *
 * Machine-checkable document: evidence/gate8/pilot/pilot-run.json
 * (+ STATUS.json). Fails closed (exit 1) on any violation. The run root and
 * Harbor jobs stay in scratch OUTSIDE the repository.
 *
 * Environment:
 *   DSH_GATE8_CREDENTIAL  path to the 0600 credential file
 *                         (default /root/.config/dsh-evolve-le/zen-compatible.key)
 *   DSH_GATE8_BASE_URL    OpenAI-compatible base URL
 *   DSH_GATE8_MODEL       exact model id
 *
 * Usage: node --import tsx/esm scripts/record-gate8-pilot.ts
 * @module scripts/record-gate8-pilot
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

const pilotDir = resolve(repoRoot, 'evidence/gate8/pilot')
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const HARBOR_BIN = process.env['HARBOR_BIN'] ?? 'harbor'
const HARBOR_VERSION = '0.21.0'
const ARTIFACT_HOST =
  process.env['GATE8_ARTIFACT_HOST'] ?? process.env['GATE6_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT =
  process.env['GATE8_ARTIFACT_PORT'] ?? process.env['GATE6_ARTIFACT_PORT'] ?? '8443'
const RUN_ID = 'gate8-pilot'
const MASTER_SEED = 'gate8-pilot-master-seed-1'
// specs/03 §2: K counts ADMITTED non-baseline candidates. specs/04 §4.1/§4.2:
// the pilot's own baseline freeze uses the 6+6≤12 discovery protocol.
const K_TARGET = 10
const DISCOVERY_BATCH = 6
const DISCOVERY_CAP = 12
// Funds the §4.1 discovery (≤12) plus every admitted child's pool trials.
// Sizing history: ADR-025 raised 24 → 48 from live scheduler spend (~2.8 pool
// trials per admitted child beyond the q0 cold start); attempt 5 then spent
// the full 48/48 at 12 admitted children with the final wave's last 2 q0 cold
// starts unfunded (STOPPED:TRIAL_CAP — specs/03 §6 requires admitted nodes to
// complete q0, so that run is budget-calibration evidence, not the recorded
// pilot). ADR-026 re-sizes from the measured curve: 6 batch-1 freeze + ≤12
// q0 + ~2.8×11 pool ≈ 49; 60 adds overshoot/flake headroom.
const MAX_SOLVER_TRIALS = 60

const credentialPath =
  process.env['DSH_GATE8_CREDENTIAL'] ?? '/root/.config/dsh-evolve-le/zen-compatible.key'
const baseUrl = process.env['DSH_GATE8_BASE_URL'] ?? 'http://one-api.wattman.cn:805/v1'
const modelName = process.env['DSH_GATE8_MODEL'] ?? 'deepseek-v4-flash'

const importBuilt = (builtPath: string) => import(pathToFileURL(resolve(repoRoot, builtPath)).href)

interface CliResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

async function cli(args: readonly string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_BIN, ...args], {
      cwd: repoRoot,
      // 48 Harbor trials (~5 min each, sequential) + real-model proposals
      // (~10 min each) + capsule builds per child + Harbor/container overhead
      // — up to ~7h; the 8h ceiling leaves crash-recovery headroom.
      timeout: 28_800_000,
      maxBuffer: 64 << 20,
      env: { ...process.env, ...env },
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
  /** ADR-026: per-child trusted-rebuild rejections and crash-abandoned
   * intents — registered, never admitted, each with its accounting reason. */
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
  // DSH_GATE8_PILOT_RUN_ROOT re-verifies an ALREADY COMPLETED run (read-only
  // checks + the idempotent resume probe) instead of paying for a new one —
  // for when a recorder defect, not a protocol violation, voided the first
  // verdict. Every check below still runs against the durable run root.
  const verifyOnly = process.env['DSH_GATE8_PILOT_RUN_ROOT'] !== undefined
  if (
    verifyOnly &&
    !existsSync(join(process.env['DSH_GATE8_PILOT_RUN_ROOT'] as string, 'drive-report.json'))
  ) {
    throw new Error(
      `DSH_GATE8_PILOT_RUN_ROOT has no completed run: ${String(process.env['DSH_GATE8_PILOT_RUN_ROOT'])}`,
    )
  }
  let scratch = ''
  let runsRoot = ''
  let jobsRoot = ''
  let runRoot = ''
  if (verifyOnly) {
    runRoot = process.env['DSH_GATE8_PILOT_RUN_ROOT'] as string
    notes.push(`verify-only pass over the completed run root ${runRoot}`)
  } else {
    scratch = await mkdtemp(join(tmpdir(), 'dsh-gate8-pilot-'))
    runsRoot = join(scratch, 'runs')
    jobsRoot = join(scratch, 'jobs')
    runRoot = join(runsRoot, RUN_ID)
    await mkdir(jobsRoot, { recursive: true })
    await mkdir(runsRoot, { recursive: true })
  }

  let initDoc: { configHash: string; handles: number } | null = null
  if (verifyOnly) {
    const manifest = JSON.parse(await readFile(join(runRoot, 'run-manifest.json'), 'utf8')) as {
      configHash?: string
    }
    initDoc =
      manifest.configHash === undefined ? null : { configHash: manifest.configHash, handles: 0 }
  } else {
    console.log('gate8 pilot: extracting pinned terminal-bench 2.1 tasks…')
    await exec('tar', ['-xzf', TARBALL, '-C', scratch])
    const { DATASET_PIN } = await importBuilt('benchmark-adapters/terminal-bench/lib/dataset.js')
    await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), join(scratch, 'tasks'), {
      recursive: true,
    })

    // ---- init: pilot profile — real-model proposer route, K=10 discovery -----
    const initArgs = [
      'init',
      '--runs-root',
      runsRoot,
      '--run-id',
      RUN_ID,
      '--master-seed',
      MASTER_SEED,
      '--tasks-root',
      join(scratch, 'tasks'),
      '--baseline-source',
      resolve(repoRoot, 'packages/candidate-baseline'),
      '--jobs-root',
      jobsRoot,
      '--credential-file',
      credentialPath,
      '--proposer-route',
      'deepseek/zen-compatible',
      '--model-base-url',
      baseUrl,
      '--model-name',
      modelName,
      '--model-temperature',
      '0',
      '--harbor-bin',
      HARBOR_BIN,
      '--artifact-host',
      ARTIFACT_HOST,
      '--artifact-port',
      ARTIFACT_PORT,
      // K=10 pre-registration (specs/03 §2): K is the ADMITTED-candidate
      // target; discovery follows §4.1 (6+6, hard cap 12) and the trial cap
      // funds every admitted child's q0 cold start.
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
    ]
    console.log('gate8 pilot: dsh-evolve init (zen-compatible proposer route, K=10 admitted)…')
    const init = await cli(initArgs)
    initDoc =
      init.code === 0 ? (JSON.parse(init.stdout) as { configHash: string; handles: number }) : null
    check(
      'initFrozeConfigAndHandles',
      init.code === 0 && initDoc !== null && initDoc.handles === 89,
      `exit ${String(init.code)}: ${init.stderr.slice(0, 400)}`,
    )
  }
  const frozenConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
    proposerRoute?: string
    modelRoutes?: Array<{
      id: string
      provider: string
      baseUrl?: string
      model?: string
      temperature?: number
      credentialFile?: string
      maxOutputTokens?: number
      inputUsdMicrosPerMTok?: number
      outputUsdMicrosPerMTok?: number
    }>
    search?: Record<string, number>
    sealedAccess?: boolean
    benchmark?: { harbor?: { jobsRoot?: string } }
  }
  if (verifyOnly) {
    jobsRoot = frozenConfig.benchmark?.harbor?.jobsRoot ?? ''
    if (jobsRoot === '') throw new Error('frozen config carries no harbor jobs root')
  }
  const zenRoute = frozenConfig.modelRoutes?.find((route) => route.id === 'deepseek/zen-compatible')
  check(
    'configFrozeTheRealModelRoute',
    frozenConfig.proposerRoute === 'deepseek/zen-compatible' &&
      zenRoute?.baseUrl === baseUrl &&
      zenRoute?.model === modelName &&
      zenRoute?.temperature === 0,
    JSON.stringify({ proposerRoute: frozenConfig.proposerRoute, zenRoute }),
  )
  const search = frozenConfig.search ?? {}
  check(
    'configIsK10PilotShape',
    search['kTarget'] === K_TARGET &&
      search['maxDiscoveryTrials'] === DISCOVERY_CAP &&
      search['discoveryBatchSize'] === DISCOVERY_BATCH &&
      search['maxSolverTrials'] === MAX_SOLVER_TRIALS &&
      frozenConfig['sealedAccess'] === false,
    JSON.stringify(search),
  )
  // The frozen route hash every sandbox receipt must bind to.
  const { remoteRoutePlanHash } = await importBuilt(
    'packages/dsh-evolve-le/lib/proposer/remote-gateway.js',
  )
  const routeHash = remoteRoutePlanHash({
    routeId: 'deepseek/zen-compatible',
    baseUrl,
    model: modelName,
    temperature: 0,
    maxOutputTokens: zenRoute?.maxOutputTokens ?? 32_768,
    inputUsdPerMTok: (zenRoute?.inputUsdMicrosPerMTok ?? 140_000) / 1_000_000,
    outputUsdPerMTok: (zenRoute?.outputUsdMicrosPerMTok ?? 280_000) / 1_000_000,
  })

  // ---- doctor -----------------------------------------------------------------
  console.log('gate8 pilot: dsh-evolve doctor (real docker/harbor/credential checks)…')
  const doctor = await cli(['doctor', '--run-root', runRoot])
  check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
  console.log(doctor.stdout.trimEnd())

  // ---- run: baseline freeze on the K=10 sample, then the real-model search ----
  let runSeconds: number | null = null
  let report: DriveReportDoc | null = null
  if (verifyOnly) {
    report = JSON.parse(
      await readFile(join(runRoot, 'drive-report.json'), 'utf8'),
    ) as DriveReportDoc
    // Wall-clock from the durable journal (first → last committed event): the
    // §12 budget actual must come from evidence, not from the crashed
    // recorder's stdout.
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
        `wall-clock re-derived from the controller journal (${String(stamps.length)} events): ${String(runSeconds)}s`,
      )
    }
  } else {
    console.log(
      'gate8 pilot: dsh-evolve run (§4.1 discovery batches + REAL model proposals to K=10 admitted + q0 cold starts; hours)…',
    )
    const runStart = Date.now()
    const run = await cli(['run', '--run-root', runRoot])
    runSeconds = Math.round((Date.now() - runStart) / 1000)
    check('runExitZero', run.code === 0, `exit ${String(run.code)}: ${run.stderr.slice(0, 2000)}`)
    report = run.code === 0 ? (JSON.parse(run.stdout) as DriveReportDoc) : null
    if (report === null) {
      console.error(`gate8 pilot FAILED: run exited ${String(run.code)}`)
      console.error(run.stderr.slice(0, 4000))
      process.exit(1)
    }
  }
  console.log(
    `gate8 pilot: ${report.stopReason} / ${report.status} — ` +
      `trials=${String(report.trials)} discovery=${String(report.discoveryTrials)} ` +
      `expansions=${String(report.expansionAttempts)} admitted=${String(report.admittedNonBaseline)} ` +
      `depth=${String(report.lineageDepthMax)} pool=${String(report.failurePool.length)} ` +
      `rebuild-rejected=${String((report.rebuildRejections ?? []).length)} ` +
      `abandoned=${String((report.abandonedIntents ?? []).length)}` +
      (runSeconds === null ? '' : ` (${String(runSeconds)}s)`),
  )

  // ---- the pilot shape ----------------------------------------------------------
  // specs/03 §2 + specs/07 §10: the pilot's K=10 is the ADMITTED-candidate
  // target. The loop stops at K_REACHED once admittedNonBaseline ≥ K and no
  // cold start is pending; the final W_p=3 wave may overshoot K by up to 2,
  // which is pre-registered and budgeted (maxSolverTrials funds 12 children).
  // The driver's STABLE_ITERATION_VERIFIED label is the GATE 6 stable-demo
  // bar (lineageDepthMax ≥ 2); a wave-shaped pilot may reach K at any depth,
  // recorded verbatim below.
  check(
    'stopReasonKReached',
    report.stopReason === 'K_REACHED',
    `${report.stopReason} / ${report.status}`,
  )
  if (report.lineageDepthMax < 2) {
    notes.push(
      `lineageDepthMax=${String(report.lineageDepthMax)}: K was reached within one expansion wave, so the driver honestly reported ${report.status}; the ≥2-depth bar belongs to the Gate 6 stable-demo profile`,
    )
  }
  // specs/04 §4.1: batches of 6 in the frozen order, hard cap 12. With ≥1
  // real baseline failure in batch 1 the pool freezes at 6; only a clean
  // first batch pays for the second.
  check(
    'discoveryHonoredThePreRegisteredProtocol',
    report.discoveryTrials === DISCOVERY_BATCH || report.discoveryTrials === DISCOVERY_CAP,
    `${String(report.discoveryTrials)} discovery trials`,
  )

  // ---- agent participation: deaths must be pre-launch infra, never the agent (rule 7) ------
  // Harbor's installed-agent runner records the ACP `initialize` response in
  // agent_result.metadata.acp the moment the agent speaks; null with an
  // exception means the process died before one protocol byte. Two classes
  // must stay distinguishable (ADR-025): pre-launch provisioning timeouts
  // (`AgentSetupTimeoutError` etc. — harbor's own venv bootstrap, before the
  // candidate process exists) are disclosed infra deaths that keep
  // FAIL-in-the-denominator semantics, while an agent-process death
  // (`NonZeroAgentExitCodeError` — the original Gate 8 defect,
  // `exec: node: not found`) is a capability/harness-integration failure and
  // fails the gate outright. The self-contained capsule (runtime/node) must
  // make agent-process deaths impossible.
  const { participationOf, INFRA_RETRYABLE_EXCEPTIONS } = await importBuilt(
    'benchmark-adapters/terminal-bench/lib/normalize.js',
  )
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
  for (const trialPath of await trialDirs(jobsRoot)) {
    const resultPath = join(trialPath, 'result.json')
    const configPath = join(trialPath, 'config.json')
    if (!existsSync(resultPath) || !existsSync(configPath)) {
      partTally.unknown += 1
      continue
    }
    const parsed = JSON.parse(await readFile(resultPath, 'utf8')) as {
      task_name?: string
      agent_info?: { version?: string }
      exception_info?: { exception_type?: string } | null
    }
    // Handle from result.json's task_name, falling back to the trial's own
    // config.json task.path (the normalizer's authoritative attribution link).
    const handle =
      parsed.task_name?.split('/').filter(Boolean).pop() ??
      (JSON.parse(await readFile(configPath, 'utf8')) as { task?: { path?: string } }).task?.path
        ?.split('/')
        .filter(Boolean)
        .pop()
    const state = participationOf(parsed)
    const exceptionType = parsed.exception_info?.exception_type ?? null
    if (state === 'ran') partTally.ran += 1
    else if (state === 'never-initialized') {
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

  // ---- §4.2 baseline freeze: pre-registered, pool frozen before proposals --------
  const { runSplitCeremony } = await importBuilt('packages/dsh-evolve-le/lib/split/ceremony.js')
  const handles = (
    JSON.parse(await readFile(join(runRoot, 'dataset-handles.json'), 'utf8')) as {
      handles: string[]
    }
  ).handles
  const ceremonyDoc = JSON.parse(await readFile(join(runRoot, 'split-ceremony.json'), 'utf8')) as {
    observedHandles: string[]
  }
  const rederived = runSplitCeremony({ runId: RUN_ID, masterSeed: MASTER_SEED, handles })
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
  // The pilot's own baseline capsule: discovery trials are its only trials,
  // so its archive sha attributes participation for the freeze (a child's
  // infra death on the same handle must not stain the baseline freeze).
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
    const part =
      own.length === 0 || own.every((t) => t.state !== 'ran')
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

  // ---- children: K admitted, cold-started, cite raw evidence --------------------
  const children = catalog.entries.filter((entry) => entry.parentCandidateId !== null)
  // ADR-026 accounting: every non-admission the driver recorded must name a
  // candidate that is NOT in the archive catalog (an admitted child can never
  // also be rejected or abandoned), and no candidate may be counted twice.
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
  // (capsuleRecords hoisted above the baseline-freeze block)
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
  console.log('gate8 pilot: dsh-evolve audit…')
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

  // ---- concealment: sealed/guard invisible; the credential nowhere on disk --------
  // Same surfaces as Gate 6: the split ASSIGNMENT must never leak, but the
  // frozen population document (dataset-handles.json) carries every task name
  // by design, so it is not a leak surface. Guard tasks never run, so jobs
  // are a sealed-only surface. The credential scan is over EVERYTHING —
  // rule 8 admits no by-design exceptions.
  const sealedHandles = rederived.sealedStore.sealedHandles
  const guardHandles = rederived.sealedStore.guardHandles
  const frozenDocNames = [
    'run.config.json',
    'split-ceremony.json',
    'run-manifest.json',
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
  const scanFiles = [
    ...docFiles,
    ...(await walkTextFiles(join(runRoot, 'exports'))),
    ...(await walkTextFiles(join(runRoot, 'controller'))),
    ...(await walkTextFiles(join(runRoot, 'objects'))),
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

  // ---- budget accounting exact --------------------------------------------------
  const taskTrials = report.budget['task-trials']
  const proposalCalls = report.budget['proposal-calls']
  const usd = report.budget['usd']
  check(
    'budgetAccountingExact',
    taskTrials !== undefined &&
      taskTrials.spent === report.trials &&
      taskTrials.reserved === 0 &&
      proposalCalls !== undefined &&
      proposalCalls.spent === report.expansionAttempts &&
      proposalCalls.reserved === 0 &&
      usd !== undefined &&
      usd.reserved === 0 &&
      usd.spent > 0,
    JSON.stringify(report.budget),
  )

  // ---- evidence out (no secrets, no tls/, no capsule archives) -------------------
  console.log('gate8 pilot: writing evidence…')
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

  // Budget extrapolation actuals (specs/04 §12): what the pilot exists to measure.
  const document = {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/gate8-pilot/v1',
    generatedAt: new Date().toISOString(),
    runId: RUN_ID,
    masterSeed: MASTER_SEED,
    configHash: initDoc?.configHash ?? null,
    verificationMode: verifyOnly
      ? 'verify-only (DSH_GATE8_PILOT_RUN_ROOT over the completed run root)'
      : 'fresh run (init + doctor + run + verify)',
    configProfile:
      'stable-demo base + zen-compatible proposer route + Gate 8 pilot K=10 (admitted candidates; specs/03 §2, specs/07 §10)',
    route: {
      id: 'deepseek/zen-compatible',
      baseUrl,
      model: modelName,
      temperature: 0,
      routeHash,
      credentialFile: credentialPath,
    },
    dataset: { tarball: 'terminal-bench-2-1-7131e43.tar.gz', handles: handles.length },
    preRegistration: {
      kTarget: K_TARGET,
      discoveryBatch: DISCOVERY_BATCH,
      discoveryCap: DISCOVERY_CAP,
      maxSolverTrials: MAX_SOLVER_TRIALS,
      sample: kSample,
      selectionRule:
        'specs/04 §4.1 protocol over the frozen ceremony order: first batch 6 observed handles, second batch 6 only if the first shows no failure, hard cap 12; specs/04 §4.2 requires this pilot to freeze its OWN baseline (stable-demo evidence may not be reused)',
      seedCommitment: rederived.ceremony.seedCommitment,
    },
    agentParticipation: {
      tally: partTally,
      neverInitializedTrials,
      preLaunchInfraDeaths,
      agentProcessDeaths,
      note: 'harbor agent_result.metadata.acp.initialize non-null ⇔ the agent spoke the protocol. Per ADR-025 a never-initialized trial is disclosed infra (FAIL-in-denominator) only when its exception is a pre-launch phase class (e.g. AgentSetupTimeoutError); an agent-process death (NonZeroAgentExitCodeError — the original Gate 8 defect) fails the gate, and the baseline freeze must be all-ran.',
    },
    baselineFreeze,
    failurePool: poolDoc.handles,
    report,
    runSeconds,
    proposals,
    proposerCostUsdMicros: proposerCostMicros,
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
      'pilot profile only: tuning stability and budget actuals for K=10 ADMITTED candidates ' +
      "(specs/03 §2) on the pilot's own §4.2 baseline freeze; no sealed unblinding, no " +
      'search/sealed/official profile, no performance claim',
  }
  await writeFile(join(pilotDir, 'pilot-run.json'), `${JSON.stringify(document, null, 2)}\n`)
  const documentSha = createHash('sha256')
    .update(await readFile(join(pilotDir, 'pilot-run.json')))
    .digest('hex')
  await writeFile(
    join(pilotDir, 'STATUS.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: 8,
        profile: 'pilot',
        status: failures.length === 0 ? 'PASS' : 'FAIL',
        failedChecks: failures,
        evidence: 'evidence/gate8/pilot/pilot-run.json',
        evidenceSha256: documentSha,
        recordedAt: document.generatedAt,
        summary: {
          route: `deepseek/zen-compatible → ${modelName}`,
          driverStatus: report.status,
          discoveryTrials: report.discoveryTrials,
          expansions: report.expansionAttempts,
          admittedChildren: report.admittedNonBaseline,
          lineageDepthMax: report.lineageDepthMax,
          trials: report.trials,
          agentParticipation: `${String(partTally.ran)} ran / ${String(partTally.never)} never-initialized / ${String(partTally.unknown)} unknown`,
          expansionAccounting: {
            rebuildRejections: report.rebuildRejections ?? [],
            abandonedIntents: report.abandonedIntents ?? [],
          },
          proposerCostUsdMicros: proposerCostMicros,
          runSeconds,
        },
      },
      null,
      2,
    )}\n`,
  )
  if (failures.length > 0) {
    console.error(`gate8 pilot FAILED: ${failures.join(' | ')}`)
    console.error(`run root kept for diagnosis: ${runRoot}`)
    process.exit(1)
  }
  if (!verifyOnly) await rm(scratch, { recursive: true, force: true })
  console.log(
    `gate8 pilot: PASS — K=${String(K_TARGET)} admitted candidates over ${String(report.expansionAttempts)} real-model proposal(s), ` +
      `${String(report.discoveryTrials)} discovery trials, ${String(report.trials)} trials, ` +
      `participation ran=${String(partTally.ran)}/never=${String(partTally.never)}, ` +
      `${String(proposerCostMicros)} µUSD proposer cost` +
      (runSeconds === null ? '' : `, ${String(runSeconds)}s`) +
      (verifyOnly ? ' (verify-only pass)' : ''),
  )
}

await main()
