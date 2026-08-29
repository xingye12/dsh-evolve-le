/**
 * Proposal output protocol (Gate 4, specs/03 §9, specs/07 §6): the only
 * channel a proposer sandbox has back to the controller. The bundle names the
 * children it materialized under its writable root (never absolute paths) and
 * the controller re-canonicalizes, re-diffs and validates everything — the
 * protocol carries intent and references, never trust.
 * @module @dsh-evolve-le/core/proposer/protocol
 */

export const PROPOSAL_PROTOCOL = 'dsh-evolve-le/proposal/v1'

/** Hard width bound (specs/03 §9 W_p): at most three children per proposal. */
export const PROPOSAL_MAX_WIDTH = 3

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
  evidenceRefs: string[]
  /** Failure modes from the evidence this child targets. */
  targetFailureModes: string[]
}

export interface ProposalOutput {
  schemaVersion: 1
  protocol: typeof PROPOSAL_PROTOCOL
  /** Canonical source digest of the parent the children derive from. */
  parentSourceHash: string
  children: ChildProposalIntent[]
}

const CHILD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

/** Parse and shape-check a proposal bundle (semantic validation is the controller's). */
export function parseProposalOutput(value: unknown): asserts value is ProposalOutput {
  const record = value as Record<string, unknown> | null
  const bad = (detail: string): ProposalProtocolError => new ProposalProtocolError(detail)
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw bad('bundle must be an object')
  }
  if (record['schemaVersion'] !== 1) throw bad('schemaVersion must be 1')
  if (record['protocol'] !== PROPOSAL_PROTOCOL) {
    throw bad(`protocol must be ${PROPOSAL_PROTOCOL}`)
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
    for (const field of ['donorCandidates', 'evidenceRefs', 'targetFailureModes'] as const) {
      const list = entry[field]
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        throw bad(`child ${entry['childName']} ${field} must be a string array`)
      }
    }
    for (const ref of entry['evidenceRefs'] as string[]) {
      if (!DIGEST_PATTERN.test(ref)) throw bad(`evidence ref ${ref} is not a bare sha256 digest`)
    }
  }
}
