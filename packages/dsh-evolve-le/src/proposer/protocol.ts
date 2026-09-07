/**
 * Proposal output protocol (Gate 4, specs/03 §9, specs/07 §6): the only
 * channel a proposer sandbox has back to the controller. The bundle names the
 * children it materialized under its writable root (never absolute paths) and
 * the controller re-canonicalizes, re-diffs and validates everything — the
 * protocol carries intent and references, never trust.
 * @module @dsh-evolve-le/core/proposer/protocol
 */

import type { TreeV2AnalysisReceipt, TreeV2ProposalReceipt } from '../tree-v2/receipts.js'

export const PROPOSAL_PROTOCOL = 'dsh-evolve-le/proposal/v1'
export const PROPOSAL_V2_PROTOCOL = 'dsh-evolve-le/proposal/v2'

/** Trusted parent facts required before a proposer may author a v2 child. */
export interface TreeV2ProposalParent {
  candidateDigest: string
  mechanismOutcomeDigest: string
}

/** Hard width bound (specs/03 §9 W_p): at most three children per proposal. */
export const PROPOSAL_MAX_WIDTH = 3

/** Candidate-owned strategy surfaces a proposal may target. */
export type StrategySurface =
  'system-prompt' | 'tools' | 'skills' | 'agent-events' | 'session-events' | 'workflow'

const STRATEGY_SURFACES = new Set<StrategySurface>([
  'system-prompt',
  'tools',
  'skills',
  'agent-events',
  'session-events',
  'workflow',
])

export class ProposalProtocolError extends Error {
  constructor(message: string) {
    super(`proposal-protocol: ${message}`)
    this.name = 'ProposalProtocolError'
  }
}

/** One proposed child: a name in the sandbox children root plus its intent. */
export interface ChildProposalIntent {
  /** Directory name under `work/children/` holding the child source tree. */
  childName: string
  /** The mechanism the child tests; must be distinct across the batch. */
  hypothesis: string
  /** Archive candidate ids whose mechanism this child builds on. */
  donorCandidates: string[]
  /** Export object digests this child's hypothesis is grounded in. */
  evidenceRefs?: string[]
  /** Failure modes from the evidence this child targets. */
  targetFailureModes: string[]
  /** Explicit candidate-owned surfaces this hypothesis intends to evolve. */
  strategySurfaces?: StrategySurface[]
  /** Required in a v2 envelope; absent in legacy v1. */
  analysisReceipt?: TreeV2AnalysisReceipt
  /** Required in a v2 envelope; binds this child's candidate-intent receipt. */
  proposalReceipt?: TreeV2ProposalReceipt
}

export interface ProposalOutput {
  schemaVersion: 1 | 2
  protocol: typeof PROPOSAL_PROTOCOL | typeof PROPOSAL_V2_PROTOCOL
  /** Canonical source digest of the parent the children derive from. */
  parentSourceHash: string
  children: ChildProposalIntent[]
}

const CHILD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SHA256_REF_PATTERN = /^sha256:[0-9a-f]{64}$/

function isTreeV2Receipt(value: unknown, kind: 'analysis' | 'proposal'): boolean {
  const receipt = value as Record<string, unknown> | null
  return (
    receipt !== null &&
    typeof receipt === 'object' &&
    !Array.isArray(receipt) &&
    receipt['schemaVersion'] === 2 &&
    receipt['protocol'] === 'dsh-self-evolving-candidate-tree-v2' &&
    receipt['kind'] === kind &&
    typeof receipt['receiptDigest'] === 'string' &&
    SHA256_REF_PATTERN.test(receipt['receiptDigest'])
  )
}

function isModeContract(value: unknown): boolean {
  const contract = value as Record<string, unknown> | null
  if (contract === null || typeof contract !== 'object' || Array.isArray(contract)) return false
  const target = contract['targetModes']
  const preserved = contract['preservedModes']
  if (!Array.isArray(target) || !Array.isArray(preserved) || target.length === 0) return false
  if ([...target, ...preserved].some((mode) => mode !== 'solve' && mode !== 'propose')) return false
  if (new Set(target).size !== target.length || new Set(preserved).size !== preserved.length) {
    return false
  }
  if (target.some((mode) => preserved.includes(mode))) return false
  return new Set([...target, ...preserved]).size === 2
}

function isParentEvidence(value: unknown): boolean {
  const evidence = value as Record<string, unknown> | null
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return false
  const names = [
    'analysisDigest',
    'mechanismOutcomeDigest',
    'normalizedTrialDigest',
    'trajectoryDigest',
  ]
  return (
    Object.keys(evidence).length === names.length &&
    names.every(
      (name) => typeof evidence[name] === 'string' && SHA256_REF_PATTERN.test(evidence[name]),
    )
  )
}

/** Parse and shape-check a proposal bundle (semantic validation is the controller's). */
export function parseProposalOutput(value: unknown): asserts value is ProposalOutput {
  const record = value as Record<string, unknown> | null
  const bad = (detail: string): ProposalProtocolError => new ProposalProtocolError(detail)
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw bad('bundle must be an object')
  }
  const isV2 = record['schemaVersion'] === 2
  if (record['schemaVersion'] !== 1 && !isV2) throw bad('schemaVersion must be 1 or 2')
  const expectedProtocol = isV2 ? PROPOSAL_V2_PROTOCOL : PROPOSAL_PROTOCOL
  if (record['protocol'] !== expectedProtocol) {
    throw bad(
      `protocol must be ${expectedProtocol} for schemaVersion ${String(record['schemaVersion'])}`,
    )
  }
  if (
    typeof record['parentSourceHash'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record['parentSourceHash'])
  ) {
    throw bad('parentSourceHash must be sha256:<64-hex>')
  }
  const children = record['children']
  if (!Array.isArray(children) || children.length === 0) {
    throw bad('children must be a non-empty array')
  }
  if (children.length > PROPOSAL_MAX_WIDTH) {
    throw bad(`width ${children.length} exceeds the pre-registered cap ${PROPOSAL_MAX_WIDTH}`)
  }
  const names = new Set<string>()
  const hypotheses = new Set<string>()
  for (const child of children) {
    const entry = child as Record<string, unknown> | null
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw bad('each child must be an object')
    }
    if (typeof entry['childName'] !== 'string' || !CHILD_NAME_PATTERN.test(entry['childName'])) {
      throw bad(`childName ${String(entry['childName'])} is not a safe directory name`)
    }
    if (names.has(entry['childName'])) throw bad(`duplicate childName ${entry['childName']}`)
    names.add(entry['childName'])
    if (typeof entry['hypothesis'] !== 'string' || entry['hypothesis'].length < 10) {
      throw bad(`child ${entry['childName']} hypothesis too short to be a mechanism`)
    }
    if (hypotheses.has(entry['hypothesis'])) {
      throw bad('children in one batch must have distinct hypotheses (diversity)')
    }
    hypotheses.add(entry['hypothesis'])
    for (const field of ['donorCandidates', 'targetFailureModes'] as const) {
      const list = entry[field]
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        throw bad(`child ${entry['childName']} ${field} must be a string array`)
      }
    }
    if (entry['strategySurfaces'] !== undefined) {
      const surfaces = entry['strategySurfaces']
      if (
        !Array.isArray(surfaces) ||
        surfaces.length === 0 ||
        surfaces.some(
          (surface) =>
            typeof surface !== 'string' || !STRATEGY_SURFACES.has(surface as StrategySurface),
        )
      ) {
        throw bad(
          `child ${entry['childName']} strategySurfaces must contain known strategy surfaces`,
        )
      }
      if (new Set(surfaces).size !== surfaces.length) {
        throw bad(`child ${entry['childName']} strategySurfaces must be unique`)
      }
    }
    if (!isV2) {
      const refs = entry['evidenceRefs']
      if (!Array.isArray(refs) || refs.some((item) => typeof item !== 'string')) {
        throw bad(`child ${entry['childName']} evidenceRefs must be a string array in v1`)
      }
      for (const ref of refs as string[]) {
        if (!DIGEST_PATTERN.test(ref)) throw bad(`evidence ref ${ref} is not a bare sha256 digest`)
      }
      if (entry['analysisReceipt'] !== undefined || entry['proposalReceipt'] !== undefined) {
        throw bad(`child ${entry['childName']} cannot attach tree-v2 receipts to a v1 envelope`)
      }
    } else {
      if (entry['evidenceRefs'] !== undefined) {
        throw bad(`child ${entry['childName']} tree-v2 evidence must use named receipt bindings`)
      }
      if (
        !isTreeV2Receipt(entry['analysisReceipt'], 'analysis') ||
        !isTreeV2Receipt(entry['proposalReceipt'], 'proposal')
      ) {
        throw bad(`child ${entry['childName']} has invalid tree-v2 receipt envelopes`)
      }
      const analysis = entry['analysisReceipt'] as TreeV2AnalysisReceipt
      const proposal = entry['proposalReceipt'] as TreeV2ProposalReceipt
      if (proposal.analysisDigest !== analysis.receiptDigest) {
        throw bad(`child ${entry['childName']} proposal does not bind its analysis receipt`)
      }
      if (proposal.requiredParentEvidence.analysisDigest !== analysis.receiptDigest) {
        throw bad(
          `child ${entry['childName']} named analysisDigest does not bind its analysis receipt`,
        )
      }
      for (const [name, digest] of [
        ['normalizedTrialDigest', proposal.requiredParentEvidence.normalizedTrialDigest],
        ['trajectoryDigest', proposal.requiredParentEvidence.trajectoryDigest],
      ] as const) {
        if (!analysis.evidenceDigests.includes(digest)) {
          throw bad(`child ${entry['childName']} ${name} is absent from the analysis evidence`)
        }
      }
      if (
        !isModeContract(proposal.modeContract) ||
        !isParentEvidence(proposal.requiredParentEvidence)
      ) {
        throw bad(`child ${entry['childName']} has invalid tree-v2 contract`)
      }
    }
  }
}
