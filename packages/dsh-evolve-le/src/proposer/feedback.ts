/**
 * Prior-rejection feedback (ADR-044): the controller keeps every expansion's
 * rejected children with their exact validator reasons and hands them to the
 * NEXT expansion as a controller-owned input document, so the proposer stops
 * repeating rejected shapes (attempt 2 died on three consecutive all-reject
 * expansions; attempt 12's were malformed children the proposer never saw).
 *
 * The record is durable in search-state (merged idempotently by actionId in
 * the same write as the expansion counters) and staged as
 * `input/prior-rejections.json` — dev-observed verdicts about the proposer's
 * own output, never sealed data. The cap and truncation keep the staged doc
 * far under the 512 KiB tool-read cap.
 * @module @dsh-evolve-le/core/proposer/feedback
 */

/** One expansion's rejection evidence: what was rejected and why. */
export interface ProposalRejectionRecord {
  actionId: string
  rejected: Array<{ childName: string; reason: string }>
  batchErrors: string[]
}

/** Frozen limits (ADR-044): last N expansions, reason truncation. */
export const PROPOSAL_REJECTION_CAP = 16
export const REJECTION_REASON_CAP = 300

const PRIOR_REJECTIONS_PROTOCOL = 'dsh-evolve-le/prior-rejections/v1'

/** Build the record for one proposal result; null when nothing was rejected. */
export function proposalRejectionOf(result: {
  actionId: string
  summary: {
    rejected: Array<{ childName: string; reason?: string }>
    batchErrors: string[]
  }
}): ProposalRejectionRecord | null {
  const rejected = result.summary.rejected.map((verdict) => ({
    childName: verdict.childName,
    reason: (verdict.reason ?? 'no reason recorded').slice(0, REJECTION_REASON_CAP),
  }))
  const batchErrors = result.summary.batchErrors.map((error) =>
    error.slice(0, REJECTION_REASON_CAP),
  )
  if (rejected.length === 0 && batchErrors.length === 0) return null
  return { actionId: result.actionId, rejected, batchErrors }
}

/** Idempotent append: an entry with the same actionId is replaced, never doubled. */
export function mergeProposalRejections(
  existing: readonly ProposalRejectionRecord[],
  next: ProposalRejectionRecord,
): ProposalRejectionRecord[] {
  return [...existing.filter((entry) => entry.actionId !== next.actionId), next].slice(
    -PROPOSAL_REJECTION_CAP,
  )
}

/** The staged input document (frozen protocol, exact entries). */
export function buildPriorRejectionsDoc(records: readonly ProposalRejectionRecord[]): {
  protocol: string
  entries: ProposalRejectionRecord[]
} {
  return { protocol: PRIOR_REJECTIONS_PROTOCOL, entries: records.map((entry) => ({ ...entry })) }
}
