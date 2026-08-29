/**
 * Guard/sealed canary tokens (specs/05 §10–§11, specs/06 §11).
 *
 * DEV_GUARD and SEALED records carry canary tokens. Any appearance of a
 * canary in proposer outputs, logs, prompts or source is an information-flow
 * breach: stop immediately and invalidate the lineage. Receipts and error
 * messages carry only sha256 fingerprints of the tokens — never the tokens
 * themselves, or the receipt would leak the canary into evidence.
 * @module @dsh-evolve-le/core/proposer/canary
 */

import { createHash, randomBytes } from 'node:crypto'

export const CANARY_VERSION = 'dsh-evolve-le/canary/v1'

/** Canary token shape: uppercase prefix + lowercase hex body, URL-safe. */
export const CANARY_PATTERN = /^DSHCANARY_[0-9a-f]{32}$/

/** One canary hit: the fingerprint, the offending field, and where it moved. */
export interface CanaryHit {
  tokenFingerprint: string
  field: string
}

/** Generate `count` fresh canary tokens (crypto-random, non-guessable). */
export function generateCanaryTokens(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new Error(`canary count must be 1..10000, got ${String(count)}`)
  }
  return Array.from({ length: count }, () => `DSHCANARY_${randomBytes(16).toString('hex')}`)
}

/** sha256 fingerprint of a token — safe to write into receipts and errors. */
export function canaryFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Validate a canary token's shape before embedding it in guarded content. */
export function isValidCanaryToken(token: string): boolean {
  return CANARY_PATTERN.test(token)
}

/**
 * Scan untrusted text for known canary tokens. Returns fingerprints of every
 * token found — the caller can log the result without leaking the tokens.
 * Guarded content is data, never authority (specs/05 §11).
 */
export function scanForCanary(text: string, tokens: readonly string[]): CanaryHit[] {
  const hits: CanaryHit[] = []
  for (const token of tokens) {
    if (text.includes(token)) {
      hits.push({ tokenFingerprint: canaryFingerprint(token), field: 'text' })
    }
  }
  return hits
}

/**
 * Scan an object of string fields (proposal output, manifest, log line…) for
 * canaries, reporting which field leaked. Recurses into arrays/objects so a
 * canary hidden in a nested list is still attributed.
 */
export function scanFieldsForCanary(
  value: unknown,
  tokens: readonly string[],
  path = '',
): CanaryHit[] {
  const hits: CanaryHit[] = []
  if (typeof value === 'string') {
    for (const token of tokens) {
      if (value.includes(token)) {
        hits.push({ tokenFingerprint: canaryFingerprint(token), field: path || 'text' })
      }
    }
    return hits
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      hits.push(...scanFieldsForCanary(item, tokens, `${path}[${index}]`))
    }
    return hits
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      hits.push(...scanFieldsForCanary(item, tokens, path === '' ? key : `${path}.${key}`))
    }
  }
  return hits
}
