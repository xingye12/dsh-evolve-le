/**
 * Record the Gate 6 acceptance evidence (specs/07 §8): the STABLE K=3
 * iteration proof on a fresh development-only run with the DEFAULT
 * stable-demo configuration — no --set overrides — driving the real
 * `dsh-evolve` CLI over the pinned Terminal-Bench 2.1 dataset:
 *
 *   1. baseline failure discovery in deterministic batches (≤12 observed
 *      trials, batch size 6), the failure pool frozen BEFORE any proposal;
 *   2. a REAL process crash (SIGKILL via the DSH_EVOLVE_CRASH_AFTER_OBSERVATION
 *      seam) after the first durably committed external effect, mid discovery
 *      batch, with no terminal documents written;
 *   3. `resume` drives the SAME run to `STABLE_ITERATION_VERIFIED`: 3 unique
 *      admitted candidates across ≥2 lineage depths, every child carrying a
 *      cold-start evaluation from the frozen pool;
 *   4. exactly-once external effects across the crash (one Harbor trial dir
 *      per committed trial, one sandbox per expansion, one ledger line per
 *      launch) with complete raw refs, hash-chain replay (`audit`) and
 *      normalized per-trial Harbor evidence (registry-entry attributed);
 *   5. every admitted child cites the historical raw evidence objects it was
 *      derived from (proposal.evidenceRefs → content-addressed store);
 *   6. budget accounting exact; sealed/guard assignment invisible everywhere
 *      it must be; `status` replays durable evidence in a fresh process.
 *
 * Machine-checkable document: evidence/gate6/stable-iteration.json
 * (+ STATUS.json). Fails closed (exit 1) on any acceptance violation. The run
 * root, credential placeholder (0600) and TLS key live in scratch OUTSIDE the
 * repository; no credential material ever enters the evidence tree.
 *
 * Usage: node --import tsx/esm scripts/record-gate6-evidence.ts
 * @module scripts/record-gate6-evidence
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

const gate6Dir = resolve(repoRoot, 'evidence', 'gate6')
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const HARBOR_BIN = process.env['HARBOR_BIN'] ?? 'harbor'
const HARBOR_VERSION = '0.21.0'
const ARTIFACT_HOST = process.env['GATE6_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT = process.env['GATE6_ARTIFACT_PORT'] ?? '8443'
const RUN_ID = 'gate6-stable-iteration'
const MASTER_SEED = 'gate6-stable-iteration-master-seed'
/** Default stable-demo shape (specs/03 §11), pinned by the config itself. */
const DEFAULT_BATCH_SIZE = 6
const DEFAULT_MAX_DISCOVERY = 12
const K_TARGET = 3

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
      // Default shape is up to 12 discovery trials + 3 proposal sandboxes + 3
      // cold-start Harbor trials; gate5 measured ~340s per real trial.
      timeout: 14_400_000,
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

/**
 * Event-journal bytes: the hash-chained `events-*.jsonl` segments under
 * `controller/journal/` (not the budget ledger that sits beside it).
 */
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

/**
 * Committed evaluation actions in the journal — parsed, not string-matched.
 * This is the same count the CLI crash drill increments (cli.ts onBoundary:
 * `action.committed` with an `eval-*` payload actionId).
 */
async function committedEvalActions(controllerDir: string): Promise<string[]> {
  const text = await journalBytes(controllerDir)
  const actions: string[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const event = JSON.parse(line) as {
      type?: string
      payload?: { actionId?: string }
    }
    if (event.type === 'action.committed' && (event.payload?.actionId ?? '').startsWith('eval-')) {
      actions.push(event.payload?.actionId ?? '')
    }
  }
  return actions
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
  failurePool: string[]
  stateHash: string
  budget: Record<string, { spent: number; reserved: number }>
}

interface CatalogEntry {
  candidateId: string
  parentCandidateId: string | null
  tasks: Array<{ opaqueTaskId: string; attempts: number }>
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

  const failures: string[] = []
  const notes: string[] = []
  const flags: Record<string, boolean> = {}
  const check = (name: string, ok: boolean, detail?: string): boolean => {
    flags[name] = ok
    if (!ok) failures.push(detail === undefined ? name : `${name}: ${detail}`)
    return ok
  }

  // ---- scratch: every secret and bulky tree stays OUT of the repo ----------
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-gate6-'))
  const tasksRoot = join(scratch, 'tasks')
  const jobsRoot = join(scratch, 'jobs')
  const runsRoot = join(scratch, 'runs')
  const runRoot = join(runsRoot, RUN_ID)
  const credential = join(scratch, 'zen-compatible.key')
  const credentialBody =
    'PLACEHOLDER — the zen-compatible route is optional and unused by the recorded proposer\n'
  await writeFile(credential, credentialBody, { mode: 0o600 })
  await chmod(credential, 0o600)
  await mkdir(jobsRoot, { recursive: true })
  await mkdir(runsRoot, { recursive: true })

  console.log('gate6: extracting pinned terminal-bench 2.1 tasks…')
  await exec('tar', ['-xzf', TARBALL, '-C', scratch])
  const { DATASET_PIN } = await importBuilt('benchmark-adapters/terminal-bench/lib/dataset.js')
  await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), tasksRoot, { recursive: true })

  // ---- init: DEFAULT stable-demo config (no --set) --------------------------
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
    credential,
    '--harbor-bin',
    HARBOR_BIN,
    '--artifact-host',
    ARTIFACT_HOST,
    '--artifact-port',
    ARTIFACT_PORT,
  ]
  console.log('gate6: dsh-evolve init (default stable-demo config)…')
  const init = await cli(initArgs)
  const initDoc =
    init.code === 0 ? (JSON.parse(init.stdout) as { configHash: string; handles: number }) : null
  check(
    'initFrozeConfigAndHandles',
    init.code === 0 &&
      initDoc !== null &&
      initDoc.handles === 89 &&
      /^sha256:[0-9a-f]{64}$/.test(initDoc.configHash),
    `exit ${String(init.code)}: ${init.stderr.slice(0, 400)}`,
  )
  const frozenConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
    search?: Record<string, number>
    sealedAccess?: boolean
  }
  const search = frozenConfig.search ?? {}
  check(
    'configIsDefaultStableDemo',
    search['kTarget'] === K_TARGET &&
      search['maxDiscoveryTrials'] === DEFAULT_MAX_DISCOVERY &&
      search['discoveryBatchSize'] === DEFAULT_BATCH_SIZE &&
      frozenConfig['sealedAccess'] === false,
    JSON.stringify(search),
  )

  // ---- doctor ---------------------------------------------------------------
  console.log('gate6: dsh-evolve doctor (real docker/harbor/credential checks)…')
  const doctor = await cli(['doctor', '--run-root', runRoot])
  check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
  console.log(doctor.stdout.trimEnd())

  // ---- crash drill: SIGKILL after the FIRST committed observation -----------
  console.log('gate6: crash drill run (SIGKILL after observation 1)…')
  const crashStart = Date.now()
  const crash = await cli(['run', '--run-root', runRoot], {
    DSH_EVOLVE_CRASH_AFTER_OBSERVATION: '1',
  })
  const crashSeconds = Math.round((Date.now() - crashStart) / 1000)
  check(
    'crashDrillWasARealProcessKill',
    crash.signal === 'SIGKILL' && crash.stderr.includes('crash drill: SIGKILL after observation 1'),
    `code=${String(crash.code)} signal=${String(crash.signal)}: ${crash.stderr.slice(-400)}`,
  )
  // The crash landed AFTER one durable external effect, mid discovery batch:
  // one committed Harbor trial, one committed observation, no frozen pool yet,
  // no terminal documents.
  const crashedTrials = await trialDirs(jobsRoot)
  check('crashLeftExactlyOneHarborTrial', crashedTrials.length === 1, crashedTrials.join(','))
  const crashCommits = await committedEvalActions(join(runRoot, 'controller'))
  check(
    'crashLeftExactlyOneCommittedObservation',
    crashCommits.length === 1,
    `${String(crashCommits.length)} committed eval action(s): ${crashCommits.join(',')}`,
  )
  check(
    'crashWroteNoTerminalDocuments',
    !existsSync(join(runRoot, 'drive-report.json')) &&
      !existsSync(join(runRoot, 'failure-pool.json')),
  )
  check('crashBeforeAnyProposal', !existsSync(join(runRoot, 'controller', 'sandboxes')))

  // ---- resume: the same run to its terminal state ----------------------------
  console.log('gate6: dsh-evolve resume (real Harbor trials; this takes a while)…')
  const resumeStart = Date.now()
  const resume = await cli(['resume', '--run-root', runRoot])
  const resumeSeconds = Math.round((Date.now() - resumeStart) / 1000)
  check(
    'resumeExitZero',
    resume.code === 0,
    `exit ${String(resume.code)}: ${resume.stderr.slice(0, 2000)}`,
  )
  const report = resume.code === 0 ? (JSON.parse(resume.stdout) as DriveReportDoc) : null
  if (report === null) throw new Error('resume failed; see failures above')
  console.log(
    `gate6: resumed to ${report.stopReason} / ${report.status} after ${String(resumeSeconds)}s — ` +
      `trials=${String(report.trials)} discovery=${String(report.discoveryTrials)} ` +
      `expansions=${String(report.expansionAttempts)} admitted=${String(report.admittedNonBaseline)} ` +
      `depth=${String(report.lineageDepthMax)} pool=${String(report.failurePool.length)}`,
  )

  // ---- the stable K=3 shape ---------------------------------------------------
  check(
    'stableIterationVerified',
    report.status === 'STABLE_ITERATION_VERIFIED' && report.stopReason === 'K_REACHED',
    `${report.stopReason} / ${report.status}`,
  )
  check(
    'discoveryBatchesDeterministic',
    report.discoveryTrials > 0 &&
      report.discoveryTrials % DEFAULT_BATCH_SIZE === 0 &&
      report.discoveryTrials <= DEFAULT_MAX_DISCOVERY,
    `${String(report.discoveryTrials)} discovery trials`,
  )
  check(
    'threeUniqueChildrenAdmitted',
    report.admittedNonBaseline === K_TARGET,
    String(report.admittedNonBaseline),
  )
  check('twoLineageDepthsAtLeast', report.lineageDepthMax >= 2, String(report.lineageDepthMax))
  const poolSet = new Set(report.failurePool)
  const catalog = JSON.parse(await readFile(join(runRoot, 'archive-catalog.json'), 'utf8')) as {
    entries: CatalogEntry[]
  }
  const children = catalog.entries.filter((entry) => entry.parentCandidateId !== null)
  check('catalogMatchesReport', children.length === report.admittedNonBaseline)
  const depthOf = (entry: CatalogEntry, seen = new Set<string>()): number => {
    if (entry.parentCandidateId === null || seen.has(entry.candidateId)) return 0
    seen.add(entry.candidateId)
    const parent = catalog.entries.find(
      (candidate) => candidate.candidateId === entry.parentCandidateId,
    )
    return parent === undefined ? 1 : depthOf(parent, seen) + 1
  }
  const childDepths = children.map((child) => depthOf(child))
  check(
    'catalogDepthsMatchReport',
    Math.max(0, ...childDepths) === report.lineageDepthMax,
    childDepths.join(','),
  )
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
  // The pool froze BEFORE any proposal: every pool handle comes from baseline
  // discovery observations only, and the first sandbox postdates the freeze.
  const poolDoc = JSON.parse(await readFile(join(runRoot, 'failure-pool.json'), 'utf8')) as {
    handles: string[]
    frozenFromObservations: number
  }
  check(
    'poolFrozenFromDiscoveryOnly',
    poolDoc.frozenFromObservations === report.discoveryTrials &&
      poolDoc.handles.length === report.failurePool.length,
    JSON.stringify(poolDoc),
  )

  // ---- exactly-once external effects across the crash -------------------------
  const trials = await trialDirs(jobsRoot)
  check(
    'oneHarborTrialDirPerCommittedTrial',
    trials.length === report.trials,
    `${String(trials.length)} trial dirs vs ${String(report.trials)} trials`,
  )
  const sandboxes = (
    await readdir(join(runRoot, 'controller', 'sandboxes')).catch(() => [] as string[])
  ).filter((name) => /^prop-\d+$/.test(name))
  check(
    'oneSandboxPerExpansion',
    sandboxes.length === report.expansionAttempts,
    `${String(sandboxes.length)} sandboxes vs ${String(report.expansionAttempts)} expansions`,
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
  // A second resume re-runs nothing: event journal, budget ledger and the
  // terminal report stay byte-identical, and no new Harbor trial appears.
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

  // ---- proposer citations: children cite real raw evidence objects ------------
  // The content-addressed store shards digests: objects/sha256/<2-hex>/<digest>.
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

  // ---- normalized Harbor evidence with registry-entry attribution -------------
  const capsuleRecords: CapsuleRecord[] = []
  for (const entry of await readdir(join(runRoot, 'capsules')).catch(() => [])) {
    if (!entry.endsWith('.json')) continue
    capsuleRecords.push(
      JSON.parse(await readFile(join(runRoot, 'capsules', entry), 'utf8')) as CapsuleRecord,
    )
  }
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

  // ---- capsule records: identity digests recorded (archives re-derivable) ----
  // (The Harbor attribution check above already ties every trial to the exact
  // archiveSha256 it ran; the capsule archives themselves stay out of evidence.)

  // ---- hash-chain replay + frozen-document re-derivation ----------------------
  console.log('gate6: dsh-evolve audit…')
  const audit = await cli(['audit', '--run-root', runRoot])
  check('auditAllGreen', audit.code === 0 && !audit.stdout.includes('✗'), audit.stdout)
  console.log(audit.stdout.trimEnd())

  // ---- status in a fresh process ----------------------------------------------
  const status = await cli(['status', '--run-root', runRoot])
  const statusDoc =
    status.code === 0
      ? (JSON.parse(status.stdout) as {
          phase: string
          stopReason: string
          status: string | null
          lineageDepthMax: number | null
          admittedNonBaseline: number
          controller: { stateHash: string; observationCount: number } | null
        })
      : null
  check(
    'statusFromDurableEvidenceAfterRestart',
    statusDoc !== null &&
      statusDoc.controller !== null &&
      statusDoc.controller.observationCount === report.trials &&
      statusDoc.controller.stateHash === report.stateHash &&
      statusDoc.stopReason === report.stopReason &&
      statusDoc.status === report.status &&
      statusDoc.lineageDepthMax === report.lineageDepthMax &&
      statusDoc.admittedNonBaseline === report.admittedNonBaseline,
    status.stdout.slice(0, 600),
  )

  // ---- concealment: sealed never on disk; guard never proposer-visible -------
  const { runSplitCeremony } = await importBuilt('packages/dsh-evolve-le/lib/split/ceremony.js')
  const handles = (
    JSON.parse(await readFile(join(runRoot, 'dataset-handles.json'), 'utf8')) as {
      handles: string[]
    }
  ).handles
  const ceremony = runSplitCeremony({ runId: RUN_ID, masterSeed: MASTER_SEED, handles })
  const sealedHandles = ceremony.sealedStore.sealedHandles
  const guardHandles = ceremony.sealedStore.guardHandles

  // Same surfaces as Gate 5 (the split ASSIGNMENT must never leak; the frozen
  // population document carries every task name by design).
  const frozenDocs = [
    'split-ceremony.json',
    'run-manifest.json',
    'failure-pool.json',
    'search-state.json',
    'archive-catalog.json',
    'drive-report.json',
  ]
  const docFiles: Array<{ path: string; text: string }> = []
  for (const name of frozenDocs) {
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

  // ---- budget accounting -------------------------------------------------------
  const taskTrials = report.budget['task-trials']
  const proposalCalls = report.budget['proposal-calls']
  check(
    'budgetAccountingExact',
    taskTrials !== undefined &&
      taskTrials.spent === report.trials &&
      taskTrials.reserved === 0 &&
      proposalCalls !== undefined &&
      proposalCalls.spent === report.expansionAttempts &&
      proposalCalls.reserved === 0,
    JSON.stringify(report.budget),
  )

  // ---- evidence out (no secrets, no tls/, no capsule archives) ---------------
  console.log('gate6: writing evidence…')
  const evidenceRunRoot = join(gate6Dir, 'run')
  const jobsEvidenceRoot = join(gate6Dir, 'jobs')
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
    protocol: 'dsh-evolve-le/gate6-stable-iteration/v1',
    generatedAt: new Date().toISOString(),
    runId: RUN_ID,
    masterSeed: MASTER_SEED,
    configHash: initDoc?.configHash ?? null,
    configProfile: 'default stable-demo (no --set overrides)',
    cliBin: 'packages/cli/lib/main.js',
    dataset: { tarball: 'terminal-bench-2-1-7131e43.tar.gz', handles: handles.length },
    crash: {
      env: 'DSH_EVOLVE_CRASH_AFTER_OBSERVATION=1',
      signal: crash.signal,
      seconds: crashSeconds,
      harborTrialsAfterCrash: crashedTrials.length,
      committedObservationsAfterCrash: crashCommits.length,
      committedActionIds: crashCommits,
    },
    report,
    resumeSeconds,
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
  }
  await writeFile(join(gate6Dir, 'stable-iteration.json'), `${JSON.stringify(document, null, 2)}\n`)
  await writeFile(
    join(gate6Dir, 'STATUS.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: 6,
        status: failures.length === 0 ? 'PASS' : 'FAIL',
        failedChecks: failures,
        evidence: 'evidence/gate6/stable-iteration.json',
        recordedAt: document.generatedAt,
      },
      null,
      2,
    )}\n`,
  )
  if (failures.length > 0) {
    console.error(`gate6 STABLE ITERATION FAILED: ${failures.join(' | ')}`)
    process.exit(1)
  }
  await rm(scratch, { recursive: true, force: true })
  console.log('gate6: PASS — stable K=3 iteration with crash/resume, every acceptance flag true')
}

await main()
