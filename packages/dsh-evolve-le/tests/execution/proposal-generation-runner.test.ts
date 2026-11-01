/** Composition contract with real broker/RPC/CAS/executor; Engine, host and owner are simulated. */
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it, expect, vi } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { captureSourceSnapshot } from '../../src/execution/snapshot.js'
import { verifySubmission, readSubmission } from '../../src/execution/submission.js'
import { verifyGenerationResult } from '../../src/execution/proposal-generation-result.js'
import { runProposalGeneration } from '../../src/execution/proposal-generation.js'
import { dockerProposalClient } from '../../src/execution/worker-client.js'
import { callActionRpc } from '../../src/execution/rpc.js'
import { sweepFrozenGeneration } from '../../src/execution/proposal-generation-process.js'
import { publishCanonical } from '../../src/execution/evidence.js'
import { executionName } from '../../src/execution/types.js'
import { DockerApiError, type DockerEngine } from '../../src/execution/docker-engine.js'
import { makeProposalConfig } from './fixtures.js'
const state = vi.hoisted(() => ({
  binding: {} as any,
  host: {} as any,
  engine: {} as any,
  owner: { generation: 1 },
}))
vi.mock('../../src/execution/docker-engine.js', async (original) => ({
  ...(await original<typeof import('../../src/execution/docker-engine.js')>()),
  localDockerEngine: () => state.engine,
}))
vi.mock('../../src/execution/proposal-input.js', () => ({
  readProposalInputBinding: async () => state.binding,
}))
vi.mock('../../src/execution/owner.js', () => ({
  claimOwnerGeneration: async () => state.owner,
  assertOwnerGeneration: async () => {},
  reclaimActionEndpoint: async () => {},
}))
vi.mock('../../src/execution/linux-host.js', () => ({
  LinuxExecutionHost: class {
    constructor(options: any) {
      Object.assign(state.host, { actions: options.actions })
      return state.host
    }
  },
}))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(
  mode: 'success' | 'draft' | 'no-finish' | 'preflight' | 'cleanup' | 'pause' = 'success',
) {
  const root = await mkdtemp(join(tmpdir(), 'generation-runner-'))
  roots.push(root)
  const store = await openObjectStore(join(root, 'cas'))
  const base = makeProposalConfig()
  const spec = base.spec
  const facts = await store.put(Buffer.from('{}'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  spec.inputs = [facts]
  spec.reservation = facts
  spec.policy = facts
  spec.gateway = { route: facts, authorization: facts }
  spec.deadlineUtc = new Date(Date.now() + 10000).toISOString()
  const hostRoot = join(root, 'host'),
    attempt = join(hostRoot, executionName(spec))
  for (const mount of spec.mounts)
    mount.source = join(attempt, mount.target === '/gateway' ? 'ipc' : mount.target.slice(1))
  state.binding = {
    config: {
      provider: 'replay',
      model: 'fixed',
      maxTokens: 1024,
      contextWindowTokens: 8192,
      generationOnly: true,
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
    },
    parent: {
      sha256: 'a'.repeat(64),
      files: [{ path: 'index.ts', content: Buffer.from('export {}') }],
    },
    children: ['child-1'],
  }
  if (mode === 'draft')
    state.binding.config.treeV2Parent = {
      candidateDigest: state.binding.config.parentSourceHash,
      mechanismOutcomeDigest: `sha256:${'b'.repeat(64)}`,
    }
  let actual: any = null,
    starts = 0,
    creates = 0,
    removed = false,
    workerError: unknown,
    testsDenied = false
  const log: string[] = []
  const engine: DockerEngine = {
    async json<T = Record<string, unknown>>(
      method: string,
      path: string,
      body?: unknown,
    ): Promise<T> {
      if (path === '/info')
        return {
          OSType: 'linux',
          CgroupVersion: '2',
          MemoryLimit: true,
          SwapLimit: true,
          PidsLimit: true,
          CpuCfsQuota: true,
          SecurityOptions: ['name=seccomp', 'name=apparmor'],
        } as T
      if (path.startsWith('/images/'))
        return { Id: spec.image.id, Os: 'linux', Architecture: 'amd64' } as T
      if (path.startsWith('/containers/create')) {
        creates++
        const config = body as any
        actual = {
          Id: 'container',
          Image: spec.image.id,
          Config: config,
          HostConfig: config.HostConfig,
          Mounts: spec.mounts.map((m) => ({
            Type: 'bind',
            Source: m.source,
            Destination: m.target,
            RW: !m.readOnly,
            Propagation: 'rprivate',
          })),
          State: { Running: false, Paused: false, StartedAt: '0001-01-01T00:00:00Z', ExitCode: 0 },
        }
        return { Id: 'container' } as T
      }
      if (path.endsWith('/json')) {
        if (!actual) throw new DockerApiError(404, method, path, 'missing')
        return structuredClone(actual) as T
      }
      if (path.endsWith('/start')) {
        starts++
        actual.State = { ...actual.State, Running: true, StartedAt: new Date().toISOString() }
        setTimeout(() => {
          void (async () => {
            try {
              if (mode !== 'no-finish') {
                const socketPath = join(attempt, 'ipc/action.sock')
                await expect(
                  callActionRpc({
                    socketPath,
                    executionId: spec.executionId,
                    invocationId: 'deny-test',
                    method: 'test-child',
                    args: { child: 'child-1' },
                  }),
                ).rejects.toThrow(/disables/)
                testsDenied = true
                const client = dockerProposalClient({
                  socketPath,
                  executionId: spec.executionId,
                  timeoutMs: 5000,
                  maxFrameBytes: 1048576,
                  generationOnly: true,
                })
                expect(client.backend.testChild).toBeUndefined()
                await client.backend.writeChildFile(
                  'child-1',
                  'index.ts',
                  'export const improved = true',
                )
                await client.backend.finalizeProposal({
                  schemaVersion: mode === 'draft' ? 2 : 1,
                  protocol:
                    mode === 'draft' ? 'dsh-evolve-le/proposal/v2' : 'dsh-evolve-le/proposal/v1',
                  parentSourceHash: state.binding.config.parentSourceHash,
                  children: [
                    {
                      childName: 'child-1',
                      hypothesis: 'General mechanism.',
                      donorCandidates: [],
                      evidenceRefs: [],
                      targetFailureModes: ['planning'],
                    },
                  ],
                })
              }
            } catch (error) {
              workerError = error
            } finally {
              if (actual)
                actual.State = { ...actual.State, Running: false, ExitCode: workerError ? 1 : 0 }
            }
          })()
        }, 0)
        return {} as T
      }
      if (path.includes('/kill')) {
        log.push('kill')
        actual.State = { ...actual.State, Running: false, ExitCode: 137 }
        return {} as T
      }
      if (path.includes('/wait')) return { StatusCode: 137 } as T
      if (method === 'DELETE') {
        removed = true
        actual = null
        return {} as T
      }
      throw Error(`unexpected engine request: ${method} ${path}`)
    },
    async request(method, path, body) {
      await engine.json(method, path, body)
      return { status: 204, body: Buffer.alloc(0) }
    },
    async stream() {},
  }
  state.engine = engine
  state.host = {
    async preflight() {
      if (mode === 'preflight') throw Error('incompatible platform')
      return facts
    },
    async verifyInputs() {
      return facts
    },
    async prepare() {
      for (const path of ['input', 'workspace', 'work', 'ipc'])
        await mkdir(join(attempt, path), { recursive: true })
      return facts
    },
    async sample() {
      return {
        cpuTimeUs: 1,
        memoryPeakBytes: 1,
        oom: 0,
        oomKill: 0,
        pidsCurrent: actual?.State.Running ? 1 : 0,
        pidsMaxEvents: 0,
        populated: !!actual?.State.Running,
        frozen: false,
        ioStat: '',
      }
    },
    async quiesceSnapshot() {
      if (mode === 'pause') throw Error('pause failed')
      return captureSourceSnapshot({
        root: join(attempt, 'workspace/child-1'),
        spec,
        store,
        child: 'child-1',
      })
    },
    async revoke() {
      await state.host.actions.revoke()
    },
    async cancelChildren() {},
    async closeSockets() {
      await state.host.actions.close()
    },
    async export(_spec: unknown, outcome: string) {
      const submission = await readSubmission({ root: attempt, spec, store, generationOnly: true })
      return {
        outcome: outcome === 'SUCCEEDED' && !submission ? 'INCOMPLETE' : outcome,
        artifacts: [...(await state.host.actions.artifacts()), ...(submission?.artifacts ?? [])],
      }
    },
    async cleanup() {
      if (mode === 'cleanup') throw Error('unmount failed')
      return facts
    },
  }
  const options = {
    ...base,
    spec,
    inputManifest: facts,
    hostRoot,
    executionRoot: join(root, 'executions'),
    resourceRoot: join(root, 'resources'),
    cgroupRoot: '/unused',
    store,
    engine,
    security: {
      seccompJson: canonicalJson({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }),
      apparmorProfile: 'test',
      cgroupParent: '/test',
    },
    model: {
      ...base.model,
      dispatch: vi.fn(async () => {
        throw Error('unexpected model request')
      }),
    },
  }
  const expected = {
    store,
    spec,
    children: ['child-1'],
    parentSourceHash: state.binding.config.parentSourceHash,
  }
  return {
    options,
    expected,
    attempt,
    log,
    get workerError() {
      return workerError
    },
    get starts() {
      return starts
    },
    get creates() {
      return creates
    },
    get removed() {
      return removed
    },
    get testsDenied() {
      return testsDenied
    },
  }
}
it('exports immutable source, denies online tests, proves cleanup and refuses a second worker', async () => {
  const f = await fixture()
  const result = await runProposalGeneration(f.options)
  expect(f.workerError).toBeUndefined()
  expect(result.outcome).toBe('SUCCEEDED')
  expect(result.admission).toBe('NONE')
  expect(f.testsDenied).toBe(true)
  expect(f.starts).toBe(1)
  expect(f.creates).toBe(1)
  expect(f.removed).toBe(true)
  const submission = await verifySubmission({
    ...f.expected,
    ref: result.submission!,
    generationOnly: true,
  })
  expect(submission.sources).toHaveLength(1)
  await expect(runProposalGeneration(f.options)).rejects.toThrow(/already started/)
  expect(f.starts).toBe(1)
  await rm(f.attempt, { recursive: true })
  expect(await verifyGenerationResult(result, f.expected)).toEqual(result)
})
it.each(['preflight', 'no-finish', 'pause', 'cleanup'] as const)(
  'keeps %s failure without successful handoff or retry',
  async (mode) => {
    const f = await fixture(mode)
    const result = await runProposalGeneration(f.options)
    expect(result.outcome).not.toBe('SUCCEEDED')
    expect(result.submission).toBeNull()
    expect(await verifyGenerationResult(result, f.expected)).toEqual(result)
    expect(f.starts).toBe(mode === 'preflight' ? 0 : 1)
    if (mode === 'cleanup') expect(result.completion).toBeNull()
    expect(f.options.model.dispatch).not.toHaveBeenCalled()
  },
)

it('sweep releases a failed cleanup reservation without worker/model restart or result rewrite', async () => {
  const f = await fixture('cleanup')
  const result = await runProposalGeneration(f.options)
  const {
    store,
    engine: _engine,
    tests: _tests,
    model,
    protocol: _protocol,
    ...options
  } = f.options
  const config = {
    ...options,
    protocol: 'dsh-evolve-le/proposal-generation/v1',
    storeRoot: store.root,
    model: {
      provider: model.provider,
      model: model.model,
      limits: model.limits,
      route: options.spec.gateway!.route,
      mode: 'replay',
    },
  }
  await publishCanonical(join(f.attempt, 'generation-config.json'), config)
  state.host.cleanup = async () => options.spec.policy
  const receipt = await sweepFrozenGeneration(config)
  expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(f.starts).toBe(1)
  expect(f.creates).toBe(1)
  expect(f.options.model.dispatch).not.toHaveBeenCalled()
  expect(result.outcome).toBe('INCOMPLETE')
  expect(await verifyGenerationResult(result, f.expected)).toEqual(result)
})

it('captures tree-v2 drafts without fabricated receipt digests and legacy submission consumers refuse them', async () => {
  const f = await fixture('draft')
  const result = await runProposalGeneration(f.options)
  expect(f.workerError).toBeUndefined()
  expect(result.outcome).toBe('SUCCEEDED')
  const submission = await verifySubmission({
    ...f.expected,
    ref: result.submission!,
    generationOnly: true,
  })
  expect(submission.proposal.schemaVersion).toBe(2)
  expect(submission.proposal.children[0]?.analysisReceipt).toBeUndefined()
  await expect(verifySubmission({ ...f.expected, ref: result.submission! })).rejects.toThrow(
    /binding/,
  )
})
