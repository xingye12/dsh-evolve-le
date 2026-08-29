/**
 * Thompson sampling over the archive (specs/03 §5–6, specs/06 §9).
 *
 * Parent selection draws one Beta sample per eligible candidate from the
 * clade aggregates (`Beta(tau*(1+S_C), tau*(1+F_C))`, primary runs tau=1);
 * node evaluation selection draws `Beta(1+s, 1+f)` per node. Every draw is a
 * pure function of (masterSeed, runId, stream, counter, population): the
 * population is canonically sorted before hashing (specs/06 §9), the raw
 * uint32 words land in the receipt, and replay re-reads the receipt instead
 * of re-sampling. Guard observations never enter the parameters — they were
 * already excluded by the clade aggregation.
 * @module @dsh-evolve-le/core/selection/thompson
 */

import type { CandidateState, Observation } from '../state/reducer.js'
import { betaParametersFor, cladeStats, nodeStats } from './clade.js'
import { drawWords, hashDrawInput, type RngReceipt } from '../state/rng.js'

/** Primary-run default tau (HGM public implementation cool_down=false). */
export const DEFAULT_TAU = 1

/** Convert one uint32 word to a uniform in (0, 1). */
function wordToUniform(word: number): number {
  return (word + 0.5) / 4294967296
}

/**
 * Sample Beta(alpha, beta) from a deterministic word stream.
 *
 * Marsaglia–Tsang gamma sampling (shape >= 1; smaller shapes use the standard
 * boost `Gamma(a) = Gamma(a+1) * U^(1/a)`), normals via Box–Muller from pairs
 * of uniforms, and the squeeze/acceptance tests exactly as published. Words
 * are consumed in order and rejection advances to the next word, so the word
 * sequence fully determines the sample and a receipt's `raw` re-derives it.
 */
export function betaSample(alpha: number, beta: number, words: readonly number[]): number {
  if (!(alpha > 0) || !(beta > 0)) throw new Error(`thompson: invalid Beta(${alpha}, ${beta})`)
  let cursor = 0
  const nextUniform = (): number => {
    if (cursor >= words.length) {
      throw new Error('thompson: word stream exhausted before the sample converged')
    }
    const word = words[cursor]
    cursor += 1
    if (word === undefined) throw new Error('thompson: missing word')
    return wordToUniform(word)
  }
  let spareNormal: number | null = null
  const nextNormal = (): number => {
    if (spareNormal !== null) {
      const value = spareNormal
      spareNormal = null
      return value
    }
    for (;;) {
      const u1 = nextUniform()
      const u2 = nextUniform()
      const radius = Math.sqrt(-2 * Math.log(u1))
      const angle = 2 * Math.PI * u2
      spareNormal = radius * Math.sin(angle)
      return radius * Math.cos(angle)
    }
  }
  const gamma = (shape: number): number => {
    const boosted = shape < 1
    const a = boosted ? shape + 1 : shape
    const d = a - 1 / 3
    const c = 1 / Math.sqrt(9 * d)
    for (;;) {
      const x = nextNormal()
      if (x <= -1 / c) continue
      const v = (1 + c * x) ** 3
      const u = nextUniform()
      if (u < 1 - 0.0331 * x ** 4) return boosted ? d * v * nextUniform() ** (1 / shape) : d * v
      if (Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) {
        return boosted ? d * v * nextUniform() ** (1 / shape) : d * v
      }
    }
  }
  const x = gamma(alpha)
  const y = gamma(beta)
  return x / (x + y)
}

export interface DrawParameters {
  candidateId: string
  alpha: number
  beta: number
}

export interface ThompsonDraw {
  winner: string
  /** Beta parameters per population member (canonical order). */
  parameters: DrawParameters[]
  /** theta per population member, canonical order. */
  thetas: number[]
  receipt: RngReceipt
}

function wordsForPopulation(count: number): number {
  // Each Beta sample needs a bounded-but-variable word count; 256 words per
  // member is far beyond any realistic rejection chain.
  return Math.max(64, count * 256)
}

/** Population order for hashing and iteration (specs/06 §9: canonical sort). */
function canonicalOrder(candidates: readonly CandidateState[]): CandidateState[] {
  return [...candidates].sort((a, b) =>
    a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0,
  )
}

/**
 * One parent-selection draw: `theta_clade(a) ~ Beta(tau*(1+S_C), tau*(1+F_C))`
 * over the eligible population; the winner is argmax theta.
 */
export function drawParentThompson(input: {
  masterSeed: string
  runId: string
  counter: number
  candidates: readonly CandidateState[]
  observations: readonly Observation[]
  tau?: number
}): ThompsonDraw {
  const tau = input.tau ?? DEFAULT_TAU
  const ordered = canonicalOrder(input.candidates)
  if (ordered.length === 0) throw new Error('thompson: empty parent population')
  const stats = new Map(
    cladeStats({ candidates: ordered, observations: input.observations }).map((entry) => [
      entry.candidateId,
      entry,
    ]),
  )
  const parameters: DrawParameters[] = ordered.map((candidate) => {
    const entry = stats.get(candidate.candidateId)
    if (entry === undefined)
      throw new Error(`thompson: no clade stats for ${candidate.candidateId}`)
    const params = betaParametersFor({ sC: entry.sC, fC: entry.fC, tau })
    return { candidateId: candidate.candidateId, ...params }
  })
  return samplePopulation({
    masterSeed: input.masterSeed,
    runId: input.runId,
    counter: input.counter,
    kind: 'parent',
    parameters,
  })
}

/** One node-evaluation draw: `theta_node(a) ~ Beta(1+s, 1+f)` (specs/03 §6). */
export function drawNodeThompson(input: {
  masterSeed: string
  runId: string
  counter: number
  candidates: readonly CandidateState[]
  observations: readonly Observation[]
}): ThompsonDraw {
  const ordered = canonicalOrder(input.candidates)
  if (ordered.length === 0) throw new Error('thompson: empty node population')
  const stats = nodeStats({ candidates: ordered, observations: input.observations })
  const parameters: DrawParameters[] = ordered.map((candidate) => {
    const entry = stats.get(candidate.candidateId)
    if (entry === undefined) throw new Error(`thompson: no node stats for ${candidate.candidateId}`)
    return {
      candidateId: candidate.candidateId,
      alpha: 1 + entry.s,
      beta: 1 + entry.f,
    }
  })
  return samplePopulation({
    masterSeed: input.masterSeed,
    runId: input.runId,
    counter: input.counter,
    kind: 'node',
    parameters,
  })
}

function samplePopulation(input: {
  masterSeed: string
  runId: string
  counter: number
  kind: 'parent' | 'node'
  parameters: DrawParameters[]
}): ThompsonDraw {
  const description = {
    stream: 'scheduler-thompson',
    kind: input.kind,
    population: input.parameters.map((parameter) => parameter.candidateId),
    parameters: input.parameters.map((parameter) => [parameter.alpha, parameter.beta]),
  }
  const words = drawWords({
    masterSeed: input.masterSeed,
    runId: input.runId,
    stream: 'scheduler-thompson',
    counter: input.counter,
    words: wordsForPopulation(input.parameters.length),
  })
  const stride = Math.floor(words.length / input.parameters.length)
  const thetas = input.parameters.map((parameter, index) =>
    betaSample(parameter.alpha, parameter.beta, words.slice(index * stride, (index + 1) * stride)),
  )
  let winnerIndex = 0
  for (let index = 1; index < thetas.length; index += 1) {
    if (thetas[index]! > thetas[winnerIndex]!) winnerIndex = index
  }
  const receipt: RngReceipt = {
    stream: 'scheduler-thompson',
    counter: input.counter,
    algorithm: 'dsh-evolve-le/counter-hmac-sha256/v1',
    inputHash: hashDrawInput(description),
    raw: words,
    result: {
      kind: input.kind,
      winner: input.parameters[winnerIndex]!.candidateId,
      // Per-mille: journal payloads must be canonical JSON (safe integers
      // only); the exact thetas re-derive from `raw` and the parameters.
      thetasPerMille: thetas.map((theta) => Math.round(theta * 1000)),
    },
  }
  return {
    winner: input.parameters[winnerIndex]!.candidateId,
    parameters: input.parameters,
    thetas,
    receipt,
  }
}
