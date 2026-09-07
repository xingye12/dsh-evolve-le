/** Explicit legacy-v1 -> tree-v2 migration boundary. Historical results are
 * audit evidence only: a tree-v2 identity always gets a fresh build, archive
 * admission and evaluation. */

import { validateTreeV2 } from '../schema.js'
import {
  finalizeTreeV2Receipt,
  verifyTreeV2Receipt,
  TREE_V2_PROTOCOL,
  type TreeV2Receipt,
} from './contract.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { persistTreeV2ReceiptDocument } from './receipts.js'

export interface TreeV2MigrationInput {
  legacyCandidateDigest: string
  treeV2CandidateDigest: string
  sourceDigest: string
}

export function createTreeV2MigrationReceipt(input: TreeV2MigrationInput): TreeV2Receipt {
  return finalizeTreeV2Receipt({
    schemaVersion: 2,
    protocol: TREE_V2_PROTOCOL,
    kind: 'migration-receipt',
    legacyCandidateDigest: input.legacyCandidateDigest,
    treeV2CandidateDigest: input.treeV2CandidateDigest,
    sourceDigest: input.sourceDigest,
    resultsInherited: false,
    requiredActions: ['rebuild', 'readmit', 'reevaluate'],
  })
}

export function assertTreeV2MigrationReceipt(receipt: TreeV2Receipt): void {
  const result = validateTreeV2('migration-receipt', receipt)
  if (!result.ok)
    throw new Error(`invalid tree-v2 migration receipt: ${result.error.errors.join('; ')}`)
  verifyTreeV2Receipt(receipt)
  if (receipt.resultsInherited !== false) {
    throw new Error('tree-v2 migration cannot inherit historical evaluation results')
  }
  const actions = receipt.requiredActions
  if (
    !Array.isArray(actions) ||
    actions.length !== 3 ||
    !['rebuild', 'readmit', 'reevaluate'].every((action) => actions.includes(action))
  ) {
    throw new Error('tree-v2 migration requires exactly rebuild, readmit, and reevaluate')
  }
}

/** Publish the migration root as immutable evidence before any fresh evaluation. */
export async function persistTreeV2MigrationReceipt(
  store: ObjectStore,
  input: TreeV2MigrationInput,
): Promise<{ receipt: TreeV2Receipt; ref: ObjectRef }> {
  const receipt = createTreeV2MigrationReceipt(input)
  assertTreeV2MigrationReceipt(receipt)
  const ref = await persistTreeV2ReceiptDocument(store, 'migration-receipt', receipt)
  return { receipt, ref }
}
