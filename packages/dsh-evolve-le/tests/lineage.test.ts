/**
 * Parent-diff admission contract tests (Gate 4, specs/02 §10, specs/03 §9).
 *
 * A non-root candidate is admitted only against its declared canonical parent:
 * the supplied parent tree must re-capture to the declared digest, the child
 * must preserve every parent-declared prompt section name, the diff must stay
 * inside the pre-registered line cap, and the real-Loader boot must expose
 * exactly the declared sections per mode. These tests pin each rejection and
 * the admitted-child record in the build manifest.
 */
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCandidate, type BuildResult } from '../src/builder/pipeline.js'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const baselineSource = join(repoRoot, 'packages/candidate-baseline')

/** Work roots are cleaned up after the suite. */
const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function freshWorkRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lineage-'))
  workRoots.push(root)
  return root
}

/** Add owner-write bits over a copied canonical tree so variants can edit it. */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o755)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name)
    if (entry.isDirectory()) await makeWritable(at)
    else await chmod(at, 0o644)
  }
}

interface ChildVariant {
  /** Rewrite of candidate.json applied after the copy. */
  manifest?: (manifest: Record<string, unknown>) => Record<string, unknown>
  /** Extra file to add to the source (path → content). */
  addFile?: { path: string; content: string }
  /** Replacement for src/index.ts. */
  indexSource?: string
}

/** Copy the canonical parent tree and apply a variant's edits. */
async function childSource(parentTreeDir: string, variant: ChildVariant): Promise<string> {
  const dir = join(await freshWorkRoot(), 'child')
  await mkdir(dir, { recursive: true })
  await cp(parentTreeDir, dir, { recursive: true })
  await makeWritable(dir)
  if (variant.manifest !== undefined) {
    const manifestPath = join(dir, 'candidate.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify(variant.manifest(manifest), null, 2)}\n`)
  }
  if (variant.addFile !== undefined) {
    const path = join(dir, ...variant.addFile.path.split('/'))
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, variant.addFile.content)
  }
  if (variant.indexSource !== undefined) {
    await writeFile(join(dir, 'src/index.ts'), variant.indexSource)
  }
  return dir
}

/** Rewrite the lineage fields of a copied parent manifest into a child's. */
function asChildOf(
  parentDigest: string,
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...manifest,
    canonicalParent: parentDigest,
    proposal: {
      ...(manifest.proposal as Record<string, unknown>),
      hypothesis:
        'Child revision: tighten the solve-mode identity section wording; no tool or protocol change.',
      evidenceRefs: ['evidence://gate4/lineage-contract'],
    },
  }
}

describe('non-root candidates admit through the verified parent diff', () => {
  let parent: BuildResult
  /**
   * The staged source slot is the pure canonical parent tree: unlike
   * `artifacts.treeDir` it never gains the offline `node_modules/` the bundle
   * stage installs, so re-capturing it reproduces the parent digest exactly.
   */
  let parentTreeDir: string

  beforeAll(async () => {
    parent = await buildCandidate({
      sourceDir: baselineSource,
      workRoot: await freshWorkRoot(),
    })
    parentTreeDir = join(parent.artifacts.workRoot, 'staged-src')
  }, 300_000)

  it('admits a child with an identity-bound parentDiff in the build manifest', async () => {
    const original = await readFile(join(baselineSource, 'src/index.ts'), 'utf8')
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => asChildOf(parent.sourceDigest, manifest),
      indexSource: original.replace(
        'in solve mode. Candidate-owned tools and skills provide bounded strategy',
        'in solve mode (child revision). Candidate-owned tools and skills provide bounded strategy',
      ),
    })
    const child = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    expect(child.outcome).toBe('admitted')
    expect(child.sourceDigest).not.toBe(parent.sourceDigest)
    expect(child.candidateId).not.toBe(parent.candidateId)

    const identity = child.manifest.identity as Record<string, unknown>
    expect(identity.canonicalParent).toBe(parent.sourceDigest)
    const parentDiff = child.manifest.parentDiff as {
      parent: string
      diffHash: string
      filesChanged: number
      linesAdded: number
      linesRemoved: number
      differingFiles: { path: string; status: string }[]
    }
    expect(parentDiff.parent).toBe(parent.sourceDigest)
    expect(parentDiff.diffHash).toMatch(/^[0-9a-f]{64}$/)
    expect(parentDiff.filesChanged).toBe(2)
    expect(new Set(parentDiff.differingFiles.map((file) => file.path))).toEqual(
      new Set(['candidate.json', 'src/index.ts']),
    )
    expect(parentDiff.differingFiles.every((file) => file.status === 'modified')).toBe(true)
    expect(parentDiff.linesAdded).toBeGreaterThan(0)
  }, 300_000)

  it('derives the same diffHash for the same child bytes (deterministic boundary)', async () => {
    const original = await readFile(join(baselineSource, 'src/index.ts'), 'utf8')
    const variant = {
      manifest: (manifest: Record<string, unknown>) => asChildOf(parent.sourceDigest, manifest),
      indexSource: original.replace(
        'in propose mode. Produce one proposal manifest',
        'in propose mode (child revision). Produce one proposal manifest',
      ),
    }
    const first = await buildCandidate({
      sourceDir: await childSource(parentTreeDir, variant),
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    const second = await buildCandidate({
      sourceDir: await childSource(parentTreeDir, variant),
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    expect(first.outcome).toBe('admitted')
    expect(second.outcome).toBe('admitted')
    const diffOf = (result: BuildResult) =>
      (result.manifest.parentDiff as { diffHash: string }).diffHash
    expect(diffOf(second)).toBe(diffOf(first))
  }, 600_000)

  it('rejects a declared parent digest the supplied tree does not hash to', async () => {
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => asChildOf(`sha256:${'1'.repeat(64)}`, manifest),
    })
    const result = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('diffBoundary')
    expect(result.rejection?.reason).toContain('declares sha256:1111')
    expect(result.receipts.policyScan?.status).toBe('skipped')
  }, 120_000)

  it('rejects a declared parent with no parent source tree supplied', async () => {
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => asChildOf(parent.sourceDigest, manifest),
    })
    const result = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('diffBoundary')
    expect(result.rejection?.reason).toContain('no parent source tree was supplied')
  }, 120_000)

  it('rejects a child that drops a parent-declared section name', async () => {
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => {
        const child = asChildOf(parent.sourceDigest, manifest)
        const runtime = child.runtime as {
          promptSections: Record<string, { name: string; order: number }[]>
        }
        runtime.promptSections.propose = [{ name: 'candidate:other-policy', order: 100 }]
        return child
      },
    })
    const result = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('diffBoundary')
    expect(result.rejection?.reason).toContain('preservation violation')
    expect(result.rejection?.reason).toContain('candidate:proposal-policy')
  }, 120_000)

  it('rejects a diff exceeding the pre-registered changed-line cap', async () => {
    const huge = `${Array.from(
      { length: 5100 },
      (_, index) => `export const filler${index} = ${index}`,
    ).join('\n')}\n`
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => asChildOf(parent.sourceDigest, manifest),
      addFile: { path: 'src/filler.ts', content: huge },
    })
    const result = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('diffBoundary')
    expect(result.rejection?.reason).toContain('exceed the pre-registered cap')
  }, 120_000)

  it('rejects a declaration the booted plugin does not expose', async () => {
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => {
        const child = asChildOf(parent.sourceDigest, manifest)
        const runtime = child.runtime as {
          promptSections: Record<string, { name: string; order: number }[]>
        }
        runtime.promptSections.solve = [
          ...runtime.promptSections.solve,
          { name: 'candidate:extra', order: 200 },
        ]
        return child
      },
    })
    const result = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
      parentTreeDir: parentTreeDir,
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('loaderBoot')
    expect(result.rejection?.reason).toContain('candidate:extra')
  }, 300_000)

  it('rejects a lineage root that declares no sections to verify', async () => {
    const childDir = await childSource(parentTreeDir, {
      manifest: (manifest) => ({
        ...manifest,
        runtime: {
          ...(manifest.runtime as Record<string, unknown>),
          promptSections: {
            solve: [],
            propose: [{ name: 'candidate:proposal-policy', order: 100 }],
          },
        },
      }),
    })
    const result = await buildCandidate({
      sourceDir: childDir,
      workRoot: await freshWorkRoot(),
    })
    expect(result.outcome).toBe('rejected')
    expect(result.rejection?.stage).toBe('loaderBoot')
    expect(result.rejection?.reason).toContain('declares no solve promptSections')
  }, 300_000)
})
