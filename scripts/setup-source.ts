/**
 * Idempotent materialization of the pinned upstreams and content-addressed
 * references. For each upstream:
 *
 * - present as a git checkout → verify HEAD equals the pin and the tree is
 *   clean (preferred mode; requires github.com reachability);
 * - present as an extracted snapshot → verify the recorded tree digest
 *   (no network);
 * - missing → fetch the SHA-addressed codeload tarball, verify its recorded
 *   sha256, and extract it (github.com git endpoint is not required).
 *
 * References are fetched from their source URL when absent and verified by
 * sha256. Never mutates an existing directory that fails verification — a
 * drifted or corrupt tree is reported and left for a human decision.
 * @module scripts/setup-source
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtemp, readdir, rename, rm } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { loadLock, repoRoot, type ProvenanceLock } from './lib/lock.ts'
import { computeTreeDigest } from './lib/upstream.ts'

const exec = promisify(execFile)

async function verifySnapshot(pin: ProvenanceLock['upstreams'][string]): Promise<void> {
  const snapshot = pin.snapshot
  if (snapshot === undefined) {
    throw new Error(`${pin.path} exists without .git but has no recorded snapshot digest`)
  }
  const { digest, fileCount } = await computeTreeDigest(resolve(repoRoot, pin.path))
  if (digest !== snapshot.treeDigest.value) {
    throw new Error(
      `${pin.path}: tree digest ${digest} != recorded ${snapshot.treeDigest.value}; the directory drifted — resolve manually instead of overwriting`,
    )
  }
  console.log(`  verified snapshot digest over ${fileCount} files`)
}

async function verifyGit(pin: ProvenanceLock['upstreams'][string]): Promise<void> {
  const dir = resolve(repoRoot, pin.path)
  const { stdout: head } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])
  if (head.trim() !== pin.commit) {
    throw new Error(`${pin.path}: HEAD ${head.trim()} != pinned ${pin.commit}`)
  }
  const { stdout: status } = await exec('git', ['-C', dir, 'status', '--porcelain'])
  if (status.trim() !== '') throw new Error(`${pin.path}: working tree dirty`)
  console.log(`  verified git checkout at ${pin.commit.slice(0, 7)}`)
}

async function materializeTarball(pin: ProvenanceLock['upstreams'][string]): Promise<void> {
  const snapshot = pin.snapshot
  if (snapshot === undefined) {
    throw new Error(
      `${pin.path} is missing and the lock records no snapshot tarball; materialize a git checkout at ${pin.commit} manually`,
    )
  }
  const response = await fetch(snapshot.url)
  if (!response.ok) throw new Error(`fetch ${snapshot.url}: HTTP ${String(response.status)}`)
  const tarball = Buffer.from(await response.arrayBuffer())
  const tarballSha256 = createHash('sha256').update(tarball).digest('hex')
  if (tarballSha256 !== snapshot.tarballSha256) {
    throw new Error(`tarball sha256 ${tarballSha256} != recorded ${snapshot.tarballSha256}`)
  }
  const staging = await mkdtemp(join(tmpdir(), 'dsh-evolve-le-upstream-'))
  try {
    await writeFile(join(staging, 'upstream.tar.gz'), tarball)
    await exec('tar', ['-xzf', join(staging, 'upstream.tar.gz'), '-C', staging])
    // GitHub tarballs wrap the tree in one top-level <repo>-<sha>/ directory.
    const extracted = (await readdir(staging, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== '.')
      .map((entry) => join(staging, entry.name))
    if (extracted.length !== 1) {
      throw new Error(
        `expected one top-level directory in the tarball, found ${String(extracted.length)}`,
      )
    }
    const target = resolve(repoRoot, pin.path)
    await rename(extracted[0] as string, target)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  console.log('  materialized SHA-addressed tarball and verified its sha256')
  await verifySnapshot(pin)
}

async function main(): Promise<number> {
  const lock = await loadLock()
  let failures = 0

  for (const [name, pin] of Object.entries(lock.upstreams)) {
    console.log(
      `upstream ${name} (${pin.remote.owner}/${pin.remote.repo} @ ${pin.commit.slice(0, 7)}):`,
    )
    try {
      if (existsSync(resolve(repoRoot, pin.path, '.git'))) {
        await verifyGit(pin)
      } else if (existsSync(resolve(repoRoot, pin.path))) {
        await verifySnapshot(pin)
      } else {
        await materializeTarball(pin)
      }
    } catch (error) {
      failures += 1
      console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const [name, ref] of Object.entries(lock.references)) {
    console.log(`reference ${name} (${ref.sourceUrl}):`)
    try {
      const path = resolve(repoRoot, ref.path)
      if (!existsSync(path)) {
        const response = await fetch(ref.sourceUrl)
        if (!response.ok) throw new Error(`fetch ${ref.sourceUrl}: HTTP ${String(response.status)}`)
        const content = Buffer.from(await response.arrayBuffer())
        await writeFile(path, content)
        console.log('  downloaded')
      }
      const digest = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      if (digest !== ref.value) throw new Error(`sha256 ${digest} != recorded ${ref.value}`)
      console.log('  verified sha256')
    } catch (error) {
      failures += 1
      console.error(`  FAIL: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (failures > 0) {
    console.error(`setup:source: ${String(failures)} failure(s)`)
    return 1
  }
  console.log('setup:source: all upstreams and references verified')
  return 0
}

process.exitCode = await main()
