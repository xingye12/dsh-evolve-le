/**
 * Evidence export, archive catalog and canary contract tests (Gate 4,
 * specs/06 §11, specs/05 §10–§11).
 *
 * The proposer's world is one label-filtered export: guard/sealed labels fail
 * closed, canary-carrying objects never materialize, the view is immutable and
 * idempotent under a deterministic id, and the catalog derives every number
 * from dev-observed observations only.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Observation, RunState } from '../src/state/reducer.js'
import { openObjectStore, type ObjectRef } from '../src/state/object-store.js'
import {
  canaryFingerprint,
  generateCanaryTokens,
  isValidCanaryToken,
  scanFieldsForCanary,
  scanForCanary,
} from '../src/proposer/canary.js'
import {
  createEvidenceExport,
  EvidenceExportError,
  merkleRootOf,
  PROPOSER_READ_LABELS,
} from '../src/proposer/export.js'
import { buildArchiveCatalog, catalogBytes, type ArchiveCatalog } from '../src/proposer/catalog.js'

const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  workRoots.push(root)
  return root
}

describe('canary tokens', () => {
  it('generates non-guessable, well-shaped tokens', () => {
    const tokens = generateCanaryTokens(3)
    expect(tokens).toHaveLength(3)
    for (const token of tokens) expect(isValidCanaryToken(token)).toBe(true)
    expect(new Set(tokens).size).toBe(3)
    expect(() => generateCanaryTokens(0)).toThrow()
  })

  it('reports hits as fingerprints, never the token itself', () => {
    const [token] = generateCanaryTokens(1)
    const hits = scanForCanary(`harmless text ${token} more text`, [token])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.tokenFingerprint).toBe(canaryFingerprint(token!))
    expect(JSON.stringify(hits)).not.toContain(token!)
    expect(scanForCanary('clean text', [token!])).toEqual([])
  })

  it('attributes canaries hidden in nested proposal fields', () => {
    const [token] = generateCanaryTokens(1)
    const hits = scanFieldsForCanary(
      { proposal: { children: [{ hypothesis: `reuse ${token}` }], width: 3 } },
      [token!],
    )
    expect(hits).toHaveLength(1)
    expect(hits[0]?.field).toBe('proposal.children[0].hypothesis')
  })
})

describe('label-filtered evidence export', () => {
  it('materializes an immutable, idempotent view with a merkle root', async () => {
    const store = await openObjectStore(await freshRoot('dsh-exp-store-'))
    const exportsRoot = await freshRoot('dsh-exp-views-')
    const spec = await store.put(Buffer.from('{"spec": "terminal-bench 2.1"}\n'), {
      mediaType: 'application/json',
      label: 'PUBLIC_SPEC',
    })
    const trace = await store.put(Buffer.from('{"trial": 1, "outcome": "fail"}\n'), {
      mediaType: 'application/vnd.dsh-self-evolving.trajectory+json',
      label: 'DEV_OBSERVED',
    })

    const created = await createEvidenceExport({
      exportsRoot,
      store,
      principal: 'proposer:action-1',
      purpose: 'candidate-expansion',
      allowedLabels: [...PROPOSER_READ_LABELS],
      refs: [spec, trace],
      createdFromStateHash: 'sha256:' + 'a'.repeat(64),
      canaryTokens: generateCanaryTokens(2),
    })
    expect(created.exportId).toMatch(/^exp_[a-z2-7]{13}$/)
    expect(created.manifest.allowedLabels).toEqual(['PUBLIC_SPEC', 'DEV_OBSERVED'])
    expect(created.manifest.objects.map((object) => object.label).sort()).toEqual([
      'DEV_OBSERVED',
      'PUBLIC_SPEC',
    ])
    expect(created.manifest.canaryAbsence.result).toBe('absent')
    expect(created.manifest.canaryAbsence.checkedObjects).toBe(2)

    // Object bytes are materialized verbatim under their digests, read-only.
    const materialized = await readFile(join(created.dir, 'objects', trace.digest))
    expect(materialized.toString('utf8')).toContain('"outcome": "fail"')
    expect((await stat(join(created.dir, 'objects', trace.digest))).mode & 0o222).toBe(0)

    // Re-exporting the identical selection is idempotent.
    const again = await createEvidenceExport({
      exportsRoot,
      store,
      principal: 'proposer:action-1',
      purpose: 'candidate-expansion',
      allowedLabels: [...PROPOSER_READ_LABELS],
      refs: [spec, trace],
      createdFromStateHash: 'sha256:' + 'a'.repeat(64),
      canaryTokens: generateCanaryTokens(2),
    })
    expect(again.exportId).toBe(created.exportId)
    expect(again.manifest.merkleRoot).toBe(created.manifest.merkleRoot)
  })

  it('fails closed when a disallowed label reaches the request', async () => {
    const store = await openObjectStore(await freshRoot('dsh-exp-store-'))
    const exportsRoot = await freshRoot('dsh-exp-views-')
    const guard = await store.put(Buffer.from('{"guard": "trial"}\n'), {
      mediaType: 'application/json',
      label: 'DEV_GUARD',
    })
    await expect(
      createEvidenceExport({
        exportsRoot,
        store,
        principal: 'proposer:action-2',
        purpose: 'candidate-expansion',
        allowedLabels: [...PROPOSER_READ_LABELS],
        refs: [guard],
        createdFromStateHash: 'sha256:' + 'b'.repeat(64),
        canaryTokens: [],
      }),
    ).rejects.toThrow(EvidenceExportError)
    await expect(
      createEvidenceExport({
        exportsRoot,
        store,
        principal: 'proposer:action-2',
        purpose: 'candidate-expansion',
        allowedLabels: [...PROPOSER_READ_LABELS],
        refs: [guard],
        createdFromStateHash: 'sha256:' + 'b'.repeat(64),
        canaryTokens: [],
      }),
    ).rejects.toThrow(/label DEV_GUARD, not allowed/)
  })

  it('refuses to export an object carrying a canary token', async () => {
    const store = await openObjectStore(await freshRoot('dsh-exp-store-'))
    const exportsRoot = await freshRoot('dsh-exp-views-')
    const [token] = generateCanaryTokens(1)
    const poisoned = await store.put(Buffer.from(`{"sealed": "${token}"}\n`), {
      mediaType: 'application/json',
      label: 'DEV_OBSERVED', // mislabeled content still cannot carry a canary
    })
    const attempt = createEvidenceExport({
      exportsRoot,
      store,
      principal: 'proposer:action-3',
      purpose: 'candidate-expansion',
      allowedLabels: [...PROPOSER_READ_LABELS],
      refs: [poisoned],
      createdFromStateHash: 'sha256:' + 'c'.repeat(64),
      canaryTokens: [token!],
    })
    await expect(attempt).rejects.toThrow(/canary fingerprint /)
    // The failure message names the fingerprint, not the token.
    const message = await attempt.then(
      () => '',
      (error: Error) => error.message,
    )
    expect(message).not.toContain(token!)
    expect(message).toContain(canaryFingerprint(token!).slice(0, 12))
  })

  it('fails closed when a selected object is missing from the store', async () => {
    const store = await openObjectStore(await freshRoot('dsh-exp-store-'))
    const exportsRoot = await freshRoot('dsh-exp-views-')
    const ghost: ObjectRef = {
      algorithm: 'sha256',
      digest: 'd'.repeat(64),
      size: 3,
      mediaType: 'application/json',
      label: 'PUBLIC_SPEC',
    }
    await expect(
      createEvidenceExport({
        exportsRoot,
        store,
        principal: 'proposer:action-4',
        purpose: 'candidate-expansion',
        allowedLabels: [...PROPOSER_READ_LABELS],
        refs: [ghost],
        createdFromStateHash: 'sha256:' + 'e'.repeat(64),
        canaryTokens: [],
      }),
    ).rejects.toThrow(/missing/)
  })

  it('merkle roots are order-insensitive over digests and differ per set', () => {
    const a = 'a'.repeat(64)
    const b = 'b'.repeat(64)
    expect(merkleRootOf([a, b])).toBe(merkleRootOf([b, a]))
    expect(merkleRootOf([a, b])).not.toBe(merkleRootOf([a]))
    expect(merkleRootOf([])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('archive catalog', () => {
  const observation = (fields: Partial<Observation>): Observation => ({
    actionId: 'act-1',
    candidateId: 'c_alpha',
    opaqueTaskId: 'task-1',
    split: 'dev-observed',
    attempt: 1,
    outcome: 'ok',
    reward: 0,
    costUsdMicros: 1000,
    durationMs: 10,
    ...fields,
  })

  function catalogFixture(): RunState {
    return {
      schemaVersion: 1,
      runId: 'run-cat',
      seq: 9,
      lastEventHash: 'sha256:' + '0'.repeat(64),
      phase: 'search',
      phaseEnteredAtSeq: 1,
      actions: {},
      waves: {},
      candidates: {
        c_alpha: {
          candidateId: 'c_alpha',
          sourceHash: 'sha256:' + '1'.repeat(64),
          parentCandidateId: null,
          proposalActionId: null,
          status: 'admitted',
        },
        c_beta: {
          candidateId: 'c_beta',
          sourceHash: 'sha256:' + '2'.repeat(64),
          parentCandidateId: 'c_alpha',
          proposalActionId: 'act-9',
          status: 'rejected',
        },
        c_gamma: {
          candidateId: 'c_gamma',
          sourceHash: 'sha256:' + '3'.repeat(64),
          parentCandidateId: null,
          proposalActionId: null,
          status: 'registered',
        },
      },
      observations: {
        'c_alpha\u0000task-1\u0000dev-observed\u00001': observation({ reward: 1 }),
        'c_alpha\u0000task-1\u0000dev-observed\u00002': observation({ attempt: 2, reward: 0 }),
        'c_alpha\u0000task-2\u0000dev-observed\u00001': observation({
          opaqueTaskId: 'task-2',
          reward: 1,
        }),
        'c_alpha\u0000task-9\u0000dev-guard\u00001': observation({
          opaqueTaskId: 'task-9',
          split: 'dev-guard',
          reward: 1,
        }),
        'c_beta\u0000task-1\u0000dev-observed\u00001': observation({
          candidateId: 'c_beta',
          reward: 1,
        }),
      },
      rngReceipts: {},
      budget: {},
      budgetByAction: {},
      externalJobs: {},
      locks: { candidateLock: null, sealedRevealed: null },
      reservationCounter: 0,
    } as unknown as RunState
  }

  it('exposes only archive-worthy candidates with dev-observed stats', () => {
    const catalog = buildArchiveCatalog(catalogFixture())
    expect(catalog.entries.map((entry) => entry.candidateId)).toEqual(['c_alpha'])

    const alpha = catalog.entries[0]!
    expect(alpha.tasks).toEqual([
      { opaqueTaskId: 'task-1', attempts: 2, successes: 1, failures: 1 },
      { opaqueTaskId: 'task-2', attempts: 1, successes: 1, failures: 0 },
    ])
    expect(alpha.totalAttempts).toBe(3)
    expect(alpha.totalSuccesses).toBe(2)
    // The guard observation is counted as excluded, never folded into stats.
    expect(alpha.guardObservationsExcluded).toBe(1)
    expect(alpha.totalAttempts + alpha.guardObservationsExcluded).toBe(4)
  })

  it('is deterministic for identical state', () => {
    const first: ArchiveCatalog = buildArchiveCatalog(catalogFixture(), {
      createdFromStateHash: 'sha256:' + 'f'.repeat(64),
    })
    const second = buildArchiveCatalog(catalogFixture(), {
      createdFromStateHash: 'sha256:' + 'f'.repeat(64),
    })
    expect(catalogBytes(second).equals(catalogBytes(first))).toBe(true)
    expect(catalogBytes(first).toString('utf8')).not.toContain('dev-guard')
  })
})
