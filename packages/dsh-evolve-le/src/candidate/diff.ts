/**
 * Canonical diff boundary between a child candidate and its canonical parent
 * (specs/02 §1, §11 step 3). Only candidate source counts: the diff is over
 * canonical file sets, so build output, dependency trees and undeclared files
 * cannot hide inside it. Line deltas are computed as deterministic multiset
 * differences (child-minus-parent and parent-minus-child), not a minimal edit
 * script — the metric is monotone, cheap, and stable by construction.
 * @module @dsh-evolve-le/core/candidate/diff
 */

import { createHash } from 'node:crypto'
import { CANONICAL_SOURCE_CAPS, type CanonicalSource } from './canonical.js'

/** Per-file delta classification. */
export interface FileDelta {
  path: string
  status: 'added' | 'removed' | 'modified'
  linesAdded: number
  linesRemoved: number
}

/** Aggregate diff record stored in build-manifest.json. */
export interface CanonicalDiff {
  parentDigest: string
  diffHash: string
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  differingFiles: FileDelta[]
}

function toLines(content: Buffer): string[] {
  const text = content.toString('utf8')
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Multiset difference: how many occurrences of each line lack a partner. */
function multisetSurplus(base: string[], over: string[]): number {
  const counts = new Map<string, number>()
  for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1)
  let surplus = 0
  for (const line of over) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else surplus += 1
  }
  return surplus
}

/**
 * Diff a child canonical source against its canonical parent. Throws when the
 * combined changed-line count exceeds the pre-registered cap.
 */
export function diffCanonicalSources(
  parent: CanonicalSource,
  child: CanonicalSource,
): CanonicalDiff {
  const parentFiles = new Map(parent.files.map((file) => [file.path, file]))
  const childFiles = new Map(child.files.map((file) => [file.path, file]))
  const paths = [...new Set([...parentFiles.keys(), ...childFiles.keys()])].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )

  const differingFiles: FileDelta[] = []
  let linesAdded = 0
  let linesRemoved = 0
  const hashLines: string[] = [`parent sha256:${parent.sha256}`]

  for (const path of paths) {
    const before = parentFiles.get(path)
    const after = childFiles.get(path)
    if (before !== undefined && after !== undefined) {
      if (before.content.equals(after.content) && before.mode === after.mode) continue
      const added = multisetSurplus(toLines(before.content), toLines(after.content))
      const removed = multisetSurplus(toLines(after.content), toLines(before.content))
      linesAdded += added
      linesRemoved += removed
      differingFiles.push({ path, status: 'modified', linesAdded: added, linesRemoved: removed })
      hashLines.push(`~ ${path} +${added} -${removed}`)
      continue
    }
    if (after !== undefined) {
      const added = toLines(after.content).length
      linesAdded += added
      differingFiles.push({ path, status: 'added', linesAdded: added, linesRemoved: 0 })
      hashLines.push(`+ ${path} ${added}`)
      continue
    }
    const removed = toLines(before!.content).length
    linesRemoved += removed
    differingFiles.push({ path, status: 'removed', linesAdded: 0, linesRemoved: removed })
    hashLines.push(`- ${path} ${removed}`)
  }

  const changed = linesAdded + linesRemoved
  if (changed > CANONICAL_SOURCE_CAPS.maxChangedLines) {
    throw new Error(
      `canonical diff rejected: changed lines ${changed} exceed the pre-registered cap ${CANONICAL_SOURCE_CAPS.maxChangedLines}`,
    )
  }

  return {
    parentDigest: `sha256:${parent.sha256}`,
    diffHash: createHash('sha256')
      .update(`${hashLines.join('\n')}\n`)
      .digest('hex'),
    filesChanged: differingFiles.length,
    linesAdded,
    linesRemoved,
    differingFiles,
  }
}
