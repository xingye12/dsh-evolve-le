/**
 * Record the Gate 5 acceptance evidence (specs/07 §7): the productized
 * iteration closure behind ONE command — the real `dsh-evolve` CLI driving
 * propose → trusted build → real Cordis Loader capsule → REAL Harbor
 * evaluation on the pinned Terminal-Bench 2.1 dataset → normalization →
 * Archive commit — plus every Accept property around it:
 *
 *   1. preflight fails closed (invalid config, missing credential) BEFORE
 *      any run state exists or any paid launch happens;
 *   2. `run` completes the loop on the REAL provider and stops at a
 *      documented StopReason with real Harbor job dirs as per-trial evidence;
 *   3. every Harbor trial is attributed to the capsule archive it ran;
 *   4. `resume` re-runs nothing: journal bytes, ledger lines, Harbor trial
 *      directories and the drive report are all unchanged (no duplicate
 *      proposal, trial, score or cost);
 *   5. `status` in a fresh process reads only durable evidence;
 *   6. `audit` re-derives every frozen document;
 *   7. sealed identities never reach disk at all, and guard identities never
 *      reach the proposer-visible export, the controller journal, the stored
 *      candidate sources, or any frozen selection document;
 *   8. budget accounting is exact (trials and proposal calls settled, no
 *      dangling reservations).
 *
 * Machine-checkable document: evidence/gate5/cli-e2e.json (+ STATUS.json).
 * Fails closed (exit 1) on any acceptance violation. The run root, the
 * credential placeholder (0600) and the TLS key guarding the artifact
 * endpoint all live in scratch OUTSIDE the repository — none of them, and no
 * credential material, ever enters the evidence tree.
 *
 * Usage: node --import tsx/esm scripts/record-gate5-evidence.ts
 * @module scripts/record-gate5-evidence
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

const gate5Dir = resolve(repoRoot, 'evidence', 'gate5')
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const HARBOR_BIN = process.env['HARBOR_BIN'] ?? 'harbor'
const HARBOR_VERSION = '0.21.0'
const ARTIFACT_HOST = process.env['GATE5_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT = process.env['GATE5_ARTIFACT_PORT'] ?? '8443'
const RUN_ID = 'gate5-cli-e2e'
const MASTER_SEED = 'gate5-cli-e2e-master-seed'
/** Smallest REAL loop: 2 discovery trials → 1 expansion → K=1 (frozen config). */
const SEARCH_SETS = [
  'kTarget=1',
  'maxDiscoveryTrials=2',
  'discoveryBatchSize=2',
  'maxSolverTrials=4',
]
const DOCUMENTED_STOPS: ReadonlySet<string> = new Set([
  'K_REACHED',
  'TRIAL_CAP',
  'BUDGET_EXHAUSTED',
  'NO_ADMISSIBLE_CHILD',
  'NO_REAL_FAILURE_SIGNAL',
  'NO_ADMISSIBLE_TASK',
])

const importBuilt = (builtPath: string) => import(pathToFileURL(resolve(repoRoot, builtPath)).href)

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_BIN, ...args], {
      cwd: repoRoot,
      timeout: 3_300_000, // real Harbor trials include docker environment builds
      maxBuffer: 64 << 20,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message }
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

async function countTrialDirs(root: string): Promise<number> {
  let count = 0
  for (const job of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!job.isDirectory() || job.name.startsWith('.')) continue
    for (const trial of await readdir(join(root, job.name), { withFileTypes: true })) {
      if (trial.isDirectory() && existsSync(join(root, job.name, trial.name, 'result.json'))) {
        count += 1
      }
    }
  }
  return count
}

async function journalBytes(controllerDir: string): Promise<string> {
  const names = ((await readdir(controllerDir).catch(() => [])) as string[]).filter((name) =>
    name.endsWith('.jsonl'),
  )
  names.sort()
  let all = ''
  for (const name of names) all += await readFile(join(controllerDir, name), 'utf8')
  return all
}

interface DriveReportDoc {
  stopReason: string
  phase: string
  trials: number
  discoveryTrials: number
  admittedNonBaseline: number
  expansionAttempts: number
  failurePool: string[]
  stateHash: string
  budget: Record<string, { spent: number; reserved: number }>
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
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-gate5-'))
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

  console.log('gate5: extracting pinned terminal-bench 2.1 tasks…')
  await exec('tar', ['-xzf', TARBALL, '-C', scratch])
  const { DATASET_PIN } = await importBuilt('benchmark-adapters/terminal-bench/lib/dataset.js')
  await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), tasksRoot, { recursive: true })

  // ---- init ----------------------------------------------------------------
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
    ...SEARCH_SETS.flatMap((setArg) => ['--set', setArg]),
  ]
  console.log('gate5: dsh-evolve init…')
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
  const secondInit = await cli(initArgs)
  check(
    'initRefusesOverwrite',
    secondInit.code === 2 && secondInit.stderr.includes('already exists'),
  )

  // ---- doctor ---------------------------------------------------------------
  console.log('gate5: dsh-evolve doctor (real docker/harbor/credential checks)…')
  const doctor = await cli(['doctor', '--run-root', runRoot])
  check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
  console.log(doctor.stdout.trimEnd())

  // ---- fail-closed probes BEFORE any paid launch ----------------------------
  console.log('gate5: fail-closed probes…')
  const brokenRoot = join(runsRoot, 'gate5-broken-credential')
  await mkdir(brokenRoot, { recursive: true })
  await cp(join(runRoot, 'run.config.json'), join(brokenRoot, 'run.config.json'))
  await cp(join(runRoot, 'dataset-handles.json'), join(brokenRoot, 'dataset-handles.json'))
  await rm(credential, { force: true })
  const brokenDoctor = await cli(['doctor', '--run-root', brokenRoot])
  check(
    'doctorReportsMissingCredential',
    brokenDoctor.code === 1 && brokenDoctor.stdout.includes('✗ credential:'),
    brokenDoctor.stdout,
  )
  const brokenRun = await cli(['run', '--run-root', brokenRoot])
  check(
    'runFailsClosedOnMissingCredential',
    brokenRun.code === 2 && brokenRun.stderr.includes('preflight failed'),
    `exit ${String(brokenRun.code)}`,
  )
  check(
    'noRunStateCreatedOnPreflightFailure',
    !existsSync(join(brokenRoot, 'controller')) &&
      !existsSync(join(brokenRoot, 'run-manifest.json')),
  )
  await writeFile(credential, credentialBody, { mode: 0o600 })
  await chmod(credential, 0o600)

  const invalidRoot = join(runsRoot, 'gate5-invalid-config')
  await mkdir(invalidRoot, { recursive: true })
  const tampered = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as Record<
    string,
    unknown
  >
  tampered['sealedAccess'] = true
  await writeFile(join(invalidRoot, 'run.config.json'), `${JSON.stringify(tampered, null, 2)}\n`)
  await cp(join(runRoot, 'dataset-handles.json'), join(invalidRoot, 'dataset-handles.json'))
  const invalidRun = await cli(['run', '--run-root', invalidRoot])
  check(
    'runFailsClosedOnInvalidConfig',
    invalidRun.code === 2 && invalidRun.stderr.includes('sealedAccess'),
    `exit ${String(invalidRun.code)}`,
  )
  check(
    'noRunStateCreatedOnInvalidConfig',
    !existsSync(join(invalidRoot, 'controller')) &&
      !existsSync(join(invalidRoot, 'run-manifest.json')),
  )
  check('failClosedBeforeAnyHarborJob', (await countTrialDirs(jobsRoot)) === 0)

  // ---- run: the real loop ----------------------------------------------------
  console.log('gate5: dsh-evolve run (real Harbor trials; this takes a while)…')
  const runStart = Date.now()
  const run = await cli(['run', '--run-root', runRoot])
  const runSeconds = Math.round((Date.now() - runStart) / 1000)
  check('runExitZero', run.code === 0, `exit ${String(run.code)}: ${run.stderr.slice(0, 2000)}`)
  const report = run.code === 0 ? (JSON.parse(run.stdout) as DriveReportDoc) : null
  if (report === null) throw new Error('run failed; see failures above')
  console.log(
    `gate5: run stopped at ${report.stopReason} after ${String(runSeconds)}s — ` +
      `trials=${String(report.trials)} expansions=${String(report.expansionAttempts)} ` +
      `admitted=${String(report.admittedNonBaseline)} pool=${String(report.failurePool.length)}`,
  )
  check('stopReasonDocumented', DOCUMENTED_STOPS.has(report.stopReason), report.stopReason)
  if (report.stopReason !== 'K_REACHED') {
    notes.push(`stop reason was ${report.stopReason}, not K_REACHED (recorded honestly)`)
  }

  const sandboxes = await readdir(join(runRoot, 'controller', 'sandboxes')).catch(
    () => [] as string[],
  )
  check(
    'proposalRanInRealOneShotSandbox',
    report.expansionAttempts >= 1 && sandboxes.some((name) => name.startsWith('prop-')),
    `${String(sandboxes.length)} sandbox dir(s)`,
  )
  const trialDirs = await countTrialDirs(jobsRoot)
  check(
    'harborTrialsReal',
    trialDirs >= report.discoveryTrials && report.trials >= 1,
    `${String(trialDirs)} trial dir(s)`,
  )
  check(
    'archiveCommitted',
    report.admittedNonBaseline >= 1 && existsSync(join(runRoot, 'archive-catalog.json')),
  )

  // ---- attribution: every Harbor trial names the capsule archive it ran -----
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
    'trialsAttributedToCapsuleArchive',
    attributed > 0 && unattributed.length === 0,
    unattributed.join(',').slice(0, 300),
  )

  // ---- resume: duplicates nothing -------------------------------------------
  const journalBefore = await journalBytes(join(runRoot, 'controller'))
  const ledgerBefore = (
    await readFile(join(runRoot, 'harbor-ledger.jsonl'), 'utf8').catch(() => '')
  ).trim()
  const reportBefore = await readFile(join(runRoot, 'drive-report.json'), 'utf8')
  console.log('gate5: dsh-evolve resume (must re-run nothing)…')
  const resume = await cli(['run', '--run-root', runRoot])
  check('resumeExitZero', resume.code === 0, resume.stderr.slice(0, 1000))
  check(
    'resumeJournalByteIdentical',
    (await journalBytes(join(runRoot, 'controller'))) === journalBefore,
  )
  check(
    'resumeLedgerUnchanged',
    (await readFile(join(runRoot, 'harbor-ledger.jsonl'), 'utf8')).trim() === ledgerBefore,
  )
  check('resumeNoNewHarborTrial', (await countTrialDirs(jobsRoot)) === trialDirs)
  check(
    'resumeReportIdentical',
    (await readFile(join(runRoot, 'drive-report.json'), 'utf8')) === reportBefore,
  )

  // ---- status in a fresh process ---------------------------------------------
  console.log('gate5: dsh-evolve status (fresh process, durable evidence only)…')
  const status = await cli(['status', '--run-root', runRoot])
  const statusDoc =
    status.code === 0
      ? (JSON.parse(status.stdout) as {
          phase: string
          stopReason: string
          trials: number
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
      statusDoc.admittedNonBaseline === report.admittedNonBaseline,
    status.stdout.slice(0, 600),
  )

  // ---- audit ------------------------------------------------------------------
  console.log('gate5: dsh-evolve audit…')
  const audit = await cli(['audit', '--run-root', runRoot])
  check('auditAllGreen', audit.code === 0 && !audit.stdout.includes('✗'), audit.stdout)
  console.log(audit.stdout.trimEnd())

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

  // Concealment targets the SPLIT ASSIGNMENT, not population membership:
  // `dataset-handles.json` is the frozen 89-handle population the ceremony
  // derives from (and `audit` re-derives against) — every task NAME is in it
  // by design. What must never reach disk outside the sealed store is the
  // assignment: which names are sealed/guard. Scanned surfaces:
  // - the frozen loop documents (ceremony carries observed + OPAQUE guard ids
  //   + sealedCount only), the proposer-visible exports, the controller
  //   journal/candidates/sandboxes, and the object store → sealed AND guard
  //   identities forbidden;
  // - the Harbor jobs root → sealed identities forbidden outright (a sealed
  //   handle in a job dir would mean a sealed trial ran — the cardinal sin);
  //   guard identities would be legal there (TCB), so they are not asserted.
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
  const leaksIn = (files: Array<{ path: string; text: string }>, handles: readonly string[]) =>
    files.filter((file) => handles.some((handle) => file.text.includes(handle)))
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
  // The population document itself must carry exactly the dataset population
  // (no extra "hint" handles, none missing) — anchored to the tasks root, the
  // same enumeration `init` froze.
  const populationDoc = JSON.parse(
    await readFile(join(runRoot, 'dataset-handles.json'), 'utf8'),
  ) as { handles: string[] }
  const enumerated: string[] = []
  for (const entry of await readdir(tasksRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(tasksRoot, entry.name, 'task.toml'))) {
      enumerated.push(entry.name)
    }
  }
  check(
    'populationDocCarriesNoAssignment',
    [...populationDoc.handles].sort().join('\u{0}') === [...enumerated].sort().join('\u{0}'),
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
  console.log('gate5: writing evidence…')
  const evidenceRunRoot = join(gate5Dir, 'run')
  const jobsEvidenceRoot = join(gate5Dir, 'jobs')
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
  // Controller journal + candidate store + proposal sandboxes: durable state.
  await cp(join(runRoot, 'controller'), join(evidenceRunRoot, 'controller'), {
    recursive: true,
  }).catch(() => undefined)
  // Proposer-visible evidence exports, the content-addressed store, plans.
  for (const name of ['exports', 'objects', 'harbor-plans']) {
    await cp(join(runRoot, name), join(evidenceRunRoot, name), { recursive: true }).catch(
      () => undefined,
    )
  }
  // Capsule RECORDS (identity + digests); the archives themselves stay out —
  // they are content-addressed and re-derivable from the pinned source.
  for (const record of capsuleRecords) {
    const name = `${record.candidateId}.json`
    await cp(join(runRoot, 'capsules', name), join(evidenceRunRoot, 'capsules', name)).catch(
      () => undefined,
    )
  }
  // Raw Harbor job directories are the per-trial evidence (gate2 precedent).
  for (const job of await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!job.isDirectory() || job.name.startsWith('.')) continue
    await cp(join(jobsRoot, job.name), join(jobsEvidenceRoot, job.name), { recursive: true })
  }

  const document = {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/gate5-cli-e2e/v1',
    generatedAt: new Date().toISOString(),
    runId: RUN_ID,
    masterSeed: MASTER_SEED,
    configHash: initDoc?.configHash ?? null,
    searchSets: SEARCH_SETS,
    cliBin: 'packages/cli/lib/main.js',
    dataset: { tarball: 'terminal-bench-2-1-7131e43.tar.gz', handles: handles.length },
    report,
    runSeconds,
    capsules: capsuleRecords,
    harborTrialDirs: trialDirs,
    attributedTrials: attributed,
    ledgerLines: ledgerBefore === '' ? 0 : ledgerBefore.split('\n').length,
    sealedCount: sealedHandles.length,
    guardCount: guardHandles.length,
    flags,
    notes,
  }
  await writeFile(join(gate5Dir, 'cli-e2e.json'), `${JSON.stringify(document, null, 2)}\n`)
  await writeFile(
    join(gate5Dir, 'STATUS.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: 5,
        status: failures.length === 0 ? 'PASS' : 'FAIL',
        failedChecks: failures,
        evidence: 'evidence/gate5/cli-e2e.json',
        recordedAt: document.generatedAt,
      },
      null,
      2,
    )}\n`,
  )
  if (failures.length > 0) {
    console.error(`gate5 CLI E2E FAILED: ${failures.join(' | ')}`)
    process.exit(1)
  }
  await rm(scratch, { recursive: true, force: true })
  console.log('gate5: PASS — closed loop behind one command, every acceptance flag true')
}

await main()
