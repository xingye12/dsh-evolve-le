/**
 * Content-addressed candidate source store (specs/06 §2 `candidates/`, Gate 4).
 * Every admitted candidate's canonical source is materialized once under its
 * candidate id and never overwritten: the tree is the bytes the canonical tar
 * hashed, `source.json` is the small metadata ref, and build receipts append
 * beside it. Loading re-captures the tree and verifies the digest, so a
 * drifted or tampered store fails closed instead of quietly proposing from
 * edited parent bytes.
 * @module @dsh-evolve-le/core/candidate/store
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import {
  candidateIdFromDigest,
  captureCanonicalSource,
  type CanonicalFile,
  type CanonicalSource,
} from './canonical.js'

export const SOURCE_STORE_VERSION = 'dsh-evolve-le/candidate-store/v1'

export class CandidateStoreError extends Error {
  constructor(message: string) {
    super(`candidate-store: ${message}`)
    this.name = 'CandidateStoreError'
  }
}

export interface StoredCandidate {
  candidateId: string
  sourceHash: string
  treeDir: string
  storeDir: string
}

/** Materialize the canonical tree files under `treeDir` (no-clobber). */
async function materializeTree(treeDir: string, files: CanonicalFile[]): Promise<void> {
  await mkdir(treeDir, { recursive: true })
  for (const file of files) {
    const target = join(treeDir, ...file.path.split('/'))
    const dir = join(target, '..')
    await mkdir(dir, { recursive: true })
    try {
      await access(target, constants.F_OK)
      throw new CandidateStoreError(`refuses to overwrite existing tree file ${file.path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(target, file.content, { mode: file.mode })
  }
}

/**
 * Store one candidate source tree. The capture is canonical (symlinks, caps
 * and normalization collisions rejected upstream), the id derives from the
 * tar digest, and an already-stored identical source is idempotent.
 */
export async function storeCandidateSource(
  candidatesRoot: string,
  sourceDir: string,
): Promise<StoredCandidate & { source: CanonicalSource }> {
  const source = await captureCanonicalSource(sourceDir)
  const candidateId = candidateIdFromDigest(source.sha256)
  const storeDir = join(candidatesRoot, candidateId)
  const treeDir = join(storeDir, 'tree')
  const sourceJson = join(storeDir, 'source.json')
  const record = {
    schemaVersion: 1,
    storeVersion: SOURCE_STORE_VERSION,
    candidateId,
    sourceHash: `sha256:${source.sha256}`,
    fileCount: source.files.length,
    bytes: source.bytes,
  }
  try {
    await access(sourceJson, constants.F_OK)
    // Already stored: verify the recorded identity still matches the capture.
    const existing = JSON.parse(await readFile(sourceJson, 'utf8')) as {
      sourceHash?: string
    }
    if (existing.sourceHash !== record.sourceHash) {
      throw new CandidateStoreError(
        `store disagrees with capture for ${candidateId}: ${String(existing.sourceHash)} != ${record.sourceHash}`,
      )
    }
    return { ...record, sourceHash: record.sourceHash, treeDir, storeDir, source }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await materializeTree(treeDir, source.files)
  await writeFile(sourceJson, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { ...record, sourceHash: record.sourceHash, treeDir, storeDir, source }
}

/**
 * Load a stored candidate's canonical source by exact digest. The tree is
 * re-captured and re-hashed — a store that drifted from its recorded identity
 * is `EVIDENCE_CORRUPT`, never silently accepted.
 */
export async function loadCandidateSource(
  candidatesRoot: string,
  sourceDigest: string,
): Promise<StoredCandidate & { source: CanonicalSource }> {
  if (!/^sha256:[0-9a-f]{64}$/.test(sourceDigest)) {
    throw new CandidateStoreError(`digest must be sha256:<64-hex>, got ${sourceDigest}`)
  }
  const candidateId = candidateIdFromDigest(sourceDigest.slice('sha256:'.length))
  const storeDir = join(candidatesRoot, candidateId)
  const treeDir = join(storeDir, 'tree')
  const source = await captureCanonicalSource(treeDir).catch((error: unknown) => {
    throw new CandidateStoreError(`cannot load ${candidateId}: ${String(error)}`)
  })
  if (`sha256:${source.sha256}` !== sourceDigest) {
    throw new CandidateStoreError(
      `stored tree for ${candidateId} hashes to sha256:${source.sha256}, expected ${sourceDigest}`,
    )
  }
  return { candidateId, sourceHash: sourceDigest, treeDir, storeDir, source }
}

/** Append a build receipt beside the stored source (no-clobber per build). */
export async function recordCandidateBuild(
  candidatesRoot: string,
  sourceDigest: string,
  build: Record<string, unknown>,
): Promise<string> {
  const { storeDir } = await loadCandidateSource(candidatesRoot, sourceDigest)
  const buildsDir = join(storeDir, 'builds')
  await mkdir(buildsDir, { recursive: true })
  const path = join(buildsDir, `${String(build['candidateId'])}-build.json`)
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, ...build }, null, 2)}\n`, {
    flag: 'wx',
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  })
  return path
}
