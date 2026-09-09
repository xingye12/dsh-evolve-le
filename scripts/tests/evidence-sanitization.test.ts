import { describe, expect, it } from 'vitest'
import {
  imagePrefetchAttestation,
  restrictedTaskNameHits,
  restrictedTaskNameRedactions,
  sanitizeRestrictedTaskNames,
} from '../lib/evidence-sanitization.ts'

describe('formal evidence restricted-name sanitation (ADR-052)', () => {
  const redactions = restrictedTaskNameRedactions(
    new Map([['guard-real-task', 'guard-opaque-01']]),
    ['sealed-real-task'],
  )

  it('redacts bare and registry-qualified guard/sealed names before a copy is written', () => {
    const raw = JSON.stringify({
      task_name: 'terminal-bench/guard-real-task',
      image: 'tb/terminal-bench/sealed-real-task:latest',
      nested: ['guard-real-task', 'sealed-real-task'],
    })
    const sanitized = sanitizeRestrictedTaskNames(raw, redactions)

    expect(sanitized).toContain('guard:guard-opaque-01')
    expect(sanitized).toContain('sealed:01')
    expect(restrictedTaskNameHits(sanitized, redactions)).toEqual([])
  })

  it('exports image prefetch only as a hash-bound, task-name-free attestation', () => {
    const raw = Buffer.from(
      JSON.stringify({ images: ['tb/terminal-bench/guard-real-task:latest', 'sealed-real-task'] }),
    )
    const attestation = imagePrefetchAttestation(raw)
    const rendered = JSON.stringify(attestation)

    expect(attestation).toMatchObject({
      protocol: 'dsh-evolve-le/evidence-image-prefetch-attestation/v1',
      imageCount: 2,
    })
    expect(attestation.sourceSha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(restrictedTaskNameHits(rendered, redactions)).toEqual([])
  })
})
