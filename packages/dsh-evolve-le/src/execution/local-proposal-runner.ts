/** Source-generation backend for the existing proposal saga. No candidate code runs in this process. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProposalRunner } from '../controller/controller.js'
import type { RunProposalSandboxOptions } from '../proposer/sandbox.js'
import type { ModelRouteConfig } from '../config/run-config.js'
import { buildPriorRejectionsDoc } from '../proposer/feedback.js'
import { remoteRoutePlanHash } from '../proposer/remote-gateway.js'
import { remoteRoutePlanOf } from '../proposer/remote-runner.js'
import { canonicalHash, canonicalJson } from '../state/canonical.js'
import { openObjectStore, type ObjectRef } from '../state/object-store.js'
import { captureBoundedTree, captureSourceSnapshot } from './snapshot.js'
import { composeProposalInputs } from './proposal-input.js'
import { readFrozenGeneration } from './proposal-generation-process.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { SECCOMP_PROFILE } from './security.js'
import {
  EXECUTION_PROTOCOL,
  DOCKER_SANDBOX_PROTOCOL,
  DOCKER_NATIVE_PROTOCOL,
  DOCKER_CAPABILITIES_PROTOCOL,
  DOCKER_TOOLS_PROTOCOL,
  executionName,
  type ExecutionSpec,
  ExecutionError,
} from './types.js'
import type { ProposalGenerationConfig } from './proposal-generation-config.js'
const exec = promisify(execFile)
export interface LocalProposalProfile {
  backend: 'docker-local/v1'
  hostRoot: string
  image: ExecutionSpec['image']
}
export interface LocalGenerationOutcome {
  backend: 'local-generation/v1'
  configuration: ProposalGenerationConfig
  result: ObjectRef
}
export function localDockerProposalRunner(options: {
  runId: string
  storeRoot: string
  profile: LocalProposalProfile
  route: ModelRouteConfig
  dependencyClosureSha256: string
}): ProposalRunner {
  options = structuredClone(options)
  if (options.route.provider !== 'zen-compatible' || !options.route.credentialFile)
    throw new ExecutionError(
      'Docker proposal backend requires an explicit live route/credential file',
    )
  if (options.route.retry?.maxAttempts !== 1 || options.route.retry.backoffMs.length)
    throw new ExecutionError('Docker proposal route must freeze maxAttempts=1')
  const runner: ProposalRunner = async (input) => {
    const config = await prepareLocalProposal(options, input)
    const configPath = join(input.sandboxRoot, 'generation-config.json')
    await publishCanonical(configPath, config)
    const entry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../lib/bin/docker-proposal-generation.js',
    )
    try {
      await exec(
        process.execPath,
        [entry, 'run', configPath, '--credential-file', options.route.credentialFile!],
        {
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
          timeout: config.spec.maxElapsedMs + 120000,
          maxBuffer: 1024 * 1024,
        },
      )
    } catch {
      /* Read the trusted CAS outcome, never worker stdout. Lost owner is not restarted. */
    }
    const result = await readFrozenGeneration(config)
    const handoff: LocalGenerationOutcome = {
      backend: 'local-generation/v1',
      configuration: config,
      result: result.ref,
    }
    await publishCanonical(join(input.sandboxRoot, 'generation-handoff.json'), handoff)
    return handoff
  }
  runner.backend = 'local-generation/v1'
  runner.profile = {
    runId: options.runId,
    storeRoot: options.storeRoot,
    profile: options.profile,
    routeHash: remoteRoutePlanHash(remoteRoutePlanOf(options.route)),
    provider: options.route.provider,
    contextWindowTokens: options.route.contextWindowTokens,
    dependencyClosureSha256: options.dependencyClosureSha256,
  }
  return runner
}
export async function readLocalGenerationHandoff(
  sandboxRoot: string,
): Promise<LocalGenerationOutcome> {
  try {
    return (await readCanonicalFile(
      join(sandboxRoot, 'generation-handoff.json'),
    )) as LocalGenerationOutcome
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const configuration = (await readCanonicalFile(
      join(sandboxRoot, 'generation-config.json'),
    )) as ProposalGenerationConfig
    const result = await readFrozenGeneration(configuration)
    return { backend: 'local-generation/v1', configuration, result: result.ref }
  }
}
async function prepareLocalProposal(
  options: {
    runId: string
    storeRoot: string
    profile: LocalProposalProfile
    route: ModelRouteConfig
    dependencyClosureSha256: string
  },
  input: RunProposalSandboxOptions,
): Promise<ProposalGenerationConfig> {
  if (
    !input.generationBudget ||
    input.generationBudget.maxTotalTokens < 1 ||
    input.generationBudget.maxCostUsdMicros < 1
  )
    throw new ExecutionError('Docker proposal requires action budget reservation')
  const store = await openObjectStore(options.storeRoot)
  const put = (value: unknown) =>
    store.put(Buffer.from(canonicalJson(value)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
  const security = {
    profile: 'local-generation/v1' as const,
    seccompJson: JSON.stringify(SECCOMP_PROFILE),
    apparmorProfile: 'none',
    cgroupParent: '/unused',
  }
  const policy = await put(security),
    plan = remoteRoutePlanOf(options.route),
    route = await store.put(Buffer.from(JSON.stringify(plan)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
  const executionId = `generation-${canonicalHash([options.runId, input.sandboxRoot]).slice(0, 32)}`
  const hostRoot = options.profile.hostRoot
  const limits: ExecutionSpec['limits'] = {
    cpuMillis: 2000,
    cpuTimeMs: 0,
    memoryBytes: 1024 * 1024 * 1024,
    pids: 128,
    nofile: 1024,
    fileBytes: 1024 * 1024,
    workspace: { bytes: 32 * 1024 * 1024, inodes: 8192 },
    work: { bytes: 64 * 1024 * 1024, inodes: 8192 },
    tmp: { bytes: 32 * 1024 * 1024, inodes: 8192 },
    shm: { bytes: 1024 * 1024, inodes: 128 },
    outputBytes: 32 * 1024 * 1024,
    shellTimeoutMs: 30000,
    shellCalls: 64,
  }
  // cpuTimeMs is retained for wire compatibility; local enforcement is CPU rate + wall clock.
  limits.cpuTimeMs = Math.max(1, input.timeoutMs ?? 1800000)
  const spec: ExecutionSpec = {
    protocol: EXECUTION_PROTOCOL,
    kind: 'proposal',
    runId: options.runId,
    actionId: input.sandboxRoot.split('/').at(-1)!,
    attemptId: '1',
    executionId,
    image: options.profile.image,
    policy,
    reservation: await put(input.generationBudget),
    inputs: [policy, route],
    command: [
      '/input/capsule/runtime/node',
      '/input/capsule/runner/bin/docker-proposer-worker.js',
      '/input/config.json',
    ],
    gateway: { route, authorization: policy },
    mounts: [],
    limits,
    maxElapsedMs: input.timeoutMs ?? 1800000,
    deadlineUtc: new Date(Date.now() + (input.timeoutMs ?? 1800000) + 120000).toISOString(),
  }
  for (const target of ['/input', '/workspace', '/work', '/gateway'] as const)
    spec.mounts.push({
      target,
      source: join(hostRoot, executionName(spec), target === '/gateway' ? 'ipc' : target.slice(1)),
      readOnly: target === '/input' || target === '/gateway',
    })
  const parentSnapshot = await captureSourceSnapshot({
    root: input.parentTreeDir,
    store,
    spec: { ...spec, executionId: `parent-${executionId}` },
    child: 'parent',
  })
  const capture = async (root: string, bytes: number, fileBytes: number) =>
    put(await captureBoundedTree({ root, store, limits: { bytes, fileBytes, inodes: 65536 } }))
  const parentCapsuleInventory = await capture(
    input.capsuleDir,
    512 * 1024 * 1024,
    160 * 1024 * 1024,
  )
  const coreLib = resolve(dirname(fileURLToPath(import.meta.url)), '../../lib')
  const workerInventory = await capture(coreLib, 32 * 1024 * 1024, 4 * 1024 * 1024)
  const manifest = JSON.parse(await readFile(join(input.capsuleDir, 'manifest.json'), 'utf8'))
  const pkg = JSON.parse(await readFile(join(input.capsuleDir, 'candidate/package.json'), 'utf8'))
  const frozen = await composeProposalInputs({
    store,
    parentSnapshot,
    parentCapsuleInventory,
    workerInventory,
    dependencyClosureSha256: options.dependencyClosureSha256,
    catalog: await put(input.catalog),
    evidenceInventory: await capture(input.exportDir, 256 * 1024 * 1024, 32 * 1024 * 1024),
    ...(input.priorRejections?.length
      ? { priorRejections: await put(buildPriorRejectionsDoc(input.priorRejections)) }
      : {}),
    config: {
      protocol: DOCKER_SANDBOX_PROTOCOL,
      nativeProtocol: DOCKER_NATIVE_PROTOCOL,
      capabilityProtocol: DOCKER_CAPABILITIES_PROTOCOL,
      toolsProtocol: DOCKER_TOOLS_PROTOCOL,
      generationOnly: true,
      ...(input.authoringInstruction ? { authoringInstruction: input.authoringInstruction } : {}),
      executionId,
      candidateId: manifest.identity.candidateId,
      candidatePackage: pkg.name,
      parentSourceHash: input.parentSourceHash,
      width: input.width,
      provider: options.route.provider,
      model: plan.model,
      maxTokens: plan.maxOutputTokens,
      contextWindowTokens: options.route.contextWindowTokens,
      maxTurns: input.maxTurns ?? 128,
      shellTimeoutMs: limits.shellTimeoutMs,
      outputBytes: limits.outputBytes,
      clientTimeoutMs: 600000,
      ...(input.treeV2Parent ? { treeV2Parent: input.treeV2Parent } : {}),
    },
  })
  spec.inputs = frozen.inputs
  const capacity = {
    slots: 1,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    cpuMillis: 4000,
    pids: 512,
    bytes: 512 * 1024 * 1024,
    inodes: 65536,
  }
  await mkdir(input.sandboxRoot, { recursive: true, mode: 0o700 })
  return {
    protocol: 'dsh-evolve-le/proposal-generation/v1',
    spec,
    inputManifest: frozen.inputManifest,
    storeRoot: options.storeRoot,
    hostRoot,
    executionRoot: join(hostRoot, 'executions'),
    resourceRoot: join(hostRoot, 'resources'),
    cgroupRoot: join(hostRoot, 'unused-cgroups'),
    pools: { proposal: capacity, test: capacity, validator: capacity },
    security,
    model: {
      mode: 'live',
      provider: options.route.provider,
      model: plan.model,
      route,
      limits: {
        maxRequests: 64,
        maxInputTokens: options.route.contextWindowTokens,
        maxOutputTokens: plan.maxOutputTokens,
        maxTotalTokens: input.generationBudget.maxTotalTokens,
        maxCostUsdMicros: input.generationBudget.maxCostUsdMicros,
        maxRequestBytes: Math.max(1, options.route.contextWindowTokens - 4096),
        inputUsdMicrosPerMillion: options.route.inputUsdMicrosPerMTok,
        outputUsdMicrosPerMillion: options.route.outputUsdMicrosPerMTok,
      },
    },
  }
}
