/**
 * Contract tests for prior-rejection feedback (ADR-044): every expansion must
 * read this run's previously rejected children with their exact validator
 * reasons, so the proposer stops repeating rejected shapes (attempt 2 died
 * on three consecutive all-reject expansions; attempt 12's were malformed
 * children the proposer never saw). Pins:
 *
 * - the rejection record is built from the proposal summary (per-child
 *   rejected reasons + batch errors), truncated at the frozen cap;
 * - a clean proposal (nothing rejected, no bundle error) records nothing;
 * - merging is idempotent by actionId (a crash/resume never double-appends)
 *   and keeps only the last 16 entries;
 * - the staged document carries the frozen protocol + exact entries;
 * - the live-route prompt (native instruction + wire-protocol section) names
 *   prior-rejections.json as a readable input and binds the reasons as
 *   constraints.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPriorRejectionsDoc,
  mergeProposalRejections,
  PROPOSAL_REJECTION_CAP,
  proposalRejectionOf,
  REJECTION_REASON_CAP,
} from '../src/proposer/feedback.js'
import {
  buildNativeProposalInstruction,
  TCB_PROTOCOL_SECTION,
} from '../src/proposer/prompt-text.js'

describe('proposalRejectionOf (ADR-044)', () => {
  it('builds a record from rejected children and batch errors, truncating reasons', () => {
    const record = proposalRejectionOf({
      actionId: 'prop-2',
      summary: {
        rejected: [
          {
            childName: 'child-1',
            reason: `candidate scan rejected the child: ${'x'.repeat(2000)}`,
          },
        ],
        batchErrors: [],
      },
    })
    expect(record).not.toBeNull()
    expect(record!.actionId).toBe('prop-2')
    expect(record!.rejected).toHaveLength(1)
    expect(record!.rejected[0]!.childName).toBe('child-1')
    expect(record!.rejected[0]!.reason).toHaveLength(REJECTION_REASON_CAP)
    expect(record!.batchErrors).toEqual([])
  })

  it('records nothing for a clean proposal (no rejections, no bundle errors)', () => {
    expect(
      proposalRejectionOf({
        actionId: 'prop-1',
        summary: { rejected: [], batchErrors: [] },
      }),
    ).toBeNull()
  })

  it('records a failed action through its synthesized batch error', () => {
    const record = proposalRejectionOf({
      actionId: 'prop-3',
      summary: { rejected: [], batchErrors: ['worker failed: injected worker failure'] },
    })
    expect(record!.batchErrors).toEqual(['worker failed: injected worker failure'])
  })
})

describe('mergeProposalRejections (ADR-044)', () => {
  function record(actionId: string): NonNullable<ReturnType<typeof proposalRejectionOf>> {
    return {
      actionId,
      rejected: [{ childName: 'child-1', reason: 'duplicate mechanism: identical diff hash' }],
      batchErrors: [],
    }
  }

  it('is idempotent by actionId: re-merging the same expansion replaces, never appends', () => {
    const first = mergeProposalRejections([], record('prop-1'))
    const again = mergeProposalRejections(first, record('prop-1'))
    expect(again).toHaveLength(1)
    expect(again).toEqual(first)
  })

  it('keeps only the last PROPOSAL_REJECTION_CAP entries (oldest dropped)', () => {
    let merged: ReturnType<typeof mergeProposalRejections> = []
    for (let index = 0; index < PROPOSAL_REJECTION_CAP + 3; index += 1) {
      merged = mergeProposalRejections(merged, record(`prop-${index + 1}`))
    }
    expect(merged).toHaveLength(PROPOSAL_REJECTION_CAP)
    expect(merged[0]!.actionId).toBe('prop-4')
    expect(merged[PROPOSAL_REJECTION_CAP - 1]!.actionId).toBe(`prop-${PROPOSAL_REJECTION_CAP + 3}`)
  })
})

describe('buildPriorRejectionsDoc (ADR-044)', () => {
  it('wraps the entries in the frozen protocol document', () => {
    const doc = buildPriorRejectionsDoc([
      {
        actionId: 'prop-2',
        rejected: [{ childName: 'child-1', reason: 'package/missing' }],
        batchErrors: ['bundle rejected: nope'],
      },
    ])
    expect(doc.protocol).toBe('dsh-evolve-le/prior-rejections/v1')
    expect(doc.entries).toHaveLength(1)
    expect(doc.entries[0]).toEqual({
      actionId: 'prop-2',
      rejected: [{ childName: 'child-1', reason: 'package/missing' }],
      batchErrors: ['bundle rejected: nope'],
    })
  })
})

describe('live-route prompt names the feedback file (ADR-044)', () => {
  it('the native proposal instruction tells the model to read prior-rejections.json', () => {
    const text = buildNativeProposalInstruction({ parentSourceHash: 'sha256:ab', width: 3 })
    expect(text).toContain('prior-rejections.json')
    expect(text).toContain('rejected')
  })

  it('the wire-protocol section lists prior-rejections.json as a readable root', () => {
    expect(TCB_PROTOCOL_SECTION.text).toContain('prior-rejections.json')
  })
})
