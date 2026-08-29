/**
 * Candidate source store contract tests (Gate 4, specs/06 §2 `candidates/`).
 *
 * The store is content-addressed and append-only: a source is materialized
 * once under its candidate id, re-storage of the same bytes is idempotent, and
 * loading re-captures the tree and verifies the digest — a drifted store fails
 * closed instead of quietly proposing from edited parent bytes.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { candidateIdFromDigest } from '../src/candidate/canonical.js'
import {
  CandidateStoreError,
  loadCandidateSource,
  recordCandidateBuild,
  SOURCE_STORE_VERSION,
  storeCandidateSource,
} from '../src/candidate/store.js'

const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  workRoots.push(root)
  return root
}

/** A minimal valid candidate source tree (two files, stable bytes). */
async function writeSource(dir: string, marker: string): Promise<void> {
  await writeFile(
    join(dir, 'candidate.json'),
    `${JSON.stringify({ schemaVersion: 1, canonicalParent: null, marker }, null, 2)}\n`,
  )
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: marker })}\n`)
}

describe('candidate source store', () => {
  it('stores a source under its tar-derived id and reloads it by exact digest', async () => {
    const sourceDir = await freshRoot('dsh-store-src-')
    const candidatesRoot = await freshRoot('dsh-store-root-')
    await writeSource(sourceDir, 'alpha')

    const stored = await storeCandidateSource(candidatesRoot, sourceDir)
    expect(stored.candidateId).toBe(candidateIdFromDigest(stored.source.sha256))
    const record = JSON.parse(
      await readFile(join(stored.storeDir, 'source.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(record.storeVersion).toBe(SOURCE_STORE_VERSION)
    expect(record.sourceHash).toBe(stored.sourceHash)

    const loaded = await loadCandidateSource(candidatesRoot, stored.sourceHash)
    expect(loaded.candidateId).toBe(stored.candidateId)
    expect(loaded.source.files.map((file) => file.path).sort()).toEqual([
      'candidate.json',
      'package.json',
    ])
    expect(`sha256:${loaded.source.sha256}`).toBe(stored.sourceHash)
  })

  it('is idempotent for identical bytes and keeps tree files immutable', async () => {
    const sourceDir = await freshRoot('dsh-store-src-')
    const candidatesRoot = await freshRoot('dsh-store-root-')
    await writeSource(sourceDir, 'beta')

    const first = await storeCandidateSource(candidatesRoot, sourceDir)
    const second = await storeCandidateSource(candidatesRoot, sourceDir)
    expect(second.candidateId).toBe(first.candidateId)
    expect(second.sourceHash).toBe(first.sourceHash)
  })

  it('rejects a malformed digest without touching the filesystem', async () => {
    const candidatesRoot = await freshRoot('dsh-store-root-')
    await expect(loadCandidateSource(candidatesRoot, 'sha256:deadbeef')).rejects.toThrow(
      CandidateStoreError,
    )
  })

  it('fails closed when the stored tree drifted from its recorded identity', async () => {
    const sourceDir = await freshRoot('dsh-store-src-')
    const candidatesRoot = await freshRoot('dsh-store-root-')
    await writeSource(sourceDir, 'gamma')
    const stored = await storeCandidateSource(candidatesRoot, sourceDir)

    // Tamper with the materialized tree (store files are read-only by intent;
    // an attacker with write access is exactly what this check detects).
    const target = join(stored.treeDir, 'candidate.json')
    await chmod(target, 0o644)
    await writeFile(target, '{"tampered": true}\n')
    await expect(loadCandidateSource(candidatesRoot, stored.sourceHash)).rejects.toThrow(
      /hashes to sha256:/,
    )
  })

  it('appends build receipts exactly once per build id', async () => {
    const sourceDir = await freshRoot('dsh-store-src-')
    const candidatesRoot = await freshRoot('dsh-store-root-')
    await writeSource(sourceDir, 'delta')
    const stored = await storeCandidateSource(candidatesRoot, sourceDir)

    const build = { candidateId: stored.candidateId, buildId: 'b1', outcome: 'admitted' }
    await recordCandidateBuild(candidatesRoot, stored.sourceHash, build)
    await recordCandidateBuild(candidatesRoot, stored.sourceHash, build) // no-clobber
    const receipt = JSON.parse(
      await readFile(join(stored.storeDir, 'builds', `${stored.candidateId}-build.json`), 'utf8'),
    ) as Record<string, unknown>
    expect(receipt.buildId).toBe('b1')
    expect(receipt.schemaVersion).toBe(1)

    await expect(
      recordCandidateBuild(candidatesRoot, `sha256:${'9'.repeat(64)}`, build),
    ).rejects.toThrow(CandidateStoreError)
  })
})
