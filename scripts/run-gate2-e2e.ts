/**
 * Gate 2 end-to-end (specs/07 §4): one REAL Harbor job on the REAL pinned
 * extract-elf task, running a REAL dsh-evolve-le candidate capsule through
 * the inline ACP binary distribution — capsule tar.gz served over local
 * HTTPS, downloaded and sha256-verified inside the task container, booted
 * through the real Cordis Loader, solving over ACP, verified by the task's
 * own verifier. Then the acceptance machinery around it:
 *
 *   1. attribution: the trial's agent_info.version == capsule archive sha256
 *   2. verifier compatibility probe: a derived task copy forcing the separate
 *      verifier environment runs the same capsule; both modes must produce
 *      well-attributed, explicit outcomes on an untouched official task.
 *      Empirically (harbor 0.21.0): the separate verifier container is a
 *      fresh copy of the task environment — only the verifier dir is mounted,
 *      never the agent's workspace — so extract-elf's verifier cannot read
 *      the agent-written output file and fails with RewardFileNotFoundError.
 *      The probe records that finding ('shared-only') rather than demanding
 *      equal rewards; the sealed protocol keeps each task's default mode.
 *   3. idempotency: re-planning the same submission is `existing` and the
 *      ledger stays one line; re-invoking Harbor resumes the same job dir
 *      with no new trial directory (no second paid trial)
 *   4. determinism: normalizing the raw Harbor job directory twice from
 *      scratch yields the identical artifact hash
 *
 * Writes machine-checkable evidence to evidence/gate2/ and exits non-zero if
 * any acceptance flag is false (fail closed, CLAUDE.md rule 9).
 *
 * Usage: node --import tsx/esm scripts/run-gate2-e2e.ts
 * @module scripts/run-gate2-e2e
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildCandidate } from '../packages/dsh-evolve-le/src/index.js'
import {
  ACP_AGENT_ID,
  DATASET_PIN,
  SubmissionLedger,
  buildAugmentedCaBundle,
  generateLocalCa,
  normalizeJob,
  planSubmission,
  startArtifactServer,
} from '../benchmark-adapters/terminal-bench/src/index.js'

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const TARBALL = join(repoRoot, '.references', `${DATASET_PIN.id}-7131e43.tar.gz`)
const HARBOR_BIN = process.env['HARBOR_BIN'] ?? 'harbor'
const EVIDENCE = join(repoRoot, 'evidence/gate2')
const DOCKER_GATEWAY = '172.17.0.1'
const ARTIFACT_PORT = 8443
const RUN_ID = 'gate2-dev'
const HARBOR_VERSION = '0.21.0'

interface Flags {
  harborVersionOk: boolean
  capsuleBuilt: boolean
  artifactEndpointHttps: boolean
  jobCompleted: boolean
  trialAttributionOk: boolean
  verifierRan: boolean
  acpCandidateStreamed: boolean
  verifierModeProbed: boolean
  idempotencyLedgerSingleEntry: boolean
  idempotencyNoSecondTrial: boolean
  normalizationDeterministic: boolean
}

function fail(flags: Flags, message: string): never {
  console.error(`✗ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-gate2-'))
  console.log(`scratch: ${scratch}`)
  const flags: Flags = {
    harborVersionOk: false,
    capsuleBuilt: false,
    artifactEndpointHttps: false,
    jobCompleted: false,
    trialAttributionOk: false,
    verifierRan: false,
    acpCandidateStreamed: false,
    verifierModeProbed: false,
    idempotencyLedgerSingleEntry: false,
    idempotencyNoSecondTrial: false,
    normalizationDeterministic: false,
  }
  const notes: string[] = []
  let verifierModeVerdict = 'not-run'

  // ---- prerequisites (fail closed) ---------------------------------------
  const { stdout: harborVersion } = await exec(HARBOR_BIN, ['--version'])
  flags['harborVersionOk'] = harborVersion.trim() === HARBOR_VERSION
  if (!flags['harborVersionOk']) {
    fail(flags, `harbor --version = ${harborVersion.trim()}, expected ${HARBOR_VERSION}`)
  }
  if (!existsSync(TARBALL)) {
    fail(flags, `pinned tarball missing: ${TARBALL}; run pnpm setup:source`)
  }
  await exec('docker', ['info', '--format', '{{.ServerVersion}}'])

  await mkdir(EVIDENCE, { recursive: true })
  await mkdir(join(EVIDENCE, 'jobs'), { recursive: true })
  const ledger = new SubmissionLedger(join(EVIDENCE, 'ledger.jsonl'))

  // ---- capsule ------------------------------------------------------------
  console.log('building candidate capsule…')
  const workRoot = await mkdtemp(join(tmpdir(), 'dsh-gate2-build-'))
  const build = await buildCandidate({
    sourceDir: join(repoRoot, 'packages/candidate-baseline'),
    workRoot,
  })
  if (build.outcome !== 'admitted' || build.capsule === undefined) {
    fail(flags, `baseline capsule build rejected: ${JSON.stringify(build.receipts)}`)
  }
  const capsuleArchiveSha256 = build.capsule.archiveSha256
  flags['capsuleBuilt'] = true
  console.log(`capsule tar.gz ${capsuleArchiveSha256.slice(0, 16)}…`)

  const artifactsDir = join(scratch, 'artifacts')
  await mkdir(artifactsDir)
  const archivePath = join(artifactsDir, `${capsuleArchiveSha256}.tar.gz`)
  await writeFile(archivePath, await readFile(build.artifacts.capsuleArchive))

  // ---- pinned tasks -------------------------------------------------------
  const tasksRoot = join(scratch, 'tasks')
  await mkdir(tasksRoot)
  console.log('extracting pinned terminal-bench 2.1 tasks…')
  await exec('tar', ['-xzf', TARBALL, '-C', scratch])
  await cp(join(scratch, DATASET_PIN.rootDir, DATASET_PIN.tasksDir), tasksRoot, {
    recursive: true,
  })

  // Derived task copy for the verifier-mode probe: identical task, verifier
  // forced into its own container. The official task directory is untouched.
  const probeHandle = 'extract-elf-separate-probe'
  const probeDir = join(tasksRoot, probeHandle)
  await cp(join(tasksRoot, 'extract-elf'), probeDir, { recursive: true })
  const probeToml = await readFile(join(probeDir, 'task.toml'), 'utf8')
  await writeFile(
    join(probeDir, 'task.toml'),
    probeToml.replace(
      /^\[verifier\]$/m,
      '[verifier]\n# dsh-evolve-le Gate 2 probe: force the separate verifier environment.\nenvironment_mode = "separate"',
    ),
  )

  // ---- local HTTPS artifact endpoint --------------------------------------
  const tlsDir = join(scratch, 'tls')
  await mkdir(tlsDir)
  const tls = await generateLocalCa({ dir: tlsDir, ip: DOCKER_GATEWAY })
  const caBundleHost = await buildAugmentedCaBundle({
    dir: tlsDir,
    localCaCertPath: tls.caCertPath,
  })
  const server = await startArtifactServer({
    host: DOCKER_GATEWAY,
    port: ARTIFACT_PORT,
    artifactsDir,
    tls: { certPath: tls.serverCertPath, keyPath: tls.serverKeyPath },
  })
  const archiveUrl = server.urls.get(capsuleArchiveSha256)
  if (archiveUrl === undefined) fail(flags, 'artifact server did not register the capsule')
  flags['artifactEndpointHttps'] = archiveUrl.startsWith('https://')
  console.log(`artifact endpoint: ${archiveUrl}`)

  // Containers trust the local CA through SSL_CERT_FILE at a fresh path —
  // never a bind mount over /etc/ssl/certs/ca-certificates.crt, which
  // update-ca-certificates would rewrite (and a read-only mount would break).
  const caBundleContainer = '/opt/dsh-evolve-le/ca-bundle.crt'
  const caOptions = {
    mounts: [{ source: caBundleHost, target: caBundleContainer }],
    env: { SSL_CERT_FILE: caBundleContainer },
  }

  const jobsRoot = join(scratch, 'jobs')
  await mkdir(jobsRoot)

  try {
    // ---- main job ---------------------------------------------------------
    const mainHandles = ['extract-elf']
    const plan = await planSubmission({
      runId: RUN_ID,
      tasksRoot,
      handles: mainHandles,
      capsuleArchiveSha256,
      archiveUrl,
      jobsRoot,
      harborVersion: HARBOR_VERSION,
      attempts: 1,
      concurrentTrials: 1,
      ledger,
      ...caOptions,
    })
    const configPath = join(scratch, 'job-main.yaml')
    await writeFile(configPath, plan.jobPlan.yaml, 'utf8')
    console.log(`main job ${plan.jobName}: running harbor…`)
    await runHarbor(configPath, scratch)
    flags['jobCompleted'] = true

    const artifact = await normalizeJob({
      jobDir: plan.jobDir,
      jobName: plan.jobName,
      idempotencyKey: plan.idempotencyKey,
      identity: plan.identity,
    })
    await writeJson(join(EVIDENCE, 'normalized-main.json'), artifact)
    await cp(plan.jobDir, join(EVIDENCE, 'jobs', plan.jobName), { recursive: true })

    const trial = artifact.trials[0]
    flags['trialAttributionOk'] =
      trial?.agentInfo.version === capsuleArchiveSha256 &&
      trial?.agentInfo.name === ACP_AGENT_ID &&
      trial?.status !== 'protocol_invalid'
    if (!flags['trialAttributionOk']) {
      fail(flags, `attribution failed: ${JSON.stringify(trial)}`)
    }
    // The replay runner does not solve extract-elf; the expected result is a
    // verifier-scored FAIL (reward present, 0 <= reward < 1), never a
    // missing/invalid outcome.
    flags['verifierRan'] =
      trial?.outcome.category === 'reward' &&
      trial?.outcome.reward !== null &&
      trial.outcome.reward < 1
    console.log(`main trial: status=${trial?.status} reward=${trial?.outcome.reward}`)

    flags['acpCandidateStreamed'] = await acpMarkerPresent(plan.jobDir)
    if (!flags['acpCandidateStreamed']) {
      notes.push('candidate:identity marker absent from the agent ACP logs')
    }

    // ---- determinism ------------------------------------------------------
    const reParsed = await normalizeJob({
      jobDir: plan.jobDir,
      jobName: plan.jobName,
      idempotencyKey: plan.idempotencyKey,
      identity: plan.identity,
    })
    flags['normalizationDeterministic'] = reParsed.artifactSha256 === artifact.artifactSha256

    // ---- idempotency ------------------------------------------------------
    const rePlan = await planSubmission({
      runId: RUN_ID,
      tasksRoot,
      handles: mainHandles,
      capsuleArchiveSha256,
      archiveUrl,
      jobsRoot,
      harborVersion: HARBOR_VERSION,
      attempts: 1,
      concurrentTrials: 1,
      ledger,
      ...caOptions,
    })
    const ledgerEntries = (await ledger.entries()).filter((e) => e.key === plan.idempotencyKey)
    flags['idempotencyLedgerSingleEntry'] =
      rePlan.status === 'existing' && ledgerEntries.length === 1
    const trialsBefore = await countTrialDirs(plan.jobDir)
    console.log('idempotency: re-invoking harbor on the same job (resume expected)…')
    await runHarbor(configPath, scratch)
    const trialsAfter = await countTrialDirs(plan.jobDir)
    flags['idempotencyNoSecondTrial'] = trialsAfter === trialsBefore
    notes.push(`trial dirs before/after resume: ${trialsBefore}/${trialsAfter}`)

    // ---- verifier-mode probe ----------------------------------------------
    console.log('verifier-mode probe: separate verifier environment…')
    const probePlan = await planSubmission({
      runId: RUN_ID,
      tasksRoot,
      handles: [probeHandle],
      capsuleArchiveSha256,
      archiveUrl,
      jobsRoot,
      harborVersion: HARBOR_VERSION,
      attempts: 1,
      concurrentTrials: 1,
      ledger,
      ...caOptions,
    })
    const probeConfigPath = join(scratch, 'job-probe.yaml')
    await writeFile(probeConfigPath, probePlan.jobPlan.yaml, 'utf8')
    await runHarbor(probeConfigPath, scratch)
    const probeArtifact = await normalizeJob({
      jobDir: probePlan.jobDir,
      jobName: probePlan.jobName,
      idempotencyKey: probePlan.idempotencyKey,
      identity: probePlan.identity,
    })
    await writeJson(join(EVIDENCE, 'normalized-probe.json'), probeArtifact)
    await cp(probePlan.jobDir, join(EVIDENCE, 'jobs', probePlan.jobName), { recursive: true })
    const probeTrial = probeArtifact.trials[0]
    // Both modes must yield well-attributed, explicit outcomes. If rewards
    // agree the task is mode-portable; if the separate container cannot
    // reproduce the shared reward, the probe records the incompatibility
    // (extract-elf's verifier reads agent-written workspace files, which the
    // fresh separate container never sees) instead of failing the gate on a
    // property the official task contract does not promise.
    const probeAttributed =
      probeTrial?.agentInfo.version === capsuleArchiveSha256 &&
      probeTrial?.status !== 'protocol_invalid'
    const probeExplicit =
      probeTrial?.outcome.reward !== null ||
      probeTrial?.outcome.exceptionType !== null ||
      probeTrial?.outcome.category === 'missing-reward'
    flags['verifierModeProbed'] = probeAttributed && probeExplicit
    const rewardsAgree = probeTrial?.outcome.reward === trial?.outcome.reward
    verifierModeVerdict = rewardsAgree ? 'rewards-agree' : 'shared-only'
    console.log(
      `probe trial: status=${probeTrial?.status} reward=${probeTrial?.outcome.reward} exception=${probeTrial?.outcome.exceptionType} → ${verifierModeVerdict}`,
    )
    if (!flags['verifierModeProbed']) {
      notes.push(
        `verifier-mode probe not attributable/explicit: ${JSON.stringify(probeTrial?.outcome)}`,
      )
    }
  } finally {
    await server.close().catch(() => undefined)
    await rm(workRoot, { recursive: true, force: true })
  }

  const evidence = {
    $schema: 'https://dsh-evolve-le.local/schemas/gate2.e2e.schema.json',
    schemaVersion: 1,
    runId: RUN_ID,
    recordedAt: new Date().toISOString(),
    capsule: { archiveSha256: capsuleArchiveSha256 },
    artifactEndpoint: { url: `https://${DOCKER_GATEWAY}:${ARTIFACT_PORT}`, caBundleContainer },
    verifierModeProbe: { verdict: verifierModeVerdict },
    harborVersion,
    flags,
    notes,
  }
  await writeJson(join(EVIDENCE, 'e2e.json'), evidence)

  const allOk = Object.values(flags).every(Boolean)
  console.log(
    allOk
      ? 'gate2 e2e: all acceptance flags true'
      : `gate2 e2e: FAILED flags: ${Object.entries(flags)
          .filter(([, ok]) => !ok)
          .map(([name]) => name)
          .join(', ')}`,
  )
  if (!allOk) process.exitCode = 1
}

async function runHarbor(configPath: string, cwd: string): Promise<void> {
  const exit = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(HARBOR_BIN, ['run', '-c', configPath, '-y', '-q'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(stderr.slice(-4000))
        reject(new Error(`harbor run exited ${code}`))
      } else {
        resolvePromise(code)
      }
    })
  })
  void exit
}

async function countTrialDirs(jobDir: string): Promise<number> {
  const entries = await readdir(jobDir, { withFileTypes: true })
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory()) count += 1
  }
  return count
}

/** The ACP agent logs must show the candidate's section streamed in-session. */
async function acpMarkerPresent(jobDir: string): Promise<boolean> {
  const trialDirs = (await readdir(jobDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  )
  for (const trial of trialDirs) {
    const agentDir = join(jobDir, trial.name, 'agent')
    const files = await readdir(agentDir).catch(() => [] as string[])
    for (const name of files) {
      if (!name.startsWith('acp')) continue
      const text = await readFile(join(agentDir, name), 'utf8').catch(() => '')
      if (text.includes('[candidate:identity]')) return true
    }
  }
  return false
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(process.exitCode ?? 1)
}
