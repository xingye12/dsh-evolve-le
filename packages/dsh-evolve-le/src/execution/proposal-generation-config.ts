/** Serializable, closed proposal owner configuration; credentials are never configuration. */
import { canonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef } from '../state/object-store.js'
import type { ProposalGenerationOptions } from './proposal-generation.js'
import { validateSupervisorHostConfig } from './supervisor-host-config.js'
import { assertExact, validateExecutionSpec, ExecutionError } from './types.js'
export interface ProposalGenerationConfig extends Omit<
  ProposalGenerationOptions,
  'store' | 'engine' | 'signal' | 'model'
> {
  protocol: 'dsh-evolve-le/proposal-generation/v1'
  storeRoot: string
  model: Omit<ProposalGenerationOptions['model'], 'dispatch'> & {
    route: ObjectRef
    mode: 'replay' | 'live'
  }
}
export function validateGenerationConfig(raw: unknown): ProposalGenerationConfig {
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
  ])
  if (raw.protocol !== 'dsh-evolve-le/proposal-generation/v1')
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
  if (spec.inputs.some((ref) => ref.label === 'SEALED' || ref.label === 'DEV_GUARD'))
    throw new ExecutionError('guard/sealed generation input forbidden')
  validateSupervisorHostConfig(raw)
  assertExact(raw.model, ['provider', 'model', 'limits', 'route', 'mode'])
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
  if (raw.model.mode !== 'replay' && raw.model.mode !== 'live')
    throw new ExecutionError('generation requires explicit model mode')
  return structuredClone(raw) as unknown as ProposalGenerationConfig
}
