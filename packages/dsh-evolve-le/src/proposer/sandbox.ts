/**
 * Proposal sandbox supervisor (Gate 4, specs/05 §9–§10, specs/07 §6): stages
 * the one-shot sandbox tree, enforces the OS boundary, runs the worker, and
 * verifies the boundary held.
 *
 * Layout:
 *
 * ```text
 * <sandboxRoot>/input/          # root-owned, read-only: capsule (+ worker
 *                               # runtime), export view, parent tree,
 *                               # parent-files.json, config.json
 * <sandboxRoot>/work/           # worker-writable (nobody): children/,
 *                               # transcript, receipts, proposal, result
 * <sandboxRoot>/controller-private/   # 0700: fake credentials (DAC canary)
 * <sandboxRoot>-sibling/               # 0700: sealed canary (DAC canary)
 * ```
 *
 * The worker runs as `nobody` (uid 65534) under `setpriv --clear-groups`
 * inside a network namespace (`unshare --net`), with a stripped environment
 * and a wall-clock watchdog. `input/capsule` stays worker-writable only
 * because the Cordis include plugin may flush its tree file beside the boot
 * config; the capsule tree digest is re-verified after the run excluding
 * exactly that overlay, so any other drift fails closed. A host that offers
 * neither uid drop nor network namespace fails closed — a proposal is never
 * accepted from an unenforced boundary.
 * @module @dsh-evolve-le/core/proposer/sandbox
 */

import { spawn } from 'node:child_process'
import { chmod, chown, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureCanonicalSource } from '../candidate/canonical.js'
import { bootConfig } from '../builder/capsule.js'
import { probeNetworkNamespace, sandboxEnvironment } from '../builder/sandbox.js'
import { computeTreeDigest } from '../digest.js'
import { runProposerAgentLoop } from './agent-loop.js'
import { openModelGateway } from './gateway.js'
import { buildProposalInstruction, createRecordedProposerPolicy } from './policy.js'
import { openProposerTools } from './tools.js'
import type { GatewayUsage } from './gateway.js'
import type { ProposalOutput } from './protocol.js'

export const SANDBOX_VERSION = 'dsh-evolve-le/proposal-sandbox/v1'

/** The uid/gid the worker drops to (Debian `nobody`). */
export const WORKER_UID = 65534

/** The boot overlay files excluded from the capsule re-verification. */
const CAPSULE_OVERLAY = new Set(['cordis.propose.yml', 'cordis.propose.yml.tmp'])

export class SandboxError extends Error {
  constructor(message: string) {
    super(`proposal-sandbox: ${message}`)
    this.name = 'SandboxError'
  }
}

/** The OS boundary actually achieved for a run (specs/05 §9). */
export interface SandboxAchievement {
  kind: 'uid-netns' | 'netns' | 'uid'
  uid: number | null
  detail: string
}

export interface WorkerResultDoc {
  schemaVersion: 1
  ok: boolean
  uid: number
  error?: string
  boot?: {
    capturedSections: { name: string; order: number; text: string }[]
    declaredMatch: boolean
    quiescent: boolean
  }
  dacProbes?: { path: string; outcome: string }[]
  turns?: number
  usage?: GatewayUsage
  proposal?: ProposalOutput
}

export interface ProposalSandboxOutcome {
  sandboxRoot: string
  exitCode: number | null
  timedOut: boolean
  stderr: string
  sandbox: SandboxAchievement
  worker: WorkerResultDoc
  transcriptPath: string
  receiptsPath: string
  proposalPath: string
  childrenRoot: string
  capsuleDigest: string
  capsuleVerified: boolean
  dacHeld: boolean
}

/** Pre-run supervisor facts persisted beside the sandbox (before the run). */
export interface SupervisorManifest {
  schemaVersion: 1
  sandboxVersion: typeof SANDBOX_VERSION
  sandbox: SandboxAchievement
  parentSourceHash: string
  width: number
  capsuleDigest: string
  capsuleFileCount: number
  /**
   * The model route the worker's gateway spoke to (Gate 8). `remote` routes
   * are verified by the controller against the proxy receipt chain; recorded
   * routes by byte-replay.
   */
  model:
    | { kind: 'recorded' }
    | { kind: 'remote'; routeId: string; routeHash: string; receiptsPath: string }
}

/** The worker's completion manifest — written LAST: its presence means done. */
export function workerResultPath(sandboxRoot: string): string {
  return join(sandboxRoot, 'work', 'worker-result.json')
}

/** The supervisor's pre-run facts (staging + boundary), written before spawn. */
export function supervisorManifestPath(sandboxRoot: string): string {
  return join(sandboxRoot, 'supervisor.json')
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const coreLibDir = existsSync(join(moduleDir, '..', 'bin/candidate-probe.js'))
  ? join(moduleDir, '..')
  : join(moduleDir, '..', '..', 'lib')

/** Worker runtime files the supervisor stages into the capsule runner tree. */
const WORKER_RUNTIME_FILES = [
  'bin/proposer-worker.js',
  'proposer/gateway.js',
  'proposer/remote-model.js',
  'proposer/tools.js',
  'proposer/policy.js',
  'proposer/agent-loop.js',
  'proposer/protocol.js',
] as const

async function walk(
  root: string,
  visit: (path: string, entry: { isDirectory: boolean }) => Promise<void>,
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const at = join(root, entry.name)
    await visit(at, { isDirectory: entry.isDirectory() })
    if (entry.isDirectory()) await walk(at, visit)
  }
}

/** Make a tree root-owned and read-only for everyone else. */
async function sealReadOnly(root: string, dirMode = 0o555, fileMode = 0o444): Promise<void> {
  await chmod(root, dirMode)
  await walk(root, async (path, entry) => {
    await chmod(path, entry.isDirectory ? dirMode : fileMode)
  })
}

/** Hand a tree to the worker uid (recursive chown) and open it for writing. */
async function handToWorker(root: string): Promise<void> {
  await chown(root, WORKER_UID, WORKER_UID)
  await chmod(root, 0o755)
  await walk(root, async (path, entry) => {
    await chown(path, WORKER_UID, WORKER_UID)
    await chmod(path, entry.isDirectory ? 0o755 : 0o644)
  })
}

/**
 * Grant world-traverse (+x for others) on every ancestor of the sandbox root.
 * Private scratch roots (mkdtemp 0700) would otherwise make the whole sandbox
 * unreadable for the worker uid — Node then fails the entry module with a
 * misleading "Cannot find module". Only the traverse bit is ever added;
 * nothing is opened for reading or writing.
 */
async function ensureTraversable(from: string): Promise<void> {
  let current = from
  while (true) {
    const stats = await stat(current)
    if ((stats.mode & 0o001) === 0) await chmod(current, stats.mode | 0o001)
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Detect the strongest OS boundary this host can give the worker. */
function achieveSandbox(): SandboxAchievement {
  const setpriv = existsSync('/usr/bin/setpriv')
  const netns = probeNetworkNamespace()
  if (setpriv && netns) {
    return {
      kind: 'uid-netns',
      uid: WORKER_UID,
      detail: `setpriv --reuid=${WORKER_UID} --regid=${WORKER_UID} --clear-groups + unshare --net, stripped env, wall-clock watchdog`,
    }
  }
  if (netns) {
    return { kind: 'netns', uid: null, detail: 'unshare --net only (no uid drop available)' }
  }
  if (setpriv) {
    return { kind: 'uid', uid: WORKER_UID, detail: `setpriv --reuid=${WORKER_UID} only` }
  }
  throw new SandboxError(
    'host provides neither setpriv nor a network namespace; refusing to run a proposal without an OS boundary',
  )
}

/**
 * Capsule digest over everything except the include-plugin boot overlay.
 * Exported for the controller's resume path (re-verify the capsule against
 * the digest recorded in `supervisor.json`).
 */
export function capsuleDigestExcludingOverlay(
  capsuleDir: string,
): Promise<{ digest: string; fileCount: number }> {
  return computeTreeDigest(capsuleDir, { exclude: (rel) => CAPSULE_OVERLAY.has(rel) })
}

export interface RemoteSandboxModel {
  kind: 'remote'
  /** AF_UNIX socket of the controller-side TCB proxy (see remote-runner.ts). */
  socketPath: string
  routeId: string
  routeHash: string
  /** Durable proxy receipts, verified by the controller after the run. */
  receiptsPath: string
  /** Worker-side socket timeout; must exceed the proxy's request timeout. */
  clientTimeoutMs?: number
}

export interface RunProposalSandboxOptions {
  sandboxRoot: string
  /** Controller-side parent capsule directory (from the trusted builder). */
  capsuleDir: string
  /** Controller-side label-filtered export directory (manifest.json + objects/). */
  exportDir: string
  /** Canonical parent source tree (must hash to parentSourceHash). */
  parentTreeDir: string
  parentSourceHash: string
  width: number
  maxTurns?: number
  timeoutMs?: number
  /** Networked route (Gate 8); default is the recorded deterministic policy. */
  model?: RemoteSandboxModel
}

/**
 * Stage, run and verify one proposal sandbox. The outcome carries the worker
 * result plus the boundary evidence; admission is decided by the controller
 * from the proposal bundle and children trees, never from the exit code
 * alone.
 */
export async function runProposalSandbox(
  options: RunProposalSandboxOptions,
): Promise<ProposalSandboxOutcome> {
  const sandbox = achieveSandbox()
  const sandboxRoot = options.sandboxRoot
  const inputRoot = join(sandboxRoot, 'input')
  const workRoot = join(sandboxRoot, 'work')
  const capsuleDir = join(inputRoot, 'capsule')
  const controllerPrivate = join(sandboxRoot, 'controller-private')
  const siblingRoot = `${sandboxRoot}-sibling`

  // ---- stage -----------------------------------------------------------
  await rm(sandboxRoot, { recursive: true, force: true })
  await rm(siblingRoot, { recursive: true, force: true })
  await mkdir(join(workRoot, 'children'), { recursive: true })
  await mkdir(inputRoot, { recursive: true })
  await cp(options.capsuleDir, capsuleDir, { recursive: true })

  // Worker runtime joins the capsule runner tree (same resolution surface as
  // probe.js: bare imports resolve against the capsule node_modules closure).
  for (const file of WORKER_RUNTIME_FILES) {
    const from = join(coreLibDir, file)
    if (!existsSync(from)) throw new SandboxError(`worker runtime file missing: ${file}`)
    const to = join(capsuleDir, 'runner', file)
    await mkdir(dirname(to), { recursive: true })
    await cp(from, to)
  }

  // Boot overlay: regenerated deterministically, never trusted from the
  // source capsule even though the builder ships an identical one.
  const candidatePkg = JSON.parse(
    await readFile(join(capsuleDir, 'candidate', 'package.json'), 'utf8'),
  ) as { name: string }
  const capsuleManifest = JSON.parse(await readFile(join(capsuleDir, 'manifest.json'), 'utf8')) as {
    identity: { candidateId: string }
  }
  const candidateManifest = JSON.parse(
    await readFile(join(capsuleDir, 'candidate', 'candidate.json'), 'utf8'),
  ) as { runtime?: { promptSections?: { propose?: { name: string }[] } } }
  const declaredProposeSections = (candidateManifest.runtime?.promptSections?.propose ?? []).map(
    (section) => section.name,
  )
  await writeFile(
    join(capsuleDir, 'cordis.propose.yml'),
    `${bootConfig(candidatePkg.name ?? '', capsuleManifest.identity.candidateId, 'propose')}\n`,
    'utf8',
  )

  // Export view (controller-selected) and the canonical parent tree.
  await cp(options.exportDir, join(inputRoot, 'export'), { recursive: true })
  const parentSource = await captureCanonicalSource(options.parentTreeDir)
  if (parentSource.sha256 !== options.parentSourceHash.replace(/^sha256:/, '')) {
    throw new SandboxError('parent tree does not hash to the declared parentSourceHash')
  }
  await mkdir(join(inputRoot, 'parent'), { recursive: true })
  for (const file of parentSource.files) {
    const target = join(inputRoot, 'parent', ...file.path.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { mode: file.mode })
  }
  await writeFile(
    join(inputRoot, 'parent-files.json'),
    `${JSON.stringify(
      parentSource.files.map((file) => file.path),
      null,
      2,
    )}\n`,
    'utf8',
  )

  // DAC canaries: root-only fixtures the worker must fail to read. Probe
  // paths are relative to the sandbox PARENT (the worker probes
  // sandboxRoot/..), so both carry the sandbox basename.
  await mkdir(controllerPrivate, { recursive: true })
  await writeFile(
    join(controllerPrivate, 'credentials.json'),
    '{"note": "fake controller credentials — never readable from the sandbox"}\n',
    { mode: 0o600 },
  )
  await mkdir(join(siblingRoot, 'sealed'), { recursive: true })
  await writeFile(
    join(siblingRoot, 'sealed', 'canary.json'),
    '{"note": "fake sealed fixture — never readable from the sandbox"}\n',
    { mode: 0o600 },
  )
  await chmod(controllerPrivate, 0o700)
  await chmod(siblingRoot, 0o700)
  const sandboxBase = basename(sandboxRoot)
  const dacProbePaths = [
    `${sandboxBase}/controller-private/credentials.json`,
    `${basename(siblingRoot)}/sealed/canary.json`,
  ]

  await writeFile(
    join(inputRoot, 'config.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1 as const,
        parentSourceHash: options.parentSourceHash,
        width: options.width,
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        ...(options.model !== undefined ? { modelSocket: options.model.socketPath } : {}),
        ...(options.model?.clientTimeoutMs !== undefined
          ? { modelClientTimeoutMs: options.model.clientTimeoutMs }
          : {}),
        declaredProposeSections,
        dacProbePaths,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  // Freeze: input root-owned read-only, except the capsule subtree handed to
  // the worker for the include flush (digest re-verified post-run); work/
  // belongs to the worker.
  await ensureTraversable(dirname(sandboxRoot))
  await chmod(sandboxRoot, 0o755)
  await sealReadOnly(inputRoot)
  await handToWorker(capsuleDir)
  await handToWorker(workRoot)
  const capsuleBefore = await capsuleDigestExcludingOverlay(capsuleDir)
  const supervisorManifest: SupervisorManifest = {
    schemaVersion: 1,
    sandboxVersion: SANDBOX_VERSION,
    sandbox,
    parentSourceHash: options.parentSourceHash,
    width: options.width,
    capsuleDigest: capsuleBefore.digest,
    capsuleFileCount: capsuleBefore.fileCount,
    model:
      options.model === undefined
        ? { kind: 'recorded' }
        : {
            kind: 'remote',
            routeId: options.model.routeId,
            routeHash: options.model.routeHash,
            receiptsPath: options.model.receiptsPath,
          },
  }
  await writeFile(
    supervisorManifestPath(sandboxRoot),
    `${JSON.stringify(supervisorManifest, null, 2)}\n`,
    'utf8',
  )

  // ---- run --------------------------------------------------------------
  const workerEntry = join(capsuleDir, 'runner', 'bin', 'proposer-worker.js')
  const useUid = sandbox.kind === 'uid-netns' || sandbox.kind === 'uid'
  const useNetns = sandbox.kind === 'uid-netns' || sandbox.kind === 'netns'
  // The network namespace must be created while still root (CAP_SYS_ADMIN);
  // the uid drop then happens INSIDE it, so the worker never holds both.
  const argv: string[] = []
  if (useNetns) argv.push('/usr/bin/unshare', '--net')
  if (useUid) {
    argv.push(
      '/usr/bin/setpriv',
      `--reuid=${WORKER_UID}`,
      `--regid=${WORKER_UID}`,
      '--clear-groups',
    )
  }
  argv.push(process.execPath, workerEntry, sandboxRoot)

  const run = await new Promise<{ code: number | null; timedOut: boolean; stderr: string }>(
    (resolveRun) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: sandboxRoot,
        env: sandboxEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, options.timeoutMs ?? 300_000)
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolveRun({ code: null, timedOut, stderr: `${stderr}${error.message}` })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveRun({ code, timedOut, stderr })
      })
    },
  )

  // ---- verify -----------------------------------------------------------
  const capsuleAfter = await capsuleDigestExcludingOverlay(capsuleDir)
  const resultPath = join(workRoot, 'worker-result.json')
  const parsed = await readFile(resultPath, 'utf8')
    .then((text) => JSON.parse(text) as WorkerResultDoc)
    .catch(() => undefined)
  if (parsed === undefined) {
    throw new SandboxError(
      `worker produced no result document (exit ${run.code}${run.timedOut ? ', timed out' : ''}): ${run.stderr.slice(0, 500)}`,
    )
  }
  return {
    sandboxRoot,
    exitCode: run.code,
    timedOut: run.timedOut,
    stderr: run.stderr,
    sandbox,
    worker: parsed,
    transcriptPath: join(workRoot, 'transcript.jsonl'),
    receiptsPath: join(workRoot, 'gateway-receipts.jsonl'),
    proposalPath: join(workRoot, 'proposal.json'),
    childrenRoot: join(workRoot, 'children'),
    capsuleDigest: capsuleAfter.digest,
    capsuleVerified: capsuleAfter.digest === capsuleBefore.digest,
    dacHeld:
      (parsed.dacProbes ?? []).length === dacProbePaths.length &&
      parsed.dacProbes!.every((probe) => probe.outcome === 'EACCES'),
  }
}

export interface ReplayVerification {
  /** Captured section names equal the declared contract in config.json. */
  sectionsMatch: boolean
  /** Controller replay reproduced the worker transcript byte for byte. */
  transcriptMatches: boolean
  /** Controller replay reproduced the proposal document byte for byte. */
  proposalMatches: boolean
  /** Worker children root and replay children root hash identically. */
  childrenMatch: boolean
  childrenDigest: string
  replayChildrenDigest: string
}

/**
 * Controller-side integrity verification of a finished sandbox run
 * (specs/07 §6): re-derive the whole proposal from the sandbox's own frozen
 * inputs — with the recorded TCB policy, not whatever ran in the worker — and
 * demand byte-identical transcript, proposal and children trees.
 *
 * The replay consumes `work/sections.json` (TCB section + the sections the
 * worker captured) after re-checking their names against the declared
 * contract in the root-owned `input/config.json`. Doctored section *text*
 * would replay consistently, so the text is additionally anchored downstream:
 * every imported child re-boots through the trusted builder's loaderBoot
 * stage, which verifies the declared sections against the parent contract.
 */
export async function verifyProposalSandboxReplay(
  sandboxRoot: string,
  options: { replayDir: string },
): Promise<ReplayVerification> {
  const inputRoot = join(sandboxRoot, 'input')
  const workRoot = join(sandboxRoot, 'work')
  const config = JSON.parse(await readFile(join(inputRoot, 'config.json'), 'utf8')) as {
    parentSourceHash: string
    width: number
    maxTurns?: number
    declaredProposeSections: string[]
  }
  const sectionsDoc = JSON.parse(await readFile(join(workRoot, 'sections.json'), 'utf8')) as {
    boot: { capturedSections: { name: string; order: number; text: string }[] }
    tcb: { name: string; order: number; text: string }
  }
  const capturedNames = sectionsDoc.boot.capturedSections.map((s) => s.name).sort()
  const sectionsMatch =
    JSON.stringify(capturedNames) === JSON.stringify([...config.declaredProposeSections].sort())

  await mkdir(join(options.replayDir, 'children'), { recursive: true })
  const gateway = openModelGateway({
    model: createRecordedProposerPolicy({ width: config.width }),
    receiptsPath: join(options.replayDir, 'gateway-receipts.jsonl'),
  })
  await runProposerAgentLoop({
    gateway,
    tools: openProposerTools({
      inputRoot,
      childrenRoot: join(options.replayDir, 'children'),
    }),
    sections: [sectionsDoc.tcb, ...sectionsDoc.boot.capturedSections],
    instruction: buildProposalInstruction({
      parentSourceHash: config.parentSourceHash,
      width: config.width,
    }),
    transcriptPath: join(options.replayDir, 'transcript.jsonl'),
    proposalPath: join(options.replayDir, 'proposal.json'),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
  })
  await gateway.close()

  const readBytes = async (path: string): Promise<string> =>
    readFile(path, 'utf8').catch(() => '<missing>')
  const childrenDigest = await computeTreeDigest(join(workRoot, 'children'))
  const replayChildrenDigest = await computeTreeDigest(join(options.replayDir, 'children'))
  return {
    sectionsMatch,
    transcriptMatches:
      (await readBytes(join(workRoot, 'transcript.jsonl'))) ===
      (await readBytes(join(options.replayDir, 'transcript.jsonl'))),
    proposalMatches:
      (await readBytes(join(workRoot, 'proposal.json'))) ===
      (await readBytes(join(options.replayDir, 'proposal.json'))),
    childrenMatch: childrenDigest.digest === replayChildrenDigest.digest,
    childrenDigest: childrenDigest.digest,
    replayChildrenDigest: replayChildrenDigest.digest,
  }
}
