import {
  verifyProposalSupervisorOutcome,
  type ProposalSupervisorOutcome,
} from './proposal-result.js'
export type { ProposalSupervisorOutcome } from './proposal-result.js'
import { ProposalValidatorTests, type ProposalTestOptions } from './proposal-tests.js'
import { readSourceSnapshot } from './snapshot.js'
import { buildCanonicalTar } from '../candidate/canonical.js'
/** External owner composition. No second AgentLoop and no candidate import. */
import { readExecutionCancellation, requestExecutionCancellation } from './cancellation.js'
import { mkdir, chown, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, sha256Hex, parseCanonicalJson } from '../state/canonical.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { readProposalInputBinding } from './proposal-input.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { claimOwnerGeneration, assertOwnerGeneration, reclaimActionEndpoint } from './owner.js'
import { openActionRpc } from './rpc.js'
import { ProposalActionBroker } from './action-broker.js'
import { ProposalSnapshotFinalizer } from './proposal-finalizer.js'
import { ActionModelGateway, type ActionModelLimits } from './model-gateway.js'
import type {
  NativeLlmCompletionRequest,
  NativeLlmCompletionResult,
} from '../dsh/native-llm-adapter.js'
import { ContainerShell } from './shell.js'
import { LinuxExecutionHost, type ActionLifecycle } from './linux-host.js'
import { DockerExecutor } from './docker-executor.js'
import type { DockerEngine } from './docker-engine.js'
import type { DockerSecurity } from './docker-policy.js'
import { WorkerStreamReceiver } from './stream.js'
import { PersistentResourceAdmission } from './reservation-ledger.js'
import type { ResourceCapacity } from './resources.js'
import { writeCapabilityFile } from './files.js'
import { readCanonicalFile, publishCanonical, verifyExecutionBundle } from './evidence.js'
import { executionName, ExecutionError, type ExecutionSpec, type ExecutionKind } from './types.js'
export interface ProposalSupervisorOptions {
  spec: ExecutionSpec
  signal?: AbortSignal
  inputManifest: ObjectRef
  hostRoot: string
  executionRoot: string
  cgroupRoot: string
  resourceRoot: string
  pools: Record<ExecutionKind, ResourceCapacity>
  security: DockerSecurity
  store: ObjectStore
  engine: DockerEngine
  model: {
    provider: string
    model: string
    limits: ActionModelLimits
    dispatch: (
      id: string,
      request: NativeLlmCompletionRequest,
      signal: AbortSignal,
    ) => Promise<NativeLlmCompletionResult>
  }
  tests: Omit<ProposalTestOptions, 'root' | 'store' | 'spec' | 'children'>
}
/** Durable intent only; the owner remains responsible for stopping and exporting. */
export async function cancelProposalSupervisor(
  options: Pick<ProposalSupervisorOptions, 'spec' | 'hostRoot'>,
  reason: string,
): Promise<void> {
  await requestExecutionCancellation(
    join(options.hostRoot, executionName(options.spec)),
    options.spec,
    reason,
  )
}
export async function runProposalSupervisor(
  options: ProposalSupervisorOptions,
): Promise<ProposalSupervisorOutcome> {
  options = {
    ...options,
    spec: structuredClone(options.spec),
    inputManifest: structuredClone(options.inputManifest),
    security: structuredClone(options.security),
    pools: structuredClone(options.pools),
    model: { ...options.model, limits: structuredClone(options.model.limits) },
    tests: structuredClone(options.tests),
  }
  const { store, engine } = options,
    spec = structuredClone(options.spec),
    root = join(options.hostRoot, executionName(spec))
  await prepareSupervisorDirectory(root)
  const { config, parent, children, catalog, exportManifest } = await readProposalInputBinding(
    store,
    options.inputManifest,
    spec,
  )
  if (
    config.provider !== options.model.provider ||
    config.model !== options.model.model ||
    config.maxTokens > options.model.limits.maxOutputTokens ||
    config.contextWindowTokens > options.model.limits.maxInputTokens
  )
    throw new ExecutionError('proposal model route/limits differ from frozen input')
  for (const ref of [
    options.tests.parentSnapshot,
    options.tests.parentCapsuleInventory,
    options.tests.workerInventory,
  ])
    if (!spec.inputs.some((input) => canonicalJson(input) === canonicalJson(ref)))
      throw new ExecutionError('online test runtime missing from frozen proposal inputs')
  if (
    options.tests.profile.resourceRoot !== options.resourceRoot ||
    canonicalJson(options.tests.profile.pools) !== canonicalJson(options.pools)
  )
    throw new ExecutionError('online tests require the shared action resource ledger/pools')
  const testParent = await readSourceSnapshot(store, options.tests.parentSnapshot)
  const testParentFiles = await Promise.all(
    testParent.files.map(async (file) => ({
      path: file.path,
      mode: file.mode,
      content: await store.read(file.content),
    })),
  )
  if (sha256Hex(buildCanonicalTar(testParentFiles)) !== parent.sha256)
    throw new ExecutionError('online test parent differs from proposal input')
  const tests = new ProposalValidatorTests({
    ...options.tests,
    root: join(root, 'tests'),
    store,
    spec,
    children,
  })
  const finalizer = new ProposalSnapshotFinalizer({
    root: join(root, 'finalizations'),
    store,
    spec,
    inputManifest: options.inputManifest,
    children,
    context: {
      parentSourceHash: config.parentSourceHash,
      ...(config.treeV2Parent ? { treeV2Parent: config.treeV2Parent } : {}),
      catalog,
      exportManifest,
      parentSourceFiles: Object.fromEntries(
        parent.files.map((file) => [
          file.path,
          new TextDecoder('utf-8', { fatal: true }).decode(file.content),
        ]),
      ),
    },
  })
  // The launcher uses flock --no-fork; claiming without that lock is refused.
  const owner = await claimOwnerGeneration(root, canonicalHash(spec)),
    abort = new AbortController()
  let rpc: Awaited<ReturnType<typeof openActionRpc>> | undefined
  const stream = await WorkerStreamReceiver.open({
    root: join(root, 'stream'),
    store,
    executionId: spec.executionId,
    maxBytes: spec.limits.outputBytes,
    maxFrameBytes: spec.limits.outputBytes,
  })
  let observation: Promise<void> | undefined
  let observationError: unknown
  const actions: ActionLifecycle = {
    async quiesce() {
      await broker?.quiesce()
    },
    async resume() {
      broker?.resume()
    },
    async revoke() {
      broker?.revoke()
      abort.abort()
    },
    async cancelChildren() {
      await tests.cancel()
    },
    async close() {
      await rpc?.close()
    },
    async artifacts() {
      await broker?.drain()
      return [
        ...((await broker?.artifacts()) ?? []),
        ...(await stream.artifacts()),
        ...(await finalizer.artifacts()),
        ...(await tests.artifacts()),
      ]
    },
  }
  const host = new LinuxExecutionHost({
    root: options.hostRoot,
    cgroupRoot: options.cgroupRoot,
    store,
    engine,
    security: options.security,
    actions,
    inputManifest: options.inputManifest,
  })
  const executor = new DockerExecutor({
    root: options.executionRoot,
    store,
    engine,
    host,
    security: options.security,
    admission: new PersistentResourceAdmission({
      root: options.resourceRoot,
      pools: options.pools,
    }),
  })
  const gateway = new ActionModelGateway({
    root: join(root, 'models'),
    store,
    executionId: spec.executionId,
    ...options.model,
    dispatch: (id, request, signal) =>
      options.model.dispatch(id, request, AbortSignal.any([signal, abort.signal])),
  })
  const broker = new ProposalActionBroker({
    spec,
    inputRoot: join(root, 'input'),
    workspaceRoot: join(root, 'workspace'),
    controlRoot: root,
    store,
    children: children,
    parentSourceHash: `sha256:${parent.sha256}`,
    modelGateway: gateway,
    shell: new ContainerShell({
      engine,
      store,
      async abort(reason) {
        if (!abort.signal.aborted) await executor.fail(spec.executionId, reason)
      },
    }),
    snapshot: (child) => host.quiesceSnapshot(spec, child),
    test: (child, source) => tests.test(child, source),
    async finalize(proposal, sources) {
      const finalized = await finalizer.finalize(proposal, sources)
      await tests.testSubmission(finalized)
      return finalized
    },
    async submitted() {
      gateway.revoke()
    },
  })
  const observe = () => {
    if (!engine.stream) throw new ExecutionError('Docker streaming observer unavailable')
    observation = engine
      .stream(
        'GET',
        `/containers/${executionName(spec)}/logs?stdout=true&stderr=true&follow=true`,
        {
          timeoutMs: Math.max(1000, Date.parse(spec.deadlineUtc) - Date.now() + 10000),
          maxBytes: spec.limits.outputBytes * 10,
          onChunk: (chunk) => stream.write(chunk),
        },
      )
      .then(() => stream.end())
      .catch(async (error) => {
        observationError = error
        try {
          await executor.fail(
            spec.executionId,
            error instanceof Error ? error.message : 'worker stream failed',
          )
        } catch (stopError) {
          observationError = stopError
        }
      })
  }
  const cancelled = () => {
    broker.revoke()
    gateway.revoke()
    abort.abort()
    void cancelProposalSupervisor(options, 'proposal supervisor cancelled')
      .then(() => executor.cancel(spec.executionId, 'proposal supervisor cancelled'))
      .catch(() =>
        executor
          .fail(spec.executionId, 'proposal cancellation persistence failed')
          .catch(() => undefined),
      )
  }
  try {
    await mkdir(join(root, 'ipc'), { recursive: true, mode: 0o755 })
    const recoveryOnly = (await readExecutionCancellation(root, spec)) !== null
    await executor.prepare(spec, { existingOnly: recoveryOnly })
    options.signal?.addEventListener('abort', cancelled, { once: true })
    if (options.signal?.aborted)
      await cancelProposalSupervisor(options, 'proposal supervisor cancelled')
    const initialStatus = parseCanonicalJson(
      (await store.read(await executor.reconcile(spec.executionId))).toString('utf8'),
    ) as { phase: string; started: boolean }
    const initialCancellation = await readExecutionCancellation(root, spec)
    if (initialCancellation) await executor.cancel(spec.executionId, initialCancellation)
    await broker.restore()
    if (
      !['COMMITTED', 'CLEANED'].includes(initialStatus.phase) &&
      (
        await gateway.usage({
          existingOnly: initialStatus.started || initialStatus.phase === 'RUNNING',
        })
      ).ambiguous > 0
    )
      throw new ExecutionError('AMBIGUOUS model account on supervisor recovery')
    let status = parseCanonicalJson(
      (await store.read(await executor.reconcile(spec.executionId))).toString('utf8'),
    ) as { phase: string }
    if (status.phase === 'CREATED') {
      // No candidate has run; seed once from the already frozen parent bytes.
      for (const child of children) {
        const path = join(root, 'workspace', child)
        await mkdir(path, { recursive: true, mode: 0o750 })
        await chown(path, 65532, 65532)
        for (const file of parent.files)
          await writeCapabilityFile(path, file.path, file.content, spec.limits.fileBytes, {
            uid: 65532,
            gid: 65532,
          })
      }
    }
    if (status.phase === 'CREATED' || status.phase === 'RUNNING') {
      await assertOwnerGeneration(root, owner)
      await mkdir(join(root, 'ipc'), { recursive: true, mode: 0o755 })
      await chmod(join(root, 'ipc'), 0o755)
      await reclaimActionEndpoint(root, owner)
      rpc = await openActionRpc({
        socketPath: join(root, 'ipc/action.sock'),
        executionId: spec.executionId,
        socketUid: 65532,
        socketGid: 65532,
        maxFrameBytes: spec.limits.outputBytes * 2 + 8192,
        maxConnections: 8,
        handler: async (request, signal) => {
          await assertOwnerGeneration(root, owner)
          if (await readExecutionCancellation(root, spec)) {
            broker.revoke()
            gateway.revoke()
            throw new ExecutionError('proposal cancellation requested')
          }
          return broker!.handler(request, signal)
        },
      })
      const beforeStartCancellation = await readExecutionCancellation(root, spec)
      if (beforeStartCancellation) await executor.cancel(spec.executionId, beforeStartCancellation)
      else if (status.phase === 'CREATED') await executor.start(spec.executionId)
      observe()
      for (;;) {
        if (observationError) throw observationError
        await assertOwnerGeneration(root, owner)
        const requestedCancellation = await readExecutionCancellation(root, spec)
        if (requestedCancellation) await executor.cancel(spec.executionId, requestedCancellation)
        status = parseCanonicalJson(
          (await store.read(await executor.reconcile(spec.executionId))).toString('utf8'),
        ) as { phase: string }
        if (status.phase !== 'RUNNING') break
        await new Promise<void>((r) => setTimeout(r, 200))
      }
      await observation
      if (observationError) throw observationError
    }
    const execution = await executor.collect(spec.executionId),
      bundle = await verifyExecutionBundle(store, execution)
    let submission: ObjectRef | null = null
    if (bundle.outcome === 'SUCCEEDED')
      submission = (await readCanonicalFile(join(root, 'submitted.json'))) as ObjectRef
    await executor.cleanup(spec.executionId)
    const result: ProposalSupervisorOutcome = {
      protocol: 'dsh-evolve-le/proposal-supervisor-result/v2',
      outcome: bundle.outcome,
      execution,
      completion: await executor.completion(spec.executionId),
      submission,
    }
    await verifyProposalSupervisorOutcome(result, {
      store,
      spec,
      children,
      parentSourceHash: config.parentSourceHash,
    })
    await publishCanonical(join(root, 'result.json'), result)
    return result
  } catch (error) {
    broker.revoke()
    abort.abort()
    await executor
      .fail(spec.executionId, error instanceof Error ? error.message : 'supervisor failed')
      .catch(() => undefined)
    // Any inability to export/clean remains in the persistent registry for reconcile.
    try {
      const execution = await executor.collect(spec.executionId)
      await executor.cleanup(spec.executionId)
      const result: ProposalSupervisorOutcome = {
        protocol: 'dsh-evolve-le/proposal-supervisor-result/v2',
        outcome: (await verifyExecutionBundle(store, execution)).outcome,
        execution,
        completion: await executor.completion(spec.executionId),
        submission: null,
      }
      await verifyProposalSupervisorOutcome(result, {
        store,
        spec,
        children,
        parentSourceHash: config.parentSourceHash,
      })
      await publishCanonical(join(root, 'result.json'), result)
    } catch {
      /* never convert incomplete cleanup into success */
    }
    throw error
  } finally {
    options.signal?.removeEventListener('abort', cancelled)
    // Setup/preflight failures must not leave the supervisor's IPC listener alive.
    await rpc?.close()
  }
}
