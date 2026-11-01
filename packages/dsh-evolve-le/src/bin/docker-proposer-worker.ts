/** Native one-shot proposal target. External supervisor owns authority and cleanup. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from '../cordis/boot.js'
import { snapshotCordisInventory } from '../cordis/inventory.js'
import { runNativeProposal } from '../dsh/native-proposal-runner.js'
import { installNativeLlmAdapter } from '../dsh/native-llm-adapter.js'
import { assertNativeDshClosure } from '../dsh/native-composition.js'
import {
  buildNativeProposalInstruction,
  TCB_PROPOSAL_SECTION,
  TCB_PROTOCOL_SECTION,
} from '../proposer/prompt-text.js'
import { dockerProposalComposition } from '../execution/composition.js'
import { dockerProposalClient } from '../execution/worker-client.js'
import { ExecutionError, DOCKER_SANDBOX_PROTOCOL } from '../execution/types.js'
import { validateProposalWorkerConfig } from '../execution/proposal-worker-config.js'
async function main(): Promise<void> {
  if (process.getuid?.() === 0) throw new ExecutionError('Docker worker must not run as root')
  if (process.argv[2] !== '/input/config.json')
    throw new ExecutionError('Docker worker requires frozen config path')
  const raw: unknown = JSON.parse(await readFile('/input/config.json', 'utf8'))
  const config = validateProposalWorkerConfig(raw)
  const manifest = JSON.parse(
    await readFile('/input/capsule/runtime/install-manifest.json', 'utf8'),
  ) as { packages?: unknown; entries?: Array<{ name: string; version: string }> }
  const packages = manifest.entries ?? manifest.packages
  if (!Array.isArray(packages)) throw new ExecutionError('capsule dependency inventory unavailable')
  assertNativeDshClosure(packages)
  for (const name of [
    '@deepseek-ai/dsh-shell',
    '@deepseek-ai/dsh-shell-env',
    '@deepseek-ai/dsh-tool-bash',
  ])
    if (!packages.some((p) => p.name === name && p.version === '0.1.0-rc.5'))
      throw new ExecutionError(`missing pinned shell dependency ${name}`)
  await mkdir('/work/home', { recursive: true })
  await mkdir('/work/runtime-config', { recursive: true })
  await mkdir('/work/sessions', { recursive: true })
  const composition = dockerProposalComposition({ ...config, socketPath: '/gateway/action.sock' })
  await writeFile('/work/runtime-config/cordis.yml', composition, { flag: 'wx' })
  const client = dockerProposalClient({
    socketPath: '/gateway/action.sock',
    executionId: config.executionId,
    timeoutMs: config.clientTimeoutMs,
    maxFrameBytes: config.outputBytes * 2 + 8192,
    ...(config.generationOnly ? { generationOnly: true as const } : {}),
  })
  const ctx = new Context(),
    before = snapshotCordisInventory(ctx),
    abort = new AbortController()
  const cancel = () => abort.abort()
  process.once('SIGTERM', cancel)
  let stream: Promise<void> = Promise.resolve(),
    streamError: unknown,
    seq = 0,
    output = 0
  const emit = (session: { id?: unknown }, event: unknown) => {
    const frame = Buffer.from(
      JSON.stringify({
        protocol: 'dsh-evolve-le/worker-event/v1',
        executionId: config.executionId,
        sequence: ++seq,
        sessionId: session.id ?? null,
        event,
      }) + '\n',
    )
    output += frame.length
    if (output > config.outputBytes) {
      streamError ??= new ExecutionError('worker event output limit')
      abort.abort()
      return
    }
    stream = stream
      .then(async () => {
        if (!process.stdout.write(frame)) await once(process.stdout, 'drain')
      })
      .catch((error) => {
        streamError ??= error
        abort.abort()
      })
  }
  const disposeEvents = ctx.on('session/event' as never, emit as never)
  let boot: Awaited<ReturnType<typeof bootLoader>> | undefined,
    disposeModel: (() => void) | undefined
  try {
    boot = await bootLoader('/work/runtime-config/cordis.yml', {
      context: ctx,
      bareModuleBaseUrl: pathToFileURL('/input/capsule/node_modules/').href,
    })
    disposeModel = installNativeLlmAdapter(ctx, {
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      contextWindowTokens: config.contextWindowTokens,
      complete: client.complete,
    })
    const result = await runNativeProposal({
      ctx,
      backend: client.backend,
      stopOnSubmission: true,
      workspaceMutationCount: client.mutationCount,
      sessionId: `${config.executionId}-main`,
      cwd: '/workspace',
      prompt:
        buildNativeProposalInstruction({
          parentSourceHash: config.parentSourceHash,
          width: config.width,
          ...(config.generationOnly ? { generationOnly: true as const } : {}),
          ...(config.treeV2Parent ? { treeV2Parent: config.treeV2Parent } : {}),
        }) +
        `\nAllocated child packages: ${Array.from({ length: config.width }, (_, i) => `child-${i + 1}`).join(', ')}. Foreground bash and proposal file tools share these trees under /workspace. Use only those candidate packages. Read export/manifest.json, archive-catalog.json and parent-files.json under the input root for frozen evidence and parent context. External immutable snapshots own source identity. Testing and admission happen after this container is cleaned up.`,
      ...(config.authoringInstruction
        ? {
            prompt:
              buildNativeProposalInstruction({
                parentSourceHash: config.parentSourceHash,
                width: config.width,
                generationOnly: true,
                ...(config.treeV2Parent ? { treeV2Parent: config.treeV2Parent } : {}),
              }) +
              `\nAllocated child packages: ${Array.from({ length: config.width }, (_, i) => `child-${i + 1}`).join(', ')} under /workspace. Read frozen input under /input. Trusted authoring objective: ${config.authoringInstruction}`,
          }
        : {}),
      proposalPath: '/work/proposal.json',
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
      maxTurns: config.maxTurns,
      signal: abort.signal,
      tcbPromptSections: config.generationOnly
        ? [
            TCB_PROPOSAL_SECTION,
            {
              name: 'tcb:generation-protocol',
              order: 1,
              text: 'Use native tool calls. Produce candidate source and call proposal_finish. Candidate tests are unavailable here. Semantic receipt fields are normalized by the external trusted pipeline after generation; do not invent evidence digests. Generation does not authorize admission.',
            },
          ]
        : [TCB_PROPOSAL_SECTION, TCB_PROTOCOL_SECTION],
    })
    await stream
    if (streamError) throw streamError
    // Diagnostic only. The supervisor verifies its own submitted snapshot receipt.
    await writeFile(
      '/work/worker-result.json',
      JSON.stringify({
        protocol: DOCKER_SANDBOX_PROTOCOL,
        executionId: config.executionId,
        ok: true,
        proposal: result.proposal,
      }) + '\n',
    )
  } finally {
    process.removeListener('SIGTERM', cancel)
    disposeModel?.()
    disposeEvents()
    await boot?.loaderFiber.dispose()
    await stream
  }
  if (JSON.stringify(before) !== JSON.stringify(snapshotCordisInventory(ctx)))
    throw new ExecutionError('Docker worker Loader inventory not quiescent')
}
main().catch(async (error) => {
  const message = error instanceof Error ? error.message : 'worker failed'
  await writeFile(
    '/work/worker-failure.json',
    JSON.stringify({ protocol: DOCKER_SANDBOX_PROTOCOL, ok: false, error: message }) + '\n',
  ).catch(() => undefined)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
