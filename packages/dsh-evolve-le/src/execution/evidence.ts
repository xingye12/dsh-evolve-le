/** Manifest-last execution evidence; immutable CAS plus no-clobber receipt slots. */
import { constants } from 'node:fs'
import { open, mkdir, link, unlink, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  canonicalHash,
  canonicalJson,
  parseCanonicalJson,
  isValidCanonicalTimestamp,
} from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import {
  BUNDLE_PROTOCOL,
  RECEIPT_PROTOCOL,
  ExecutionError,
  assertExact,
  validateExecutionSpec,
  type ExecutionSpec,
  type ExecutionReceipt,
  type ExecutionPhase,
  type ExecutionOutcome,
  type ExecutionBundle,
} from './types.js'
const NEXT: Record<ExecutionPhase, ExecutionPhase[]> = {
  RESERVED: ['PREPARED', 'STOPPED'],
  PREPARED: ['CREATED', 'STOPPED'],
  CREATED: ['RUNNING', 'STOPPED'],
  RUNNING: ['STOPPED'],
  STOPPED: ['EXPORTED'],
  EXPORTED: ['COMMITTED'],
  COMMITTED: ['CLEANED'],
  CLEANED: [],
}
export async function readCanonicalFile(path: string): Promise<unknown> {
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await h.stat()
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new ExecutionError('invalid evidence file')
    return parseCanonicalJson(await h.readFile('utf8'))
  } finally {
    await h.close()
  }
}
export async function publishCanonical(path: string, value: unknown): Promise<void> {
  const bytes = canonicalJson(value)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staging = join(dirname(path), `.staging-${randomUUID()}`)
  const h = await open(staging, 'wx', 0o600)
  try {
    await h.writeFile(bytes)
    await h.sync()
  } finally {
    await h.close()
  }
  try {
    try {
      await link(staging, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (canonicalJson(await readCanonicalFile(path)) !== bytes)
        throw new ExecutionError('no-clobber evidence conflict')
    }
    const dir = await open(dirname(path), 'r')
    try {
      await dir.sync()
    } finally {
      await dir.close()
    }
  } finally {
    await unlink(staging)
  }
}
export interface ExecutionEvidence {
  readonly ran: boolean
  readonly phase: ExecutionPhase | null
  readonly receipts: readonly ObjectRef[]
  readonly specRef: ObjectRef
  record(
    phase: ExecutionPhase,
    event: string,
    facts: ObjectRef,
    source?: ExecutionReceipt['source'],
  ): Promise<ObjectRef>
  committed(): Promise<ObjectRef | null>
  commit(
    outcome: ExecutionOutcome,
    artifacts: ObjectRef[],
    failureReason?: string,
  ): Promise<ObjectRef>
}
export function validateExecutionReceipt(value: unknown): asserts value is ExecutionReceipt {
  assertExact(value, [
    'protocol',
    'executionId',
    'specDigest',
    'sequence',
    'previousDigest',
    'phase',
    'event',
    'observedAt',
    'source',
    'facts',
  ])
  if (
    value.protocol !== RECEIPT_PROTOCOL ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.event !== 'string' ||
    !value.event ||
    value.event.length > 128 ||
    typeof value.observedAt !== 'string' ||
    !isValidCanonicalTimestamp(value.observedAt) ||
    !['executor-observed', 'gateway-observed', 'worker-reported'].includes(String(value.source))
  )
    throw new ExecutionError('invalid receipt envelope')
  if (!Object.hasOwn(NEXT, String(value.phase))) throw new ExecutionError('unknown receipt phase')
  validateRef(value.facts)
}
export async function verifyExecutionBundle(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<ExecutionBundle> {
  const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
  assertExact(value, ['protocol', 'spec', 'receipts', 'artifacts', 'outcome'], ['failureReason'])
  if (
    value.protocol !== BUNDLE_PROTOCOL ||
    !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INCOMPLETE'].includes(String(value.outcome)) ||
    !Array.isArray(value.receipts) ||
    !value.receipts.length ||
    value.receipts.length > 65536 ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length > 65536
  )
    throw new ExecutionError('invalid execution bundle')
  if (
    value.outcome === 'SUCCEEDED'
      ? value.failureReason !== undefined
      : typeof value.failureReason !== 'string' ||
        !value.failureReason ||
        value.failureReason.length > 4096
  )
    throw new ExecutionError('invalid execution outcome/reason')
  validateRef(value.spec)
  const spec = validateExecutionSpec(
    parseCanonicalJson((await store.read(value.spec)).toString('utf8')),
  )
  await store.scrub([
    ...spec.inputs,
    spec.policy,
    spec.reservation,
    ...(spec.gateway ? [spec.gateway.route, spec.gateway.authorization] : []),
  ])
  let previous: string | null = null
  let phase: ExecutionPhase | null = null
  let ran = false
  for (let i = 0; i < value.receipts.length; i++) {
    const r = value.receipts[i]
    validateRef(r)
    const receipt = parseCanonicalJson((await store.read(r)).toString('utf8'))
    validateExecutionReceipt(receipt)
    if (
      receipt.executionId !== spec.executionId ||
      receipt.specDigest !== canonicalHash(spec) ||
      receipt.sequence !== i + 1 ||
      receipt.previousDigest !== previous ||
      (phase === null
        ? receipt.phase !== 'RESERVED'
        : receipt.phase !== phase && !NEXT[phase].includes(receipt.phase))
    )
      throw new ExecutionError('receipt chain/transition mismatch')
    // Worker events cannot transition the trusted lifecycle.
    if (receipt.source !== 'executor-observed' && receipt.phase !== phase)
      throw new ExecutionError('untrusted phase transition')
    await store.verify(receipt.facts)
    phase = receipt.phase
    previous = r.digest
    ran ||= phase === 'RUNNING'
  }
  if (phase !== 'EXPORTED' || (value.outcome === 'SUCCEEDED' && !ran))
    throw new ExecutionError('bundle missing EXPORTED/RUNNING evidence')
  for (const artifact of value.artifacts) {
    validateRef(artifact)
    await store.verify(artifact)
  }
  return value as unknown as ExecutionBundle
}
export async function openExecutionEvidence(
  root: string,
  store: ObjectStore,
  spec: ExecutionSpec,
): Promise<ExecutionEvidence> {
  validateExecutionSpec(spec)
  const specRef = await store.put(Buffer.from(canonicalJson(spec)), {
    mediaType: 'application/vnd.dsh-evolve-le.execution-spec+json',
    label: 'CONTROLLER_INTERNAL',
  })
  await publishCanonical(join(root, 'spec.json'), specRef)
  const receiptDir = join(root, 'receipts')
  await mkdir(receiptDir, { recursive: true, mode: 0o700 })
  let phase: ExecutionPhase | null = null
  const refs: ObjectRef[] = []
  let ran = false
  for (const name of (await readdir(receiptDir)).filter((n) => !n.startsWith('.staging-')).sort()) {
    if (name !== `${String(refs.length + 1).padStart(8, '0')}.json`)
      throw new ExecutionError('receipt sequence gap/unknown entry')
    const ref = await readCanonicalFile(join(receiptDir, name))
    validateRef(ref)
    const receipt = parseCanonicalJson((await store.read(ref)).toString('utf8'))
    validateExecutionReceipt(receipt)
    if (
      receipt.specDigest !== canonicalHash(spec) ||
      receipt.executionId !== spec.executionId ||
      receipt.sequence !== refs.length + 1 ||
      receipt.previousDigest !== (refs.at(-1)?.digest ?? null) ||
      (phase === null
        ? receipt.phase !== 'RESERVED'
        : receipt.phase !== phase && !NEXT[phase].includes(receipt.phase))
    )
      throw new ExecutionError('receipt chain/transition mismatch')
    if (receipt.source !== 'executor-observed' && receipt.phase !== phase)
      throw new ExecutionError('untrusted phase transition')
    await store.verify(receipt.facts)
    phase = receipt.phase
    ran ||= phase === 'RUNNING'
    refs.push(ref)
  }
  const committed = async (): Promise<ObjectRef | null> => {
    let value: unknown
    try {
      value = await readCanonicalFile(join(root, 'manifest.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    validateRef(value)
    const bundle = await verifyExecutionBundle(store, value)
    if (
      bundle.spec.digest !== specRef.digest ||
      bundle.receipts.some((r, i) => refs[i]?.digest !== r.digest)
    )
      throw new ExecutionError('bundle/spec/receipt mismatch')
    return value
  }
  await committed()
  return {
    get ran() {
      return ran
    },
    get phase() {
      return phase
    },
    get receipts() {
      return [...refs]
    },
    specRef,
    async record(next, event, facts, source = 'executor-observed') {
      if (!event || event.length > 128) throw new ExecutionError('invalid receipt event')
      if (phase === null ? next !== 'RESERVED' : next !== phase && !NEXT[phase].includes(next))
        throw new ExecutionError('invalid lifecycle transition')
      if (source !== 'executor-observed' && next !== phase)
        throw new ExecutionError('untrusted phase transition')
      await store.verify(facts)
      const receipt: ExecutionReceipt = {
        protocol: RECEIPT_PROTOCOL,
        executionId: spec.executionId,
        specDigest: canonicalHash(spec),
        sequence: refs.length + 1,
        previousDigest: refs.at(-1)?.digest ?? null,
        phase: next,
        event,
        observedAt: new Date().toISOString(),
        source,
        facts,
      }
      const ref = await store.put(Buffer.from(canonicalJson(receipt)), {
        mediaType: 'application/vnd.dsh-evolve-le.execution-receipt+json',
        label: 'CONTROLLER_INTERNAL',
      })
      await publishCanonical(
        join(receiptDir, `${String(receipt.sequence).padStart(8, '0')}.json`),
        ref,
      )
      refs.push(ref)
      phase = next
      ran ||= phase === 'RUNNING'
      return ref
    },
    committed,
    async commit(outcome, artifacts, failureReason) {
      const existing = await committed()
      if (existing !== null) return existing
      if (phase !== 'EXPORTED') throw new ExecutionError('commit requires EXPORTED')
      if (outcome === 'SUCCEEDED' && !ran) throw new ExecutionError('success requires RUNNING')
      const bundle: ExecutionBundle = {
        protocol: BUNDLE_PROTOCOL,
        spec: specRef,
        receipts: [...refs],
        artifacts,
        outcome,
        ...(failureReason === undefined ? {} : { failureReason }),
      }
      const ref = await store.put(Buffer.from(canonicalJson(bundle)), {
        mediaType: 'application/vnd.dsh-evolve-le.execution-bundle+json',
        label: 'CONTROLLER_INTERNAL',
      })
      await verifyExecutionBundle(store, ref)
      await publishCanonical(join(root, 'manifest.json'), ref)
      return (await committed())!
    },
  }
}
