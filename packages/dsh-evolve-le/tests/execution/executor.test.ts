import {
  verifyProposalSupervisorOutcome,
  readProposalSupervisorResult,
} from '../../src/execution/proposal-result.js'
import { captureSourceSnapshot, readSourceSnapshot } from '../../src/execution/snapshot.js'
import { canonicalHash, canonicalJson } from '../../src/state/canonical.js'
import { verifyExecutionCompletion } from '../../src/execution/completion.js'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { verifyExecutionBundle } from '../../src/execution/evidence.js'
import { DockerExecutor, type ExecutionHost } from '../../src/execution/docker-executor.js'
import { DockerApiError, type DockerEngine } from '../../src/execution/docker-engine.js'
import { ResourceAdmission, type CgroupSample } from '../../src/execution/resources.js'
import { makeSpec } from './fixtures.js'
const roots: string[] = []
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'docker-executor-'))
  roots.push(root)
  const store = await openObjectStore(join(root, 'cas'))
  const facts = await store.put(Buffer.from('{}'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  const spec = makeSpec()
  spec.inputs = [facts]
  spec.policy = facts
  spec.reservation = facts
  spec.gateway = { route: facts, authorization: facts }
  spec.deadlineUtc = new Date(Date.now() + 60000).toISOString()
  const log: string[] = []
  let actual: Record<string, unknown> | null = null
  let starts = 0
  let observeKill!: () => void
  const killed = new Promise<void>((resolve) => {
    observeKill = resolve
  })
  const sample: CgroupSample = {
    cpuTimeUs: 1,
    memoryPeakBytes: 1,
    oom: 0,
    oomKill: 0,
    pidsCurrent: 0,
    pidsMaxEvents: 0,
    populated: false,
    frozen: false,
    ioStat: '',
  }
  const host: ExecutionHost = {
    async verifyInputs() {
      log.push('inputs-verified')
      return facts
    },
    async preflight() {
      log.push('preflight')
      return facts
    },
    async prepare() {
      log.push('prepare')
      return facts
    },
    async sample() {
      return { ...sample }
    },
    async revoke() {
      log.push('revoke')
    },
    async cancelChildren() {
      log.push('cancel-tests')
    },
    async export(_s, outcome) {
      log.push('export')
      return { artifacts: [facts], outcome }
    },
    async closeSockets() {
      log.push('close-sockets')
    },
    async cleanup() {
      log.push('unmount')
      return facts
    },
  }
  const json = async <T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    if (path === '/info')
      return {
        OSType: 'linux',
        CgroupVersion: '2',
        MemoryLimit: true,
        SwapLimit: true,
        PidsLimit: true,
        CpuCfsQuota: true,
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=apparmor'],
      } as T
    if (path.startsWith('/images/'))
      return { Id: spec.image.id, Os: 'linux', Architecture: 'amd64' } as T
    if (path.startsWith('/containers/create')) {
      log.push('create')
      const config = body as Record<string, unknown>
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
    if (path.includes('/json')) {
      if (!actual) throw new DockerApiError(404, method, path, 'missing')
      return structuredClone(actual) as T
    }
    if (path.includes('/start')) {
      starts++
      log.push('start')
      actual!.State = {
        Running: true,
        Paused: false,
        StartedAt: new Date().toISOString(),
        ExitCode: 0,
      }
      return {} as T
    }
    if (path.includes('/kill')) {
      log.push('kill')
      observeKill()
      actual!.State = { ...(actual!.State as object), Running: false, ExitCode: 137 }
      return {} as T
    }
    if (path.includes('/wait')) return { StatusCode: 137 } as T
    if (method === 'DELETE') {
      log.push('remove')
      actual = null
      return {} as T
    }
    throw new Error(`${method} ${path}`)
  }
  const engine: DockerEngine = {
    json,
    async request(method, path, body) {
      await json(method, path, body)
      return { status: 204, body: Buffer.alloc(0) }
    },
  }
  const caps = {
    slots: 1,
    memoryBytes: 1e9,
    cpuMillis: 4000,
    pids: 1000,
    bytes: 1e9,
    inodes: 10000,
  }
  const options = {
    root: join(root, 'executions'),
    store,
    engine,
    host,
    admission: new ResourceAdmission({ proposal: caps, test: caps, validator: caps }),
    security: {
      seccompJson: JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }),
      apparmorProfile: 'dsh-proposal-v1',
      cgroupParent: '/dsh-executor',
    },
  }
  return {
    spec,
    log,
    store,
    options,
    sample,
    killed,
    executor: new DockerExecutor(options),
    exitNormally() {
      actual!.State = { ...(actual!.State as object), Running: false, ExitCode: 0 }
    },
    get starts() {
      return starts
    },
  }
}
describe('Docker execution lifecycle and replay', () => {
  it('refuses recovery-only preparation without receipts before allocating or creating', async () => {
    const f = await fixture()
    await expect(f.executor.prepare(f.spec, { existingOnly: true })).rejects.toThrow(
      /recorded execution effects/,
    )
    expect(f.log).toEqual([])
    // A normal fresh prepare remains authorized; recovery mode did not create a target.
    await f.executor.prepare(f.spec)
    await f.executor.cancel(f.spec.executionId, 'test-complete')
    await f.executor.collect(f.spec.executionId)
    await f.executor.cleanup(f.spec.executionId)
  })

  it('recovers an existing created target for cancellation without starting a worker', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    const prepares = f.log.filter((event) => event === 'prepare').length
    const recovered = new DockerExecutor(f.options)
    await recovered.prepare(f.spec, { existingOnly: true })
    await recovered.cancel(f.spec.executionId, 'explicit orphan collection')
    const bundle = await verifyExecutionBundle(f.store, await recovered.collect(f.spec.executionId))
    expect(bundle.outcome).toBe('CANCELLED')
    expect(f.starts).toBe(0)
    expect(f.log.filter((event) => event === 'prepare')).toHaveLength(prepares)
    await recovered.cleanup(f.spec.executionId)
    expect(await recovered.completion(f.spec.executionId)).toBeTruthy()
  })

  it('stops its own process domain when child cancellation fails and fences cleanup across reopen', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.start(f.spec.executionId)
    f.options.host.cancelChildren = async () => {
      throw Error('child daemon unavailable')
    }
    await expect(f.executor.cancel(f.spec.executionId, 'operator-cancel')).rejects.toThrow(
      'child daemon unavailable',
    )
    expect(f.log).toContain('kill')
    const stoppedReplay = new DockerExecutor(f.options)
    await stoppedReplay.prepare(f.spec)
    const ref = await stoppedReplay.collect(f.spec.executionId)
    expect((await verifyExecutionBundle(f.store, ref)).outcome).toBe('INCOMPLETE')
    const replay = new DockerExecutor(f.options)
    await replay.prepare(f.spec)
    await expect(replay.cleanup(f.spec.executionId)).rejects.toThrow('child daemon unavailable')
    expect(f.log).not.toContain('remove')
    expect(f.log).not.toContain('close-sockets')
    f.options.host.cancelChildren = async () => {
      f.log.push('children-stopped')
    }
    await replay.cleanup(f.spec.executionId)
    expect(f.log.indexOf('children-stopped')).toBeLessThan(f.log.indexOf('remove'))
    expect(await replay.collect(f.spec.executionId)).toEqual(ref)
  })

  it('kills the proposal while child cancellation is still pending', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.start(f.spec.executionId)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    f.options.host.cancelChildren = () => pending
    const cancelled = f.executor.cancel(f.spec.executionId, 'cancel-with-pending-child')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        f.killed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('proposal kill not observed')), 3000)
        }),
      ])
      expect(f.log).toContain('kill')
    } finally {
      if (timer) clearTimeout(timer)
      release()
      await cancelled
      await f.executor.collect(f.spec.executionId)
      await f.executor.cleanup(f.spec.executionId)
    }
  })

  it('retries reservation release across reopen before declaring CLEANED', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.cancel(f.spec.executionId, 'test-complete')
    await f.executor.collect(f.spec.executionId)
    const original = f.options.admission.release.bind(f.options.admission)
    let releases = 0
    f.options.admission.release = async (id) => {
      releases++
      if (releases === 1) throw Error('reservation persistence unavailable')
      await original(id)
    }
    await expect(f.executor.cleanup(f.spec.executionId)).rejects.toThrow(/reservation persistence/)
    await expect(f.executor.completion(f.spec.executionId)).rejects.toThrow(/cleanup/)
    const replay = new DockerExecutor(f.options)
    await replay.prepare(f.spec)
    await replay.cleanup(f.spec.executionId)
    expect(releases).toBe(2)
    const completion = await replay.completion(f.spec.executionId)
    const verified = await verifyExecutionCompletion(f.store, completion, f.spec)
    const last = JSON.parse((await f.store.read(verified.receipts.at(-1)!)).toString('utf8'))
    const legacyReceipt = await f.store.put(
      Buffer.from(canonicalJson({ ...last, event: 'owned-resources-released' })),
      { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
    )
    const legacy = await f.store.put(
      Buffer.from(
        canonicalJson({
          ...verified,
          receipts: [...verified.receipts.slice(0, -1), legacyReceipt],
        }),
      ),
      { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
    )
    await expect(verifyExecutionCompletion(f.store, legacy, f.spec)).rejects.toThrow(/cleanup fact/)
    const corrupt = await f.store.put(
      Buffer.from(JSON.stringify({ ...verified, receipts: verified.receipts.slice(0, -1) })),
      { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
    )
    await expect(verifyExecutionCompletion(f.store, corrupt, f.spec)).rejects.toThrow(
      /CLEANED|prefix/,
    )
    await rm(f.options.root, { recursive: true, force: true })
    expect(await verifyExecutionCompletion(f.store, completion, f.spec)).toEqual(verified)
  })

  it('hands off only a verified successful bundle, cleanup chain and bound immutable submission', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    const sourceRoot = join(f.options.root, 'source')
    await mkdir(sourceRoot)
    await writeFile(join(sourceRoot, 'index.ts'), 'export {}')
    const source = await captureSourceSnapshot({
      root: sourceRoot,
      spec: f.spec,
      store: f.store,
      child: 'child-1',
    })
    const snapshot = await readSourceSnapshot(f.store, source)
    const proposal = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/proposal/v1',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      children: [
        {
          childName: 'child-1',
          hypothesis: 'General mechanism.',
          donorCandidates: [],
          evidenceRefs: [],
          targetFailureModes: ['planning'],
        },
      ],
    }
    const payload = {
      protocol: 'dsh-evolve-le/proposal-submission/v1',
      specDigest: canonicalHash(f.spec),
      executionId: f.spec.executionId,
      proposal,
      sources: [{ child: 'child-1', source }],
    }
    const put = (value: unknown) =>
      f.store.put(Buffer.from(canonicalJson(value)), {
        mediaType: 'application/json',
        label: 'CONTROLLER_INTERNAL',
      })
    const submission = await put(payload)
    f.options.host.export = async (_spec, outcome) => ({
      outcome,
      artifacts: [submission, source, ...snapshot.files.map((file) => file.content)],
    })
    await f.executor.start(f.spec.executionId)
    f.exitNormally()
    const execution = await f.executor.collect(f.spec.executionId)
    await expect(f.executor.completion(f.spec.executionId)).rejects.toThrow(/cleanup/)
    await f.executor.cleanup(f.spec.executionId)
    const completion = await f.executor.completion(f.spec.executionId)
    const result = {
      protocol: 'dsh-evolve-le/proposal-supervisor-result/v2',
      outcome: 'SUCCEEDED',
      execution,
      completion,
      submission,
    }
    const expected = {
      store: f.store,
      spec: f.spec,
      children: ['child-1'],
      parentSourceHash: proposal.parentSourceHash,
    }
    expect(await verifyProposalSupervisorOutcome(result, expected)).toEqual(result)
    const { default: Ajv } = await import('ajv')
    const ajv = new Ajv({ strict: true })
    const resultSchema = ajv.compile(
      JSON.parse(await readFile('schemas/proposal.supervisor-result.schema.json', 'utf8')),
    )
    const completionSchema = ajv.compile(
      JSON.parse(await readFile('schemas/execution.completion.schema.json', 'utf8')),
    )
    expect(resultSchema(result), JSON.stringify(resultSchema.errors)).toBe(true)
    expect(
      completionSchema(await verifyExecutionCompletion(f.store, completion)),
      JSON.stringify(completionSchema.errors),
    ).toBe(true)
    expect(resultSchema({ ...result, admissions: [] })).toBe(false)
    const handoffRoot = join(f.options.root, '..', 'handoff')
    await mkdir(handoffRoot)
    expect(await readProposalSupervisorResult({ ...expected, root: handoffRoot })).toBeNull()
    await writeFile(
      join(handoffRoot, 'result.json'),
      canonicalJson({ ...result, execution: f.spec.policy }),
    )
    await expect(readProposalSupervisorResult({ ...expected, root: handoffRoot })).rejects.toThrow()
    await writeFile(join(handoffRoot, 'result.json'), canonicalJson(result))
    expect(await readProposalSupervisorResult({ ...expected, root: handoffRoot })).toEqual(result)
    await expect(
      verifyProposalSupervisorOutcome({ ...result, outcome: 'FAILED' }, expected),
    ).rejects.toThrow(/outcome/)
    await expect(
      verifyProposalSupervisorOutcome({ ...result, submission: null }, expected),
    ).rejects.toThrow()
    await expect(
      verifyProposalSupervisorOutcome(
        { ...result, protocol: 'dsh-evolve-le/proposal-supervisor-result/v1' },
        expected,
      ),
    ).rejects.toThrow(/v2/)
    await expect(
      verifyProposalSupervisorOutcome({ ...result, admissions: [submission] }, expected),
    ).rejects.toThrow(/unexpected/)
    const foreign = await put({
      ...payload,
      proposal: {
        ...proposal,
        children: [{ ...proposal.children[0], hypothesis: 'Other proposal.' }],
      },
    })
    await expect(
      verifyProposalSupervisorOutcome({ ...result, submission: foreign }, expected),
    ).rejects.toThrow(/absent/)
    await rm(f.options.root, { recursive: true, force: true })
    expect(await verifyProposalSupervisorOutcome(result, expected)).toEqual(result)
    expect(await readProposalSupervisorResult({ ...expected, root: handoffRoot })).toEqual(result)
  })

  it('refuses Docker start when frozen input verification detects drift', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    f.options.host.verifyInputs = async () => {
      throw Error('input drift')
    }
    try {
      await expect(f.executor.start(f.spec.executionId)).rejects.toThrow(/input drift/)
      expect(f.starts).toBe(0)
    } finally {
      await f.executor.cancel(f.spec.executionId, 'test-complete')
      await f.executor.collect(f.spec.executionId)
      await f.executor.cleanup(f.spec.executionId)
    }
  })

  it('preserves a late observer failure across supervisor reopen after the process stopped', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.start(f.spec.executionId)
    f.exitNormally()
    await f.executor.reconcile(f.spec.executionId)
    await f.executor.fail(f.spec.executionId, 'worker-log-gap')
    const replay = new DockerExecutor(f.options)
    await replay.prepare(f.spec)
    const bundle = await verifyExecutionBundle(f.store, await replay.collect(f.spec.executionId))
    expect(bundle.outcome).toBe('FAILED')
    expect(bundle.failureReason).toBe('worker-log-gap')
    await replay.cleanup(f.spec.executionId)
  })

  it('cancels, commits failure, cleans in order and preserves the same bundle across reopen', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.start(f.spec.executionId)
    await f.executor.cancel(f.spec.executionId, 'operator-cancel')
    const ref = await f.executor.collect(f.spec.executionId)
    expect((await verifyExecutionBundle(f.store, ref)).outcome).toBe('CANCELLED')
    await f.executor.cleanup(f.spec.executionId)
    await f.executor.cleanup(f.spec.executionId)
    expect(f.log.indexOf('revoke')).toBeLessThan(f.log.indexOf('kill'))
    expect(f.log.indexOf('export')).toBeLessThan(f.log.indexOf('close-sockets'))
    expect(f.log.indexOf('close-sockets')).toBeLessThan(f.log.indexOf('remove'))
    expect(f.log.indexOf('remove')).toBeLessThan(f.log.indexOf('unmount'))
    const replay = new DockerExecutor(f.options)
    await replay.prepare(f.spec)
    expect(await replay.collect(f.spec.executionId)).toEqual(ref)
    const recoveredStatus = JSON.parse(
      (await f.store.read(await replay.reconcile(f.spec.executionId))).toString('utf8'),
    )
    expect(recoveredStatus.started).toBe(true)
    expect(f.starts).toBe(1)
  })
  it('refuses collect while running and never resets the original deadline', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.start(f.spec.executionId)
    await expect(f.executor.collect(f.spec.executionId)).rejects.toThrow(/stopped/)
    await f.executor.start(f.spec.executionId)
    expect(f.starts).toBe(1)
    await f.executor.cancel(f.spec.executionId, 'end')
    await f.executor.collect(f.spec.executionId)
    await f.executor.cleanup(f.spec.executionId)
  })
  it('uses accumulated CPU and will not clean without a committed bundle', async () => {
    const f = await fixture()
    await f.executor.prepare(f.spec)
    await f.executor.start(f.spec.executionId)
    await expect(f.executor.cleanup(f.spec.executionId)).rejects.toThrow(/committed/)
    f.sample.cpuTimeUs = f.spec.limits.cpuTimeMs * 1000
    await f.executor.reconcile(f.spec.executionId)
    const ref = await f.executor.collect(f.spec.executionId)
    expect((await verifyExecutionBundle(f.store, ref)).failureReason).toBe('cpu-total-limit')
    await f.executor.cleanup(f.spec.executionId)
  })
})
