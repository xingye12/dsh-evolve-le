/** Cross-document validation for the tree-v2 proposal and admission chain. */

import { validateTreeV2, type TreeV2SchemaKind } from '../schema.js'
import {
  TREE_V2_PROTOCOL,
  treeV2Digest,
  verifyTreeV2Receipt,
  type TreeV2CandidateIntent,
  type TreeV2ModeContract,
  type TreeV2ModeFingerprints,
  type TreeV2Receipt,
  type TreeV2ReceiptKind,
  type TreeV2RequiredParentEvidence,
} from './contract.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { canonicalJson } from '../state/canonical.js'

type ReceiptBase<K extends TreeV2ReceiptKind> = {
  schemaVersion: 2
  protocol: typeof TREE_V2_PROTOCOL
  kind: K
  receiptDigest: string
}

export type TreeV2AnalysisReceipt = ReceiptBase<'analysis'> & {
  parentCandidateDigest: string
  findings: string[]
  evidenceDigests: string[]
}

export type TreeV2ProposalReceipt = ReceiptBase<'proposal'> & {
  proposalId: string
  parentCandidateDigest: string
  analysisDigest: string
  candidateIntentDigest: string
  modeContract: TreeV2ModeContract
  requiredParentEvidence: TreeV2RequiredParentEvidence
}

export type TreeV2MechanismOutcomeReceipt = ReceiptBase<'mechanism-outcome'> & {
  candidateIntentDigest: string
  mechanismTestDigest: string
  outcome: 'passed' | 'failed'
}

export type TreeV2CapabilityCatalogReceipt = ReceiptBase<'capability-catalog'> & {
  candidateDigest: string
  capabilities: string[]
}

export type TreeV2MaterializationReceipt = ReceiptBase<'materialization-receipt'> & {
  parentCandidateDigest: string | null
  candidateDigest: string
  candidateIntentDigest: string
  sourceDigest: string
  capabilityCatalogDigest: string
}

export type TreeV2AdmissionReceipt = ReceiptBase<'admission-receipt'> & {
  candidateDigest: string
  buildDigest: string
  materializationDigest: string
  capabilityCatalogDigest: string
  modeFingerprints: TreeV2ModeFingerprints
  admitted: true
}

export interface TreeV2ReceiptChain {
  analysis: TreeV2AnalysisReceipt
  proposal: TreeV2ProposalReceipt
  candidateIntent: TreeV2CandidateIntent
  mechanismOutcome: TreeV2MechanismOutcomeReceipt
  capabilityCatalog: TreeV2CapabilityCatalogReceipt
  materialization: TreeV2MaterializationReceipt
  admission: TreeV2AdmissionReceipt
}

export const TREE_V2_MEDIA_TYPES: Record<TreeV2ReceiptKind, string> = {
  proposal: 'application/vnd.dsh-evolve-le.tree-v2.proposal+json',
  analysis: 'application/vnd.dsh-evolve-le.tree-v2.analysis+json',
  'candidate-intent': 'application/vnd.dsh-evolve-le.tree-v2.candidate-intent+json',
  'mechanism-outcome': 'application/vnd.dsh-evolve-le.tree-v2.mechanism-outcome+json',
  'capability-catalog': 'application/vnd.dsh-evolve-le.tree-v2.capability-catalog+json',
  'materialization-receipt': 'application/vnd.dsh-evolve-le.tree-v2.materialization-receipt+json',
  'admission-receipt': 'application/vnd.dsh-evolve-le.tree-v2.admission-receipt+json',
  'migration-receipt': 'application/vnd.dsh-evolve-le.tree-v2.migration-receipt+json',
}

function reject(message: string): never {
  throw new Error(`tree-v2 receipt chain rejected: ${message}`)
}

function sameValue(left: unknown, right: unknown): boolean {
  return treeV2Digest(left) === treeV2Digest(right)
}

/** Validate one receipt against both its strict schema and canonical digest. */
export function assertTreeV2ReceiptDocument(
  kind: TreeV2SchemaKind,
  receipt: unknown,
): asserts receipt is TreeV2Receipt {
  const validation = validateTreeV2(kind, receipt)
  if (!validation.ok) reject(`${kind} schema: ${validation.error.errors.join('; ')}`)
  const record = receipt as TreeV2Receipt
  if (record.kind !== kind) reject(`${kind} document declares kind ${record.kind}`)
  verifyTreeV2Receipt(record)
}

/** Validate, canonicalize and publish one receipt through the durable object store. */
export async function persistTreeV2ReceiptDocument(
  store: ObjectStore,
  kind: TreeV2SchemaKind,
  receipt: unknown,
): Promise<ObjectRef> {
  assertTreeV2ReceiptDocument(kind, receipt)
  return store.put(Buffer.from(`${canonicalJson(receipt)}\n`, 'utf8'), {
    mediaType: TREE_V2_MEDIA_TYPES[kind],
    label: 'CONTROLLER_INTERNAL',
  })
}

/**
 * Validate the seven-document proposal-to-admission chain. Migration is a
 * separate chain root because legacy results are explicitly non-inheritable.
 */
export function assertTreeV2ReceiptChain(chain: TreeV2ReceiptChain): void {
  const documents = [
    ['analysis', chain.analysis],
    ['proposal', chain.proposal],
    ['candidate-intent', chain.candidateIntent],
    ['mechanism-outcome', chain.mechanismOutcome],
    ['capability-catalog', chain.capabilityCatalog],
    ['materialization-receipt', chain.materialization],
    ['admission-receipt', chain.admission],
  ] as const
  for (const [kind, receipt] of documents) assertTreeV2ReceiptDocument(kind, receipt)

  const intent = chain.candidateIntent
  if (intent.parent === null || intent.requiredParentEvidence === undefined) {
    reject('a proposal-to-admission chain requires a child intent with named parent evidence')
  }
  if (chain.analysis.parentCandidateDigest !== intent.parent.candidateDigest) {
    reject('analysis parent does not match candidate intent parent')
  }
  if (intent.requiredParentEvidence.analysisDigest !== chain.analysis.receiptDigest) {
    reject('candidate intent does not bind the analysis receipt')
  }
  if (chain.proposal.parentCandidateDigest !== intent.parent.candidateDigest) {
    reject('proposal parent does not match candidate intent parent')
  }
  if (chain.proposal.analysisDigest !== chain.analysis.receiptDigest) {
    reject('proposal does not bind the analysis receipt')
  }
  if (chain.proposal.candidateIntentDigest !== intent.receiptDigest) {
    reject('proposal does not bind the candidate intent receipt')
  }
  if (!sameValue(chain.proposal.modeContract, intent.modeContract)) {
    reject('proposal and candidate intent mode contracts differ')
  }
  if (!sameValue(chain.proposal.requiredParentEvidence, intent.requiredParentEvidence)) {
    reject('proposal and candidate intent parent evidence differ')
  }
  if (chain.mechanismOutcome.candidateIntentDigest !== intent.receiptDigest) {
    reject('mechanism outcome does not bind the candidate intent receipt')
  }
  if (chain.mechanismOutcome.outcome !== 'passed') {
    reject('a failed mechanism outcome cannot enter an admission chain')
  }
  if (!sameValue(chain.capabilityCatalog.capabilities, intent.runtime.capabilities)) {
    reject('capability catalog differs from candidate intent capabilities')
  }
  if (chain.materialization.parentCandidateDigest !== intent.parent.candidateDigest) {
    reject('materialization parent does not match candidate intent parent')
  }
  if (chain.materialization.candidateIntentDigest !== intent.receiptDigest) {
    reject('materialization does not bind the candidate intent receipt')
  }
  if (chain.materialization.candidateDigest !== chain.capabilityCatalog.candidateDigest) {
    reject('materialization and capability catalog candidate digests differ')
  }
  if (chain.materialization.capabilityCatalogDigest !== chain.capabilityCatalog.receiptDigest) {
    reject('materialization does not bind the capability catalog receipt')
  }
  if (chain.admission.candidateDigest !== chain.materialization.candidateDigest) {
    reject('admission and materialization candidate digests differ')
  }
  if (chain.admission.materializationDigest !== chain.materialization.receiptDigest) {
    reject('admission does not bind the materialization receipt')
  }
  if (chain.admission.capabilityCatalogDigest !== chain.capabilityCatalog.receiptDigest) {
    reject('admission does not bind the capability catalog receipt')
  }
}
