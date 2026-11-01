import { it, expect } from 'vitest'
import {
  validateProposalWorkerConfig,
  type ProposalWorkerConfig,
} from '../../src/execution/proposal-worker-config.js'
import {
  DOCKER_SANDBOX_PROTOCOL,
  DOCKER_NATIVE_PROTOCOL,
  DOCKER_CAPABILITIES_PROTOCOL,
  DOCKER_TOOLS_PROTOCOL,
} from '../../src/execution/types.js'
export function workerConfig(): ProposalWorkerConfig {
  return {
    protocol: DOCKER_SANDBOX_PROTOCOL,
    nativeProtocol: DOCKER_NATIVE_PROTOCOL,
    capabilityProtocol: DOCKER_CAPABILITIES_PROTOCOL,
    toolsProtocol: DOCKER_TOOLS_PROTOCOL,
    executionId: 'proposal-input-test',
    candidatePackage: '@dsh-evolve-le/candidate-baseline',
    candidateId: 'c_test',
    parentSourceHash: `sha256:${'a'.repeat(64)}`,
    width: 1,
    provider: 'replay',
    model: 'fixed',
    maxTokens: 1024,
    contextWindowTokens: 8192,
    maxTurns: 8,
    shellTimeoutMs: 1000,
    outputBytes: 1048576,
    clientTimeoutMs: 10000,
  }
}
it('rejects legacy protocols, unsafe identifiers, malformed parent facts and protocol width overflow', () => {
  const config = workerConfig()
  expect(validateProposalWorkerConfig(config)).toEqual(config)
  for (const changed of [
    { protocol: 'legacy' },
    { width: 4 },
    { executionId: '../escape' },
    { candidatePackage: "@bad/name'\n" },
    { maxTokens: 9000 },
    { treeV2Parent: { candidateDigest: 'bad', mechanismOutcomeDigest: 'bad' } },
    { token: 'secret' },
  ])
    expect(() => validateProposalWorkerConfig({ ...config, ...changed })).toThrow()
})

it('freezes trusted authoring objectives only for the generation profile', () => {
  const base = workerConfig()
  expect(
    validateProposalWorkerConfig({
      ...base,
      generationOnly: true,
      authoringInstruction: 'make the bounded source edit',
    }).authoringInstruction,
  ).toBe('make the bounded source edit')
  for (const raw of [
    { ...base, authoringInstruction: 'unfrozen' },
    { ...base, generationOnly: true, authoringInstruction: 42 },
    { ...base, generationOnly: true, authoringInstruction: 'x'.repeat(8193) },
  ])
    expect(() => validateProposalWorkerConfig(raw)).toThrow()
})
