/**
 * Counter-stream RNG with receipts (specs/06 §9). Every category of
 * randomness draws from its own named counter stream derived from the run's
 * master seed; each draw is recorded as a receipt (stream, counter,
 * algorithm, input-population/order/parameters hash, raw words, result).
 * Replay reads receipts and never re-invokes the RNG, so decisions are
 * auditable byte-for-byte. Raw draws are uint32 words — always safe
 * integers under the canonical-JSON rules.
 *
 * The state layer is deliberately unaware of the master seed: derivation
 * helpers live here for the controller, while the reducer only consumes and
 * validates receipts (duplicate identical counter = idempotent; same counter
 * with different content fails closed).
 * @module @dsh-evolve-le/core/state/rng
 */

import { createHmac } from 'node:crypto'
import { canonicalHash } from './canonical.js'

export const RNG_ALGORITHM = 'dsh-evolve-le/counter-hmac-sha256/v1'

export const RNG_STREAMS = [
  'split',
  'scheduler-thompson',
  'task-sampler',
  'wave-permutation',
  'bootstrap',
  'audit-sample',
] as const

export type RngStreamName = (typeof RNG_STREAMS)[number]

export interface RngReceipt {
  stream: RngStreamName
  counter: number
  algorithm: typeof RNG_ALGORITHM
  /** Canonical hash of the input description: population/order/parameters. */
  inputHash: string
  /** Raw uint32 words drawn for this counter (sufficient to re-derive). */
  raw: number[]
  /** The decision the draw produced (canonical-representable value). */
  result: unknown
}

/** Derive `words` uint32 words for (seed, runId, stream, counter). */
export function drawWords(input: {
  masterSeed: string
  runId: string
  stream: RngStreamName
  counter: number
  words: number
}): number[] {
  const out: number[] = []
  for (let index = 0; index < input.words; index += 1) {
    const digest = createHmac('sha256', input.masterSeed)
      .update(`${input.runId}\0${input.stream}\0${input.counter}\0${index}`)
      .digest()
    out.push(digest.readUInt32BE(0))
  }
  return out
}

/** Map a raw uint32 word onto [0, n) without modulo bias, or null to reject. */
function unbiasedIndex(word: number, n: number): number | null {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`rng: invalid population ${n}`)
  const limit = Math.floor(4294967296 / n) * n
  return word < limit ? word % n : null
}

/** Uniform pick of one index from a population of size `n` (throws to reject). */
export function wordToIndex(word: number, n: number): number {
  const index = unbiasedIndex(word, n)
  if (index === null) throw new Error('rng: rejected word; draw the next counter')
  return index
}

/** Uniform pick of one index from a population of size `n` at `counter`. */
export function sampleIndex(input: {
  masterSeed: string
  runId: string
  stream: RngStreamName
  counter: number
  population: number
}): { index: number; raw: number[] } {
  const [word] = drawWords({ ...input, words: 1 })
  const index = wordToIndex(word ?? 0, input.population)
  return { index, raw: [word ?? 0] }
}

/**
 * Deterministic Fisher–Yates permutation of [0, n). One word per swap step;
 * a biased word advances to the next counter, and every consumed word is
 * recorded in `raw` order so the permutation re-derives from the receipt.
 */
export function permutationOf(input: {
  masterSeed: string
  runId: string
  stream: RngStreamName
  counter: number
  size: number
}): { order: number[]; raw: number[] } {
  const order = Array.from({ length: input.size }, (_unused, index) => index)
  const raw: number[] = []
  let counter = input.counter
  const nextWord = (): number => {
    const word = drawWords({
      masterSeed: input.masterSeed,
      runId: input.runId,
      stream: input.stream,
      counter,
      words: 1,
    })[0]
    if (word === undefined) throw new Error('rng: derivation returned no word')
    raw.push(word)
    counter += 1
    return word
  }
  for (let step = order.length - 1; step > 0; step -= 1) {
    let index = unbiasedIndex(nextWord(), step + 1)
    while (index === null) index = unbiasedIndex(nextWord(), step + 1)
    const swapped = order[index]
    order[index] = order[step] ?? step
    order[step] = swapped ?? step
  }
  return { order, raw }
}

/** Canonical input hash for a draw receipt (population/order/parameters). */
export function hashDrawInput(description: unknown): string {
  return canonicalHash(description)
}

const RECEIPT_FIELDS = 'algorithm,counter,inputHash,raw,stream'

/**
 * Validate a receipt's shape (fail closed). Semantic linkage — that `raw` and
 * `result` match the derivation — is the controller's job at draw time; the
 * reducer checks uniqueness per (stream, counter).
 */
export function validateRngReceipt(raw: unknown): asserts raw is RngReceipt {
  const record = raw as Record<string, unknown> | null
  const problem = (() => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return 'receipt must be an object'
    }
    const keys = Object.keys(record).sort().join(',')
    if (keys !== RECEIPT_FIELDS) return `wrong field set: ${keys}`
    if (typeof record['algorithm'] !== 'string' || record['algorithm'] !== RNG_ALGORITHM) {
      return `algorithm must be ${RNG_ALGORITHM}`
    }
    if (!RNG_STREAMS.includes(record['stream'] as RngStreamName)) return 'unknown stream'
    const counter = record['counter']
    if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) {
      return 'counter must be a non-negative safe integer'
    }
    if (typeof record['inputHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['inputHash'])) {
      return 'inputHash must be 64-hex'
    }
    const words = record['raw']
    if (!Array.isArray(words) || words.length === 0) return 'raw must be a non-empty array'
    if (
      words.some(
        (word) =>
          typeof word !== 'number' || !Number.isSafeInteger(word) || word < 0 || word > 4294967295,
      )
    ) {
      return 'raw words must be uint32 safe integers'
    }
    return undefined
  })()
  if (problem !== undefined) throw new Error(`rng: invalid receipt: ${problem}`)
}
