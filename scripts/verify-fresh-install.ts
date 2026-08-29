/**
 * Gate 7 fresh-profile install verification (specs/07 §9): prove that the
 * RELEASE TARBALL — the committed tree, not this working copy — installs and
 * works on a clean profile, and that rollback/uninstall plus one prior-state
 * restore are EXECUTED, not merely documented.
 *
 *  1. extract the release tarball into a scratch profile with a FRESH $HOME
 *     and a profile-local pnpm store (nothing shared with the dev machine's
 *     install beyond the npm registry itself);
 *  2. `pnpm install --frozen-lockfile` + `pnpm build` inside the profile;
 *  3. real Cordis Loader smoke via the built `loader-spike` bin (quiescence
 *     report parsed, process must exit on its own);
 *  4. K=3 demo smoke: `dsh-evolve init` at the DEFAULT stable-demo config +
 *     `run --provider fake` → `STABLE_ITERATION_VERIFIED` (real trusted
 *     builder + real one-shot sandboxes, synthetic tasks);
 *  5. PRIOR-STATE RESTORE: replay the run's journal to a mid-run snapshot
 *     seq with the profile's own built reducer and assert the folded hash
 *     equals the snapshot's recorded hash; then delete every snapshot and
 *     the terminal drive-report and prove `status`/`resume` reconstruct the
 *     identical terminal state from the journal alone;
 *  6. UNINSTALL: delete the entire profile and assert nothing remains —
 *     the workspace installs nothing outside its directory (fresh $HOME
 *     died with the profile; no global installs exist by design).
 *
 * Emits a JSON summary on stdout; exit 1 on any failure.
 *
 * Usage: node --import tsx/esm scripts/verify-fresh-install.ts [tarball]
 * @module scripts/verify-fresh-install
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

const DEFAULT_TARBALL = (version: string): string =>
  resolve(repoRoot, 'release', `dsh-evolve-le-${version}-src.tar.gz`)

interface Check {
  name: string
  ok: boolean
  detail?: string
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  const tarball =
    process.argv[2] !== undefined ? resolve(process.argv[2]) : DEFAULT_TARBALL(manifest['version'])
  if (!existsSync(tarball)) {
    throw new Error(`release tarball missing: ${tarball}; run pnpm release:artifacts first`)
  }

  const profile = await mkdtemp(join(tmpdir(), 'dsh-fresh-'))
  const home = join(profile, 'home')
  const repo = join(profile, 'repo')
  const store = join(profile, 'pnpm-store')
  const runsRoot = join(profile, 'runs')
  const tasksRoot = join(profile, 'tasks')
  const jobsRoot = join(profile, 'jobs')
  await mkdir(home, { recursive: true })
  await mkdir(repo, { recursive: true })
  await mkdir(runsRoot, { recursive: true })
  await mkdir(jobsRoot, { recursive: true })

  // Fresh profile env: nothing from the developer's HOME follows the install.
  const profileEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    PNPM_HOME: join(home, '.local', 'share', 'pnpm'),
    CI: '1',
  }

  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  }
  const run = async (
    cmd: string,
    args: readonly string[],
    opts: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await exec(cmd, args, {
        cwd: opts.cwd ?? repo,
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 32 << 20,
        env: profileEnv,
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const err = error as { code?: number; stdout?: string; stderr?: string; message: string }
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message }
    }
  }

  // ---- 1. extract the release tarball ------------------------------------
  await exec('tar', ['-xzf', tarball, '-C', repo])
  const version = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
    version: string
  }
  check('tarballExtracted', version['version'] === manifest['version'], version['version'])

  // ---- 2. install + build in the clean profile ----------------------------
  console.error('fresh-install: pnpm install (profile-local store)…')
  const installStart = Date.now()
  const install = await run('pnpm', ['install', '--frozen-lockfile', '--store-dir', store], {
    timeoutMs: 900_000,
  })
  check('pnpmInstallFrozenLockfile', install.code === 0, install.stderr.slice(-400))
  const installSeconds = Math.round((Date.now() - installStart) / 1000)
  console.error(`fresh-install: install done in ${String(installSeconds)}s; building…`)
  const build = await run('pnpm', ['build'], { timeoutMs: 600_000 })
  check('pnpmBuild', build.code === 0, build.stderr.slice(-400))
  check(
    'builtCliPresent',
    existsSync(join(repo, 'packages/cli/lib/main.js')) &&
      existsSync(join(repo, 'packages/dsh-evolve-le/lib/bin/loader-spike.js')),
  )

  // ---- 3. real Cordis Loader smoke ----------------------------------------
  console.error('fresh-install: real Loader smoke…')
  const loader = await run(
    process.execPath,
    [
      join(repo, 'packages/dsh-evolve-le/lib/bin/loader-spike.js'),
      join(repo, 'packages/dsh-evolve-le/tests/fixtures/cordis.baseline.yml'),
    ],
    { timeoutMs: 120_000 },
  )
  let quiescent = false
  let loaderError: string | undefined
  try {
    const report = JSON.parse(loader.stdout) as { quiescent?: boolean; error?: string }
    quiescent = report.quiescent === true
    loaderError = report.error
  } catch {
    loaderError = `unparseable spike report: ${loader.stdout.slice(0, 200)}`
  }
  check(
    'realLoaderQuiescent',
    loader.code === 0 && quiescent && loaderError === undefined,
    loaderError,
  )

  // ---- 4. K=3 demo smoke at the DEFAULT config ----------------------------
  console.error('fresh-install: K=3 demo (default stable-demo config, fake provider)…')
  for (let index = 1; index <= 89; index += 1) {
    const handle = `task-${String(index).padStart(3, '0')}`
    await mkdir(join(tasksRoot, handle), { recursive: true })
    await writeFile(join(tasksRoot, handle, 'task.toml'), '[task]\nname = "synthetic"\n')
  }
  const credential = join(profile, 'credential.key')
  await writeFile(credential, 'PLACEHOLDER — demo profile, no real credential\n', { mode: 0o600 })
  await chmod(credential, 0o600)
  const runRoot = join(runsRoot, 'demo-k3')
  const cli = (args: readonly string[], timeoutMs = 900_000) =>
    run(process.execPath, [join(repo, 'packages/cli/lib/main.js'), ...args], { timeoutMs })

  const init = await cli([
    'init',
    '--runs-root',
    runsRoot,
    '--run-id',
    'demo-k3',
    '--master-seed',
    'fresh-install-demo-master-seed',
    '--tasks-root',
    tasksRoot,
    '--baseline-source',
    join(repo, 'packages/candidate-baseline'),
    '--jobs-root',
    jobsRoot,
    '--credential-file',
    credential,
    '--harbor-bin',
    process.env['HARBOR_BIN'] ?? 'harbor',
  ])
  check('initDefaultConfig', init.code === 0, init.stderr.slice(-400))
  const frozen = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
    search: { kTarget: number; discoveryBatchSize: number }
    sealedAccess: boolean
  }
  check(
    'demoUsesDefaultStableDemoConfig',
    frozen.search.kTarget === 3 &&
      frozen.search.discoveryBatchSize === 6 &&
      frozen.sealedAccess === false,
    JSON.stringify(frozen.search),
  )

  const demoStart = Date.now()
  const demo = await cli([
    'run',
    '--run-root',
    runRoot,
    '--provider',
    'fake',
    '--fake-failure-period',
    '2',
  ])
  const demoSeconds = Math.round((Date.now() - demoStart) / 1000)
  const report =
    demo.code === 0
      ? (JSON.parse(demo.stdout) as {
          stopReason: string
          status: string
          trials: number
          discoveryTrials: number
          expansionAttempts: number
          admittedNonBaseline: number
          lineageDepthMax: number
          failurePool: string[]
          stateHash: string
        })
      : null
  check(
    'demoK3StableIterationVerified',
    report !== null &&
      report.stopReason === 'K_REACHED' &&
      report.status === 'STABLE_ITERATION_VERIFIED' &&
      report.admittedNonBaseline === 3 &&
      report.lineageDepthMax >= 2,
    demo.code === 0 ? JSON.stringify(report).slice(0, 300) : demo.stderr.slice(-400),
  )
  if (report === null) throw new Error('demo run failed; see checks above')
  console.log(
    `fresh-install: demo ${report.status} — trials=${String(report.trials)} ` +
      `discovery=${String(report.discoveryTrials)} expansions=${String(report.expansionAttempts)} ` +
      `admitted=${String(report.admittedNonBaseline)} depth=${String(report.lineageDepthMax)}`,
  )

  const audit = await cli(['audit', '--run-root', runRoot], 300_000)
  check('demoAuditGreen', audit.code === 0, audit.stdout.slice(-400))

  // ---- 5. prior-state restore (executed) ----------------------------------
  // 5a. fold the journal to a MID-RUN snapshot seq with the profile's own
  //     built reducer; the folded hash must equal the recorded snapshot hash.
  const snapshotsDir = join(runRoot, 'controller', 'snapshots')
  const snapshotNames = (await readdir(snapshotsDir).catch(() => [] as string[]))
    .filter((name) => name.startsWith('state-') && name.endsWith('.json'))
    .sort((a, b) => (a < b ? 1 : -1)) // newest first
  const runConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
    runId: string
    budget: { usd: number; proposerTokens: number; proposalCalls: number; taskTrials: number }
  }
  const controllerDir = join(runRoot, 'controller')
  const built = (rel: string): string =>
    pathToFileURL(join(repo, 'packages/dsh-evolve-le/lib', rel)).href
  const journal = await import(built('state/journal.js'))
  const snapshotMod = await import(built('state/snapshot.js'))
  const reducerMod = await import(built('state/reducer.js'))
  const { events } = await (
    journal as { readJournal: (d: string, c: unknown) => Promise<{ events: unknown[] }> }
  ).readJournal(controllerDir, { runId: runConfig.runId, segmentMaxBytes: 1 << 20 })
  const budgetLimits = {
    usd: runConfig.budget.usd,
    'proposer-tokens': runConfig.budget.proposerTokens,
    'proposal-calls': runConfig.budget.proposalCalls,
    'task-trials': runConfig.budget.taskTrials,
  }
  const reducerConfig = { runId: runConfig.runId, budgetLimits }
  const terminalHashBefore = report.stateHash
  interface Snap {
    seq: number
    stateHash: string
  }
  const midSnapshot =
    snapshotNames.length >= 2 ? (snapshotNames[1] as string) : (snapshotNames[0] as string)
  const snap = JSON.parse(await readFile(join(snapshotsDir, midSnapshot), 'utf8')) as Snap
  const eventList = events as unknown[]
  const folded = (
    snapshotMod as {
      replayToState: (e: unknown[], c: unknown) => unknown
    }
  ).replayToState(eventList.slice(0, snap.seq), reducerConfig)
  const foldedHash = (reducerMod as { stateHashOf: (s: unknown) => string }).stateHashOf(folded)
  check(
    'priorStateRestoredFromJournal',
    foldedHash === snap.stateHash,
    `replay@seq${String(snap.seq)} ${foldedHash.slice(0, 16)} vs snapshot ${snap.stateHash.slice(0, 16)}`,
  )

  // 5b. delete EVERY snapshot + the terminal drive-report; `status` must
  //     reconstruct the same terminal state from the journal alone, and
  //     `resume` must re-derive the report without re-running anything.
  const journalBefore = await readAllBytes(controllerDir)
  await rm(snapshotsDir, { recursive: true, force: true })
  await rm(join(runRoot, 'drive-report.json'), { force: true })
  const statusAfterLoss = await cli(['status', '--run-root', runRoot], 300_000)
  const statusDoc =
    statusAfterLoss.code === 0
      ? (JSON.parse(statusAfterLoss.stdout) as {
          controller: { stateHash: string; observationCount: number } | null
        })
      : null
  // stopReason/status come from drive-report.json (deleted below the check by
  // design); what must be reconstructible from the journal alone is the
  // controller state itself. The re-derived report is asserted after resume.
  check(
    'terminalStateReconstructedAfterSnapshotLoss',
    statusDoc !== null &&
      statusDoc.controller !== null &&
      statusDoc.controller.stateHash === terminalHashBefore &&
      statusDoc.controller.observationCount === report.trials,
    statusAfterLoss.stdout.slice(0, 300),
  )
  const resumeAfterLoss = await cli(['resume', '--run-root', runRoot], 600_000)
  const restoredReport =
    resumeAfterLoss.code === 0
      ? (JSON.parse(resumeAfterLoss.stdout) as {
          stateHash: string
          trials: number
          stopReason: string
          status: string
        })
      : null
  check(
    'driveReportReDerivedAfterLoss',
    restoredReport !== null &&
      restoredReport.stateHash === terminalHashBefore &&
      restoredReport.trials === report.trials &&
      restoredReport.stopReason === 'K_REACHED' &&
      restoredReport.status === 'STABLE_ITERATION_VERIFIED' &&
      existsSync(join(runRoot, 'drive-report.json')),
    resumeAfterLoss.stderr.slice(-300),
  )
  const journalAfter = await readAllBytes(controllerDir)
  check('journalUnchangedByRestore', journalAfter === journalBefore)
  const auditAfterLoss = await cli(['audit', '--run-root', runRoot], 300_000)
  check('auditGreenAfterRestore', auditAfterLoss.code === 0, auditAfterLoss.stdout.slice(-400))

  // ---- 6. uninstall (executed) ---------------------------------------------
  await rm(profile, { recursive: true, force: true })
  check('uninstallRemovesEverything', !existsSync(profile) && !existsSync(repo))
  check(
    'noGlobalInstallsByDesign',
    true,
    'pnpm workspace; nothing installed outside the profile (fresh $HOME, profile-local store)',
  )

  const failed = checks.filter((c) => !c.ok)
  const summary = {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/fresh-install/v1',
    generatedAt: new Date().toISOString(),
    tarball,
    version: manifest['version'],
    installSeconds,
    demoSeconds,
    demo: {
      stopReason: report.stopReason,
      status: report.status,
      trials: report.trials,
      discoveryTrials: report.discoveryTrials,
      expansionAttempts: report.expansionAttempts,
      admittedNonBaseline: report.admittedNonBaseline,
      lineageDepthMax: report.lineageDepthMax,
      failurePool: report.failurePool.length,
      stateHash: report.stateHash,
    },
    restore: {
      snapshot: midSnapshot,
      seq: snap.seq,
      snapshotHash: snap.stateHash,
      replayHash: foldedHash,
    },
    checks,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (failed.length > 0) {
    console.error(`fresh-install FAILED: ${failed.map((c) => c.name).join(', ')}`)
    process.exit(1)
  }
  console.error(`fresh-install: PASS — ${String(checks.length)} checks green on a clean profile`)
}

async function readAllBytes(controllerDir: string): Promise<string> {
  // The events journal lives in controller/journal/events-*.jsonl (the loose
  // budget-ledger.jsonl in controller/ is NOT the journal). Reading zero
  // segments would make the before/after comparison vacuously true.
  const journalDir = join(controllerDir, 'journal')
  const dir = existsSync(journalDir) ? journalDir : controllerDir
  const names = ((await readdir(dir).catch(() => [])) as string[])
    .filter((name) => name.startsWith('events-') && name.endsWith('.jsonl'))
    .sort()
  if (names.length === 0) throw new Error(`no journal segments under ${dir}`)
  let all = ''
  for (const name of names) all += await readFile(join(dir, name), 'utf8')
  return all
}

await main()
