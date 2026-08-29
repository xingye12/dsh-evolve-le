/**
 * Canonical diff boundary between a child candidate and its canonical parent
 * (specs/02 §1, §11 step 3). Only candidate source counts: the diff is over
 * canonical file sets, so build output, dependency trees and undeclared files
 * cannot hide inside it. Line deltas are computed as deterministic multiset
 * differences (child-minus-parent and parent-minus-child), not a minimal edit
 * script — the metric is monotone, cheap, and stable by construction. The
 * diff hash covers the sorted change multiset itself, so children with equal
 * line counts but different content are distinct mechanisms (specs/03 §9).
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

/** Multiset difference: the lines of `over` without a partner in `base`. */
function multisetSurplusLines(base: string[], over: string[]): string[] {
  const counts = new Map<string, number>()
  for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1)
  const surplus: string[] = []
  for (const line of over) {
    const remaining = counts.get(line) ?? 0
    if (remaining > 0) counts.set(line, remaining - 1)
    else surplus.push(line)
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
      // Sorted for order-independence: the hash covers the change multiset, so
      // equal line counts with different content hash differently (specs/03 §9
      // dedups identical semantic diffs, not identical diff shapes).
      const added = multisetSurplusLines(toLines(before.content), toLines(after.content)).sort()
      const removed = multisetSurplusLines(toLines(after.content), toLines(before.content)).sort()
      linesAdded += added.length
      linesRemoved += removed.length
      differingFiles.push({
        path,
        status: 'modified',
        linesAdded: added.length,
        linesRemoved: removed.length,
      })
      hashLines.push(`~ ${path}`)
      for (const line of added) hashLines.push(`+ ${line}`)
      for (const line of removed) hashLines.push(`- ${line}`)
      continue
    }
    if (after !== undefined) {
      const added = toLines(after.content)
      linesAdded += added.length
      differingFiles.push({ path, status: 'added', linesAdded: added.length, linesRemoved: 0 })
      hashLines.push(`+ ${path}`)
      for (const line of added) hashLines.push(`+ ${line}`)
      continue
    }
    const removed = toLines(before!.content)
    linesRemoved += removed.length
    differingFiles.push({ path, status: 'removed', linesAdded: 0, linesRemoved: removed.length })
    hashLines.push(`- ${path}`)
    for (const line of removed) hashLines.push(`- ${line}`)
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
