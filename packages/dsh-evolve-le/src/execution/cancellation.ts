/** Durable trusted cancellation intent; completion still requires execution receipts. */
import { join } from 'node:path'
import { canonicalHash } from '../state/canonical.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { assertExact, ExecutionError, validateExecutionSpec, type ExecutionSpec } from './types.js'
const protocol = 'dsh-evolve-le/execution-cancel/v1'
export async function requestExecutionCancellation(
  root: string,
  spec: ExecutionSpec,
  reason: string,
): Promise<void> {
  validateExecutionSpec(spec)
  if (typeof reason !== 'string' || reason.length === 0 || Buffer.byteLength(reason) > 2048)
    throw new ExecutionError('invalid cancellation reason')
  await prepareSupervisorDirectory(root)
  await publishCanonical(join(root, 'cancel-request.json'), {
    protocol,
    specDigest: canonicalHash(spec),
    reason,
  })
}
export async function readExecutionCancellation(
  root: string,
  spec: ExecutionSpec,
): Promise<string | null> {
  let raw: unknown
  try {
    raw = await readCanonicalFile(join(root, 'cancel-request.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ExecutionError('invalid cancellation request')
  const request = raw as Record<string, unknown>
  assertExact(request, ['protocol', 'specDigest', 'reason'])
  if (
    request.protocol !== protocol ||
    request.specDigest !== canonicalHash(spec) ||
    typeof request.reason !== 'string' ||
    request.reason.length === 0 ||
    Buffer.byteLength(request.reason) > 2048
  )
    throw new ExecutionError('invalid cancellation request binding')
  return request.reason
}
