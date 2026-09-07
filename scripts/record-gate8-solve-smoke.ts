/**
 * Record the Gate 8 LIVE-SOLVE smoke (ADR-030, specs/07 §10, specs/05 §7): one
 * Terminal-Bench trial whose solver layer is a REAL networked model — the
 * recorded-replay capsule defect this changeset exists to fix. The trial runs
 * the full production path: real CLI init → run (real capsule build, real
 * Harbor job, real docker container) with the solve gateway open on the
 * artifact listener, a per-trial token bind-mounted read-only, and the
 * receipt-verified chain settling `budget.solver-tokens`.
 *
 * This is a PAID smoke: it talks to the real model endpoint. It refuses to
 * start without an explicit confirmation env var, and it fails closed
 * (exit 1) on any violation — including any evidence artifact that contains
 * the credential or the trial token (CLAUDE.md rule 8).
 *
 * Cost bound: the config space forces `discovery(1) + K·q0(1) ≤ maxSolverTrials
 * ≤ taskTrials`, so the minimal valid shape funds at most TWO paid trials —
 * the baseline discovery trial, plus (only if it fails honestly) the first
 * child's q0 cold-start, which also proves a REBUILT child capsule solves
 * live. Each trial is independently capped by the gateway's frozen stop
 * (48 requests / 2M tokens / $0.30): worst case $0.60, realistically ≪.
 *
 * Environment:
 *   DSH_GATE8_SOLVE_SMOKE  must be exactly `confirm` (the paid-run gate)
 *   DSH_GATE8_CREDENTIAL   path to the 0600 credential file
 *                          (default /root/.config/dsh-evolve-le/zen-compatible.key)
 *   DSH_GATE8_BASE_URL     OpenAI-compatible base URL
 *   DSH_GATE8_MODEL        exact model id
 *   GATE8_ARTIFACT_HOST/PORT  docker-bridge listener the containers reach
 *                          (defaults 172.17.0.1 / 8443, as in the pilot)
 * The credential content is read by the CLI into memory only and never
 * appears in any document, log, receipt, or artifact.
 *
 * Usage: node --import tsx/esm scripts/record-gate8-solve-smoke.ts
 * @module scripts/record-gate8-solve-smoke
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

const smokeDir = resolve(repoRoot, 'evidence/gate8/solve-smoke')
const CLI_BIN = resolve(repoRoot, 'packages/cli/lib/main.js')
const TARBALL = resolve(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const HARBOR_BIN = process.env['HARBOR_BIN'] ?? 'harbor'
const ARTIFACT_HOST = process.env['GATE8_ARTIFACT_HOST'] ?? '172.17.0.1'
const ARTIFACT_PORT = process.env['GATE8_ARTIFACT_PORT'] ?? '8443'
const RUN_ID = 'gate8-solve-smoke'
const MASTER_SEED = 'gate8-solve-smoke-master-seed-1'
// One task each: the discovery batch is 1, and at most one child q0
// cold-start can be funded. Validation forces discovery + K·q0 ≤
// maxSolverTrials ≤ taskTrials, so 2/2/2 is the minimal funded shape.
const TASK_TRIALS = 2
const MAX_SOLVER_TRIALS = 2
// The run-level stops, strictly above the gateway's per-trial cap so they
// can never false-trip a dispatch (estimate = floor(limit / taskTrials)).
const SOLVER_TOKENS = 2_000_000
const USD_MICROS = 1_000_000 // $1 ceiling; two trials are expected ≪ $0.10

const credentialPath =
  process.env['DSH_GATE8_CREDENTIAL'] ?? '/root/.config/dsh-evolve-le/zen-compatible.key'
const baseUrl = process.env['DSH_GATE8_BASE_URL'] ?? 'http://one-api.wattman.cn:805/v1'
const modelName = process.env['DSH_GATE8_MODEL'] ?? 'deepseek-v4-flash'

// --- 0. The paid-run gate -----------------------------------------------------
if (process.env['DSH_GATE8_SOLVE_SMOKE'] !== 'confirm') {
  console.error(
    'gate8 solve-smoke: this script spends real money at the live model endpoint.\n' +
      'Set DSH_GATE8_SOLVE_SMOKE=confirm to acknowledge, then re-run.',
  )
  process.exit(1)
}
if (!existsSync(TARBALL)) {
  throw new Error(`pinned tarball missing at ${TARBALL}; run \`pnpm setup:source\` first`)
}
if (!existsSync(CLI_BIN)) {
  throw new Error(`built CLI missing at ${CLI_BIN}; run \`pnpm -s build\` from the repo root first`)
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
  console.error(`gate8 solve-smoke FAILED: credential ${credentialPath} missing`)
  process.exit(1)
}
if ((credentialInfo!.mode & 0o077) !== 0) {
  console.error(
    `gate8 solve-smoke FAILED: credential ${credentialPath} mode ${credentialInfo!.mode.toString(8)} is not owner-only`,
  )
  process.exit(1)
}
const credential = (await readFile(credentialPath, 'utf8')).trim()
if (credential.length === 0) {
  console.error(`gate8 solve-smoke FAILED: credential ${credentialPath} is empty`)
  process.exit(1)
}

// --- 2. Scratch OUTSIDE the repo; the pinned task set --------------------------
// The run root carries solve-gateway/tokens/ (0600 per-trial secrets): it is
// state, never evidence, so the whole tree lives in scratch and only
// sanitized copies land under evidence/.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-gate8-solve-smoke-'))
const runsRoot = resolve(scratch, 'runs')
const jobsRoot = resolve(scratch, 'jobs')
const runRoot = join(runsRoot, RUN_ID)
console.log('gate8 solve-smoke: extracting pinned terminal-bench 2.1 tasks…')
await exec('tar', ['-xzf', TARBALL, '-C', scratch])
const { DATASET_PIN } = await import(
  pathToFileURL(resolve(repoRoot, 'benchmark-adapters/terminal-bench/lib/dataset.js')).href
)
await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), join(scratch, 'tasks'), {
  recursive: true,
})

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

async function cli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI_BIN, ...args], {
      cwd: repoRoot,
      // Up to two live trials: container boot (~7 min observed) + agent wall
      // clock (≤30 min each) + verify. 2 h covers the funded shape plus
      // crash-resume headroom without an overnight window.
      timeout: 7_200_000,
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

// --- 3. init: solver route live, proposer stays recorded (free) ----------------
console.log(`gate8 solve-smoke: dsh-evolve init (solver route → ${modelName})…`)
const init = await cli([
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
  '--harbor-bin',
  HARBOR_BIN,
  '--artifact-host',
  ARTIFACT_HOST,
  '--artifact-port',
  ARTIFACT_PORT,
  '--solver-route',
  'deepseek/zen-compatible',
  '--solver-base-url',
  baseUrl,
  '--solver-model',
  modelName,
  '--solver-temperature',
  '0',
  '--solver-tokens',
  String(SOLVER_TOKENS),
  '--set',
  `taskTrials=${String(TASK_TRIALS)}`,
  '--set',
  'kTarget=1',
  '--set',
  'maxDiscoveryTrials=1',
  '--set',
  'discoveryBatchSize=1',
  '--set',
  `maxSolverTrials=${String(MAX_SOLVER_TRIALS)}`,
  '--set',
  `usd=${String(USD_MICROS)}`,
  '--set',
  'wallClockMinutes=120',
])
if (init.code !== 0) {
  console.error(`gate8 solve-smoke FAILED: init exited ${String(init.code)}`)
  console.error(init.stderr.slice(0, 4000))
  process.exit(1)
}
const initDoc = JSON.parse(init.stdout) as { configHash: string; handles: number }
check(
  'initFrozeAll89Handles',
  initDoc.handles === 89 && /^sha256:[0-9a-f]{64}$/.test(initDoc.configHash),
  JSON.stringify(initDoc),
)
const frozenConfig = JSON.parse(await readFile(join(runRoot, 'run.config.json'), 'utf8')) as {
  solverRoute?: string
  proposerRoute?: string
  budget?: { solverTokens?: number; taskTrials?: number }
  benchmark?: { artifactEndpoint?: { host?: string; port?: number } }
}
check(
  'configSolvesLiveAndProposesRecorded',
  frozenConfig.solverRoute === 'deepseek/zen-compatible' &&
    frozenConfig.proposerRoute === 'dsh-evolve-le/recorded-proposer' &&
    frozenConfig.budget?.solverTokens === SOLVER_TOKENS &&
    frozenConfig.budget?.taskTrials === TASK_TRIALS,
  JSON.stringify({
    solverRoute: frozenConfig.solverRoute,
    proposerRoute: frozenConfig.proposerRoute,
    budget: frozenConfig.budget,
  }),
)
// R2: the gateway rides the artifact listener, so the frozen endpoint must be
// a fixed reachable address, not an ephemeral port.
check(
  'artifactEndpointIsFixedOnTheBridge',
  frozenConfig.benchmark?.artifactEndpoint?.port === Number(ARTIFACT_PORT),
  JSON.stringify(frozenConfig.benchmark?.artifactEndpoint ?? null),
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
  console.error('gate8 solve-smoke FAILED: frozen config carries no solver plan')
  process.exit(1)
}
const routeHash = remoteRoutePlanHash(solvePlan)

// --- 4. doctor + run: one REAL live-solve trial --------------------------------
console.log('gate8 solve-smoke: dsh-evolve doctor…')
const doctor = await cli(['doctor', '--run-root', runRoot])
check('doctorAllGreen', doctor.code === 0 && !doctor.stdout.includes('✗'), doctor.stdout)
if (doctor.code !== 0) {
  console.error(`gate8 solve-smoke FAILED: doctor exited ${String(doctor.code)}`)
  console.error(doctor.stdout)
  process.exit(1)
}

console.log(
  `gate8 solve-smoke: dsh-evolve run (live trials: real model ${modelName} inside real Harbor containers)…`,
)
const runStart = Date.now()
const run = await cli(['run', '--run-root', runRoot])
const runSeconds = Math.round((Date.now() - runStart) / 1000)
if (run.code !== 0) {
  console.error(`gate8 solve-smoke FAILED: run exited ${String(run.code)}`)
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
  failurePool: string[]
  budget: Record<string, { spent: number; reserved: number }>
}
console.log(
  `gate8 solve-smoke: ${report.stopReason} / ${report.status} — trials=${String(report.trials)} (${String(runSeconds)}s)`,
)

// The funded shape: one discovery trial, plus the first child's q0 cold-start
// only when that trial failed honestly. A pass stops with zero failures; a
// fail walks the full propose → rebuild → evaluate loop and stops at K=1.
const expansions = report.expansionAttempts
check(
  'trialCountMatchesTheFundedShape',
  report.trials === report.discoveryTrials + expansions &&
    report.discoveryTrials === 1 &&
    (expansions === 0 || expansions === 1),
  `trials=${String(report.trials)} discovery=${String(report.discoveryTrials)} expansions=${String(expansions)}`,
)
check(
  'stopReasonMatchesTheShape',
  expansions === 0
    ? report.stopReason === 'NO_REAL_FAILURE_SIGNAL'
    : ['K_REACHED', 'BUDGET_EXHAUSTED', 'TRIAL_CAP'].includes(report.stopReason),
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

// --- 5. Every Harbor trial + its own receipt chain -----------------------------
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
        agent_result?: { n_input_tokens?: number | null; cost_usd?: number | null }
      })
    : null
  const trajectoryText = existsSync(trajectoryPath)
    ? await readFile(trajectoryPath, 'utf8')
    : ''
  // R5 + the defect this fixes: each trajectory must be non-empty AND must not
  // be the recorded replay (the deterministic '[dsh-evolve-le replay]' marker).
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
  // Harbor's cross-check of the receipt figures: the capsule's usage figures
  // come only from gateway replies, so the trial result must carry them.
  const agentResult = parsed?.agent_result ?? null
  check(
    `agentUsageReportedToHarbor (${trial.jobName}/${trial.trialName})`,
    (agentResult?.n_input_tokens ?? 0) > 0 && (agentResult?.cost_usd ?? 0) > 0,
    JSON.stringify(agentResult),
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
const artifactsDir = resolve(smokeDir, 'artifacts')
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
)
for (const [source, name] of artifactCopies) {
  await cp(source, resolve(artifactsDir, name)).catch(() => undefined)
}

// REDACTION (rule 8), asserted over every artifact this gate writes — the
// document itself is scanned as the exact bytes it will land as.
const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
const document = {
  gate: 'gate8',
  kind: 'live-solve-trial-smoke',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repositoryHead: head.stdout.trim(),
  },
  route: {
    id: 'deepseek/zen-compatible',
    baseUrl,
    model: modelName,
    temperature: 0,
    routeHash,
    credentialFile: credentialPath,
  },
  budgets: {
    usd: report.budget['usd'] ?? null,
    'solver-tokens': solverBudget,
    'task-trials': report.budget['task-trials'] ?? null,
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
    'packages/dsh-evolve-le/tests/live-solve-agent.test.ts',
    'packages/dsh-evolve-le/tests/solve-gateway.test.ts',
    'packages/dsh-evolve-le/tests/solve-gateway-container.test.ts',
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
const documentPath = resolve(smokeDir, 'live-solve-trial.json')
await mkdir(smokeDir, { recursive: true })
await writeFile(documentPath, `${JSON.stringify(finalDocument, null, 2)}\n`)
const allPassed = failures.length === 0
const documentSha = createHash('sha256').update(await readFile(documentPath)).digest('hex')
await writeFile(
  resolve(smokeDir, 'STATUS.json'),
  `${JSON.stringify(
    {
      gate: 'gate8',
      kind: 'live-solve-trial-smoke-status',
      generatedAt: document.generatedAt,
      environment: document.environment,
      summary: {
        route: `solver deepseek/zen-compatible → ${modelName}`,
        tasks: trialFacts.map((fact) => fact.taskName ?? '?'),
        rewards: trialFacts.map((fact) => fact.reward),
        requests: document.receipts.totalRequests,
        totalTokens: document.receipts.totalTokens,
        costUsdMicros: document.receipts.costUsdMicros,
        stopReason: report.stopReason,
        seconds: runSeconds,
      },
      allPassed,
      evidence: {
        smoke: { path: 'evidence/gate8/solve-smoke/live-solve-trial.json', sha256: documentSha },
      },
    },
    null,
    2,
  )}\n`,
)
if (!allPassed) {
  console.error(`gate8 live-solve smoke FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  console.error(`scratch kept for diagnosis: ${scratch}`)
  process.exit(1)
}
await rm(scratch, { recursive: true, force: true })
console.log(
  `gate8 live-solve smoke: ${String(trialFacts.length)} live trial(s) [${trialFacts
    .map((fact) => `${String(fact.taskName)}→reward ${String(fact.reward)}`)
    .join('; ')}] via ${modelName}; ` +
    `${String(document.receipts.totalRequests)} requests, ${String(document.receipts.totalTokens)} tokens, ` +
    `${String(document.receipts.costUsdMicros)} µUSD (${String(runSeconds)}s)`,
)
