/**
 * Record the Gate 1 builder evidence: two clean builds of the golden
 * candidate, the full adversarial-fixture sweep through the real pipeline,
 * and the packed-capsule container boot — then write the machine-checkable
 * document (plus the first build's manifest and receipts) to
 * `evidence/gate1/`. This is the auditable artifact backing the Gate 1
 * acceptance claims in `PROJECT_STATUS.md`; it fails closed (exit 1) when any
 * acceptance flag is false, including when docker is unavailable.
 * @module scripts/record-gate1-evidence
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

const libDir = resolve(repoRoot, 'packages/dsh-evolve-le/lib')
if (!existsSync(join(libDir, 'builder/pipeline.js'))) {
  throw new Error(`compiled core missing: run \`pnpm build\` first (${libDir})`)
}
const fromLib = (module: string) => import(pathToFileURL(join(libDir, module)).href)
const { buildCandidate, STAGE_ORDER } = await fromLib('builder/pipeline.js')
const { runAcpSession } = await fromLib('acp/driver.js')
const { describeSandbox } = await fromLib('builder/sandbox.js')
const { validateManifest } = await fromLib('schema.js')
const { BUILDER_VERSION } = await fromLib('version.js')

const NODE_IMAGE = 'node:24-alpine'

/** Every adversarial fixture must reject at policyScan with exactly this rule. */
const ADVERSARIAL_CASES: [caseName: string, rule][] = [
  ['dynamic-import', 'import/dynamic'],
  ['require-call', 'import/require'],
  ['eval-call', 'dangerous/eval'],
  ['function-constructor', 'dangerous/function-constructor'],
  ['node-fs', 'import/node-builtin'],
  ['node-builtin-bare', 'import/node-builtin'],
  ['unknown-package', 'import/not-allowed'],
  ['traversal-import', 'import/traversal'],
  ['unresolved-relative', 'import/unresolved'],
  ['default-export', 'export/default'],
  ['leaked-timer', 'leak/timer'],
  ['process-access', 'dangerous/process'],
  ['task-literal', 'task/fingerprint'],
  ['verifier-path', 'task/verifier-path'],
  ['secret-literal', 'secret/openai-key'],
  ['native-binary', 'package/native-binary'],
  ['install-script', 'package/lifecycle-script'],
  ['loose-dep-range', 'dependency/not-exact'],
  ['unknown-dep', 'dependency/not-allowed'],
  ['patch-override', 'patch/not-insert'],
  ['missing-entry', 'entry/missing'],
]

interface StageReceipt {
  status: string
  detail: string
}
interface BuildOutcome {
  outcome: string
  candidateId: string
  sourceDigest: string
  rejection?: { stage: string; reason: string }
  receipts: Record<string, StageReceipt>
  bundle?: { tarSha256: string }
  capsule?: { tarSha256: string; sbomSha256: string; provenanceSha256: string }
}

async function freshWorkRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function gitHead(): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { timeout: 10_000 })
    return stdout.trim()
  } catch {
    return 'unknown (not a git checkout)'
  }
}

async function dockerServerVersion(): Promise<string> {
  const { stdout } = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 30_000,
  })
  return stdout.trim()
}

async function main(): Promise<number> {
  const scratch: string[] = []
  const baselineSource = resolve(repoRoot, 'packages/candidate-baseline')
  const scanCases = resolve(repoRoot, 'packages/dsh-evolve-le/tests/fixtures/scan/cases')

  // ---- two clean builds of the golden candidate -------------------------
  const workRoot1 = await freshWorkRoot('dsh-gate1-a-')
  scratch.push(workRoot1)
  const first = (await buildCandidate({
    sourceDir: baselineSource,
    workRoot: workRoot1,
  })) as BuildOutcome
  const workRoot2 = await freshWorkRoot('dsh-gate1-b-')
  scratch.push(workRoot2)
  const second = (await buildCandidate({
    sourceDir: baselineSource,
    workRoot: workRoot2,
  })) as BuildOutcome

  const allReceiptsPass =
    first.outcome === 'admitted' &&
    Object.keys(first.receipts).length === STAGE_ORDER.length &&
    Object.values(first.receipts).every((receipt) => receipt.status === 'pass')
  const doubleBuildIdentical =
    first.outcome === 'admitted' &&
    second.outcome === 'admitted' &&
    first.candidateId === second.candidateId &&
    first.sourceDigest === second.sourceDigest &&
    first.bundle?.tarSha256 === second.bundle?.tarSha256 &&
    first.capsule?.tarSha256 === second.capsule?.tarSha256 &&
    first.capsule?.sbomSha256 === second.capsule?.sbomSha256 &&
    first.capsule?.provenanceSha256 === second.capsule?.provenanceSha256

  // ---- adversarial fixture sweep through the real pipeline --------------
  const fixtureRuns: {
    case: string
    outcome: string
    stage: string
    expectedRule: string
    ruleMatched: boolean
    detail: string
  }[] = []
  for (const [caseName, rule] of ADVERSARIAL_CASES) {
    const workRoot = await freshWorkRoot('dsh-gate1-fx-')
    scratch.push(workRoot)
    const result = (await buildCandidate({
      sourceDir: join(scanCases, caseName),
      workRoot,
    })) as BuildOutcome
    const stage = result.rejection?.stage ?? 'none'
    const detail = result.rejection?.reason ?? result.receipts.policyScan?.detail ?? ''
    fixtureRuns.push({
      case: caseName,
      outcome: result.outcome,
      stage,
      expectedRule: rule,
      ruleMatched: result.outcome === 'rejected' && stage === 'policyScan' && detail.includes(rule),
      detail: detail.slice(0, 300),
    })
  }
  const rejectionsEnforced = fixtureRuns.every((run) => run.ruleMatched)

  // ---- builder trust properties (from the first build's manifest) -------
  const firstManifestRaw = await readFile(join(workRoot1, 'build-manifest.json'), 'utf8')
  const firstManifest = JSON.parse(firstManifestRaw) as {
    builder?: {
      executedCandidateLifecycleScript?: boolean
      networkAccess?: boolean
      sandbox?: { kind?: string }
    }
  }
  const manifestValidates = validateManifest('build', JSON.parse(firstManifestRaw))?.ok === true
  const builderTrustHeld =
    manifestValidates &&
    firstManifest.builder?.executedCandidateLifecycleScript === false &&
    firstManifest.builder?.networkAccess === false &&
    ['namespace', 'container'].includes(String(firstManifest.builder?.sandbox?.kind ?? ''))

  // ---- packed-capsule offline container boot ----------------------------
  let containerNodeVersion = 'unknown'
  let dockerVersion = 'unavailable'
  let container: Record<string, unknown> = { booted: false }
  let dockerAvailable = true
  try {
    dockerVersion = await dockerServerVersion()
    await exec('docker', ['pull', NODE_IMAGE], { timeout: 300_000 })
    const { stdout } = await exec(
      'docker',
      ['run', '--rm', '--network', 'none', NODE_IMAGE, 'node', '--version'],
      { timeout: 120_000 },
    )
    containerNodeVersion = stdout.trim()

    const payloadDir = await freshWorkRoot('dsh-gate1-payload-')
    scratch.push(payloadDir)
    const capsuleTar = join(workRoot1, 'capsule.tar')
    await writeFile(join(payloadDir, 'capsule.tar'), await readFile(capsuleTar))
    const hostDigest = createHash('sha256')
      .update(await readFile(capsuleTar))
      .digest('hex')

    const entrypoint = [
      'set -e',
      'mkdir /capsule',
      'cd /capsule',
      'tar -xf /payload/capsule.tar',
      'sha256sum -c SHA256SUMS > /dev/null',
      'exec node runner/bin/acp-boot.js cordis.yml',
    ].join('; ')
    const acp = await runAcpSession(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-i',
        '-v',
        `${payloadDir}:/payload:ro`,
        NODE_IMAGE,
        'sh',
        '-c',
        entrypoint,
      ],
      { timeoutMs: 120_000 },
    )
    const chunks = acp.updates
      .filter(
        (update: { sessionUpdate?: string }) => update.sessionUpdate === 'agent_message_chunk',
      )
      .map((update: { content?: { text?: string } }) => update.content?.text ?? '')
    container = {
      booted:
        !acp.timedOut &&
        acp.exitCode === 0 &&
        acp.initialize.protocolVersion === 1 &&
        acp.stopReason === 'end_turn' &&
        chunks.some((text: string) => text.includes('[candidate:identity]')) &&
        acp.report?.quiescent === true,
      exitCode: acp.exitCode,
      protocolVersion: acp.initialize.protocolVersion,
      stopReason: acp.stopReason,
      identityStreamed: chunks.some((text: string) => text.includes('[candidate:identity]')),
      unloadInvariantHeld: acp.report?.quiescent === true,
      tarDigestMatchesManifest: hostDigest === first.capsule?.tarSha256,
      nodeVersion: containerNodeVersion,
      stderrTail: acp.stderr.slice(-400),
    }
  } catch (error) {
    dockerAvailable = false
    container = {
      booted: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const evidence = {
    gate: 'gate1',
    kind: 'builder-capsule-acp',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      repositoryHead: await gitHead(),
      builderVersion: BUILDER_VERSION,
      builderSandbox: describeSandbox(),
      dockerServerVersion: dockerVersion,
      containerNodeVersion,
    },
    acceptance: {
      goldenAdmittedTenStages: allReceiptsPass,
      doubleBuildIdentical,
      rejectionsEnforced,
      builderTrustHeld,
      capsuleBootsOfflineContainer:
        container.booted === true && container.tarDigestMatchesManifest === true && dockerAvailable,
    },
    goldenBuilds: {
      first: {
        candidateId: first.candidateId,
        sourceDigest: first.sourceDigest,
        bundleTarSha256: first.bundle?.tarSha256 ?? null,
        capsuleTarSha256: first.capsule?.tarSha256 ?? null,
        capsuleSbomSha256: first.capsule?.sbomSha256 ?? null,
        capsuleProvenanceSha256: first.capsule?.provenanceSha256 ?? null,
        receipts: first.receipts,
      },
      second: {
        candidateId: second.candidateId,
        sourceDigest: second.sourceDigest,
        bundleTarSha256: second.bundle?.tarSha256 ?? null,
        capsuleTarSha256: second.capsule?.tarSha256 ?? null,
        capsuleSbomSha256: second.capsule?.sbomSha256 ?? null,
        capsuleProvenanceSha256: second.capsule?.provenanceSha256 ?? null,
      },
    },
    adversarialFixtures: fixtureRuns,
    containerBoot: container,
  }

  const targetDir = resolve(repoRoot, 'evidence/gate1')
  await mkdir(targetDir, { recursive: true })
  const target = join(targetDir, 'builder.json')
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`)
  // The first build's full manifest travels with the evidence for audit;
  // scratch trees are cleaned below, so this is the surviving copy.
  await writeFile(join(targetDir, 'build-manifest.json'), `${firstManifestRaw.trim()}\n`)

  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })))

  console.log(`evidence written: ${target}`)
  const acceptance = evidence.acceptance
  for (const [flag, value] of Object.entries(acceptance)) {
    console.log(`acceptance: ${flag}=${String(value)}`)
  }
  return Object.values(acceptance).every((value) => value === true) ? 0 : 1
}

process.exitCode = await main()
