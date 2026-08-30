/**
 * Pinned node runtime for evaluation capsules (Gate 8 defect fix, specs/02
 * §12): Terminal-Bench 2.1 task images are per-task and almost none ship
 * `node`, so the capsule embeds its own interpreter instead of exec-ing a
 * PATH `node` that does not exist inside the task container. The runtime is
 * content-addressed end to end (CLAUDE.md rule 8): the official distribution
 * tarball is locked in `provenance.lock.json` under `.references/` and
 * materialized by `pnpm setup:source`; this module verifies the tarball
 * digest, extracts exactly the one locked member, verifies the binary digest
 * and stages it executable for `assembleCapsule` to copy in. Any mismatch
 * fails closed — a capsule that would boot on an unverified interpreter is
 * worse than no capsule.
 * @module @dsh-evolve-le/core/builder/pinned-runtime
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { repoRoot } from '../schema.js'

const exec = promisify(execFile)

export const NODE_RUNTIME_VERSION = 'v24.14.0'
export const NODE_RUNTIME_PLATFORM = 'linux-x64'
/** Official distribution tarball name (nodejs.org/dist/<version>/<name>). */
export const NODE_RUNTIME_TARBALL_NAME = `node-${NODE_RUNTIME_VERSION}-${NODE_RUNTIME_PLATFORM}.tar.xz`
/** The single member this module extracts from the distribution tarball. */
export const NODE_RUNTIME_TARBALL_MEMBER = `node-${NODE_RUNTIME_VERSION}-${NODE_RUNTIME_PLATFORM}/bin/node`
/** sha256 of the tarball locked at `.references/` in provenance.lock.json. */
export const NODE_RUNTIME_TARBALL_SHA256 =
  '41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df'
/** sha256 of the extracted `bin/node` binary embedded at capsule runtime/node. */
export const NODE_RUNTIME_BINARY_SHA256 =
  'e237a2839d0cbdc9a9a2adda1a184afc0f5b20306ffbe923af5686550472d8a8'

/** The locked reference path for a repository root (gitignored, setup:source materializes it). */
export function pinnedNodeRuntimeTarballPath(root: string): string {
  return join(root, '.references', NODE_RUNTIME_TARBALL_NAME)
}

export interface PinnedNodeRuntime {
  /** Staged binary path inside the build work root. */
  path: string
  /** Verified sha256 of the staged binary (= NODE_RUNTIME_BINARY_SHA256). */
  sha256: string
  version: string
}

/**
 * Verify and stage the pinned runtime for one build. The tarball is read
 * from `<referencesDir>/<tarballName>` (default: the repository's locked
 * `.references/`), its digest checked against the lock, the single locked
 * member extracted into `<workDir>/` and the binary digest verified again.
 * Digest parameters are injectable so the contract tests can exercise the
 * verification mechanics with a synthetic tarball.
 */
export async function materializeNodeRuntime(options: {
  workDir: string
  referencesDir?: string
  tarballName?: string
  tarballSha256?: string
  binarySha256?: string
}): Promise<PinnedNodeRuntime> {
  const referencesDir = options.referencesDir ?? join(repoRoot, '.references')
  const tarballName = options.tarballName ?? NODE_RUNTIME_TARBALL_NAME
  const expectedTarball = options.tarballSha256 ?? NODE_RUNTIME_TARBALL_SHA256
  const expectedBinary = options.binarySha256 ?? NODE_RUNTIME_BINARY_SHA256
  const tarballPath = join(referencesDir, tarballName)

  let tarball: Buffer
  try {
    tarball = await readFile(tarballPath)
  } catch {
    throw new Error(
      `pinned node runtime ${tarballPath} is missing: run \`pnpm setup:source\` to materialize the locked reference (provenance.lock.json → references.nodeRuntime)`,
    )
  }
  const tarballDigest = createHash('sha256').update(tarball).digest('hex')
  if (tarballDigest !== expectedTarball) {
    throw new Error(
      `pinned node runtime ${tarballName}: sha256 ${tarballDigest} != recorded ${expectedTarball}; the reference drifted — resolve manually instead of overwriting`,
    )
  }

  await mkdir(dirname(join(options.workDir, NODE_RUNTIME_TARBALL_MEMBER)), { recursive: true })
  await exec('tar', ['-xJf', tarballPath, '-C', options.workDir, NODE_RUNTIME_TARBALL_MEMBER])
  const binaryPath = join(options.workDir, NODE_RUNTIME_TARBALL_MEMBER)
  const binary = await readFile(binaryPath)
  const binaryDigest = createHash('sha256').update(binary).digest('hex')
  if (binaryDigest !== expectedBinary) {
    throw new Error(
      `pinned node runtime member ${NODE_RUNTIME_TARBALL_MEMBER}: sha256 ${binaryDigest} != recorded ${expectedBinary}`,
    )
  }
  const stats = await stat(binaryPath)
  if ((stats.mode & 0o111) === 0) {
    throw new Error(`pinned node runtime member ${NODE_RUNTIME_TARBALL_MEMBER} is not executable`)
  }
  return { path: binaryPath, sha256: binaryDigest, version: NODE_RUNTIME_VERSION }
}
