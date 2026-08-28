/**
 * Deterministic tree digest `dsh-evolve-tree-v1` — the single implementation
 * shared by the root provenance scripts (upstream drift detection) and the
 * trusted builder (staged source-tree digest in build-manifest.json). The
 * record format is frozen: it is the format already recorded in
 * `provenance.lock.json`, so this module must stay byte-compatible with it —
 * sorting is JS default string order and records are `${path}\0${kind}\0…`
 * lines with no header. A git checkout and a tarball snapshot of the same
 * commit produce the same digest; a one-byte local drift changes it.
 * @module @dsh-evolve-le/core/digest
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'

export const TREE_DIGEST_ALGO = 'dsh-evolve-tree-v1' as const

/** Compute the deterministic digest and file count of a tree. */
export async function computeTreeDigest(
  root: string,
): Promise<{ digest: string; fileCount: number }> {
  const paths: string[] = []
  await collect(root, '', paths)
  paths.sort()
  const hash = createHash('sha256')
  for (const rel of paths) {
    const stats = await lstat(join(root, rel))
    if (stats.isSymbolicLink()) {
      const target = await readlink(join(root, rel))
      hash.update(`${rel}\0symlink\0${target}\n`)
    } else if (stats.isFile()) {
      const content = await readFile(join(root, rel))
      const executable = (stats.mode & 0o111) !== 0 ? '1' : '0'
      const contentHash = createHash('sha256').update(content).digest('hex')
      hash.update(`${rel}\0file\0${executable}\0${contentHash}\n`)
    } else {
      throw new Error(`unsupported dirent type at ${rel} under ${root}`)
    }
  }
  return { digest: hash.digest('hex'), fileCount: paths.length }
}

async function collect(root: string, prefix: string, out: string[]): Promise<void> {
  const entries = await readdir(prefix === '' ? root : join(root, prefix), { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      await collect(root, rel, out)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(rel)
    } else {
      throw new Error(`unsupported dirent type at ${rel} under ${root}`)
    }
  }
}
