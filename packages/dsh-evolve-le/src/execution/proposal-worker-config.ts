/** Frozen proposal worker contract shared by trusted input composition and the target. */
import { PROPOSAL_MAX_WIDTH, type TreeV2ProposalParent } from '../proposer/protocol.js'
import { dockerProposalComposition } from './composition.js'
import {
  assertExact,
  ExecutionError,
  DOCKER_NATIVE_PROTOCOL,
  DOCKER_CAPABILITIES_PROTOCOL,
  DOCKER_SANDBOX_PROTOCOL,
  DOCKER_TOOLS_PROTOCOL,
} from './types.js'
export interface ProposalWorkerConfig {
  protocol: typeof DOCKER_SANDBOX_PROTOCOL
  nativeProtocol: typeof DOCKER_NATIVE_PROTOCOL
  capabilityProtocol: typeof DOCKER_CAPABILITIES_PROTOCOL
  toolsProtocol: typeof DOCKER_TOOLS_PROTOCOL
  executionId: string
  candidatePackage: string
  candidateId: string
  parentSourceHash: string
  width: number
  provider: string
  model: string
  maxTokens: number
  contextWindowTokens: number
  maxTurns: number
  shellTimeoutMs: number
  outputBytes: number
  clientTimeoutMs: number
  /** Source generation only; candidate validation remains external. */
  generationOnly?: true
  authoringInstruction?: string
  treeV2Parent?: TreeV2ProposalParent
}
export function validateProposalWorkerConfig(raw: unknown): ProposalWorkerConfig {
  assertExact(
    raw,
    [
      'protocol',
      'nativeProtocol',
      'capabilityProtocol',
      'toolsProtocol',
      'executionId',
      'candidatePackage',
      'candidateId',
      'parentSourceHash',
      'width',
      'provider',
      'model',
      'maxTokens',
      'contextWindowTokens',
      'maxTurns',
      'shellTimeoutMs',
      'outputBytes',
      'clientTimeoutMs',
    ],
    ['treeV2Parent', 'generationOnly', 'authoringInstruction'],
  )
  if (
    raw.protocol !== DOCKER_SANDBOX_PROTOCOL ||
    raw.nativeProtocol !== DOCKER_NATIVE_PROTOCOL ||
    raw.capabilityProtocol !== DOCKER_CAPABILITIES_PROTOCOL ||
    raw.toolsProtocol !== DOCKER_TOOLS_PROTOCOL
  )
    throw new ExecutionError('Docker worker protocol mismatch; no legacy fallback')
  for (const key of [
    'maxTokens',
    'contextWindowTokens',
    'maxTurns',
    'shellTimeoutMs',
    'outputBytes',
    'clientTimeoutMs',
    'width',
  ])
    if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) <= 0)
      throw new ExecutionError(`invalid frozen worker ${key}`)
  for (const key of [
    'executionId',
    'candidatePackage',
    'candidateId',
    'parentSourceHash',
    'provider',
    'model',
  ])
    if (typeof raw[key] !== 'string' || !raw[key]) throw new ExecutionError(`invalid worker ${key}`)
  if (raw.generationOnly !== undefined && raw.generationOnly !== true)
    throw new ExecutionError('generationOnly must be true when specified')
  if (
    raw.authoringInstruction !== undefined &&
    (raw.generationOnly !== true ||
      typeof raw.authoringInstruction !== 'string' ||
      !raw.authoringInstruction.trim() ||
      raw.authoringInstruction.length > 8192)
  )
    throw new ExecutionError('invalid trusted authoring instruction')
  const config = raw as unknown as ProposalWorkerConfig
  if (!/^sha256:[a-f0-9]{64}$/.test(config.parentSourceHash) || config.width > PROPOSAL_MAX_WIDTH)
    throw new ExecutionError('invalid worker parent/width')
  if (config.maxTokens > config.contextWindowTokens)
    throw new ExecutionError('worker output tokens exceed context window')
  dockerProposalComposition({ ...config, socketPath: '/gateway/action.sock' })
  if (config.treeV2Parent !== undefined) {
    assertExact(config.treeV2Parent, ['candidateDigest', 'mechanismOutcomeDigest'])
    if (config.treeV2Parent.candidateDigest !== config.parentSourceHash)
      throw new ExecutionError('worker tree-v2 parent differs from source identity')
    for (const value of Object.values(config.treeV2Parent))
      if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value))
        throw new ExecutionError('invalid worker tree-v2 parent binding')
  }
  return structuredClone(config)
}
