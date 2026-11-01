/** Trusted external consumer: verifies generation, normalizes private snapshots, then hands source to the old validator. */
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObjectStore, ObjectRef } from '../state/object-store.js'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import type { ProposalRequest } from '../controller/controller.js'
import type { ArchiveCatalog } from '../proposer/catalog.js'
import { captureCanonicalSource } from '../candidate/canonical.js'
import { readExportManifest } from '../proposer/validate.js'
import { readProposalInputBinding } from './proposal-input.js'
import { readGenerationResult } from './proposal-generation-result.js'
import { validateGenerationConfig } from './proposal-generation-config.js'
import { verifySubmission } from './submission.js'
import { verifyExecutionBundle } from './evidence.js'
import { ProposalSnapshotFinalizer } from './proposal-finalizer.js'
import { materializeSourceSnapshot } from './snapshot.js'
import type { LocalGenerationOutcome } from './local-proposal-runner.js'
import { ExecutionError } from './types.js'
export async function collectGenerationSource(options: {
  onUsage?: (usage: import('../proposer/gateway.js').GatewayUsage) => void
  recordFailureArtifacts?: (artifacts: ObjectRef[]) => Promise<void>
  handoff: LocalGenerationOutcome
  store: ObjectStore
  runId: string
  actionId: string
  request: ProposalRequest
  catalog: ArchiveCatalog
  exportDir: string
  parentTreeDir: string
  sandboxRoot: string
}) {
  const { store, handoff, request } = options
  const config = validateGenerationConfig(handoff.configuration)
  if (
    handoff.backend !== 'local-generation/v1' ||
    config.security.profile !== 'local-generation/v1' ||
    config.storeRoot !== store.root ||
    config.spec.runId !== options.runId ||
    config.spec.actionId !== options.actionId
  )
    throw new ExecutionError('generation handoff namespace mismatch')
  const binding = await readProposalInputBinding(store, config.inputManifest, config.spec)
  const parent = await captureCanonicalSource(options.parentTreeDir)
  const exported = await readExportManifest(options.exportDir)
  if (
    binding.config.authoringInstruction !== request.authoringInstruction ||
    binding.config.parentSourceHash !== request.parentSourceHash ||
    `sha256:${parent.sha256}` !== request.parentSourceHash ||
    binding.config.candidateId !== request.parentCandidateId ||
    binding.config.width !== request.width ||
    binding.exportManifest.exportId !== request.exportId ||
    canonicalJson(binding.exportManifest) !== canonicalJson(exported) ||
    canonicalJson(binding.catalog) !== canonicalJson(options.catalog) ||
    canonicalJson(binding.config.treeV2Parent ?? null) !==
      canonicalJson(request.treeV2Parent ?? null)
  )
    throw new ExecutionError('generation handoff differs from durable proposal inputs')
  const expected = {
    store,
    spec: config.spec,
    children: binding.children,
    parentSourceHash: request.parentSourceHash,
  }
  const result = await readGenerationResult(handoff.result, expected)
  const bundle = await verifyExecutionBundle(store, result.execution!)
  const accounts = bundle.artifacts.filter(
    (ref) => ref.mediaType === 'application/vnd.dsh-evolve-le.generation-accounting+json',
  )
  if (accounts.length !== 1)
    throw new ExecutionError('generation accounting artifact missing or ambiguous')
  const accounting = parseCanonicalJson(
    (await store.read(accounts[0]!)).toString('utf8'),
  ) as Record<string, unknown>
  if (
    accounting.protocol !== 'dsh-evolve-le/generation-accounting/v1' ||
    accounting.specDigest !== canonicalHash(config.spec) ||
    accounting.ambiguous !== 0 ||
    accounting.reservedTokens !== 0 ||
    accounting.reservedUsdMicros !== 0
  )
    throw new ExecutionError('generation accounting incomplete')
  for (const key of [
    'requests',
    'promptTokens',
    'completionTokens',
    'settledTokens',
    'settledUsdMicros',
  ])
    if (!Number.isSafeInteger(accounting[key]) || Number(accounting[key]) < 0)
      throw new ExecutionError('invalid generation accounting')
  if (
    accounting.settledTokens !==
      Number(accounting.promptTokens) + Number(accounting.completionTokens) ||
    Number(accounting.settledTokens) > config.model.limits.maxTotalTokens ||
    Number(accounting.settledUsdMicros) > config.model.limits.maxCostUsdMicros
  )
    throw new ExecutionError('generation budget mismatch')
  const usage = {
    requests: Number(accounting.requests),
    promptTokens: Number(accounting.promptTokens),
    completionTokens: Number(accounting.completionTokens),
    totalTokens: Number(accounting.settledTokens),
    costUsdMicros: Number(accounting.settledUsdMicros),
  }
  options.onUsage?.(usage)
  if (result.outcome !== 'SUCCEEDED')
    throw new ExecutionError('failed/unclean generation cannot enter validation')
  const submitted = await verifySubmission({
    ...expected,
    ref: result.submission!,
    generationOnly: true,
  })
  const finalizer = new ProposalSnapshotFinalizer({
    root: join(options.sandboxRoot, 'finalizations'),
    store,
    spec: config.spec,
    inputManifest: config.inputManifest,
    children: binding.children,
    context: {
      parentSourceHash: request.parentSourceHash,
      ...(request.treeV2Parent ? { treeV2Parent: request.treeV2Parent } : {}),
      catalog: binding.catalog,
      exportManifest: binding.exportManifest,
      parentSourceFiles: Object.fromEntries(
        parent.files.map((file) => [file.path, file.content.toString('utf8')]),
      ),
    },
  })
  const finalized = await finalizer
    .finalize(submitted.proposal, submitted.sources)
    .catch(async (error) => {
      await options.recordFailureArtifacts?.(await finalizer.artifacts())
      throw error
    })
  await mkdir(join(options.sandboxRoot, 'materialized'), { recursive: true, mode: 0o700 })
  const childrenRoot = await mkdtemp(join(options.sandboxRoot, 'materialized/children-'))
  for (const source of finalized.sources)
    await materializeSourceSnapshot(store, source.source, join(childrenRoot, source.child))
  return {
    proposal: finalized.proposal,
    childrenRoot,
    usage,
    capsuleDigest: config.spec.inputs[2]!.digest,
    artifacts: [
      result.execution!,
      result.completion!,
      result.submission!,
      ...(await finalizer.artifacts()),
    ] as ObjectRef[],
  }
}
