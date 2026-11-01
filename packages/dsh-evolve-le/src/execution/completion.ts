/** Separate append-only proof of cleanup; never rewrites the original execution bundle. */
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { verifyExecutionBundle, validateExecutionReceipt } from './evidence.js'
import { assertExact, ExecutionError, type ExecutionSpec } from './types.js'
export const COMPLETION_PROTOCOL = 'dsh-evolve-le/execution-completion/v1' as const
export interface ExecutionCompletion {
  protocol: typeof COMPLETION_PROTOCOL
  execution: ObjectRef
  receipts: ObjectRef[]
}
export async function verifyExecutionCompletion(
  store: ObjectStore,
  ref: ObjectRef,
  expected?: ExecutionSpec,
): Promise<ExecutionCompletion> {
  ref = structuredClone(ref)
  if (expected) expected = structuredClone(expected)
  validateRef(ref)
  if (ref.size > 16 * 1024 * 1024) throw new ExecutionError('completion envelope size limit')
  const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
  assertExact(value, ['protocol', 'execution', 'receipts'])
  if (
    value.protocol !== COMPLETION_PROTOCOL ||
    !Array.isArray(value.receipts) ||
    value.receipts.length > 65536
  )
    throw new ExecutionError('invalid execution completion envelope')
  validateRef(value.execution)
  const bundle = await verifyExecutionBundle(store, value.execution)
  const spec = parseCanonicalJson(
    (await store.read(bundle.spec)).toString('utf8'),
  ) as unknown as ExecutionSpec
  if (expected && canonicalJson(spec) !== canonicalJson(expected))
    throw new ExecutionError('completion execution spec mismatch')
  if (
    value.receipts.length < bundle.receipts.length + 2 ||
    canonicalJson(value.receipts.slice(0, bundle.receipts.length)) !==
      canonicalJson(bundle.receipts)
  )
    throw new ExecutionError('completion bundle prefix mismatch')
  let previous = bundle.receipts.at(-1)!.digest,
    cleaned = false
  for (let index = bundle.receipts.length; index < value.receipts.length; index++) {
    const receiptRef = value.receipts[index]
    validateRef(receiptRef)
    const receipt = parseCanonicalJson((await store.read(receiptRef)).toString('utf8'))
    validateExecutionReceipt(receipt)
    if (
      cleaned ||
      receipt.executionId !== spec.executionId ||
      receipt.specDigest !== canonicalHash(spec) ||
      receipt.sequence !== index + 1 ||
      receipt.previousDigest !== previous ||
      receipt.source !== 'executor-observed' ||
      !['COMMITTED', 'CLEANED'].includes(receipt.phase)
    )
      throw new ExecutionError('completion receipt chain mismatch')
    if (
      index === bundle.receipts.length &&
      (receipt.phase !== 'COMMITTED' ||
        !['manifest-published', 'adopt-manifest'].includes(receipt.event) ||
        canonicalJson(receipt.facts) !== canonicalJson(value.execution))
    )
      throw new ExecutionError('completion lacks original commit binding')
    await store.verify(receipt.facts)
    if (receipt.phase === 'CLEANED') {
      if (receipt.event !== 'owned-resources-and-reservation-released')
        throw new ExecutionError('completion cleanup fact missing')
      cleaned = true
    }
    previous = receiptRef.digest
  }
  if (!cleaned) throw new ExecutionError('completion requires CLEANED proof')
  return value as unknown as ExecutionCompletion
}
