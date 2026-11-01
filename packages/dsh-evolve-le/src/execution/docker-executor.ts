import { COMPLETION_PROTOCOL, verifyExecutionCompletion } from './completion.js'
/** Disposable execution owner. Hosted by the external supervisor, never candidate code. */
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { DockerApiError, type DockerEngine } from './docker-engine.js'
import {
  assertContainerConfig,
  assertDockerPlatform,
  buildContainerConfig,
  type DockerSecurity,
} from './docker-policy.js'
import { openExecutionEvidence, type ExecutionEvidence } from './evidence.js'
import { readBootClock, type BootClock, type CgroupSample } from './resources.js'
import type { AdmissionControl } from './reservation-ledger.js'
import {
  ExecutionError,
  executionName,
  validateExecutionSpec,
  type DisposableExecutor,
  type ExecutionSpec,
  type ExecutionOutcome,
  type ExecutionReceipt,
} from './types.js'

/** Trusted host implementation performs mounts, cgroups, gateway fencing and export. */
export interface ExecutionHost {
  preflight(spec: ExecutionSpec): Promise<ObjectRef>
  verifyInputs(spec: ExecutionSpec): Promise<ObjectRef>
  prepare(spec: ExecutionSpec): Promise<ObjectRef>
  sample(spec: ExecutionSpec): Promise<CgroupSample>
  revoke(spec: ExecutionSpec): Promise<void>
  cancelChildren(spec: ExecutionSpec): Promise<void>
  export(
    spec: ExecutionSpec,
    outcome: ExecutionOutcome,
  ): Promise<{ artifacts: ObjectRef[]; outcome: ExecutionOutcome; failureReason?: string }>
  closeSockets(spec: ExecutionSpec): Promise<void>
  cleanup(spec: ExecutionSpec): Promise<ObjectRef>
}
interface Entry {
  spec: ExecutionSpec
  evidence: ExecutionEvidence
  containerId: string | null
  startedMono: BootClock | null
  watchdog: ReturnType<typeof setInterval> | null
  failure: string | null
  cancelled: boolean
  monitoring: boolean
  childrenPending: boolean
}
export class DockerExecutor implements DisposableExecutor {
  private readonly entries = new Map<string, Entry>()
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(
    private readonly options: {
      root: string
      store: ObjectStore
      engine: DockerEngine
      host: ExecutionHost
      admission: AdmissionControl
      security: DockerSecurity
    },
  ) {}
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    this.queues.set(id, next)
    return next
  }
  private security(spec: ExecutionSpec): DockerSecurity {
    return {
      ...this.options.security,
      cgroupParent: `${this.options.security.cgroupParent}/${executionName(spec)}`,
    }
  }
  private async facts(value: unknown): Promise<ObjectRef> {
    return this.options.store.put(Buffer.from(canonicalJson(value)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
  }
  private entry(id: string): Entry {
    const e = this.entries.get(id)
    if (!e)
      throw new ExecutionError('execution not registered; reopen frozen spec before reconcile')
    return e
  }
  private async inspect(e: Entry): Promise<Record<string, unknown> | null> {
    try {
      return await this.options.engine.json(
        'GET',
        `/containers/${e.containerId ?? executionName(e.spec)}/json`,
      )
    } catch (error) {
      if (error instanceof DockerApiError && error.status === 404) return null
      throw error
    }
  }
  private async stopped(e: Entry, reason: string | null): Promise<void> {
    if (e.watchdog) {
      clearInterval(e.watchdog)
      e.watchdog = null
    }
    if (reason !== null) e.failure ??= reason
    if (
      e.evidence.phase === 'STOPPED' ||
      e.evidence.phase === 'EXPORTED' ||
      e.evidence.phase === 'COMMITTED' ||
      e.evidence.phase === 'CLEANED'
    )
      return
    const sample = await this.options.host.sample(e.spec)
    if (sample.populated || sample.pidsCurrent !== 0)
      throw new ExecutionError('cannot prove execution process domain empty')
    await e.evidence.record(
      'STOPPED',
      'process-domain-empty',
      await this.facts({ sample, failure: e.failure, cancelled: e.cancelled }),
    )
  }
  private async childrenPending(evidence: ExecutionEvidence): Promise<boolean> {
    let pending = false
    for (const ref of evidence.receipts) {
      const receipt = parseCanonicalJson(
        (await this.options.store.read(ref)).toString('utf8'),
      ) as ExecutionReceipt
      if (receipt.event === 'children-cancel-intent') pending = true
      if (receipt.event === 'children-stopped') pending = false
    }
    return pending
  }
  private async beginChildrenStop(e: Entry): Promise<void> {
    e.childrenPending = true
    await e.evidence.record(
      e.evidence.phase ?? 'RESERVED',
      'children-cancel-intent',
      await this.facts({ executionId: e.spec.executionId }),
    )
  }
  private async waitChildrenStop(e: Entry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.options.host.cancelChildren(e.spec),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ExecutionError('child cancellation confirmation timeout')),
            10_000,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  private async recordChildrenStopped(e: Entry): Promise<void> {
    await e.evidence.record(
      e.evidence.phase ?? 'RESERVED',
      'children-stopped',
      await this.facts({ executionId: e.spec.executionId }),
    )
    e.childrenPending = false
  }
  private async cancelChildren(e: Entry): Promise<void> {
    await this.beginChildrenStop(e)
    await this.waitChildrenStop(e)
    await this.recordChildrenStopped(e)
  }
  private async stop(e: Entry, reason: string): Promise<void> {
    e.failure ??= reason
    let cancellationError: unknown
    try {
      await this.options.host.revoke(e.spec)
    } catch (error) {
      cancellationError = error
    }
    try {
      await this.beginChildrenStop(e)
    } catch (error) {
      cancellationError ??= error
    }
    // Start child revocation, but never leave the proposal alive while waiting for it.
    const children = this.waitChildrenStop(e).then(
      () => true,
      (error) => {
        cancellationError ??= error
        return false
      },
    )
    try {
      await this.stopOwnDomain(e)
    } finally {
      if (await children) await this.recordChildrenStopped(e)
    }
    await this.stopped(e, reason)
    if (cancellationError) throw cancellationError
  }
  private async stopOwnDomain(e: Entry): Promise<void> {
    const actual = await this.inspect(e)
    if (actual) {
      const state = actual.State as { Running?: boolean; Paused?: boolean }
      if (state?.Paused)
        await this.options.engine.request('POST', `/containers/${actual.Id}/unpause`)
      if (state?.Running) {
        try {
          await this.options.engine.request('POST', `/containers/${actual.Id}/kill?signal=KILL`)
        } catch (error) {
          if (!(error instanceof DockerApiError && error.status === 409)) throw error
        }
        await this.options.engine.json(
          'POST',
          `/containers/${actual.Id}/wait?condition=not-running`,
          undefined,
          { timeoutMs: 10_000 },
        )
      }
    }
  }
  async prepare(spec: ExecutionSpec, recovery?: { existingOnly: boolean }): Promise<ObjectRef> {
    return this.serial(spec.executionId, async () => {
      validateExecutionSpec(spec)
      const old = this.entries.get(spec.executionId)
      if (old) {
        if (canonicalHash(old.spec) !== canonicalHash(spec))
          throw new ExecutionError('execution spec drift')
        return old.evidence.specRef
      }
      const evidence = await openExecutionEvidence(
        join(this.options.root, spec.executionId),
        this.options.store,
        spec,
      )
      if (recovery?.existingOnly && !evidence.receipts.length)
        throw new ExecutionError('recovery requires recorded execution effects')
      // A completed bundle is recoverable even when the original daemon or
      // platform is no longer available. This path dispatches no new work.
      const committed = await evidence.committed()
      if (committed !== null) {
        this.entries.set(spec.executionId, {
          spec: structuredClone(spec),
          evidence,
          containerId: null,
          startedMono: null,
          watchdog: null,
          failure: null,
          cancelled: false,
          monitoring: false,
          childrenPending: await this.childrenPending(evidence),
        })
        if (evidence.phase === 'EXPORTED')
          await evidence.record('COMMITTED', 'adopt-manifest', committed)
        return evidence.specRef
      }
      // A compatible host is mandatory before allocating or dispatching anything.
      const info = await this.options.engine.json('GET', '/info')
      assertDockerPlatform(info, this.options.security)
      const image = await this.options.engine.json(
        'GET',
        `/images/${encodeURIComponent(spec.image.reference)}/json`,
      )
      if (image.Id !== spec.image.id || `${image.Os}/${image.Architecture}` !== spec.image.platform)
        throw new ExecutionError('Docker image platform/digest mismatch')
      for (const ref of [
        ...spec.inputs,
        spec.policy,
        spec.reservation,
        ...(spec.gateway ? [spec.gateway.route, spec.gateway.authorization] : []),
      ])
        await this.options.store.verify(ref)
      const preflight = await this.options.host.preflight(spec)
      if (!(await this.options.admission.reserve(spec)))
        throw new ExecutionError('resource capacity unavailable; queue authorized action')
      const e: Entry = {
        spec: structuredClone(spec),
        evidence,
        containerId: null,
        startedMono: null,
        watchdog: null,
        failure: null,
        cancelled: false,
        monitoring: false,
        childrenPending: await this.childrenPending(evidence),
      }
      this.entries.set(spec.executionId, e)
      if (evidence.phase !== null) {
        for (const ref of evidence.receipts) {
          const receipt = parseCanonicalJson(
            (await this.options.store.read(ref)).toString('utf8'),
          ) as ExecutionReceipt
          if (receipt.event === 'start-intent') {
            const facts = parseCanonicalJson(
              (await this.options.store.read(receipt.facts)).toString('utf8'),
            ) as { bootClock?: BootClock }
            if (!facts.bootClock)
              throw new ExecutionError('original monotonic deadline receipt missing')
            e.startedMono = facts.bootClock
          }
          if (receipt.event === 'failure-intent' || receipt.event === 'cancel-intent') {
            const facts = parseCanonicalJson(
              (await this.options.store.read(receipt.facts)).toString('utf8'),
            ) as { reason?: unknown }
            if (typeof facts.reason !== 'string')
              throw new ExecutionError('invalid persisted failure reason')
            e.failure ??= facts.reason
            if (receipt.event === 'cancel-intent') e.cancelled = true
          }
          if (receipt.event === 'process-domain-empty') {
            const facts = parseCanonicalJson(
              (await this.options.store.read(receipt.facts)).toString('utf8'),
            ) as { failure: string | null; cancelled: boolean }
            e.failure ??= facts.failure
            e.cancelled ||= facts.cancelled
          }
        }
        await this.reconcileEntry(e)
        return evidence.specRef
      }
      await evidence.record('RESERVED', 'resource-reservation', preflight)
      try {
        const prepared = await this.options.host.prepare(spec)
        await evidence.record('PREPARED', 'mounts-gateway-ready', prepared)
        const config = buildContainerConfig(spec, this.security(spec))
        config.Labels = {
          ...config.Labels,
          'dsh.spec': canonicalHash(spec),
        } as typeof config.Labels
        await evidence.record(
          'PREPARED',
          'create-intent',
          await this.facts({ name: executionName(spec), config }),
        )
        try {
          const created = await this.options.engine.json<{ Id: string }>(
            'POST',
            `/containers/create?name=${executionName(spec)}&platform=${spec.image.platform}`,
            config,
          )
          e.containerId = created.Id
        } catch (error) {
          const actual = await this.inspect(e)
          if (!actual) throw error
          e.containerId = String(actual.Id)
        }
        const actual = await this.inspect(e)
        if (!actual) throw new ExecutionError('created container missing')
        assertContainerConfig(spec, this.security(spec), actual)
        if (
          (actual.Config as { Labels?: Record<string, string> }).Labels?.['dsh.spec'] !==
          canonicalHash(spec)
        )
          throw new ExecutionError('container spec label mismatch')
        await evidence.record(
          'CREATED',
          'inspect-verified',
          await this.facts({
            containerId: e.containerId,
            inspection: await this.options.store.put(Buffer.from(JSON.stringify(actual)), {
              mediaType: 'application/vnd.docker.container-inspect+json',
              label: 'CONTROLLER_INTERNAL',
            }),
          }),
        )
        return evidence.specRef
      } catch (error) {
        e.failure = error instanceof Error ? error.message : 'prepare failed'
        // Preserve owned resources on uncertain daemon/host failure for reconcile.
        try {
          await this.stop(e, e.failure)
        } catch {
          /* durable intent remains; no clean claim */
        }
        throw error
      }
    })
  }
  async start(id: string): Promise<void> {
    return this.serial(id, async () => {
      const e = this.entry(id)
      if (e.evidence.phase === 'RUNNING') {
        await this.reconcileEntry(e)
        return
      }
      if (e.evidence.phase !== 'CREATED') throw new ExecutionError('start requires CREATED')
      const inputVerification = await this.options.host.verifyInputs(e.spec)
      await e.evidence.record('CREATED', 'inputs-reverified', inputVerification)
      if (Date.now() >= Date.parse(e.spec.deadlineUtc)) {
        await this.stop(e, 'deadline-before-start')
        throw new ExecutionError('deadline expired')
      }
      const actual = await this.inspect(e)
      if (!actual) throw new ExecutionError('container disappeared before start')
      assertContainerConfig(e.spec, this.security(e.spec), actual)
      e.startedMono ??= await readBootClock()
      await e.evidence.record(
        'CREATED',
        'start-intent',
        await this.facts({
          containerId: e.containerId,
          deadlineUtc: e.spec.deadlineUtc,
          bootClock: e.startedMono,
        }),
      )
      try {
        await this.options.engine.request('POST', `/containers/${actual.Id}/start`)
      } catch (error) {
        const after = await this.inspect(e)
        const state = after?.State as { StartedAt?: string } | undefined
        if (!state?.StartedAt || state.StartedAt.startsWith('0001-')) throw error
      }
      await e.evidence.record(
        'RUNNING',
        'start-observed',
        await this.facts({ containerId: e.containerId, observedAt: new Date().toISOString() }),
      )
      this.watch(e)
    })
  }
  private watch(e: Entry): void {
    if (e.watchdog) return
    e.watchdog = setInterval(() => {
      if (e.monitoring) return
      e.monitoring = true
      void this.serial(e.spec.executionId, () => this.reconcileEntry(e))
        .catch(async (error) => {
          e.failure ??= error instanceof Error ? error.message : 'monitor failed'
          // Even with daemon loss, revoke model/tool authority immediately.
          await this.options.host.revoke(e.spec).catch(() => undefined)
          await this.serial(e.spec.executionId, () => this.stop(e, e.failure!)).catch(
            () => undefined,
          )
        })
        .finally(() => {
          e.monitoring = false
        })
    }, 200)
  }
  private async reconcileEntry(e: Entry): Promise<void> {
    if (e.evidence.phase === 'CLEANED' || e.evidence.phase === 'STOPPED') return
    const committed = await e.evidence.committed()
    if (committed) {
      if (e.evidence.phase === 'EXPORTED')
        await e.evidence.record('COMMITTED', 'adopt-manifest', committed)
      return
    }
    const actual = await this.inspect(e)
    if (!actual) {
      if (['CREATED', 'RUNNING'].includes(String(e.evidence.phase))) e.failure ??= 'container-lost'
      if (e.evidence.phase === 'RUNNING' || e.evidence.phase === 'CREATED')
        await this.stop(e, e.failure ?? 'container-lost')
      return
    }
    assertContainerConfig(e.spec, this.security(e.spec), actual)
    e.containerId = String(actual.Id)
    if (e.evidence.phase === 'PREPARED')
      await e.evidence.record(
        'CREATED',
        'adopt-original-created',
        await this.facts({ containerId: e.containerId }),
      )
    const state = actual.State as {
      Running: boolean
      Paused: boolean
      ExitCode: number
      OOMKilled: boolean
      StartedAt: string
    }
    if (state.Running) {
      if (e.evidence.phase === 'CREATED') {
        await e.evidence.record(
          'RUNNING',
          'adopt-original-running',
          await this.facts({ containerId: e.containerId, startedAt: state.StartedAt }),
        )
      }
      const now = await readBootClock()
      if (
        e.startedMono === null ||
        now.bootId !== e.startedMono.bootId ||
        now.elapsedMs < e.startedMono.elapsedMs
      ) {
        await this.stop(e, 'original-monotonic-deadline-lost')
        return
      }
      const elapsed = now.elapsedMs - e.startedMono.elapsedMs
      const sample = await this.options.host.sample(e.spec)
      await e.evidence.record('RUNNING', 'resource-sample', await this.facts(sample))
      if (Date.now() >= Date.parse(e.spec.deadlineUtc) || elapsed >= e.spec.maxElapsedMs)
        await this.stop(e, 'wall-deadline')
      else if (
        this.options.security.profile !== 'local-generation/v1' &&
        sample.cpuTimeUs >= e.spec.limits.cpuTimeMs * 1000
      )
        await this.stop(e, 'cpu-total-limit')
      else if (sample.oomKill > 0 || sample.pidsMaxEvents > 0) await this.stop(e, 'resource-limit')
      else this.watch(e)
    } else if (state.StartedAt && !state.StartedAt.startsWith('0001-')) {
      if (e.evidence.phase === 'CREATED')
        await e.evidence.record(
          'RUNNING',
          'adopt-original-stopped',
          await this.facts({ startedAt: state.StartedAt }),
        )
      const reason = state.OOMKilled
        ? 'oom'
        : state.ExitCode !== 0
          ? `exit-${state.ExitCode}`
          : e.failure
      try {
        await this.options.host.revoke(e.spec)
        await this.cancelChildren(e)
      } finally {
        await this.stopped(e, reason)
      }
    }
  }
  async reconcile(id: string): Promise<ObjectRef> {
    return this.serial(id, async () => {
      const e = this.entry(id)
      await this.reconcileEntry(e)
      return this.facts({
        phase: e.evidence.phase,
        containerId: e.containerId,
        failure: e.failure,
        started: e.evidence.ran || e.startedMono !== null,
      })
    })
  }
  async fail(id: string, reason: string): Promise<void> {
    return this.serial(id, async () => {
      const e = this.entry(id)
      if (['COMMITTED', 'CLEANED'].includes(String(e.evidence.phase))) return
      e.failure ??= reason
      try {
        await e.evidence.record(
          e.evidence.phase ?? 'RESERVED',
          'failure-intent',
          await this.facts({ reason: e.failure }),
        )
      } finally {
        // An unwritable evidence disk must not keep candidate processes alive.
        await this.stop(e, reason)
      }
    })
  }
  async cancel(id: string, reason: string): Promise<void> {
    return this.serial(id, async () => {
      const e = this.entry(id)
      if (['COMMITTED', 'CLEANED'].includes(String(e.evidence.phase))) return
      e.cancelled = true
      try {
        await e.evidence.record(
          e.evidence.phase ?? 'RESERVED',
          'cancel-intent',
          await this.facts({ reason }),
        )
      } finally {
        await this.stop(e, reason)
      }
    })
  }
  async collect(id: string): Promise<ObjectRef> {
    return this.serial(id, async () => {
      const e = this.entry(id),
        committed = await e.evidence.committed()
      if (committed) return committed
      await this.reconcileEntry(e)
      if (e.evidence.phase !== 'STOPPED')
        throw new ExecutionError('collect requires stopped execution')
      const proposedOutcome = e.childrenPending
        ? 'INCOMPLETE'
        : e.cancelled
          ? 'CANCELLED'
          : e.failure
            ? 'FAILED'
            : 'SUCCEEDED'
      const exported = await this.options.host.export(e.spec, proposedOutcome)
      const outcome = proposedOutcome === 'SUCCEEDED' ? exported.outcome : proposedOutcome
      const reason = e.failure ?? exported.failureReason
      await e.evidence.record(
        'EXPORTED',
        'artifacts-exported',
        await this.facts({ artifacts: exported.artifacts, outcome }),
      )
      const bundle = await e.evidence.commit(
        outcome,
        exported.artifacts,
        outcome === 'SUCCEEDED' ? undefined : (reason ?? 'incomplete-export'),
      )
      await e.evidence.record('COMMITTED', 'manifest-published', bundle)
      return bundle
    })
  }
  async completion(id: string): Promise<ObjectRef> {
    return this.serial(id, async () => {
      const entry = this.entry(id)
      const execution = await entry.evidence.committed()
      if (entry.evidence.phase !== 'CLEANED' || !execution)
        throw new ExecutionError('completion requires committed cleanup')
      const ref = await this.options.store.put(
        Buffer.from(
          canonicalJson({
            protocol: COMPLETION_PROTOCOL,
            execution,
            receipts: entry.evidence.receipts,
          }),
        ),
        {
          mediaType: 'application/vnd.dsh-evolve-le.execution-completion+json',
          label: 'CONTROLLER_INTERNAL',
        },
      )
      await verifyExecutionCompletion(this.options.store, ref, entry.spec)
      return ref
    })
  }
  async cleanup(id: string): Promise<void> {
    return this.serial(id, async () => {
      const e = this.entry(id)
      if (e.evidence.phase === 'CLEANED') return
      if (!(await e.evidence.committed()))
        throw new ExecutionError('cleanup requires committed execution/failure bundle')
      if (e.evidence.phase === 'EXPORTED')
        await e.evidence.record('COMMITTED', 'adopt-manifest', (await e.evidence.committed())!)
      if (e.childrenPending) await this.cancelChildren(e)
      await this.options.host.closeSockets(e.spec)
      const actual = await this.inspect(e)
      if (actual) {
        if ((actual.State as { Running: boolean }).Running)
          throw new ExecutionError('cleanup refuses live process domain')
        await e.evidence.record(
          'COMMITTED',
          'remove-container-intent',
          await this.facts({ containerId: actual.Id }),
        )
        await this.options.engine.request('DELETE', `/containers/${actual.Id}?force=false&v=false`)
      }
      const cleanup = await this.options.host.cleanup(e.spec)
      await this.options.admission.release(id)
      await e.evidence.record('CLEANED', 'owned-resources-and-reservation-released', cleanup)
      if (e.watchdog) {
        clearInterval(e.watchdog)
        e.watchdog = null
      }
    })
  }
}
