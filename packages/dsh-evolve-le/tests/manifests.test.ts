/**
 * Manifest schema contract tests (Gate 1). Each valid fixture under
 * tests/fixtures/manifests/ is the documented canonical shape for one manifest
 * kind; the invalid cases are inline mutations proving the schemas actually
 * reject what the admission pipeline depends on: proposer-unforgeable build
 * fields, both-mode support, receipt completeness, and capsule identity
 * cross-binding (specs/02 §5–6, §11–12).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateManifest, type ManifestKind } from '../src/schema.js'

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/manifests')

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8')) as Record<string, unknown>
}

/** Deep clone + mutate helper keeping each invalid case a one-liner. */
function mutated<T>(base: T, mutate: (draft: T) => void): T {
  const draft = structuredClone(base)
  mutate(draft)
  return draft
}

describe('manifest fixtures accept', () => {
  for (const kind of ['candidate', 'proposal', 'build', 'capsule'] as const) {
    it(`${kind} fixture validates`, () => {
      const result = validateManifest(kind, loadFixture(`${kind}.json`))
      expect(result).toMatchObject({ ok: true })
    })
  }

  it('the real baseline candidate.json validates (golden fixture mirrors the package)', () => {
    const golden = JSON.parse(
      readFileSync(resolve(fixturesDir, '../scan/cases/golden/candidate.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(validateManifest('candidate', golden)).toMatchObject({ ok: true })
  })
})

describe('candidate manifest rejects', () => {
  const valid = loadFixture('candidate.json')

  it('missing proposal hypothesis', () => {
    const draft = mutated(valid, (d) => {
      delete (d.proposal as Record<string, unknown>).hypothesis
    })
    expect(validateManifest('candidate', draft).ok).toBe(false)
  })

  it('solve-only modes (single-mode candidates are not admissible)', () => {
    const draft = mutated(valid, (d) => {
      ;(d.runtime as Record<string, unknown>).supportsModes = ['solve']
    })
    expect(validateManifest('candidate', draft).ok).toBe(false)
  })

  it('empty requiredServices', () => {
    const draft = mutated(valid, (d) => {
      ;(d.runtime as Record<string, unknown>).requiredServices = []
    })
    expect(validateManifest('candidate', draft).ok).toBe(false)
  })

  it('surface name with invalid characters', () => {
    const draft = mutated(valid, (d) => {
      ;(d.proposal as Record<string, unknown>).touchedSurfaces = ['System Prompt!']
    })
    expect(validateManifest('candidate', draft).ok).toBe(false)
  })

  it('unknown extra field', () => {
    const draft = mutated(valid, (d) => {
      d.score = 0.9
    })
    expect(validateManifest('candidate', draft).ok).toBe(false)
  })

  it('malformed canonical parent hash', () => {
    const draft = mutated(valid, (d) => {
      d.canonicalParent = 'main'
    })
    expect(validateManifest('candidate', draft).ok).toBe(false)
  })
})

describe('proposal manifest rejects', () => {
  const valid = loadFixture('proposal.json')

  it('four children (width cap is 3)', () => {
    const one = valid.children as unknown[]
    const draft = mutated(valid, (d) => {
      d.children = [...one, ...one, ...one, ...one]
    })
    expect(validateManifest('proposal', draft).ok).toBe(false)
  })

  it('proposalId with wrong prefix', () => {
    const draft = mutated(valid, (d) => {
      ;(d.children as Record<string, unknown>[])[0]!.proposalId = 'x_aaaaaaaaaaaaaaaaaaaaaaaaaa'
    })
    expect(validateManifest('proposal', draft).ok).toBe(false)
  })

  it('missing evidenceRefs', () => {
    const draft = mutated(valid, (d) => {
      delete d.evidenceRefs
    })
    expect(validateManifest('proposal', draft).ok).toBe(false)
  })
})

describe('build manifest rejects', () => {
  const valid = loadFixture('build.json')

  it('admitted outcome without the builder-computed blocks', () => {
    const draft = mutated(valid, (d) => {
      delete d.bundle
      delete d.capsule
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })

  it('nine receipts (all ten stages required)', () => {
    const draft = mutated(valid, (d) => {
      delete (d.receipts as Record<string, unknown>).mockReplay
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })

  it('receipt status outside the enum', () => {
    const draft = mutated(valid, (d) => {
      ;(d.receipts as Record<string, unknown>).schema = { status: 'ok', detail: 'x' }
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })

  it('rejected outcome without rejection stage/reason', () => {
    const draft = mutated(valid, (d) => {
      d.outcome = 'rejected'
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })

  it('builder claiming network access', () => {
    const draft = mutated(valid, (d) => {
      ;(d.builder as Record<string, unknown>).networkAccess = true
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })

  it('builder claiming it executed a candidate lifecycle script', () => {
    const draft = mutated(valid, (d) => {
      ;(d.builder as Record<string, unknown>).executedCandidateLifecycleScript = true
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })

  it('candidateId with wrong shape', () => {
    const draft = mutated(valid, (d) => {
      d.candidateId = 'c0017'
    })
    expect(validateManifest('build', draft).ok).toBe(false)
  })
})

describe('capsule manifest rejects', () => {
  const valid = loadFixture('capsule.json')

  it('identity without candidateId (cross-binding is mandatory)', () => {
    const draft = mutated(valid, (d) => {
      delete (d.identity as Record<string, unknown>).candidateId
    })
    expect(validateManifest('capsule', draft).ok).toBe(false)
  })

  it('unknown protocol version string', () => {
    const draft = mutated(valid, (d) => {
      d.protocol = 'dsh-evolve-le/capsule/v0'
    })
    expect(validateManifest('capsule', draft).ok).toBe(false)
  })

  it('timestamp-like or extra provenance field', () => {
    const draft = mutated(valid, (d) => {
      d.createdAt = '2026-08-29T00:00:00Z'
    })
    expect(validateManifest('capsule', draft).ok).toBe(false)
  })

  it('sbom path outside the fixed location', () => {
    const draft = mutated(valid, (d) => {
      ;(d.sbom as Record<string, unknown>).path = 'runtime/sbom.spdx.json'
    })
    expect(validateManifest('capsule', draft).ok).toBe(false)
  })
})

describe('validateManifest error reporting', () => {
  it('lists every violation, not just the first', () => {
    const draft = mutated(loadFixture('candidate.json'), (d) => {
      delete d.schemaVersion
      d.extra = 1
    })
    const result = validateManifest('candidate' satisfies ManifestKind, draft)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.length).toBeGreaterThanOrEqual(2)
  })
})
