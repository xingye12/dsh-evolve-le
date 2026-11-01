/** External owner composition. No second AgentLoop and no candidate import. */
import { readExecutionCancellation, requestExecutionCancellation } from './cancellation.js'
import { mkdir, chown, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { readProposalInputBinding } from './proposal-input.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { claimOwnerGeneration, assertOwnerGeneration, reclaimActionEndpoint } from './owner.js'
import { openActionRpc } from './rpc.js'
import { ProposalActionBroker } from './action-broker.js'
import { parseGenerationDraft } from '../proposer/generation-draft.js'
import {
  publishGenerationResult,
  type ProposalGenerationResult,
} from './proposal-generation-result.js'
import { lstat } from 'node:fs/promises'
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
export interface ProposalGenerationOptions {
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
}
/** Durable intent only; the owner remains responsible for stopping and exporting. */
export async function cancelProposalGeneration(
  options: Pick<ProposalGenerationOptions, 'spec' | 'hostRoot'>,
  reason: string,
): Promise<void> {
  await requestExecutionCancellation(
    join(options.hostRoot, executionName(options.spec)),
    options.spec,
    reason,
  )
}
export async function runProposalGeneration(
  options: ProposalGenerationOptions,
): Promise<ProposalGenerationResult> {
  options = {
    ...options,
    spec: structuredClone(options.spec),
    inputManifest: structuredClone(options.inputManifest),
    security: structuredClone(options.security),
    pools: structuredClone(options.pools),
    model: { ...options.model, limits: structuredClone(options.model.limits) },
  }
  const { store, engine } = options,
    spec = structuredClone(options.spec),
    root = join(options.hostRoot, executionName(spec))
  await prepareSupervisorDirectory(root)
  const { config, parent, children } = await readProposalInputBinding(
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
  if (config.generationOnly !== true)
    throw new ExecutionError('generation requires frozen generationOnly worker profile')
  // This runner never resumes a worker. Claim the attempt before any Docker effects.
  for (const path of [
    join(root, 'generation-start.json'),
    join(root, 'owners'),
    join(options.executionRoot, spec.executionId),
  ]) {
    try {
      await lstat(path)
      throw new ExecutionError('generation attempt already started; read or sweep only')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  // The launcher uses flock --no-fork; claiming without that lock is refused.
  const owner = await claimOwnerGeneration(root, canonicalHash(spec)),
    abort = new AbortController()
  await publishCanonical(join(root, 'generation-start.json'), { specDigest: canonicalHash(spec) })
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
      // Generation has no validator children.
    },
    async close() {
      await rpc?.close()
    },
    async artifacts() {
      await broker?.drain()
      const artifacts = [...((await broker?.artifacts()) ?? []), ...(await stream.artifacts())]
      artifacts.push(
        await store.put(
          Buffer.from(
            canonicalJson({
              protocol: 'dsh-evolve-le/generation-accounting/v1',
              specDigest: canonicalHash(spec),
              ...(await gateway.usage()),
            }),
          ),
          {
            label: 'CONTROLLER_INTERNAL',
            mediaType: 'application/vnd.dsh-evolve-le.generation-accounting+json',
          },
        ),
      )
      return artifacts
    },
  }
  const host = new LinuxExecutionHost({
    generationOnly: true,
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
    generationOnly: true,
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
    async test() {
      throw new ExecutionError('generation profile disables candidate tests')
    },
    async finalize(proposal, sources) {
      parseGenerationDraft(proposal)
      if ((proposal.schemaVersion === 2) !== (config.treeV2Parent !== undefined))
        throw new ExecutionError('draft version differs from frozen parent protocol')
      return { proposal, sources: [...sources] }
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
    void cancelProposalGeneration(options, 'proposal supervisor cancelled')
      .then(() => executor.cancel(spec.executionId, 'proposal supervisor cancelled'))
      .catch(() =>
        executor
          .fail(spec.executionId, 'proposal cancellation persistence failed')
          .catch(() => undefined),
      )
  }
  const diagnostic = () =>
    store.put(
      Buffer.from(
        canonicalJson({
          protocol: 'dsh-evolve-le/proposal-generation-diagnostic/v1',
          specDigest: canonicalHash(spec),
          reason: 'generation did not complete successfully; inspect execution artifacts',
        }),
      ),
      { label: 'CONTROLLER_INTERNAL', mediaType: 'application/json' },
    )
  try {
    await mkdir(join(root, 'ipc'), { recursive: true, mode: 0o755 })
    if (await readExecutionCancellation(root, spec))
      throw new ExecutionError('generation cancelled before start')
    await executor.prepare(spec)
    options.signal?.addEventListener('abort', cancelled, { once: true })
    if (options.signal?.aborted)
      await cancelProposalGeneration(options, 'proposal supervisor cancelled')
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
    if (status.phase === 'RUNNING') throw new ExecutionError('generation refuses worker recovery')
    if (status.phase === 'CREATED') {
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
          if (request.method === 'test-child')
            throw new ExecutionError('generation disables candidate tests')
          return broker.handler(request, signal)
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
    const result: ProposalGenerationResult = {
      protocol: 'dsh-evolve-le/proposal-generation-result/v1',
      admission: 'NONE',
      specDigest: canonicalHash(spec),
      outcome: bundle.outcome,
      execution,
      completion: await executor.completion(spec.executionId),
      submission,
      diagnostic: bundle.outcome === 'SUCCEEDED' ? null : await diagnostic(),
    }
    await publishGenerationResult(root, result, {
      store,
      spec,
      children,
      parentSourceHash: config.parentSourceHash,
    })
    return result
  } catch {
    broker.revoke()
    abort.abort()
    await executor.fail(spec.executionId, 'generation failed').catch(() => undefined)
    let execution: ObjectRef | null = null,
      completion: ObjectRef | null = null
    try {
      execution = await executor.collect(spec.executionId)
      await executor.cleanup(spec.executionId)
      completion = await executor.completion(spec.executionId)
    } catch {
      /* persistent executor history remains available to sweep */
    }
    const result: ProposalGenerationResult = {
      protocol: 'dsh-evolve-le/proposal-generation-result/v1',
      admission: 'NONE',
      specDigest: canonicalHash(spec),
      outcome: 'INCOMPLETE',
      execution,
      completion,
      submission: null,
      diagnostic: await diagnostic(),
    }
    await publishGenerationResult(root, result, {
      store,
      spec,
      children,
      parentSourceHash: config.parentSourceHash,
    })
    return result
  } finally {
    options.signal?.removeEventListener('abort', cancelled)
    // Setup/preflight failures must not leave the supervisor's IPC listener alive.
    await rpc?.close()
  }
}
