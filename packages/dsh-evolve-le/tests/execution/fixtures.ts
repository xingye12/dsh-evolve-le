import { EXECUTION_PROTOCOL, type ExecutionSpec } from '../../src/execution/types.js'
import type { ObjectRef } from '../../src/state/object-store.js'
export const ref: ObjectRef = {
  algorithm: 'sha256',
  digest: 'a'.repeat(64),
  size: 1,
  mediaType: 'application/json',
  label: 'CONTROLLER_INTERNAL',
}
export function makeSpec(): ExecutionSpec {
  return {
    protocol: EXECUTION_PROTOCOL,
    runId: 'run',
    actionId: 'expand-1',
    attemptId: '1',
    executionId: 'proposal-1',
    kind: 'proposal',
    image: {
      reference: `example.test/dsh/proposal@sha256:${'a'.repeat(64)}`,
      id: `sha256:${'b'.repeat(64)}`,
      platform: 'linux/amd64',
    },
    policy: ref,
    inputs: [ref],
    reservation: ref,
    command: ['/input/capsule/runtime/node', '/input/capsule/runner/bin/proposer-worker.js', '/'],
    mounts: [
      { source: '/executor/run/input', target: '/input', readOnly: true },
      { source: '/executor/run/workspace', target: '/workspace', readOnly: false },
      { source: '/executor/run/work', target: '/work', readOnly: false },
      { source: '/executor/run/ipc', target: '/gateway', readOnly: true },
    ],
    limits: {
      cpuMillis: 1000,
      cpuTimeMs: 30000,
      memoryBytes: 256 * 1024 * 1024,
      pids: 64,
      nofile: 128,
      fileBytes: 1024 * 1024,
      workspace: { bytes: 1024 * 1024, inodes: 128 },
      work: { bytes: 1024 * 1024, inodes: 128 },
      tmp: { bytes: 1024 * 1024, inodes: 128 },
      shm: { bytes: 1024 * 1024, inodes: 128 },
      outputBytes: 1024 * 1024,
      shellTimeoutMs: 30000,
      shellCalls: 64,
    },
    deadlineUtc: '2026-11-01T00:00:00.000Z',
    maxElapsedMs: 30000,
    gateway: { route: ref, authorization: ref },
  }
}

export function makeProposalConfig() {
  const spec = makeSpec()
  spec.command = [
    '/input/capsule/runtime/node',
    '/input/capsule/runner/bin/docker-proposer-worker.js',
    '/input/config.json',
  ]
  const caps = {
    slots: 1,
    memoryBytes: 1e9,
    cpuMillis: 4000,
    pids: 1024,
    bytes: 1e9,
    inodes: 100000,
  }
  const host = {
    hostRoot: '/executor/host',
    executionRoot: '/executor/executions',
    storeRoot: '/executor/cas',
    resourceRoot: '/executor/resources',
    cgroupRoot: '/sys/fs/cgroup/dsh',
    security: { seccompJson: '{}', apparmorProfile: 'test', cgroupParent: 'test' },
    pools: { proposal: caps, test: caps, validator: caps },
  }
  return {
    protocol: 'dsh-evolve-le/proposal-supervisor/v1',
    spec,
    inputManifest: ref,
    ...host,
    model: {
      provider: 'replay',
      model: 'fixed',
      route: ref,
      limits: {
        maxRequests: 8,
        maxInputTokens: 8192,
        maxOutputTokens: 1024,
        maxTotalTokens: 100000,
        maxCostUsdMicros: 1,
        maxRequestBytes: 1048576,
        inputUsdMicrosPerMillion: 0,
        outputUsdMicrosPerMillion: 0,
      },
    },
    tests: {
      parentSnapshot: ref,
      parentCapsuleInventory: ref,
      workerInventory: ref,
      dependencyClosureSha256: 'a'.repeat(64),
      profile: {
        ...host,
        kind: 'test',
        image: spec.image,
        policy: ref,
        limits: spec.limits,
        maxElapsedMs: spec.maxElapsedMs,
      },
    },
  }
}
