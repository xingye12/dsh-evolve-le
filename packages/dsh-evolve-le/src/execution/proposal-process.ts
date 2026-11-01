import { readExecutionCancellation } from './cancellation.js'
/** Fixed standalone proposal composition; no candidate imports in this owner process. */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { openObjectStore, validateRef, type ObjectRef } from '../state/object-store.js'
import {
  validateProposalSupervisorConfig,
  type ProposalSupervisorConfig,
} from './proposal-config.js'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { executionName, assertExact, ExecutionError } from './types.js'
import { readKernelLockOwner } from './owner.js'
import { readProposalInputBinding } from './proposal-input.js'
import { readProposalSupervisorResult, type ProposalSupervisorOutcome } from './proposal-result.js'
import { frozenReplayDispatch } from './replay-transport.js'
import { runProposalSupervisor } from './supervisor.js'
import { localDockerEngine } from './docker-engine.js'
export async function proposalProcessContext(raw: unknown) {
  const config = validateProposalSupervisorConfig(raw),
    root = join(config.hostRoot, executionName(config.spec))
  await prepareSupervisorDirectory(config.storeRoot)
  const store = await openObjectStore(config.storeRoot)
  const binding = await readProposalInputBinding(store, config.inputManifest, config.spec)
  return {
    config,
    root,
    store,
    expected: {
      store,
      spec: config.spec,
      parentSourceHash: binding.config.parentSourceHash,
      children: binding.children,
    },
  }
}
export async function readProposalProcessState(raw: unknown): Promise<{
  status: 'COMPLETE' | 'RUNNING' | 'INCOMPLETE' | 'NOT_STARTED'
  pid: number | null
  result: ProposalSupervisorOutcome | null
  failures: ObjectRef[]
}> {
  const { config, root, store, expected } = await proposalProcessContext(raw)
  const result = await readProposalSupervisorResult({ ...expected, root })
  let names: string[] = []
  try {
    names = await readdir(join(root, 'failures'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const failures: ObjectRef[] = []
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw new ExecutionError('invalid proposal failure slot')
    const ref = await readCanonicalFile(join(root, 'failures', name))
    validateRef(ref)
    if (`${ref.digest}.json` !== name) throw new ExecutionError('proposal failure slot mismatch')
    const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
    assertExact(value, ['protocol', 'specDigest', 'configuration', 'reason'])
    validateRef(value.configuration)
    if (
      value.protocol !== 'dsh-evolve-le/proposal-supervisor-failure/v1' ||
      value.specDigest !== canonicalHash(config.spec) ||
      typeof value.reason !== 'string' ||
      canonicalJson(
        parseCanonicalJson((await store.read(value.configuration)).toString('utf8')),
      ) !== canonicalJson(config)
    )
      throw new ExecutionError('proposal failure configuration mismatch')
    failures.push(ref)
  }
  let attemptSeen = false
  try {
    const ref = await readCanonicalFile(
      join(config.executionRoot, config.spec.executionId, 'spec.json'),
    )
    validateRef(ref)
    if (
      canonicalJson(parseCanonicalJson((await store.read(ref)).toString('utf8'))) !==
      canonicalJson(config.spec)
    )
      throw new ExecutionError('proposal execution history spec mismatch')
    attemptSeen = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let owners: string[] = []
  try {
    owners = (await readdir(join(root, 'owners')))
      .filter((name) => !name.startsWith('.staging-'))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (let index = 0; index < owners.length; index++) {
    if (owners[index] !== `${String(index + 1).padStart(8, '0')}.json`)
      throw new ExecutionError('proposal owner history corrupt')
    const owner = (await readCanonicalFile(join(root, 'owners', owners[index]!))) as {
      specDigest?: unknown
    }
    if (owner.specDigest !== canonicalHash(config.spec))
      throw new ExecutionError('proposal owner history spec mismatch')
    attemptSeen = true
  }
  const pid = await readKernelLockOwner(root)
  return {
    status: result
      ? 'COMPLETE'
      : pid
        ? 'RUNNING'
        : failures.length || attemptSeen
          ? 'INCOMPLETE'
          : 'NOT_STARTED',
    pid,
    result,
    failures,
  }
}
export async function runFrozenProposalSupervisor(
  raw: unknown,
  signal?: AbortSignal,
): Promise<ProposalSupervisorOutcome> {
  const config: ProposalSupervisorConfig = validateProposalSupervisorConfig(raw),
    root = join(config.hostRoot, executionName(config.spec))
  for (const path of [config.executionRoot, config.resourceRoot, config.storeRoot, root])
    await prepareSupervisorDirectory(path)
  await publishCanonical(join(root, 'supervisor-config.json'), config)
  const store = await openObjectStore(config.storeRoot)
  const configuration = await store.put(Buffer.from(canonicalJson(config)), {
    mediaType: 'application/vnd.dsh-evolve-le.proposal-supervisor+json',
    label: 'CONTROLLER_INTERNAL',
  })
  try {
    const { expected } = await proposalProcessContext(config)
    const result = await readProposalSupervisorResult({ ...expected, root })
    if (result) return result
    const revoked = await readExecutionCancellation(root, config.spec)
    const dispatch = revoked
      ? async () => {
          throw new ExecutionError('revoked proposal cannot dispatch models')
        }
      : await frozenReplayDispatch({
          store,
          root: join(root, 'models'),
          executionId: config.spec.executionId,
          route: config.model.route,
          model: config.model,
        })
    return await runProposalSupervisor({
      ...config,
      store,
      engine: localDockerEngine(),
      model: { ...config.model, dispatch },
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    const failure = await store.put(
      Buffer.from(
        canonicalJson({
          protocol: 'dsh-evolve-le/proposal-supervisor-failure/v1',
          specDigest: canonicalHash(config.spec),
          configuration,
          reason: (
            (error instanceof Error ? error.message : '') || 'proposal supervisor failed'
          ).slice(0, 2048),
        }),
      ),
      {
        mediaType: 'application/vnd.dsh-evolve-le.proposal-supervisor-failure+json',
        label: 'CONTROLLER_INTERNAL',
      },
    )
    await prepareSupervisorDirectory(join(root, 'failures'))
    await publishCanonical(join(root, 'failures', `${failure.digest}.json`), failure)
    throw error
  }
}
