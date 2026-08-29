/**
 * Gate 7 evidence recorder (specs/07 §9 — open-source v0.1 release candidate).
 *
 * Orchestrates the two Gate 7 producers against the COMMITTED tree and records
 * one machine-checkable document:
 *
 *   1. `scripts/make-release.ts`   — source tarball (`git archive HEAD`),
 *      checksums, SPDX SBOM, dependency-license allowlist scan, secret-pattern
 *      scan, UTF-8 validation → release/report.json;
 *   2. `scripts/verify-fresh-install.ts` — clean-profile install from that
 *      tarball, real Loader smoke, default-config K=3 demo, EXECUTED
 *      prior-state restore + snapshot-loss reconstruction, uninstall.
 *
 * Acceptance (all must hold; fail closed otherwise):
 *   - the working tree is clean, so the scanned tarball is exactly what ships;
 *   - every release scan is green (0 non-allowlisted licenses, 0 secret hits,
 *     0 non-UTF-8 files) and the tarball carries the full public doc set;
 *   - all fresh-install checks are green, including the restore/uninstall
 *     drills and the STABLE_ITERATION_VERIFIED demo;
 *   - LICENSE in the shipped tree is the MIT text.
 *
 * Machine-checkable documents: evidence/gate7/release-candidate.json
 * (+ STATUS.json). The tarball/SBOM/checksums stay in gitignored release/;
 * their sha256 digests are recorded in the evidence document.
 *
 * Usage: node --import tsx/esm scripts/record-gate7-evidence.ts
 * @module scripts/record-gate7-evidence
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

interface ReleaseReport {
  name: string
  version: string
  sourceCommit: string
  tarball: { file: string; sha256: string; bytes: number; fileCount: number }
  utf8: { checked: number; invalid: string[] }
  secrets: { hits: Array<{ pattern: string; path: string; line: number }> }
  licenses: {
    dependencyCount: number
    unlicensed: string[]
    disallowed: string[]
    byLicense: Record<string, number>
  }
  sbom: { file: string; packages: number }
  checksums: { file: string; sha256: string }
}

interface FreshInstallSummary {
  version: string
  installSeconds: number
  demoSeconds: number
  demo: {
    stopReason: string
    status: string
    trials: number
    discoveryTrials: number
    expansionAttempts: number
    admittedNonBaseline: number
    lineageDepthMax: number
    failurePool: number
    stateHash: string
  }
  restore: { seq: number; snapshotHash: string; replayHash: string }
  checks: Array<{ name: string; ok: boolean; detail?: string }>
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a repo script with tsx, never throwing: failures become { code != 0 }. */
async function runScript(script: string, timeoutMs: number): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx/esm', script], {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 64 << 20,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message: string }
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message }
  }
}

async function main(): Promise<void> {
  const gateDir = join(repoRoot, 'evidence', 'gate7')
  await rm(gateDir, { recursive: true, force: true })
  await mkdir(gateDir, { recursive: true })

  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string
    license?: string
  }
  const { stdout: headOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  const head = headOut.trim()

  const failures: string[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    if (!ok) failures.push(detail === undefined ? name : `${name} (${detail})`)
  }

  // ---- 0. the shipped tree must be the committed tree ----------------------
  // Untracked paths are tolerated only where this gate itself writes
  // (evidence/gate7, gitignored release/). Modified tracked files would mean
  // the scan covers something that never ships.
  const { stdout: statusOut } = await exec('git', ['status', '--porcelain'], { cwd: repoRoot })
  const dirty = statusOut
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !/^(?:\?\?|A | M|M |AM)\s+(?:evidence\/gate7\/|release\/)/.test(line))
  check(
    'committedTreeClean',
    dirty.length === 0,
    dirty.length === 0 ? undefined : dirty.slice(0, 3).join(' | '),
  )

  // ---- 1. release artifacts + scans (over `git archive HEAD`) --------------
  console.log('gate7: building release artifacts (tarball, SBOM, checksums, scans)…')
  const releaseRun = await runScript('scripts/make-release.ts', 600_000)
  console.log(releaseRun.stdout.trimEnd())
  if (releaseRun.stderr.trim() !== '') console.error(releaseRun.stderr.trimEnd())
  check('releaseArtifactsBuilt', releaseRun.code === 0, `exit ${String(releaseRun.code)}`)
  const releaseReport = JSON.parse(
    await readFile(join(repoRoot, 'release', 'report.json'), 'utf8'),
  ) as ReleaseReport

  check('tarballFromHeadCommit', releaseReport.sourceCommit === head)
  check('releaseVersionMatchesManifest', releaseReport.version === manifest['version'])
  check('utf8Clean', releaseReport.utf8.invalid.length === 0)
  check('noSecretHits', releaseReport.secrets.hits.length === 0)
  check('allDependencyLicensesAllowlisted', releaseReport.licenses.disallowed.length === 0)
  check('noUnlicensedDependencies', releaseReport.licenses.unlicensed.length === 0)
  check(
    'sbomPresent',
    releaseReport.sbom.packages > 5,
    `${String(releaseReport.sbom.packages)} packages`,
  )
  check('checksumsPresent', existsSync(join(repoRoot, 'release', 'checksums.sha256')))

  // ---- 2. the shipped tree carries the public doc + governance set ---------
  const { stdout: lsOut } = await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
    cwd: repoRoot,
    maxBuffer: 32 << 20,
  })
  const tracked = new Set(lsOut.split('\n').filter((name) => name.trim() !== ''))
  for (const doc of [
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    'PROJECT_STATUS.md',
    'docs/architecture-overview.md',
    'docs/quickstart.md',
    'docs/configuration.md',
    'docs/troubleshooting.md',
    'docs/evidence-guide.md',
    'docs/operations.md',
    'docs/terminal-bench-2.1-runbook.md',
  ]) {
    check(`shipped:${doc}`, tracked.has(doc))
  }
  const licenseText = await readFile(join(repoRoot, 'LICENSE'), 'utf8')
  check(
    'licenseIsMit',
    licenseText.startsWith('MIT License') && licenseText.includes('Permission is hereby granted'),
  )
  check('manifestLicenseMit', manifest['license'] === 'MIT')

  // ---- 3. fresh-profile install + demo + restore + uninstall (executed) ----
  console.log('gate7: fresh-profile install verification (this installs, builds, runs the demo…)')
  const installRun = await runScript('scripts/verify-fresh-install.ts', 3_600_000)
  if (installRun.stderr.trim() !== '') console.error(installRun.stderr.trimEnd())
  check('freshInstallGreen', installRun.code === 0, `exit ${String(installRun.code)}`)
  const fresh = JSON.parse(installRun.stdout) as FreshInstallSummary
  const freshCheck = (name: string): boolean =>
    fresh.checks.some((entry) => entry.name === name && entry.ok)
  for (const entry of fresh.checks) {
    if (!entry.ok) check(`fresh:${entry.name}`, false, entry.detail?.slice(0, 120))
  }
  check(
    'demoStableIterationVerified',
    fresh.demo.status === 'STABLE_ITERATION_VERIFIED' && fresh.demo.stopReason === 'K_REACHED',
    `${fresh.demo.status}/${fresh.demo.stopReason}`,
  )
  check(
    'restoreDrillExecuted',
    freshCheck('priorStateRestoredFromJournal') &&
      freshCheck('terminalStateReconstructedAfterSnapshotLoss') &&
      freshCheck('driveReportReDerivedAfterLoss') &&
      freshCheck('journalUnchangedByRestore') &&
      freshCheck('auditGreenAfterRestore'),
  )
  check(
    'uninstallExecuted',
    freshCheck('uninstallRemovesEverything') && freshCheck('noGlobalInstallsByDesign'),
  )
  check('realLoaderSmokeExecuted', freshCheck('realLoaderQuiescent'))

  // ---- 4. evidence out ------------------------------------------------------
  console.log('gate7: writing evidence…')
  const document = {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/gate7-release-candidate/v1',
    generatedAt: new Date().toISOString(),
    sourceCommit: head,
    version: manifest['version'],
    license: 'MIT',
    release: {
      tarball: releaseReport.tarball,
      checksums: releaseReport.checksums,
      sbom: releaseReport.sbom,
      licenses: releaseReport.licenses,
      secrets: releaseReport.secrets,
      utf8: releaseReport.utf8,
    },
    freshInstall: {
      installSeconds: fresh.installSeconds,
      demoSeconds: fresh.demoSeconds,
      demo: fresh.demo,
      restore: fresh.restore,
      checks: fresh.checks,
    },
  }
  await writeFile(join(gateDir, 'release-candidate.json'), `${JSON.stringify(document, null, 2)}\n`)
  await cp(join(repoRoot, 'release', 'checksums.sha256'), join(gateDir, 'checksums.sha256'))
  await cp(join(repoRoot, 'release', 'sbom.spdx.json'), join(gateDir, 'sbom.spdx.json'))
  await writeFile(
    join(gateDir, 'STATUS.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        gate: 7,
        status: failures.length === 0 ? 'PASS' : 'FAIL',
        failedChecks: failures,
        evidence: 'evidence/gate7/release-candidate.json',
        recordedAt: document.generatedAt,
      },
      null,
      2,
    )}\n`,
  )
  if (failures.length > 0) {
    console.error(`gate7 RELEASE CANDIDATE FAILED: ${failures.join(' | ')}`)
    process.exit(1)
  }
  console.log(
    'gate7: PASS — installable, scanned, documented v0.1 release candidate; restore and uninstall executed',
  )
}

await main()
