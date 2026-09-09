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
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCandidate, STAGE_ORDER, type BuildResult } from '../src/builder/pipeline.js'
import { bootConfig } from '../src/builder/capsule.js'
import { toolchainFingerprints } from '../src/builder/pins.js'
import { validateManifest } from '../src/schema.js'
import { NODE_RUNTIME_BINARY_SHA256, NODE_RUNTIME_VERSION } from '../src/builder/pinned-runtime.js'
import {
  finalizeTreeV2Receipt,
  treeV2RuntimeFingerprint,
  TREE_V2_PROTOCOL,
} from '../src/tree-v2/contract.js'

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

it('records a non-empty pnpm identity from the frozen Corepack packageManager pin', async () => {
  const toolchain = await toolchainFingerprints()
  expect(toolchain.pnpm).toMatch(/^\d+\.\d+\.\d+$/)
})

it('mounts the TCB workflow declaration registry beside the native DSH spine', () => {
  const nativeConfig = bootConfig('candidate-package', 'c_candidate', 'solve', {})
  expect(nativeConfig).toContain("name: './runtime/candidate-workflow-stub.mjs'")
  expect(nativeConfig).not.toContain("name: './runtime/system-prompt-stub.mjs'")
  const compatibilityConfig = bootConfig('candidate-package', 'c_candidate', 'solve')
  expect(compatibilityConfig).toContain("name: './runtime/system-prompt-stub.mjs'")
})

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

  it('packs the live-solve protocol, client and agent into the production runner', async () => {
    const capsuleDir = first.artifacts.capsuleDir
    const sums = await readFile(join(capsuleDir, 'SHA256SUMS'), 'utf8')
    for (const relative of [
      'runner/acp/solve-protocol.js',
      'runner/acp/solve-client.js',
      'runner/acp/live-solve-agent.js',
      // Native admission runs this probe under the capsule's own runtime;
      // retaining it in every archive keeps assembly independent of a run's
      // model-route selection.
      'runner/bin/native-turn-probe.js',
      'runner/bin/native-proposal-probe.js',
      'runner/bin/native-solve-probe.js',
      'runner/dsh/native-runner.js',
      'runner/proposer/protocol.js',
    ]) {
      expect(
        (await stat(join(capsuleDir, relative))).isFile(),
        `capsule contains ${relative}`,
      ).toBe(true)
      expect(sums).toContain(`  ${relative}`)
    }
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

describe('tree-v2 trusted build', () => {
  it('proves target/preserved modes and emits the four builder-owned receipts', async () => {
    const parentSource = await freshWorkRoot()
    await cp(baselineSource, parentSource, { recursive: true })
    const originalRoot = await readFile(join(parentSource, 'src/index.ts'), 'utf8')
    await writeFile(
      join(parentSource, 'src/propose.ts'),
      'export const proposeModeBoundary = true\n',
    )

    const parent = await buildCandidate({
      sourceDir: parentSource,
      workRoot: await freshWorkRoot(),
    })
    expect(parent.outcome, parent.rejection?.reason).toBe('admitted')
    const parentSolve = JSON.parse(
      await readFile(join(parent.artifacts.workRoot, 'boot-solve.json'), 'utf8'),
    ) as unknown
    const parentPropose = JSON.parse(
      await readFile(join(parent.artifacts.workRoot, 'boot-propose.json'), 'utf8'),
    ) as unknown
    // ADR-039: mask the parent's own id — the baseline section text embeds
    // config.candidateId, and the child mounts under a DIFFERENT id; raw text
    // hashing would break the preserved-mode contract on identity alone.
    const parentModeFingerprints = {
      solve: treeV2RuntimeFingerprint(parentSolve, 'solve', { candidateId: parent.candidateId }),
      propose: treeV2RuntimeFingerprint(parentPropose, 'propose', {
        candidateId: parent.candidateId,
      }),
    }
    // ADR-039: the real Loader probe reports mounted section CONTENT
    // (name/order/text), not just names — the runtime fingerprint depends on it.
    const probeSurfaces = (
      parentSolve as { sectionSurfaces?: { afterBoot?: Array<Record<string, unknown>> } }
    ).sectionSurfaces?.afterBoot
    expect(probeSurfaces?.length).toBeGreaterThan(0)
    for (const section of probeSurfaces ?? []) {
      expect(typeof section['name']).toBe('string')
      expect(typeof section['order']).toBe('number')
      expect(typeof section['text']).toBe('string')
      expect(String(section['text']).length).toBeGreaterThan(0)
    }

    const childSource = await freshWorkRoot()
    await cp(parentSource, childSource, { recursive: true })
    const childRoot = `${originalRoot
      .replace(
        "import type { Context } from '@deepseek-ai/cordis'",
        "import type { Context } from '@deepseek-ai/cordis'\nimport { evolvedSolvePlugin } from './evolved-solve.js'",
      )
      .replace(
        'export function apply(ctx: Context, config: Config): void {',
        'export function mountCandidate(ctx: Context, config: Config): void {',
      )}\nconst component = Object.assign(mountCandidate, { inject })\n\nexport function apply(ctx: Context, config: Config): void {\n  ctx.plugin(component, config)\n  ctx.plugin(evolvedSolvePlugin, config)\n}\n`
    await writeFile(join(childSource, 'src/index.ts'), childRoot, 'utf8')
    const preservationTest = await readFile(join(childSource, 'tests/candidate.spec.ts'), 'utf8')
    await writeFile(
      join(childSource, 'tests/candidate.spec.ts'),
      preservationTest.replace(
        "import { apply, type Config } from '../src/index.js'",
        "import { mountCandidate as apply, type Config } from '../src/index.js'",
      ),
      'utf8',
    )
    await writeFile(
      join(childSource, 'src/evolved-solve.ts'),
      `import type { Context } from '@deepseek-ai/cordis'

interface Config { mode: 'solve' | 'propose' }

export function evolvedSolve(ctx: Context, config: Config): void {
  if (config.mode !== 'solve') return
  const prompt = (ctx as unknown as { systemPrompt: { section(input: { name: string; order: number; text: string }): () => void } }).systemPrompt
  ctx.effect(() => prompt.section({ name: 'candidate:evolved-solve', order: 110, text: 'Verify the selected tool result before continuing.' }))
}

export const evolvedSolvePlugin = Object.assign(evolvedSolve, { inject: ['systemPrompt'] })
`,
      'utf8',
    )
    await writeFile(
      join(childSource, 'tests/evolved-solve.spec.ts'),
      `import { describe, expect, it } from 'vitest'
import { createHarness } from '@dsh-evolve-le/candidate-sdk/testkit'
import { evolvedSolve } from '../src/evolved-solve.js'

describe('evolved solve mechanism', () => {
  it('changes solve and preserves propose', () => {
    const solve = createHarness()
    evolvedSolve(solve.ctx, { mode: 'solve' })
    expect(solve.sections().map((section) => section.name)).toEqual(['candidate:evolved-solve'])
    const propose = createHarness()
    evolvedSolve(propose.ctx, { mode: 'propose' })
    expect(propose.sections()).toEqual([])
  })
})
`,
      'utf8',
    )
    const requiredParentEvidence = {
      analysisDigest: `sha256:${'1'.repeat(64)}`,
      mechanismOutcomeDigest: `sha256:${'2'.repeat(64)}`,
      normalizedTrialDigest: `sha256:${'3'.repeat(64)}`,
      trajectoryDigest: `sha256:${'4'.repeat(64)}`,
    }
    const candidateIntent = finalizeTreeV2Receipt({
      $schema: 'https://dsh-evolve-le.local/schema/tree-v2/candidate-intent/v2',
      schemaVersion: 2,
      protocol: TREE_V2_PROTOCOL,
      kind: 'candidate-intent' as const,
      candidate: {
        name: '@dsh-evolve-le/candidate-baseline',
        version: '0.1.0',
        entry: 'src/index.ts' as const,
      },
      parent: { candidateDigest: parent.sourceDigest, sourceDigest: parent.sourceDigest },
      modeContract: { targetModes: ['solve' as const], preservedModes: ['propose' as const] },
      requiredParentEvidence,
      runtime: {
        modeComponents: { solve: ['src/index.ts'], propose: ['src/propose.ts'] },
        capabilities: ['system-prompt', 'tools', 'skills'],
        modeSurfaces: {
          solve: {
            promptSections: [
              { name: 'candidate:identity', order: 100 },
              { name: 'candidate:evolved-solve', order: 110 },
            ],
            newToolNames: ['candidate_strategy_snapshot'],
            newSkillNames: ['candidate-strategy-review'],
            agentEventNames: [],
            sessionEventNames: [],
            workflowNames: [],
          },
          propose: {
            promptSections: [{ name: 'candidate:proposal-policy', order: 100 }],
            newToolNames: ['candidate_strategy_snapshot'],
            newSkillNames: ['candidate-strategy-review'],
            agentEventNames: [],
            sessionEventNames: [],
            workflowNames: [],
          },
        },
      },
      tests: {
        command: 'pnpm test',
        mechanism: ['tests/evolved-solve.spec.ts'],
        preservation: ['tests/candidate.spec.ts'],
      },
    })
    await writeFile(
      join(childSource, 'candidate.json'),
      `${JSON.stringify(candidateIntent, null, 2)}\n`,
      'utf8',
    )

    const child = await buildCandidate({
      sourceDir: childSource,
      workRoot: await freshWorkRoot(),
      parentTreeDir: join(parent.artifacts.workRoot, 'staged-src'),
      treeV2ParentEvidence: { requiredParentEvidence, modeFingerprints: parentModeFingerprints },
    })
    expect(child.outcome, child.rejection?.reason).toBe('admitted')
    expect(child.treeV2?.receipts.mechanismOutcome.outcome).toBe('passed')
    expect(child.treeV2?.receipts.admission.admitted).toBe(true)
    expect(await readdir(child.artifacts.treeV2ReceiptsDir!)).toEqual([
      'admission-receipt.json',
      'capability-catalog.json',
      'materialization-receipt.json',
      'mechanism-outcome.json',
    ])
  }, 300_000)
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
