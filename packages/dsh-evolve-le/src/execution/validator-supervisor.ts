import { assertSupervisorPath, validateSupervisorHostConfig } from './supervisor-host-config.js'
import { readExecutionCancellation, requestExecutionCancellation } from './cancellation.js'
/** Standalone trusted owner for one snapshot validator; no model or AgentLoop. */
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { openObjectStore, validateRef, type ObjectRef } from '../state/object-store.js'
import {
  validateExecutionSpec,
  assertExact,
  executionName,
  ExecutionError,
  type ExecutionSpec,
  type ExecutionOutcome,
  type ExecutionKind,
} from './types.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { readValidatorResult } from './validator-result.js'
import { claimOwnerGeneration, assertOwnerGeneration } from './owner.js'
import { LinuxExecutionHost } from './linux-host.js'
import { DockerExecutor } from './docker-executor.js'
import { localDockerEngine, type DockerEngine } from './docker-engine.js'
import type { DockerSecurity } from './docker-policy.js'
import type { ResourceCapacity } from './resources.js'
import { PersistentResourceAdmission } from './reservation-ledger.js'
import { WorkerStreamReceiver } from './stream.js'
import { publishCanonical, readCanonicalFile, verifyExecutionBundle } from './evidence.js'
export interface ValidatorSupervisorConfig {
  protocol: 'dsh-evolve-le/validator-supervisor/v2'
  spec: ExecutionSpec
  inputManifest: ObjectRef
  hostRoot: string
  executionRoot: string
  cgroupRoot: string
  resourceRoot: string
  storeRoot: string
  security: DockerSecurity
  pools: Record<ExecutionKind, ResourceCapacity>
  validator: { sourceSnapshot: ObjectRef; dependencyClosureSha256: string; runnerSourceDir: string }
}
export interface ValidatorSupervisorResult {
  protocol: 'dsh-evolve-le/validator-supervisor-result/v1'
  specDigest: string
  configuration: ObjectRef
  outcome: ExecutionOutcome
  execution: ObjectRef | null
  validation: ObjectRef | null
  failure: ObjectRef | null
}
export function validateValidatorSupervisorConfig(value: unknown): ValidatorSupervisorConfig {
  assertExact(value, [
    'protocol',
    'spec',
    'inputManifest',
    'hostRoot',
    'executionRoot',
    'cgroupRoot',
    'resourceRoot',
    'storeRoot',
    'security',
    'pools',
    'validator',
  ])
  if (value.protocol !== 'dsh-evolve-le/validator-supervisor/v2')
    throw new ExecutionError('invalid validator supervisor protocol')
  const spec = validateExecutionSpec(value.spec)
  validateRef(value.inputManifest)
  const inputManifest = value.inputManifest
  if (!spec.inputs.some((r) => canonicalJson(r) === canonicalJson(inputManifest)))
    throw new ExecutionError('input manifest missing from frozen spec')
  if (
    spec.kind === 'proposal' ||
    !spec.parentExecutionId ||
    canonicalJson(spec.command) !==
      canonicalJson([
        '/input/capsule/runtime/node',
        '/input/capsule/runner/bin/validator-worker.js',
        '/input/config.json',
      ])
  )
    throw new ExecutionError('validator supervisor requires fixed worker and parent execution')
  validateSupervisorHostConfig(value)
  assertExact(value.validator, ['sourceSnapshot', 'dependencyClosureSha256', 'runnerSourceDir'])
  validateRef(value.validator.sourceSnapshot)
  const sourceSnapshot = value.validator.sourceSnapshot
  if (!spec.inputs.some((r) => canonicalJson(r) === canonicalJson(sourceSnapshot)))
    throw new ExecutionError('validator source snapshot missing from frozen spec')
  if (
    typeof value.validator.dependencyClosureSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.validator.dependencyClosureSha256)
  )
    throw new ExecutionError('invalid supervisor dependency identity')
  assertSupervisorPath(value.validator.runnerSourceDir)
  return value as unknown as ValidatorSupervisorConfig
}
export async function runValidatorSupervisor(
  raw: unknown,
  options: { engine?: DockerEngine; signal?: AbortSignal } = {},
): Promise<ValidatorSupervisorResult> {
  const config = validateValidatorSupervisorConfig(raw),
    { spec } = config,
    root = join(config.hostRoot, executionName(spec)),
    specDigest = canonicalHash(spec)
  for (const path of [config.executionRoot, config.resourceRoot, config.storeRoot, root])
    await prepareSupervisorDirectory(path)
  const terminal = await readValidatorResult(config)
  if (terminal) return terminal
  // Caller/launcher must hold flock --no-fork throughout this owner process.
  const owner = await claimOwnerGeneration(root, specDigest)
  await publishCanonical(join(root, 'supervisor-config.json'), config)
  const store = await openObjectStore(config.storeRoot),
    engine = options.engine ?? localDockerEngine(),
    configuration = await store.put(Buffer.from(canonicalJson(config)), {
      mediaType: 'application/vnd.dsh-evolve-le.validator-supervisor+json',
      label: 'CONTROLLER_INTERNAL',
    }),
    receiver = await WorkerStreamReceiver.open({
      root: join(root, 'stream'),
      store,
      executionId: spec.executionId,
      maxBytes: spec.limits.outputBytes,
      maxFrameBytes: spec.limits.outputBytes,
    })
  let observation: Promise<void> | undefined
  let observationError: unknown
  const host = new LinuxExecutionHost({
    root: config.hostRoot,
    cgroupRoot: config.cgroupRoot,
    store,
    engine,
    security: config.security,
    validator: config.validator,
    inputManifest: config.inputManifest,
    actions: {
      async quiesce() {},
      async resume() {},
      async revoke() {},
      async cancelChildren() {},
      async close() {},
      async artifacts() {
        return [configuration, ...(await receiver.artifacts())]
      },
    },
  })
  const executor = new DockerExecutor({
    root: config.executionRoot,
    store,
    engine,
    host,
    security: config.security,
    admission: new PersistentResourceAdmission({ root: config.resourceRoot, pools: config.pools }),
  })
  let execution: ObjectRef | null = null,
    validation: ObjectRef | null = null,
    failure: ObjectRef | null = null,
    outcome: ExecutionOutcome = 'INCOMPLETE'
  const cancelled = () => {
    void requestExecutionCancellation(root, spec, 'validator supervisor cancelled')
      .then(() => executor.cancel(spec.executionId, 'validator supervisor cancelled'))
      .catch(() =>
        executor
          .fail(spec.executionId, 'validator cancellation persistence failed')
          .catch(() => undefined),
      )
  }
  try {
    await executor.prepare(spec)
    options.signal?.addEventListener('abort', cancelled, { once: true })
    let status = parseCanonicalJson(
      (await store.read(await executor.reconcile(spec.executionId))).toString('utf8'),
    ) as { phase: string }
    const requestedCancellation = await readExecutionCancellation(root, spec)
    if (options.signal?.aborted || requestedCancellation)
      await executor.cancel(
        spec.executionId,
        requestedCancellation ?? 'validator supervisor cancelled',
      )
    else if (status.phase === 'CREATED') await executor.start(spec.executionId)
    if (['CREATED', 'RUNNING', 'STOPPED'].includes(status.phase)) {
      if (!engine.stream) throw new ExecutionError('validator log observer unavailable')
      observation = engine
        .stream(
          'GET',
          `/containers/${executionName(spec)}/logs?stdout=true&stderr=true&follow=true`,
          {
            timeoutMs: Math.max(1000, Date.parse(spec.deadlineUtc) - Date.now() + 10000),
            maxBytes: spec.limits.outputBytes * 10,
            onChunk: (chunk) => receiver.write(chunk),
          },
        )
        .then(() => receiver.end())
        .catch(async (error) => {
          observationError = error
          try {
            await executor.fail(
              spec.executionId,
              error instanceof Error ? error.message : 'validator observation failed',
            )
          } catch (stopError) {
            observationError = stopError
          }
        })
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
    execution = await executor.collect(spec.executionId)
    const bundle = await verifyExecutionBundle(store, execution)
    outcome = bundle.outcome
    if (outcome === 'SUCCEEDED') {
      const marker = await readCanonicalFile(join(root, 'validator-export.json'))
      validateRef(marker)
      if (!bundle.artifacts.some((ref) => canonicalJson(ref) === canonicalJson(marker)))
        throw new ExecutionError('validator receipt absent from execution bundle')
      validation = marker
    }
    await executor.cleanup(spec.executionId)
  } catch (error) {
    failure = await store.put(
      Buffer.from(
        canonicalJson({
          source: 'executor-observed',
          specDigest,
          reason: (error instanceof Error ? error.message : 'validator supervisor failed').slice(
            0,
            2048,
          ),
        }),
      ),
      {
        mediaType: 'application/vnd.dsh-evolve-le.supervisor-failure+json',
        label: 'CONTROLLER_INTERNAL',
      },
    )
    await executor.fail(spec.executionId, 'validator supervisor failed').catch(() => undefined)
    try {
      execution = await executor.collect(spec.executionId)
      const bundle = await verifyExecutionBundle(store, execution)
      outcome = bundle.outcome === 'SUCCEEDED' ? 'INCOMPLETE' : bundle.outcome
      validation = null
      await executor.cleanup(spec.executionId)
    } catch {
      outcome = 'INCOMPLETE'
    }
  } finally {
    options.signal?.removeEventListener('abort', cancelled)
  }
  const result: ValidatorSupervisorResult = {
    protocol: 'dsh-evolve-le/validator-supervisor-result/v1',
    specDigest,
    configuration,
    outcome,
    execution,
    validation,
    failure,
  }
  await publishCanonical(join(root, 'validator-supervisor-result.json'), result)
  return result
}
