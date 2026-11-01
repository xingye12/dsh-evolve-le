/** Serializable, closed proposal owner configuration; credentials are never configuration. */
import { canonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef } from '../state/object-store.js'
import type { ProposalSupervisorOptions } from './supervisor.js'
import { validateSupervisorHostConfig } from './supervisor-host-config.js'
import { validateValidatorProfile } from './validator-pair.js'
import { assertExact, validateExecutionSpec, ExecutionError } from './types.js'
export interface ProposalSupervisorConfig extends Omit<
  ProposalSupervisorOptions,
  'store' | 'engine' | 'signal' | 'model'
> {
  protocol: 'dsh-evolve-le/proposal-supervisor/v1'
  storeRoot: string
  model: Omit<ProposalSupervisorOptions['model'], 'dispatch'> & { route: ObjectRef }
}
export function validateProposalSupervisorConfig(raw: unknown): ProposalSupervisorConfig {
  assertExact(raw, [
    'protocol',
    'spec',
    'inputManifest',
    'hostRoot',
    'executionRoot',
    'cgroupRoot',
    'resourceRoot',
    'storeRoot',
    'pools',
    'security',
    'model',
    'tests',
  ])
  if (raw.protocol !== 'dsh-evolve-le/proposal-supervisor/v1')
    throw new ExecutionError('invalid proposal supervisor protocol')
  const spec = validateExecutionSpec(raw.spec)
  if (
    spec.kind !== 'proposal' ||
    spec.parentExecutionId ||
    !spec.gateway ||
    canonicalJson(spec.command) !==
      canonicalJson([
        '/input/capsule/runtime/node',
        '/input/capsule/runner/bin/docker-proposer-worker.js',
        '/input/config.json',
      ])
  )
    throw new ExecutionError('proposal owner requires fixed native worker and gateway')
  validateRef(raw.inputManifest)
  if (!spec.inputs.some((ref) => canonicalJson(ref) === canonicalJson(raw.inputManifest)))
    throw new ExecutionError('proposal input manifest missing from spec')
  validateSupervisorHostConfig(raw)
  if ((raw.security as Record<string, unknown>).profile !== undefined)
    throw new ExecutionError('legacy supervisor requires strict platform profile')
  assertExact(raw.model, ['provider', 'model', 'limits', 'route'])
  for (const value of [raw.model.provider, raw.model.model])
    if (typeof value !== 'string' || !value || value.length > 256)
      throw new ExecutionError('invalid frozen model route')
  validateRef(raw.model.route)
  if (canonicalJson(spec.gateway.route) !== canonicalJson(raw.model.route))
    throw new ExecutionError('model route differs from spec')
  assertExact(raw.model.limits, [
    'maxRequests',
    'maxInputTokens',
    'maxOutputTokens',
    'maxTotalTokens',
    'maxCostUsdMicros',
    'maxRequestBytes',
    'inputUsdMicrosPerMillion',
    'outputUsdMicrosPerMillion',
  ])
  for (const [key, value] of Object.entries(raw.model.limits))
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      (!key.endsWith('PerMillion') && value === 0)
    )
      throw new ExecutionError('invalid frozen model limits')
  assertExact(
    raw.tests,
    [
      'parentSnapshot',
      'parentCapsuleInventory',
      'workerInventory',
      'dependencyClosureSha256',
      'profile',
    ],
    ['treeV2ParentEvidence'],
  )
  for (const key of ['parentSnapshot', 'parentCapsuleInventory', 'workerInventory']) {
    const runtimeRef = raw.tests[key]
    validateRef(runtimeRef)
    if (!spec.inputs.some((ref) => canonicalJson(ref) === canonicalJson(runtimeRef)))
      throw new ExecutionError('test runtime missing from spec')
  }
  if (
    typeof raw.tests.dependencyClosureSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.tests.dependencyClosureSha256)
  )
    throw new ExecutionError('invalid frozen dependency digest')
  validateValidatorProfile(raw.tests.profile)
  const profile = raw.tests.profile
  validateSupervisorHostConfig(profile as unknown as Record<string, unknown>)
  if (
    profile.kind !== 'test' ||
    profile.storeRoot !== raw.storeRoot ||
    profile.resourceRoot !== raw.resourceRoot ||
    canonicalJson(profile.pools) !== canonicalJson(raw.pools)
  )
    throw new ExecutionError('test profile must share store/resource ledger and select test pool')
  // Validate the actual profile image/limits using the execution contract, without allocating anything.
  const template = {
    ...spec,
    kind: 'test',
    parentExecutionId: spec.executionId,
    image: profile.image,
    policy: profile.policy,
    limits: profile.limits,
    maxElapsedMs: profile.maxElapsedMs,
    mounts: spec.mounts.filter((mount) => mount.target !== '/gateway'),
  }
  delete template.gateway
  validateExecutionSpec(template)
  return structuredClone(raw) as unknown as ProposalSupervisorConfig
}
