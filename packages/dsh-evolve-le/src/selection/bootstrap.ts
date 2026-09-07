/**
 * Cluster bootstrap for the champion tournament (ADR-047, specs/03 §11
 * step 5): the lower confidence bound over task-clustered paired deltas.
 * Clusters (paired task deltas) are resampled with replacement, and the
 * percentile of the resample-mean distribution is the LCB — a 90% LCB is
 * the 10th percentile (ADR-047 pre-registers ≥100 000 resamples with a
 * fixed seed).
 *
 * The resample stream is fully deterministic: eight HMAC words on the
 * `'bootstrap'` RNG stream (overridable — ADR-048's sealed CI draws on
 * `'sealed-bootstrap'`) expand through xorshift128+ with rejection sampling
 * for unbiased cluster indices, so the same
 * (masterSeed, runId, counter) always reproduces the same indices, bound,
 * and receipt — replayable byte-for-byte from the receipt alone. The
 * expanded indices are never stored; they re-derive from the eight seed
 * words and the input description.
 * @module @dsh-evolve-le/core/selection/bootstrap
 */
import {
  drawWords,
  hashDrawInput,
  RNG_ALGORITHM,
  type RngReceipt,
  type RngStreamName,
} from '../state/rng.js'

export const BOOTSTRAP_EXPANSION_ALGORITHM = 'dsh-evolve-le/xorshift128plus-rejection/v1'

const MASK64 = (1n << 64n) - 1n

export interface Xorshift128plusState {
  s0: bigint
  s1: bigint
}

export interface Xorshift128plusStep {
  /** The 64-bit output word: x + y after the state swap. */
  out: bigint
  /** Next state halves (the halves are swapped by the step). */
  s0: bigint
  s1: bigint
}

/**
 * One xorshift128+ step (V8's generator convention, hand-pinned by the
 * contract tests): x = s0, y = s1; x ^= x<<23; x ^= x>>17; x ^= y;
 * x ^= y>>26 (all masked to 64 bits); out = x + y; the next state is
 * {s0: y, s1: x}.
 */
export function xorshift128plusNext(state: Xorshift128plusState): Xorshift128plusStep {
  let x = state.s0
  const y = state.s1
  x ^= (x << 23n) & MASK64
  x ^= x >> 17n
  x ^= y
  x ^= y >> 26n
  x &= MASK64
  return { out: (x + y) & MASK64, s0: y, s1: x }
}

export interface BootstrapLcbInput {
  masterSeed: string
  runId: string
  /** Draw counter on the `stream` (default 'bootstrap'). */
  counter: number
  /** Paired task deltas (each task is one cluster). */
  deltas: readonly number[]
  /** Resamples to run (ADR-047 pre-registers ≥100 000). */
  resamples: number
  /** Integer percentile of the resample-mean distribution (10 = 90% LCB). */
  percentile?: number
  /**
   * Exact percentile in (0, 100), interpolated between ranks (ADR-048's
   * 2.5th/97.5th sealed CI). Mutually exclusive with `percentile`.
   */
  percentileExact?: number
  /** Receipt stream (default 'bootstrap'; ADR-048 uses 'sealed-bootstrap'). */
  stream?: RngStreamName
}

export interface BootstrapLcbResult {
  /** Sample mean of the deltas. */
  mean: number
  /** Cluster-bootstrap lower confidence bound. */
  lcb: number
  receipt: RngReceipt
}

/** Cluster-bootstrap LCB over paired task deltas (deterministic). */
export function clusterBootstrapLcb(input: BootstrapLcbInput): BootstrapLcbResult {
  const clusters = input.deltas.length
  if (clusters === 0) throw new Error('bootstrap: empty delta vector')
  if (!Number.isSafeInteger(input.resamples) || input.resamples <= 0) {
    throw new Error('bootstrap: resamples must be a positive safe integer')
  }
  const hasPercentile = input.percentile !== undefined
  const hasPercentileExact = input.percentileExact !== undefined
  if (hasPercentile === hasPercentileExact) {
    throw new Error('bootstrap: pass exactly one of percentile or percentileExact')
  }
  if (
    hasPercentile &&
    (!Number.isSafeInteger(input.percentile) ||
      (input.percentile as number) < 1 ||
      (input.percentile as number) > 50)
  ) {
    throw new Error('bootstrap: percentile must be an integer in 1..50')
  }
  if (
    hasPercentileExact &&
    (!Number.isFinite(input.percentileExact) ||
      (input.percentileExact as number) <= 0 ||
      (input.percentileExact as number) >= 100)
  ) {
    throw new Error('bootstrap: percentileExact must be a number in (0, 100)')
  }
  const stream = input.stream ?? 'bootstrap'
  const mean = input.deltas.reduce((sum, delta) => sum + delta, 0) / clusters

  // Eight HMAC words XOR-fold into two 64-bit state halves.
  const words = drawWords({
    masterSeed: input.masterSeed,
    runId: input.runId,
    stream,
    counter: input.counter,
    words: 8,
  })
  const half = (offset: number): bigint =>
    (BigInt(words[offset]!) << 32n) | BigInt(words[offset + 1]!)
  let s0 = half(0) ^ half(4)
  let s1 = half(2) ^ half(6)
  if (s0 === 0n && s1 === 0n) {
    throw new Error('bootstrap: degenerate xorshift seed state (fail closed)')
  }
  const nextIndex = (): number => {
    for (;;) {
      const step = xorshift128plusNext({ s0, s1 })
      s0 = step.s0
      s1 = step.s1
      // Rejection sampling: only outputs below the largest multiple of
      // `clusters` in 2^64 map onto indices without modulo bias.
      const limit = (2n ** 64n / BigInt(clusters)) * BigInt(clusters)
      if (step.out < limit) return Number(step.out % BigInt(clusters))
    }
  }

  const resampleMeans = Array.from({ length: input.resamples }, () => {
    let sum = 0
    for (let index = 0; index < clusters; index += 1) sum += input.deltas[nextIndex()]!
    return sum / clusters
  }).sort((a, b) => a - b)
  let lcb: number
  if (hasPercentile) {
    const percentileIndex = Math.max(
      0,
      Math.ceil(((input.percentile as number) / 100) * resampleMeans.length) - 1,
    )
    lcb = resampleMeans[percentileIndex]!
  } else {
    // ADR-048 exact percentile: linear interpolation between the ranks the
    // fractional percentile falls between (2.5/97.5 → the sealed 95% CI).
    const rank = ((input.percentileExact as number) / 100) * (resampleMeans.length - 1)
    const lower = Math.floor(rank)
    const upper = Math.ceil(rank)
    const fraction = rank - lower
    lcb = resampleMeans[lower]! + fraction * (resampleMeans[upper]! - resampleMeans[lower]!)
  }

  // The input description must be canonical JSON (safe integers only): a
  // fractional delta vector is bound as its rounded per-mille form. Integer
  // deltas hash exactly as before, so existing receipt chains stay valid.
  const deltaDescription = input.deltas.every((delta) => Number.isSafeInteger(delta))
    ? { deltas: [...input.deltas] }
    : { deltasPerMille: input.deltas.map((delta) => Math.round(delta * 1000)) }

  const receipt: RngReceipt = {
    stream,
    counter: input.counter,
    algorithm: RNG_ALGORITHM,
    inputHash: hashDrawInput({
      stream,
      clusters,
      resamples: input.resamples,
      ...deltaDescription,
      // Canonical JSON again: the exact float is bound as its per-mille form,
      // the same value the result records.
      ...(hasPercentile
        ? { percentile: input.percentile }
        : { percentilePerMille: Math.round((input.percentileExact as number) * 10) }),
    }),
    raw: words,
    result: {
      algorithm: BOOTSTRAP_EXPANSION_ALGORITHM,
      resamples: input.resamples,
      clusters,
      // The integer path keeps its pinned `percentile` field; the exact path
      // records its per-mille percentile instead (both integer-only).
      ...(hasPercentile
        ? { percentile: input.percentile }
        : { percentilePerMille: Math.round((input.percentileExact as number) * 10) }),
      // Per-mille: journal payloads must be canonical JSON (safe integers
      // only); the exact floats re-derive from `raw` and the deltas.
      meanPerMille: Math.round(mean * 1000),
      lcbPerMille: Math.round(lcb * 1000),
    },
  }
  return { mean, lcb, receipt }
}
