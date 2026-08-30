/**
 * Trusted builder contract tests (Gate 1, specs/02 §11, specs/07 §3).
 *
 * The builder is the admission pipeline: ten ordered stages, fail-fast,
 * honest receipts, and byte-identical artifacts across two clean builds of
 * the golden candidate. These tests are the Gate 1 acceptance harness —
 * `scripts/record-gate1-evidence.ts` re-runs the same assertions and writes
 * the machine-checkable evidence document.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCandidate, STAGE_ORDER, type BuildResult } from '../src/builder/pipeline.js'
import { validateManifest } from '../src/schema.js'
import { NODE_RUNTIME_BINARY_SHA256, NODE_RUNTIME_VERSION } from '../src/builder/pinned-runtime.js'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const baselineSource = join(repoRoot, 'packages/candidate-baseline')
const scanCases = join(repoRoot, 'packages/dsh-evolve-le/tests/fixtures/scan/cases')

/** Builder work roots are cleaned up after the suite. */
const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function freshWorkRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-evolve-builder-'))
  workRoots.push(root)
  return root
}

describe('golden candidate builds reproducibly', () => {
  let first: BuildResult
  let second: BuildResult

  beforeAll(async () => {
    first = await buildCandidate({
      sourceDir: baselineSource,
      workRoot: await freshWorkRoot(),
    })
    second = await buildCandidate({
      sourceDir: baselineSource,
      workRoot: await freshWorkRoot(),
    })
  }, 300_000)

  it('admits the golden candidate with all ten stages passing', () => {
    expect(first.outcome).toBe('admitted')
    expect(Object.keys(first.receipts)).toEqual(STAGE_ORDER)
    for (const stage of STAGE_ORDER) {
      expect(first.receipts[stage]?.status, `${stage} receipt`).toBe('pass')
    }
  })

  it('derives the candidate id from the canonical source tar', () => {
    expect(first.candidateId).toMatch(/^c_[a-z2-7]{26}$/)
    expect(first.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(second.candidateId).toBe(first.candidateId)
  })

  it('two clean builds produce identical source, bundle and capsule hashes', () => {
    expect(second.bundle?.tarSha256).toBe(first.bundle?.tarSha256)
    expect(second.capsule?.tarSha256).toBe(first.capsule?.tarSha256)
    expect(second.capsule?.sbomSha256).toBe(first.capsule?.sbomSha256)
    expect(second.capsule?.provenanceSha256).toBe(first.capsule?.provenanceSha256)
  })

  it('produces a byte-identical capsule tree across builds', async () => {
    const readSums = async (result: BuildResult) =>
      readFile(join(result.artifacts.capsuleDir, 'SHA256SUMS'), 'utf8')
    expect(await readSums(second)).toBe(await readSums(first))
  })

  it('capsule layout matches specs/02 §12', async () => {
    const capsuleDir = first.artifacts.capsuleDir
    const top = new Set(await readdir(capsuleDir))
    for (const expected of [
      'runtime',
      'candidate',
      'runner',
      'manifest.json',
      'provenance.json',
      'sbom.spdx.json',
      'SHA256SUMS',
    ]) {
      expect(top.has(expected), `capsule contains ${expected}`).toBe(true)
    }
    const entryStat = await stat(join(capsuleDir, 'candidate/lib/index.js'))
    expect(entryStat.isFile()).toBe(true)
  })

  it('capsule embeds the pinned node runtime, covered by SHA256SUMS and manifests', async () => {
    // specs/02 §12: the capsule is self-contained — TB task images ship no
    // node, so runtime/node is the interpreter every trial execs. It must be
    // the digest-locked binary, executable, listed in SHA256SUMS and
    // cross-bound in both identity documents.
    const capsuleDir = first.artifacts.capsuleDir
    const runtimeStat = await stat(join(capsuleDir, 'runtime/node'))
    expect(runtimeStat.isFile()).toBe(true)
    expect(runtimeStat.mode & 0o111).not.toBe(0)
    const runtimeBytes = await readFile(join(capsuleDir, 'runtime/node'))
    const digest = createHash('sha256').update(runtimeBytes).digest('hex')
    expect(digest).toBe(NODE_RUNTIME_BINARY_SHA256)
    const sums = await readFile(join(capsuleDir, 'SHA256SUMS'), 'utf8')
    expect(sums).toContain(`${NODE_RUNTIME_BINARY_SHA256}  runtime/node`)
    const capsuleManifest = JSON.parse(
      await readFile(join(capsuleDir, 'manifest.json'), 'utf8'),
    ) as { runtime: { nodeRuntime?: { version: string; path: string; sha256: string } } }
    expect(capsuleManifest.runtime.nodeRuntime).toEqual({
      version: NODE_RUNTIME_VERSION,
      path: 'runtime/node',
      sha256: NODE_RUNTIME_BINARY_SHA256,
    })
    const provenance = JSON.parse(await readFile(join(capsuleDir, 'provenance.json'), 'utf8')) as {
      nodeRuntime?: { version: string; sha256: string }
    }
    expect(provenance.nodeRuntime).toEqual({
      version: NODE_RUNTIME_VERSION,
      sha256: NODE_RUNTIME_BINARY_SHA256,
    })
  })

  it('capsule and build manifests validate against the versioned schemas', async () => {
    const capsuleManifest = JSON.parse(
      await readFile(join(first.artifacts.capsuleDir, 'manifest.json'), 'utf8'),
    )
    expect(validateManifest('capsule', capsuleManifest)).toMatchObject({ ok: true })
    expect(validateManifest('build', first.manifest)).toMatchObject({ ok: true })
  })

  it('runner boots offline from the packed capsule without the source checkout', async () => {
    // The runner directory is self-contained: probe + boot + inventory
    // compiled files plus the flat pinned node_modules under runtime/.
    const probeStat = await stat(join(first.artifacts.capsuleDir, 'runner/bin/probe.js'))
    expect(probeStat.isFile()).toBe(true)
    const bootReport = JSON.parse(
      await readFile(join(first.artifacts.workRoot, 'boot-solve.json'), 'utf8'),
    ) as { sections: { afterBoot: string[] }; quiescent: boolean; error?: string }
    expect(bootReport.error).toBeUndefined()
    expect(bootReport.sections.afterBoot).toEqual(['candidate:identity'])
    expect(bootReport.quiescent).toBe(true)
  })

  it('builder never executed a candidate lifecycle script and ran offline', () => {
    const builder = first.manifest.builder as Record<string, unknown>
    expect(builder.executedCandidateLifecycleScript).toBe(false)
    expect(builder.networkAccess).toBe(false)
    expect(['namespace', 'container']).toContain((builder.sandbox as { kind: string }).kind)
  })
})

describe('builder rejects out-of-policy candidates', () => {
  it('stops at policyScan for a stray default export', async () => {
    const result = await buildCandidate({
      sourceDir: join(scanCases, 'default-export'),
      workRoot: await freshWorkRoot(),
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('policyScan')
    expect(result.receipts.policyScan?.status).toBe('fail')
    // Fail-fast: everything after the failing stage is skipped, not invented.
    expect(result.receipts.reproducibleBuild?.status).toBe('skipped')
    expect(result.receipts.capsuleDoubleBuild?.status).toBe('skipped')
    expect(result.bundle).toBeUndefined()
  }, 120_000)

  it('stops at policyScan for a package with an install script', async () => {
    const result = await buildCandidate({
      sourceDir: join(scanCases, 'install-script'),
      workRoot: await freshWorkRoot(),
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('policyScan')
    const builder = result.manifest.builder as Record<string, unknown>
    expect(builder.executedCandidateLifecycleScript).toBe(false)
  }, 120_000)

  it('reports scan findings in the receipt detail', async () => {
    const result = await buildCandidate({
      sourceDir: join(scanCases, 'dynamic-import'),
      workRoot: await freshWorkRoot(),
    })
    expect(result.receipts.policyScan?.detail).toContain('import/dynamic')
  }, 120_000)
})
