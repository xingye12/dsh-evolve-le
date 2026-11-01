/** Frozen Docker execution contracts. Never accepts candidate Docker options. */
import { canonicalHash, isValidCanonicalTimestamp } from '../state/canonical.js'
import { validateRef, type ObjectRef } from '../state/object-store.js'

export const EXECUTION_PROTOCOL = 'dsh-evolve-le/execution/v1' as const
export const RECEIPT_PROTOCOL = 'dsh-evolve-le/execution-receipt/v1' as const
export const BUNDLE_PROTOCOL = 'dsh-evolve-le/execution-bundle/v1' as const
export const SNAPSHOT_PROTOCOL = 'dsh-evolve-le/source-snapshot/v1' as const
export const SHELL_PROTOCOL = 'dsh-evolve-le/proposal-shell/v1' as const
export const DOCKER_SANDBOX_PROTOCOL = 'dsh-evolve-le/proposal-sandbox/v2' as const
export const DOCKER_NATIVE_PROTOCOL = 'dsh-evolve-le/native-dsh/v4' as const
export const DOCKER_CAPABILITIES_PROTOCOL = 'dsh-evolve-le/native-capabilities/v3' as const
export const DOCKER_TOOLS_PROTOCOL = 'dsh-evolve-le/proposer-tools/v2' as const

export type ExecutionPhase =
  'RESERVED' | 'PREPARED' | 'CREATED' | 'RUNNING' | 'STOPPED' | 'EXPORTED' | 'COMMITTED' | 'CLEANED'
export type ExecutionOutcome = 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INCOMPLETE'
export type ExecutionKind = 'proposal' | 'test' | 'validator'
export interface WritableLimit {
  bytes: number
  inodes: number
}
export interface ExecutionLimits {
  cpuMillis: number
  cpuTimeMs: number
  memoryBytes: number
  pids: number
  nofile: number
  fileBytes: number
  workspace: WritableLimit
  work: WritableLimit
  tmp: WritableLimit
  shm: WritableLimit
  outputBytes: number
  shellTimeoutMs: number
  shellCalls: number
}
export interface ExecutionMount {
  source: string
  target: '/input' | '/gateway' | '/workspace' | '/work' | '/dependencies' | '/toolchain'
  readOnly: boolean
}
export interface ExecutionSpec {
  protocol: typeof EXECUTION_PROTOCOL
  runId: string
  actionId: string
  attemptId: string
  executionId: string
  kind: ExecutionKind
  parentExecutionId?: string
  image: { reference: string; id: string; platform: 'linux/amd64' | 'linux/arm64' }
  policy: ObjectRef
  inputs: ObjectRef[]
  reservation: ObjectRef
  command: string[]
  mounts: ExecutionMount[]
  limits: ExecutionLimits
  deadlineUtc: string
  maxElapsedMs: number
  gateway?: { route: ObjectRef; authorization: ObjectRef }
}
export interface ExecutionReceipt {
  protocol: typeof RECEIPT_PROTOCOL
  executionId: string
  specDigest: string
  sequence: number
  previousDigest: string | null
  phase: ExecutionPhase
  event: string
  observedAt: string
  source: 'executor-observed' | 'gateway-observed' | 'worker-reported'
  facts: ObjectRef
}
export interface ExecutionBundle {
  protocol: typeof BUNDLE_PROTOCOL
  spec: ObjectRef
  receipts: ObjectRef[]
  artifacts: ObjectRef[]
  outcome: ExecutionOutcome
  failureReason?: string
}
export interface DisposableExecutor {
  prepare(spec: ExecutionSpec): Promise<ObjectRef>
  start(executionId: string): Promise<void>
  reconcile(executionId: string): Promise<ObjectRef>
  cancel(executionId: string, reason: string): Promise<void>
  collect(executionId: string): Promise<ObjectRef>
  cleanup(executionId: string): Promise<void>
  completion(executionId: string): Promise<ObjectRef>
}
export class ExecutionError extends Error {
  constructor(message: string) {
    super(`execution: ${message}`)
    this.name = 'ExecutionError'
  }
}
export function assertExact(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ExecutionError('expected object')
  for (const key of Object.keys(value))
    if (!fields.includes(key) && !optional.includes(key))
      throw new ExecutionError(`unexpected field ${key}`)
  for (const key of fields) if (!(key in value)) throw new ExecutionError(`missing ${key}`)
}
export function positive(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new ExecutionError(`invalid positive integer ${field}`)
}
export function executionName(spec: ExecutionSpec): string {
  return `dsh-${spec.kind}-${canonicalHash([spec.runId, spec.actionId, spec.attemptId, spec.executionId]).slice(0, 32)}`
}
export function validateExecutionSpec(value: unknown): ExecutionSpec {
  assertExact(
    value,
    [
      'protocol',
      'runId',
      'actionId',
      'attemptId',
      'executionId',
      'kind',
      'image',
      'policy',
      'inputs',
      'reservation',
      'command',
      'mounts',
      'limits',
      'deadlineUtc',
      'maxElapsedMs',
    ],
    ['parentExecutionId', 'gateway'],
  )
  if (value.protocol !== EXECUTION_PROTOCOL)
    throw new ExecutionError('unsupported execution protocol')
  for (const key of ['runId', 'actionId', 'attemptId', 'executionId', 'parentExecutionId']) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value[key] as string))
    )
      throw new ExecutionError(`invalid ${key}`)
  }
  if (!['proposal', 'test', 'validator'].includes(String(value.kind)))
    throw new ExecutionError('invalid kind')
  assertExact(value.image, ['reference', 'id', 'platform'])
  if (
    typeof value.image.reference !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value.image.reference)
  )
    throw new ExecutionError('image must be digest-pinned')
  if (typeof value.image.id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.image.id))
    throw new ExecutionError('invalid image ID')
  if (!['linux/amd64', 'linux/arm64'].includes(String(value.image.platform)))
    throw new ExecutionError('invalid platform')
  validateRef(value.policy)
  validateRef(value.reservation)
  if (!Array.isArray(value.inputs) || value.inputs.length === 0 || value.inputs.length > 1024)
    throw new ExecutionError('invalid inputs')
  for (const ref of value.inputs) {
    validateRef(ref)
    if (ref.label === 'DEV_GUARD' || ref.label === 'SEALED')
      throw new ExecutionError('guard/sealed input forbidden in proposal and admission execution')
  }
  if (
    !Array.isArray(value.command) ||
    value.command.length < 2 ||
    value.command.length > 32 ||
    value.command.some((v) => typeof v !== 'string' || v.length > 4096 || v.includes('\0')) ||
    value.command[0] !== '/input/capsule/runtime/node' ||
    !String(value.command[1]).startsWith('/input/capsule/runner/')
  )
    throw new ExecutionError('command must use frozen capsule worker')
  if (typeof value.deadlineUtc !== 'string' || !isValidCanonicalTimestamp(value.deadlineUtc))
    throw new ExecutionError('invalid deadlineUtc')
  positive(value.maxElapsedMs, 'maxElapsedMs')
  assertExact(value.limits, [
    'cpuMillis',
    'cpuTimeMs',
    'memoryBytes',
    'pids',
    'nofile',
    'fileBytes',
    'workspace',
    'work',
    'tmp',
    'shm',
    'outputBytes',
    'shellTimeoutMs',
    'shellCalls',
  ])
  for (const key of [
    'cpuMillis',
    'cpuTimeMs',
    'memoryBytes',
    'pids',
    'nofile',
    'fileBytes',
    'outputBytes',
    'shellTimeoutMs',
    'shellCalls',
  ])
    positive(value.limits[key], key)
  for (const key of ['workspace', 'work', 'tmp', 'shm']) {
    const limit = value.limits[key]
    assertExact(limit, ['bytes', 'inodes'])
    positive(limit.bytes, `${key}.bytes`)
    positive(limit.inodes, `${key}.inodes`)
  }
  if (!Array.isArray(value.mounts) || value.mounts.length > 6)
    throw new ExecutionError('invalid mounts')
  const targets = new Set<string>()
  for (const m of value.mounts) {
    assertExact(m, ['source', 'target', 'readOnly'])
    if (
      typeof m.source !== 'string' ||
      !m.source.startsWith('/') ||
      m.source === '/' ||
      m.source.includes('\0') ||
      m.source.split('/').some((x) => x === '.' || x === '..') ||
      m.source.includes('//') ||
      m.source.endsWith('/')
    )
      throw new ExecutionError('invalid mount source')
    if (
      !['/input', '/gateway', '/workspace', '/work', '/dependencies', '/toolchain'].includes(
        String(m.target),
      ) ||
      targets.has(String(m.target))
    )
      throw new ExecutionError('invalid/duplicate mount target')
    targets.add(String(m.target))
    if (
      typeof m.readOnly !== 'boolean' ||
      m.readOnly !== !['/workspace', '/work'].includes(String(m.target))
    )
      throw new ExecutionError('mount read-only policy mismatch')
  }
  for (const target of ['/input', '/workspace', '/work'])
    if (!targets.has(target)) throw new ExecutionError(`missing mount ${target}`)
  if (value.kind === 'proposal') {
    if (value.gateway === undefined || !targets.has('/gateway'))
      throw new ExecutionError('proposal requires action gateway')
    assertExact(value.gateway, ['route', 'authorization'])
    validateRef(value.gateway.route)
    validateRef(value.gateway.authorization)
  } else if (value.gateway !== undefined || targets.has('/gateway'))
    throw new ExecutionError('validator/test must not mount gateway')
  return value as unknown as ExecutionSpec
}
