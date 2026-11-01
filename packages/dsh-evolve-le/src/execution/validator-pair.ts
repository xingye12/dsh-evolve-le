import { readExecutionCancellation, requestExecutionCancellation } from './cancellation.js'
/** Two independent validator domains; matching artifacts never constitute Archive admission. */
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson, sha256Hex } from '../state/canonical.js'
import { validateRef, type ObjectStore, type ObjectRef } from '../state/object-store.js'
import { buildCanonicalTar } from '../candidate/canonical.js'
import {
  assertExact,
  validateExecutionSpec,
  executionName,
  EXECUTION_PROTOCOL,
  ExecutionError,
  type ExecutionSpec,
  type ExecutionLimits,
} from './types.js'
import {
  validateValidatorSupervisorConfig,
  type ValidatorSupervisorConfig,
} from './validator-supervisor.js'
import {
  startValidatorSupervisor,
  readValidatorSupervisorResult,
  cancelValidatorSupervisor,
} from './validator-launcher.js'
import { readKernelLockOwner } from './owner.js'
import { readSourceSnapshot } from './snapshot.js'
import { readValidatorExport } from './validator-export.js'
export interface ValidatorExecutionProfile extends Pick<
  ValidatorSupervisorConfig,
  'hostRoot' | 'executionRoot' | 'resourceRoot' | 'cgroupRoot' | 'storeRoot' | 'security' | 'pools'
> {
  /** Omitted profiles retain the historical validator pool. Online tests freeze test explicitly. */
  kind?: 'test' | 'validator'
  image: ExecutionSpec['image']
  policy: ObjectRef
  limits: ExecutionLimits
  maxElapsedMs: number
}
export interface ValidatorPairPlan {
  protocol: 'dsh-evolve-le/validator-pair/v1'
  parent: ObjectRef
  profile: ObjectRef
  child: string
  sourceSnapshot: ObjectRef
  sourceDigest: string
  inputManifest: ObjectRef
  inputs: ObjectRef[]
  dependencyClosureSha256: string
  configs: [ValidatorSupervisorConfig, ValidatorSupervisorConfig]
}
export function validateValidatorProfile(raw: unknown): asserts raw is ValidatorExecutionProfile {
  assertExact(
    raw,
    [
      'hostRoot',
      'executionRoot',
      'resourceRoot',
      'cgroupRoot',
      'storeRoot',
      'security',
      'pools',
      'image',
      'policy',
      'limits',
      'maxElapsedMs',
    ],
    ['kind'],
  )
  if (raw.kind !== undefined && raw.kind !== 'test' && raw.kind !== 'validator')
    throw new ExecutionError('invalid validator resource kind')
}
function allocation(
  parent: ExecutionSpec,
  profile: ObjectRef,
  sourceSnapshot: ObjectRef,
  index: number,
) {
  return {
    protocol: 'dsh-evolve-le/validator-allocation/v1',
    parent: parent.reservation,
    profile,
    sourceSnapshot,
    index,
  }
}
function configFor(
  parent: ExecutionSpec,
  plan: Omit<ValidatorPairPlan, 'configs'>,
  profile: ValidatorExecutionProfile,
  index: number,
  reservation: ObjectRef,
): ValidatorSupervisorConfig {
  const seed = canonicalHash({
      parent: plan.parent,
      profile: plan.profile,
      source: plan.sourceSnapshot,
      child: plan.child,
      input: plan.inputManifest,
    }),
    spec: ExecutionSpec = {
      protocol: EXECUTION_PROTOCOL,
      runId: parent.runId,
      actionId: parent.actionId,
      attemptId: parent.attemptId,
      executionId: `validator-${seed.slice(0, 48)}-${index + 1}`,
      kind: profile.kind ?? 'validator',
      parentExecutionId: parent.executionId,
      image: profile.image,
      policy: profile.policy,
      inputs: [...plan.inputs, plan.profile],
      reservation,
      command: [
        '/input/capsule/runtime/node',
        '/input/capsule/runner/bin/validator-worker.js',
        '/input/config.json',
      ],
      mounts: [],
      limits: profile.limits,
      deadlineUtc: parent.deadlineUtc,
      maxElapsedMs: Math.min(parent.maxElapsedMs, profile.maxElapsedMs),
    }
  const root = join(profile.hostRoot, executionName(spec))
  spec.mounts = [
    { source: join(root, 'input'), target: '/input', readOnly: true },
    { source: join(root, 'workspace'), target: '/workspace', readOnly: false },
    { source: join(root, 'work'), target: '/work', readOnly: false },
  ]
  return validateValidatorSupervisorConfig({
    protocol: 'dsh-evolve-le/validator-supervisor/v2',
    spec,
    inputManifest: plan.inputManifest,
    hostRoot: profile.hostRoot,
    executionRoot: profile.executionRoot,
    resourceRoot: profile.resourceRoot,
    cgroupRoot: profile.cgroupRoot,
    storeRoot: profile.storeRoot,
    security: profile.security,
    pools: profile.pools,
    validator: {
      sourceSnapshot: plan.sourceSnapshot,
      dependencyClosureSha256: plan.dependencyClosureSha256,
      runnerSourceDir: join(root, 'input/capsule/runner'),
    },
  })
}
export async function prepareValidatorPair(options: {
  store: ObjectStore
  parent: ExecutionSpec
  child: string
  sourceSnapshot: ObjectRef
  inputManifest: ObjectRef
  inputs: ObjectRef[]
  dependencyClosureSha256: string
  profile: ValidatorExecutionProfile
}): Promise<ObjectRef> {
  options = {
    ...options,
    parent: structuredClone(options.parent),
    profile: structuredClone(options.profile),
    sourceSnapshot: structuredClone(options.sourceSnapshot),
    inputManifest: structuredClone(options.inputManifest),
    inputs: structuredClone(options.inputs),
  }
  const { store } = options,
    parent = validateExecutionSpec(options.parent)
  validateValidatorProfile(options.profile)
  if (options.profile.storeRoot !== store.root)
    throw new ExecutionError('validator profile must use the parent evidence store')
  if (parent.kind !== 'proposal' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.child))
    throw new ExecutionError('invalid validator pair parent/child')
  const source = await readSourceSnapshot(store, options.sourceSnapshot)
  if (
    source.executionId !== parent.executionId ||
    source.specDigest !== canonicalHash(parent) ||
    source.child !== options.child
  )
    throw new ExecutionError('validator pair source context mismatch')
  if (
    !options.inputs.some((r) => canonicalJson(r) === canonicalJson(options.inputManifest)) ||
    !options.inputs.some((r) => canonicalJson(r) === canonicalJson(options.sourceSnapshot))
  )
    throw new ExecutionError('validator pair missing frozen input binding')
  const files = []
  for (const file of source.files)
    files.push({ path: file.path, mode: file.mode, content: await store.read(file.content) })
  const put = (value: unknown, mediaType: string) =>
    store.put(Buffer.from(canonicalJson(value)), { mediaType, label: 'CONTROLLER_INTERNAL' })
  const parentRef = await put(parent, 'application/vnd.dsh-evolve-le.execution+json')
  configFor(
    parent,
    {
      protocol: 'dsh-evolve-le/validator-pair/v1',
      parent: parentRef,
      profile: parent.policy,
      child: options.child,
      sourceSnapshot: options.sourceSnapshot,
      sourceDigest: `sha256:${sha256Hex(buildCanonicalTar(files))}`,
      inputManifest: options.inputManifest,
      inputs: options.inputs,
      dependencyClosureSha256: options.dependencyClosureSha256,
    },
    options.profile,
    0,
    parent.reservation,
  )
  const profileRef = await put(
    options.profile,
    'application/vnd.dsh-evolve-le.validator-profile+json',
  )
  const plan = {
    protocol: 'dsh-evolve-le/validator-pair/v1' as const,
    parent: parentRef,
    profile: profileRef,
    child: options.child,
    sourceSnapshot: options.sourceSnapshot,
    sourceDigest: `sha256:${sha256Hex(buildCanonicalTar(files))}`,
    inputManifest: options.inputManifest,
    inputs: options.inputs,
    dependencyClosureSha256: options.dependencyClosureSha256,
  }
  const configs: ValidatorSupervisorConfig[] = []
  for (let index = 0; index < 2; index++) {
    const reservation = await put(
      allocation(parent, profileRef, options.sourceSnapshot, index),
      'application/vnd.dsh-evolve-le.validator-allocation+json',
    )
    configs.push(configFor(parent, plan, options.profile, index, reservation))
  }
  const ref = await put({ ...plan, configs }, 'application/vnd.dsh-evolve-le.validator-pair+json')
  await readValidatorPair(store, ref)
  return ref
}
export async function readValidatorPair(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<ValidatorPairPlan> {
  validateRef(ref)
  if (ref.label !== 'CONTROLLER_INTERNAL' || ref.size > 16 * 1024 * 1024)
    throw new ExecutionError('invalid validator pair reference')
  const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
  assertExact(value, [
    'protocol',
    'parent',
    'profile',
    'child',
    'sourceSnapshot',
    'sourceDigest',
    'inputManifest',
    'inputs',
    'dependencyClosureSha256',
    'configs',
  ])
  if (
    value.protocol !== 'dsh-evolve-le/validator-pair/v1' ||
    !Array.isArray(value.configs) ||
    value.configs.length !== 2 ||
    !Array.isArray(value.inputs)
  )
    throw new ExecutionError('invalid validator pair plan')
  for (const key of ['parent', 'profile', 'sourceSnapshot', 'inputManifest']) {
    validateRef(value[key])
    if (value[key].label === 'SEALED' || value[key].label === 'DEV_GUARD')
      throw new ExecutionError('guard/sealed pair reference forbidden')
  }
  validateRef(value.parent)
  validateRef(value.profile)
  validateRef(value.sourceSnapshot)
  validateRef(value.inputManifest)
  if (
    typeof value.child !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.child) ||
    typeof value.dependencyClosureSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.dependencyClosureSha256)
  )
    throw new ExecutionError('invalid validator pair identity')
  if (value.inputs.length > 1024) throw new ExecutionError('validator pair input limit')
  for (const input of value.inputs) validateRef(input)
  const parent = validateExecutionSpec(
      parseCanonicalJson((await store.read(value.parent)).toString('utf8')),
    ),
    profile = parseCanonicalJson((await store.read(value.profile)).toString('utf8'))
  validateValidatorProfile(profile)
  if (parent.kind !== 'proposal' || profile.storeRoot !== store.root)
    throw new ExecutionError('validator pair parent/profile mismatch')
  const source = await readSourceSnapshot(store, value.sourceSnapshot)
  if (
    source.executionId !== parent.executionId ||
    source.specDigest !== canonicalHash(parent) ||
    source.child !== value.child
  )
    throw new ExecutionError('validator pair source context mismatch')
  const files = []
  for (const file of source.files)
    files.push({ path: file.path, mode: file.mode, content: await store.read(file.content) })
  if (value.sourceDigest !== `sha256:${sha256Hex(buildCanonicalTar(files))}`)
    throw new ExecutionError('validator pair source digest mismatch')
  const configs = value.configs.map(validateValidatorSupervisorConfig)
  if (
    configs[0]!.spec.executionId === configs[1]!.spec.executionId ||
    executionName(configs[0]!.spec) === executionName(configs[1]!.spec)
  )
    throw new ExecutionError('validator pair requires independent executions')
  for (let index = 0; index < 2; index++) {
    const actual = configs[index]!,
      reservation = allocation(parent, value.profile, value.sourceSnapshot, index)
    if (
      canonicalJson(
        parseCanonicalJson((await store.read(actual.spec.reservation)).toString('utf8')),
      ) !== canonicalJson(reservation)
    )
      throw new ExecutionError('validator pair reservation mismatch')
    const expected = configFor(
      parent,
      value as unknown as Omit<ValidatorPairPlan, 'configs'>,
      profile,
      index,
      actual.spec.reservation,
    )
    if (canonicalJson(actual) !== canonicalJson(expected))
      throw new ExecutionError('validator pair config mismatch')
  }
  return value as unknown as ValidatorPairPlan
}
function pairCancellationRoot(plan: ValidatorPairPlan): string {
  const first = plan.configs[0]
  return join(first.hostRoot, executionName(first.spec), 'pair-cancellation')
}
/** Durable group intent precedes per-execution requests, so interrupted fanout is recoverable. */
export async function cancelValidatorPair(
  store: ObjectStore,
  ref: ObjectRef,
  reason: string,
): Promise<void> {
  const plan = await readValidatorPair(store, ref)
  await requestExecutionCancellation(pairCancellationRoot(plan), plan.configs[0].spec, reason)
  const requests = await Promise.allSettled(
    plan.configs.map((config) => cancelValidatorSupervisor(config, reason)),
  )
  const failures = requests.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'validator group cancellation fanout incomplete',
    )
}
export async function startNextValidator(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<{ index: number; pid: number | null } | null> {
  const plan = await readValidatorPair(store, ref)
  const groupCancellation = await readExecutionCancellation(
    pairCancellationRoot(plan),
    plan.configs[0].spec,
  )
  if (groupCancellation) await cancelValidatorPair(store, ref, groupCancellation)
  for (let index = 0; index < 2; index++) {
    const config = plan.configs[index]!
    if (await readValidatorSupervisorResult(config)) continue
    const root = join(config.hostRoot, executionName(config.spec)),
      owner = await readKernelLockOwner(root)
    if (owner !== null) return { index, pid: owner }
    const launched = await startValidatorSupervisor(config)
    return { index, pid: launched.pid }
  }
  return null
}
export async function collectValidatorPair(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<ObjectRef | null> {
  const plan = await readValidatorPair(store, ref),
    results = []
  for (const config of plan.configs) {
    const result = await readValidatorSupervisorResult(config)
    if (!result) return null
    results.push(result)
  }
  const resultRefs = []
  for (const result of results)
    resultRefs.push(
      await store.put(Buffer.from(canonicalJson(result)), {
        mediaType: 'application/vnd.dsh-evolve-le.validator-supervisor-result+json',
        label: 'CONTROLLER_INTERNAL',
      }),
    )
  const validations: Awaited<ReturnType<typeof readValidatorExport>>[] = []
  for (let i = 0; i < 2; i++)
    if (results[i]!.outcome === 'SUCCEEDED' && results[i]!.validation)
      validations.push(
        await readValidatorExport(store, results[i]!.validation!, {
          executionId: plan.configs[i]!.spec.executionId,
          sourceDigest: plan.sourceDigest,
        }),
      )
  const matched =
    validations.length === 2 &&
    ['capsuleTar', 'capsuleArchive', 'bundleTar'].every(
      (key) =>
        validations[0]![key as 'capsuleTar'].digest === validations[1]![key as 'capsuleTar'].digest,
    )
  return store.put(
    Buffer.from(
      canonicalJson({
        protocol: 'dsh-evolve-le/validator-pair-result/v1',
        plan: ref,
        sourceDigest: plan.sourceDigest,
        status: matched ? 'ARTIFACTS_MATCHED' : 'FAILED',
        results: resultRefs,
        validations: results.map((r) => r.validation),
      }),
    ),
    {
      mediaType: 'application/vnd.dsh-evolve-le.validator-pair-result+json',
      label: 'CONTROLLER_INTERNAL',
    },
  )
}
