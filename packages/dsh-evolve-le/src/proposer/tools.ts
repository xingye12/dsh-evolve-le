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

export const TOOLS_VERSION = 'dsh-evolve-le/proposer-tools/v1'

export const TOOL_CAPS = {
  maxFileBytes: 524_288,
  maxFilesPerChild: 25,
  maxTotalWriteBytes: 1_048_576,
} as const

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
}): ProposerTools {
  const log: AccessRecord[] = []
  const written = new Map<string, number>() // childName → bytes
  const fileCounts = new Map<string, number>()

  const record = (entry: AccessRecord): void => {
    log.push(entry)
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
      const target = await resolveContained(childRoot, relPath, 'writeChildFile')
      const byteLength = Buffer.byteLength(content, 'utf8')
      if (byteLength > TOOL_CAPS.maxFileBytes) {
        throw new ToolError(`writeChildFile: ${relPath} exceeds ${TOOL_CAPS.maxFileBytes} bytes`)
      }
      const prior = await lstat(target).catch(() => undefined)
      const priorBytes = prior?.isFile() === true ? prior.size : 0
      const childTotal = (written.get(childName) ?? 0) - priorBytes + byteLength
      if (childTotal > TOOL_CAPS.maxTotalWriteBytes) {
        throw new ToolError(
          `writeChildFile: child ${childName} would exceed ${TOOL_CAPS.maxTotalWriteBytes} written bytes`,
        )
      }
      if (prior === undefined) {
        const count = (fileCounts.get(childName) ?? 0) + 1
        if (count > TOOL_CAPS.maxFilesPerChild) {
          throw new ToolError(
            `writeChildFile: child ${childName} exceeds ${TOOL_CAPS.maxFilesPerChild} files`,
          )
        }
        fileCounts.set(childName, count)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      written.set(childName, childTotal)
      record({
        op: 'write',
        path: `${childName}/${relPath}`,
        bytes: byteLength,
        sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      })
    },

    accessLog: () => [...log],
  }
  return tools
}
