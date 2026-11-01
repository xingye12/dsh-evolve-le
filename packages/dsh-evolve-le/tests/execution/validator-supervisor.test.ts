import { it, expect } from 'vitest'
import { validateValidatorSupervisorConfig } from '../../src/execution/validator-supervisor.js'
import { makeSpec, ref } from './fixtures.js'
it('freezes validator supervisor paths, resource pools and snapshot without provider capabilities', () => {
  const spec = makeSpec()
  spec.kind = 'validator'
  delete spec.gateway
  spec.parentExecutionId = 'proposal-parent'
  spec.mounts = spec.mounts.filter((m) => m.target !== '/gateway')
  spec.command = [
    '/input/capsule/runtime/node',
    '/input/capsule/runner/bin/validator-worker.js',
    '/input/config.json',
  ]
  const config = {
    protocol: 'dsh-evolve-le/validator-supervisor/v2',
    spec,
    inputManifest: ref,
    hostRoot: '/executor',
    executionRoot: '/evidence/executions',
    cgroupRoot: '/sys/fs/cgroup/dsh',
    resourceRoot: '/executor-resources',
    storeRoot: '/evidence/objects',
    security: { seccompJson: '{}', apparmorProfile: 'test', cgroupParent: 'dsh' },
    pools: Object.fromEntries(
      ['proposal', 'test', 'validator'].map((k) => [
        k,
        { slots: 1, memoryBytes: 1, cpuMillis: 1, pids: 1, bytes: 1, inodes: 1 },
      ]),
    ),
    validator: {
      sourceSnapshot: ref,
      dependencyClosureSha256: 'a'.repeat(64),
      runnerSourceDir: '/trusted/lib',
    },
  }
  expect(validateValidatorSupervisorConfig(config)).toEqual(config)
  expect(() =>
    validateValidatorSupervisorConfig({
      ...config,
      protocol: 'dsh-evolve-le/validator-supervisor/v1',
    }),
  ).toThrow(/protocol/)
  expect(() => validateValidatorSupervisorConfig({ ...config, apiKey: 'forbidden' })).toThrow()
  expect(() => validateValidatorSupervisorConfig({ ...config, hostRoot: 'relative' })).toThrow()
  expect(() =>
    validateValidatorSupervisorConfig({ ...config, spec: { ...spec, kind: 'proposal' } }),
  ).toThrow()
  expect(() =>
    validateValidatorSupervisorConfig({ ...config, spec: { ...spec, inputs: [] } }),
  ).toThrow()
})
