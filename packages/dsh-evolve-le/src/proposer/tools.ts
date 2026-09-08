/**
 * Proposer tool layer (Gate 4, specs/05 §10–§11, specs/07 §6): the sandbox's
 * ONLY filesystem channel. Reads resolve strictly under the read-only input
 * root (export view, parent capsule source), writes resolve strictly under
 * the per-child writable root. Traversal, absolute paths, symlink escapes and
 * special files are refused — the policy in code, not in prompts: instructions
 * found inside evidence are data and never widen this surface (the recorded
 * policy's injection branch proves it by trying).
 *
 * Every operation is journaled into an access log the agent loop embeds in
 * the transcript, so each proposal decision carries its source references.
 * @module @dsh-evolve-le/core/proposer/tools
 */

import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { finalizeTreeV2Bundle } from '../tree-v2/finalize-bundle.js'
import type { ArchiveCatalog } from './catalog.js'
import type { ExportManifest } from './export.js'
import type { ProposalOutput } from './protocol.js'

export const TOOLS_VERSION = 'dsh-evolve-le/proposer-tools/v1'

export const TOOL_CAPS = {
  maxFileBytes: 524_288,
  maxFilesPerChild: 25,
  maxTotalWriteBytes: 1_048_576,
} as const

/**
 * ADR-038: how many controller-side test runs one proposal session may spend
 * across ALL finalizeProposal retries. Two children per bundle = up to two
 * runs per successful finalization; a failing bundle costs one per failing
 * child, so 12 covers several fix-and-retry cycles.
 */
export const CANDIDATE_TEST_RUN_BUDGET = 12

export class ToolError extends Error {
  constructor(message: string) {
    super(`proposer-tools: ${message}`)
    this.name = 'ToolError'
  }
}

/** One journaled operation (source reference for the transcript). */
export interface AccessRecord {
  op: 'read' | 'list' | 'write'
  path: string
  bytes: number
  sha256?: string
}

export interface ProposerTools {
  /** List a directory under the input root (relative path, '' = root). */
  listInput(relDir: string): Promise<string[]>
  /** Read a file under the input root. */
  readInput(relPath: string): Promise<string>
  /** Read a file under the writable children root. */
  readChild(childName: string, relPath: string): Promise<string>
  /** Write one file of a child source tree (the only mutation surface). */
  writeChildFile(childName: string, relPath: string, content: string): Promise<void>
  /**
   * TCB finalization at the submit boundary (ADR-034): v1 bundles pass
   * through untouched; v2 receipt digests are DERIVED from the model's
   * semantic fields against the trusted export manifest, parent facts and
   * archive catalog — the model never authors a digest. Reads here are
   * controller-staged facts, so they are not journaled into the access log.
   */
  finalizeProposal(proposal: unknown): Promise<ProposalOutput>
  /** Every operation so far, in order. */
  accessLog(): readonly AccessRecord[]
}

/**
 * Resolve `rel` inside `root` and prove containment: no absolute paths, no
 * `..` segments, and the realpath must stay under the root's realpath. For a
 * target that does not exist yet, the deepest existing ancestor is checked
 * instead, so a symlink planted on the path cannot escape.
 */
async function resolveContained(root: string, rel: string, label: string): Promise<string> {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new ToolError(`${label}: empty relative path`)
  }
  if (rel.includes('\0')) throw new ToolError(`${label}: NUL byte in path`)
  const posixRel = rel.replaceAll('\\', '/')
  if (posixRel.startsWith('/')) throw new ToolError(`${label}: absolute path ${rel}`)
  for (const segment of posixRel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new ToolError(`${label}: unsafe segment in ${rel}`)
    }
  }
  const rootReal = await realpath(root)
  const prefix = rootReal.endsWith('/') ? rootReal : `${rootReal}/`
  const target = join(rootReal, ...posixRel.split('/'))
  let checked: string
  if (await existsReal(target)) {
    checked = await realpath(target)
  } else {
    // Walk up to the deepest existing ancestor and resolve that instead.
    let ancestor = dirname(target)
    while (!(await existsReal(ancestor))) ancestor = dirname(ancestor)
    const ancestorReal = await realpath(ancestor)
    const relative = ancestor === target ? '' : target.slice(ancestorReal.length + 1)
    checked = join(ancestorReal, relative)
  }
  if (checked !== rootReal && !checked.startsWith(prefix)) {
    throw new ToolError(`${label}: ${rel} escapes the sandbox root`)
  }
  return checked
}

async function existsReal(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => undefined)
  return stats !== undefined
}

/** Open the tool surface over an input root and a children root. */
export function openProposerTools(options: {
  inputRoot: string
  childrenRoot: string
  /** Trusted admission facts; required to finalize a v2 proposal bundle. */
  treeV2Parent?: { candidateDigest: string; mechanismOutcomeDigest: string }
  parentSourceHash?: string
  /**
   * ADR-038: controller-side stage-6 suite runner over a merged parent+child
   * view. Present on networked live routes (the worker speaks to the model
   * gateway socket); absent on recorded routes, which skip the check — the
   * controller's own typeLintUnit still gates every route.
   */
  candidateTestRunner?: (
    childName: string,
    files: Record<string, string>,
  ) => Promise<{ ok: boolean; output: string }>
}): ProposerTools {
  const log: AccessRecord[] = []
  const written = new Map<string, number>() // childName → model-authored bytes
  const writtenFileBytes = new Map<string, number>()
  const writtenPaths = new Set<string>()
  const fileCounts = new Map<string, number>()
  const seededChildren = new Set<string>()
  let candidateTestRuns = 0

  const record = (entry: AccessRecord): void => {
    log.push(entry)
  }

  /**
   * A tree-v2 child is a complete candidate source tree, not a patch. Seed its
   * trusted parent bytes before the model's first write so the writable view,
   * candidate-test view, and eventual scanned source are the same tree.
   * Parent bytes are controller-staged and deliberately do not consume the
   * model's write/file caps or access-log budget.
   */
  const seedChildFromParent = async (childName: string, childRoot: string): Promise<void> => {
    if (seededChildren.has(childName)) return
    const manifestPath = await resolveContained(
      options.inputRoot,
      'parent-files.json',
      'writeChildFile',
    )
    const manifest = await readFile(manifestPath, 'utf8').catch((error: unknown) => {
      const code =
        typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
      if (code === 'ENOENT') return undefined
      throw error
    })
    // Non-tree-v2/unit-test callers do not stage a parent source view.
    if (manifest === undefined) {
      seededChildren.add(childName)
      return
    }
    let parentFileList: unknown
    try {
      parentFileList = JSON.parse(manifest) as unknown
    } catch (error) {
      throw new ToolError(
        `writeChildFile: parent-files.json unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    if (
      !Array.isArray(parentFileList) ||
      parentFileList.some((entry) => typeof entry !== 'string') ||
      new Set(parentFileList).size !== parentFileList.length
    ) {
      throw new ToolError('writeChildFile: parent-files.json must be a unique string array')
    }
    for (const rel of parentFileList as string[]) {
      const parentPath = await resolveContained(
        options.inputRoot,
        `parent/${rel}`,
        'writeChildFile',
      )
      const target = await resolveContained(childRoot, rel, 'writeChildFile')
      let bytes: Buffer
      try {
        bytes = await readFile(parentPath)
      } catch (error) {
        throw new ToolError(
          `writeChildFile: parent/${rel} unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    seededChildren.add(childName)
  }

  const tools: ProposerTools = {
    async listInput(relDir) {
      const rootReal = await realpath(options.inputRoot)
      const target =
        relDir === '' ? rootReal : await resolveContained(options.inputRoot, relDir, 'listInput')
      const stats = await lstat(target).catch(() => undefined)
      if (stats === undefined) throw new ToolError(`listInput: ${relDir} does not exist`)
      if (!stats.isDirectory()) throw new ToolError(`listInput: ${relDir} is not a directory`)
      const names = (await readdir(target)).sort()
      record({ op: 'list', path: relDir, bytes: 0 })
      return names
    },

    async readInput(relPath) {
      const target = await resolveContained(options.inputRoot, relPath, 'readInput')
      const stats = await lstat(target).catch(() => undefined)
      if (stats === undefined) throw new ToolError(`readInput: ${relPath} does not exist`)
      if (!stats.isFile()) throw new ToolError(`readInput: ${relPath} is not a regular file`)
      if (stats.size > TOOL_CAPS.maxFileBytes) {
        throw new ToolError(`readInput: ${relPath} exceeds ${TOOL_CAPS.maxFileBytes} bytes`)
      }
      const bytes = await readFile(target)
      record({
        op: 'read',
        path: relPath,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      return bytes.toString('utf8')
    },

    async readChild(childName, relPath) {
      const childRoot = await resolveContained(options.childrenRoot, childName, 'readChild')
      const target = await resolveContained(childRoot, relPath, 'readChild')
      const stats = await lstat(target).catch(() => undefined)
      if (stats === undefined) throw new ToolError(`readChild: ${relPath} does not exist`)
      if (!stats.isFile()) throw new ToolError(`readChild: ${relPath} is not a regular file`)
      const bytes = await readFile(target)
      record({
        op: 'read',
        path: `${childName}/${relPath}`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
      return bytes.toString('utf8')
    },

    async writeChildFile(childName, relPath, content) {
      // The children root itself is controller-provided (never user input), so
      // creating it is safe; the child name is validated before anything is
      // materialized under it.
      await mkdir(options.childrenRoot, { recursive: true })
      const childRoot = await resolveContained(options.childrenRoot, childName, 'writeChildFile')
      await mkdir(childRoot, { recursive: true })
      await seedChildFromParent(childName, childRoot)
      const target = await resolveContained(childRoot, relPath, 'writeChildFile')
      const byteLength = Buffer.byteLength(content, 'utf8')
      if (byteLength > TOOL_CAPS.maxFileBytes) {
        throw new ToolError(`writeChildFile: ${relPath} exceeds ${TOOL_CAPS.maxFileBytes} bytes`)
      }
      const writeKey = `${childName}\u0000${relPath}`
      const priorWrittenBytes = writtenFileBytes.get(writeKey) ?? 0
      const childTotal = (written.get(childName) ?? 0) - priorWrittenBytes + byteLength
      if (childTotal > TOOL_CAPS.maxTotalWriteBytes) {
        throw new ToolError(
          `writeChildFile: child ${childName} would exceed ${TOOL_CAPS.maxTotalWriteBytes} written bytes`,
        )
      }
      if (!writtenPaths.has(writeKey)) {
        const count = (fileCounts.get(childName) ?? 0) + 1
        if (count > TOOL_CAPS.maxFilesPerChild) {
          throw new ToolError(
            `writeChildFile: child ${childName} exceeds ${TOOL_CAPS.maxFilesPerChild} files`,
          )
        }
        fileCounts.set(childName, count)
        writtenPaths.add(writeKey)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      written.set(childName, childTotal)
      writtenFileBytes.set(writeKey, byteLength)
      record({
        op: 'write',
        path: `${childName}/${relPath}`,
        bytes: byteLength,
        sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      })
    },

    accessLog: () => [...log],

    async finalizeProposal(proposal) {
      if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
        throw new ToolError('finalizeProposal: proposal must be an object')
      }
      if ((proposal as Record<string, unknown>)['schemaVersion'] !== 2) {
        return proposal as ProposalOutput
      }
      if (options.treeV2Parent === undefined || options.parentSourceHash === undefined) {
        throw new ToolError('finalizeProposal: a v2 bundle requires trusted parent evidence')
      }
      // Controller-staged facts, read with the same containment proof as every
      // other input read but without journaling: these are TCB operations, not
      // model observations.
      const readJson = async (rel: string): Promise<unknown> => {
        const target = await resolveContained(options.inputRoot, rel, 'finalizeProposal')
        try {
          return JSON.parse(await readFile(target, 'utf8')) as unknown
        } catch (error) {
          throw new ToolError(
            `finalizeProposal: ${rel} unreadable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
      // ADR-037: the finalizer enforces the modeComponents projection contract
      // against the TCB-staged parent source view. parent-files.json is the
      // same list the model reads; each file is read through the containment
      // prover. Any staging gap fails the finalization closed.
      const parentFileList = await readJson('parent-files.json')
      if (
        !Array.isArray(parentFileList) ||
        parentFileList.some((entry) => typeof entry !== 'string')
      ) {
        throw new ToolError('finalizeProposal: parent-files.json must be a string array')
      }
      const parentSourceFiles: Record<string, string> = {}
      for (const rel of parentFileList as string[]) {
        const target = await resolveContained(
          options.inputRoot,
          `parent/${rel}`,
          'finalizeProposal',
        )
        try {
          parentSourceFiles[rel] = await readFile(target, 'utf8')
        } catch (error) {
          throw new ToolError(
            `finalizeProposal: parent/${rel} unreadable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
      // The raw child tree is what later becomes content-addressed candidate
      // source. Read it before deciding whether a model-facing test runner is
      // present, so recorded routes receive the same completeness guard.
      const readChildTree = async (childName: string): Promise<Record<string, string>> => {
        const files: Record<string, string> = {}
        const childRoot = await resolveContained(
          options.childrenRoot,
          childName,
          'finalizeProposal',
        )
        const walk = async (relDir: string): Promise<void> => {
          for (const entry of await readdir(join(childRoot, relDir), { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue
            const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
            if (entry.isDirectory()) {
              await walk(rel)
              continue
            }
            if (!entry.isFile()) continue
            const target = await resolveContained(childRoot, rel, 'finalizeProposal')
            files[rel] = await readFile(target, 'utf8')
          }
        }
        await walk('')
        return files
      }
      const finalized = await finalizeTreeV2Bundle({
        proposal: proposal as ProposalOutput,
        childrenRoot: options.childrenRoot,
        exportManifest: (await readJson('export/manifest.json')) as ExportManifest,
        treeV2Parent: options.treeV2Parent,
        parentSourceHash: options.parentSourceHash,
        catalog: (await readJson('archive-catalog.json')) as ArchiveCatalog,
        parentSourceFiles,
      })
      const childTrees = new Map<string, Record<string, string>>()
      for (const child of finalized.children ?? []) {
        const childFiles = await readChildTree(child.childName)
        const missingParentFiles = Object.keys(parentSourceFiles)
          .filter((path) => childFiles[path] === undefined)
          .sort()
        if (missingParentFiles.length > 0) {
          throw new ToolError(
            `finalizeProposal: child ${child.childName} is missing inherited parent files: ${missingParentFiles.join(', ')}`,
          )
        }
        childTrees.set(child.childName, childFiles)
      }
      if (options.candidateTestRunner === undefined) return finalized
      // ADR-038: run the stage-6 suite over the complete raw child tree. The
      // explicit merge is retained only as a defensive assertion of the
      // parent-overlay equivalence established immediately above.
      for (const child of finalized.children ?? []) {
        if (candidateTestRuns >= CANDIDATE_TEST_RUN_BUDGET) {
          throw new ToolError(
            `finalizeProposal: candidate test budget exhausted (${CANDIDATE_TEST_RUN_BUDGET} runs)`,
          )
        }
        candidateTestRuns += 1
        const childFiles = childTrees.get(child.childName)
        if (childFiles === undefined) {
          throw new ToolError(
            `finalizeProposal: child ${child.childName} tree disappeared before tests`,
          )
        }
        const files: Record<string, string> = { ...parentSourceFiles }
        for (const [rel, content] of Object.entries(childFiles)) files[rel] = content
        let result: { ok: boolean; output: string }
        try {
          result = await options.candidateTestRunner(child.childName, files)
        } catch (error) {
          throw new ToolError(
            `finalizeProposal: candidate tests unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
        if (!result.ok) {
          throw new ToolError(
            `finalizeProposal: child ${child.childName} candidate tests failed:\n${result.output}`,
          )
        }
      }
      return finalized
    },
  }
  return tools
}
