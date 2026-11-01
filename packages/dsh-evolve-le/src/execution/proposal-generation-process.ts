import { openGenerationLiveDispatch } from './generation-live-dispatch.js'
/** Fixed one-shot owner entry. No worker recovery and no live dispatch before replay acceptance. */
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import { canonicalHash, canonicalJson } from '../state/canonical.js'
import { openObjectStore, validateRef } from '../state/object-store.js'
import { validateGenerationConfig } from './proposal-generation-config.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical, readCanonicalFile, openExecutionEvidence } from './evidence.js'
import { readProposalInputBinding } from './proposal-input.js'
import { readGenerationResult } from './proposal-generation-result.js'
import { runProposalGeneration } from './proposal-generation.js'
import { frozenReplayDispatch } from './replay-transport.js'
import { localDockerEngine } from './docker-engine.js'
import { LinuxExecutionHost } from './linux-host.js'
import { DockerExecutor } from './docker-executor.js'
import { PersistentResourceAdmission } from './reservation-ledger.js'
import { claimOwnerGeneration } from './owner.js'
import { requestExecutionCancellation } from './cancellation.js'
import { executionName, ExecutionError } from './types.js'

export async function generationOwnerContext(raw: unknown) {
  const config = validateGenerationConfig(raw)
  for (const path of [config.hostRoot, config.executionRoot, config.resourceRoot, config.storeRoot])
    await prepareSupervisorDirectory(path)
  const root = join(config.hostRoot, executionName(config.spec))
  await prepareSupervisorDirectory(root)
  const store = await openObjectStore(config.storeRoot)
  return { config, root, store }
}
export async function generationContext(raw: unknown) {
  const { config, root, store } = await generationOwnerContext(raw)
  const binding = await readProposalInputBinding(store, config.inputManifest, config.spec)
  if (binding.config.generationOnly !== true)
    throw new ExecutionError('generation requires generationOnly input')
  return {
    config,
    root,
    store,
    binding,
    expected: {
      store,
      spec: config.spec,
      children: binding.children,
      parentSourceHash: binding.config.parentSourceHash,
    },
  }
}
export async function runFrozenGeneration(
  raw: unknown,
  signal?: AbortSignal,
  credentialFile?: string,
) {
  const { config, root, store } = await generationOwnerContext(raw)
  await publishCanonical(join(root, 'generation-config.json'), config)
  if (config.model.mode === 'live' && !credentialFile)
    throw new ExecutionError('live generation requires credential file')
  const dispatch =
    config.model.mode === 'live'
      ? await openGenerationLiveDispatch(config, store, credentialFile!)
      : await frozenReplayDispatch({
          store,
          root: join(root, 'models'),
          executionId: config.spec.executionId,
          route: config.model.route,
          model: config.model,
        })
  return runProposalGeneration({
    ...config,
    store,
    engine: localDockerEngine(),
    model: { ...config.model, dispatch },
    ...(signal ? { signal } : {}),
  })
}
export async function readFrozenGeneration(raw: unknown) {
  const { config, root, expected } = await generationContext(raw)
  if (
    canonicalJson(await readCanonicalFile(join(root, 'generation-config.json'))) !==
    canonicalJson(config)
  )
    throw new ExecutionError('generation result configuration drift')
  const ref = await readCanonicalFile(join(root, 'generation-result.json'))
  validateRef(ref)
  return { ref, result: await readGenerationResult(ref, expected) }
}
/** Run only while holding the same kernel flock as the original owner. Never creates a worker. */
export async function sweepFrozenGeneration(raw: unknown) {
  const { config, root, store } = await generationOwnerContext(raw)
  const recorded = await readCanonicalFile(join(root, 'generation-config.json'))
  if (canonicalJson(recorded) !== canonicalJson(config))
    throw new ExecutionError('sweep configuration drift')
  const history = join(config.executionRoot, config.spec.executionId)
  // No effect history means there is nothing this command can safely reclaim.
  await lstat(join(history, 'spec.json'))
  const evidence = await openExecutionEvidence(history, store, config.spec)
  if (!evidence.receipts.length)
    throw new ExecutionError('sweep requires recorded execution effects')
  await claimOwnerGeneration(root, canonicalHash(config.spec))
  await requestExecutionCancellation(root, config.spec, 'generation sweep')
  const engine = localDockerEngine()
  const host = new LinuxExecutionHost({
    generationOnly: true,
    root: config.hostRoot,
    cgroupRoot: config.cgroupRoot,
    store,
    engine,
    security: config.security,
    inputManifest: config.inputManifest,
    actions: {
      async quiesce() {},
      async resume() {},
      async revoke() {},
      async cancelChildren() {},
      async close() {},
      // Preserve raw files and immutable submission through the host exporter. No new model transport.
      async artifacts() {
        return []
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
  await executor.prepare(config.spec, { existingOnly: true })
  await executor.cancel(config.spec.executionId, 'generation sweep')
  const execution = await executor.collect(config.spec.executionId)
  await executor.cleanup(config.spec.executionId)
  const completion = await executor.completion(config.spec.executionId)
  const receipt = await store.put(
    Buffer.from(
      canonicalJson({
        protocol: 'dsh-evolve-le/generation-cleanup/v1',
        specDigest: canonicalHash(config.spec),
        execution,
        completion,
      }),
    ),
    { label: 'CONTROLLER_INTERNAL', mediaType: 'application/json' },
  )
  await publishCanonical(join(root, 'cleanup-receipts', `${receipt.digest}.json`), receipt)
  return receipt
}
