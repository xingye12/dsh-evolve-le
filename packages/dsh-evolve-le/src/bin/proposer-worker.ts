/**
 * Proposer sandbox worker (Gate 4, specs/05 §9–§10, specs/07 §6): boots the
 * parent candidate in propose mode through the capsule's own real Cordis
 * Loader copy — the only Cordis instance in this process — captures its
 * propose-mode prompt contribution, proves the process returned to baseline,
 * probes the DAC boundary the supervisor planted, then drives the recorded
 * policy through the model gateway and tool layer until one proposal bundle
 * is submitted. Everything the worker writes lands under `work/`; the worker
 * refuses to run as root and never touches the network namespace.
 *
 * Staged by the supervisor beside the capsule's runner (same layout as
 * `bin/probe.js`), so bare imports resolve against the capsule's flat pinned
 * `node_modules/`.
 * @module @dsh-evolve-le/core/bin/proposer-worker
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from '../cordis/boot.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'
import { openModelGateway, type GatewayUsage } from '../proposer/gateway.js'
import { openRemoteModel } from '../proposer/remote-model.js'
import { sendCandidateTests } from '../proposer/remote-tests.js'
import { openProposerTools } from '../proposer/tools.js'
import { buildProposalInstruction, createRecordedProposerPolicy } from '../proposer/policy.js'
import { runProposerAgentLoop } from '../proposer/agent-loop.js'
import type { ProposalOutput, TreeV2ProposalParent } from '../proposer/protocol.js'
import { hasNativeDshComposition, type NativePromptSection } from '../dsh/native-composition.js'
import { installNativeLlmAdapter } from '../dsh/native-llm-adapter.js'
import type { NativeLlmAudit } from '../dsh/native-llm-adapter.js'
import { runNativeProposal } from '../dsh/native-proposal-runner.js'

import {
  buildNativeProposalInstruction,
  TCB_PROPOSAL_SECTION,
  TCB_PROTOCOL_SECTION,
} from '../proposer/prompt-text.js'

interface WorkerConfig {
  schemaVersion: 1
  parentSourceHash: string
  width: number
  maxTurns?: number
  treeV2Parent?: TreeV2ProposalParent
  /**
   * AF_UNIX socket of the controller-side TCB proxy (Gate 8 networked route).
   * Present → the model adapter is the socket client; absent → the recorded
   * deterministic policy. Either way this process never touches the network.
   */
  modelSocket?: string
  /** Client socket timeout; the runner derives it from the proxy's budget. */
  modelClientTimeoutMs?: number
  nativeDsh?: { provider: string; model: string; maxTokens?: number }
  /** Declared propose sections from the parent capsule's candidate.json. */
  declaredProposeSections: string[]
  /** Root-only paths (relative to the sandbox parent) the worker must NOT read. */
  dacProbePaths: string[]
}

interface WorkerResult {
  schemaVersion: 1
  ok: boolean
  uid: number
  error?: string
  boot?: {
    capturedSections: { name: string; order: number; text: string }[]
    declaredMatch: boolean
    quiescent: boolean
    /** Per-key drift when quiescence failed: what actually leaked. */
    drift?: Record<string, { before: unknown; after: unknown }>
  }
  dacProbes?: { path: string; outcome: string }[]
  turns?: number
  usage?: GatewayUsage
  proposal?: ProposalOutput
  runtime?: 'recorded-loop' | 'native-dsh'
  native?: { eventCount: number; toolCalls: number; transcriptPath: string }
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const value = (ctx as unknown as Record<string, unknown>)[name]
  if (value !== undefined) return value as T
  const get = (ctx as unknown as { get?: (serviceName: string) => unknown }).get
  return typeof get === 'function' ? (get.call(ctx, name) as T | undefined) : undefined
}

function initializeProtocolStreams(): void {
  // Node creates stdio PipeWraps lazily on first access. The supervisor pipes
  // this worker's stderr, so the first stderr write (or any late lazy touch)
  // would otherwise appear as a PipeWrap leak in the quiescence census — the
  // attempt-5 false positive that failed every proposal with
  // drift.processHandles {before: {}, after: {PipeWrap: 1}}. Establish the
  // fixed handles before the baseline, exactly like candidate-probe and
  // native-turn-probe do.
  void process.stdout
  void process.stderr
}

async function main(argv: string[]): Promise<number> {
  const sandboxRoot = resolve(argv[0] ?? '.')
  const result: WorkerResult = {
    schemaVersion: 1,
    ok: false,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  }
  try {
    if (result.uid === 0) throw new Error('worker must not run as root')
    const config = JSON.parse(
      await readFile(join(sandboxRoot, 'input', 'config.json'), 'utf8'),
    ) as WorkerConfig
    const workRoot = join(sandboxRoot, 'work')
    const capsuleDir = join(sandboxRoot, 'input', 'capsule')

    // The DAC boundary is probed before anything else so even a failed run
    // carries the isolation evidence (specs/05 §9–§10).
    const dacProbes: { path: string; outcome: string }[] = []
    for (const rel of config.dacProbePaths) {
      const outcome = await readFile(join(sandboxRoot, '..', rel), 'utf8')
        .then(() => 'READABLE')
        .catch((error: NodeJS.ErrnoException) => error.code ?? 'ERROR')
      dacProbes.push({ path: rel, outcome })
    }
    result.dacProbes = dacProbes

    // Boot the parent candidate (propose mode) through the real Loader. The
    // baseline is taken over a drained loop: the config read and DAC probes
    // above would otherwise leave a lingering FSReqPromise in the "before"
    // census and the quiescence comparison would fail against a CLEANER end
    // state. Stdio handles are likewise established first so the lazy PipeWrap
    // pair is part of the baseline rather than counted as drift.
    initializeProtocolStreams()
    for (let i = 0; i < 2; i += 1) {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    }
    const ctx = new Context()
    const before = snapshotCordisInventory(ctx)
    const handlesBefore = snapshotProcessHandles()
    const booted = await bootLoader(join(capsuleDir, 'cordis.propose.yml'), {
      context: ctx,
    })
    const service = serviceOf<{
      snapshot?: () => { name: string; order: number; text: string }[]
      assemble?: () => Promise<{ sections: { name: string; text: string }[] }>
    }>(ctx, 'systemPrompt')
    if (service === undefined)
      throw new Error('capsule composition exposes no systemPrompt service')
    const allCaptured =
      typeof service.snapshot === 'function'
        ? service.snapshot().map((section) => ({ ...section }))
        : typeof service.assemble === 'function'
          ? (await service.assemble()).sections.map((section, index) => ({
              name: section.name,
              order: index,
              text: section.text,
            }))
          : []
    // The real DSH spine also contributes harness/persona sections. The
    // candidate admission contract covers only candidate-owned namespaces.
    const captured = allCaptured.filter((section) => section.name.startsWith('candidate:'))
    if (captured.length === 0 && config.declaredProposeSections.length > 0) {
      throw new Error('capsule composition exposes no readable system-prompt sections')
    }
    const declaredMatch =
      JSON.stringify([...captured].map((s) => s.name).sort()) ===
      JSON.stringify([...config.declaredProposeSections].sort())
    await booted.loaderFiber.dispose()
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
    }
    const after: CordisInventory = snapshotCordisInventory(ctx)
    const handlesAfter: ProcessHandleInventory = snapshotProcessHandles()
    const drift: Record<string, { before: unknown; after: unknown }> = {}
    const beforeFlat = before as unknown as Record<string, unknown>
    const afterFlat = after as unknown as Record<string, unknown>
    for (const key of new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)])) {
      if (JSON.stringify(beforeFlat[key]) !== JSON.stringify(afterFlat[key])) {
        drift[key] = { before: beforeFlat[key], after: afterFlat[key] }
      }
    }
    if (JSON.stringify(handlesBefore) !== JSON.stringify(handlesAfter)) {
      drift['processHandles'] = { before: handlesBefore, after: handlesAfter }
    }
    const quiescent = Object.keys(drift).length === 0
    result.boot = { capturedSections: captured, declaredMatch, quiescent, drift }
    if (!declaredMatch) {
      throw new Error('booted propose sections do not match the declared contract')
    }
    if (!quiescent) {
      throw new Error('parent candidate did not return the worker process to baseline')
    }
    await writeFile(
      join(workRoot, 'sections.json'),
      `${JSON.stringify(
        {
          boot: result.boot,
          tcb: TCB_PROPOSAL_SECTION,
          // Present only on networked routes; the recorded policy is its own
          // protocol and byte-replay ignores this field.
          ...(config.modelSocket !== undefined ? { protocol: TCB_PROTOCOL_SECTION } : {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    // Sections: TCB policy (plus the wire protocol on networked routes) first,
    // then the parent's propose contribution in its declared order.
    const sections = [
      TCB_PROPOSAL_SECTION,
      ...(config.modelSocket !== undefined ? [TCB_PROTOCOL_SECTION] : []),
      ...captured,
    ].map((section) => ({
      name: section.name,
      order: section.order,
      text: section.text,
    }))
    const tools = openProposerTools({
      inputRoot: join(sandboxRoot, 'input'),
      childrenRoot: join(workRoot, 'children'),
      parentSourceHash: config.parentSourceHash,
      ...(config.treeV2Parent === undefined ? {} : { treeV2Parent: config.treeV2Parent }),
      // ADR-038: on networked routes the gateway proxy runs the stage-6 suite
      // over each child's merged view at finalization; recorded routes skip it
      // (the controller's own typeLintUnit still gates every route).
      ...(config.modelSocket === undefined
        ? {}
        : {
            candidateTestRunner: (childName: string, files: Record<string, string>) =>
              sendCandidateTests({ socketPath: config.modelSocket!, childName, files }),
          }),
    })
    await mkdir(join(workRoot, 'children'), { recursive: true })
    if (config.nativeDsh !== undefined) {
      if (config.modelSocket === undefined) {
        throw new Error('native DSH proposal requires a gateway-backed model socket')
      }
      // The first boot above is intentionally unloaded to prove quiescence.
      // Native execution gets a fresh Loader scope so candidate setup and the
      // DSH agent Fiber are owned by this one-shot invocation.
      const nativeBoot = await bootLoader(join(capsuleDir, 'cordis.propose.yml'), {
        context: ctx,
      })
      let disposeAdapter: (() => void) | undefined
      const audits: NativeLlmAudit[] = []
      try {
        if (!hasNativeDshComposition(ctx)) {
          throw new Error(
            'native DSH route requested but the proposal capsule did not mount ctx.agents',
          )
        }
        const model = openRemoteModel({
          socketPath: config.modelSocket,
          ...(config.modelClientTimeoutMs === undefined
            ? {}
            : { timeoutMs: config.modelClientTimeoutMs }),
        })
        if (model.completeNative === undefined) {
          throw new Error('native DSH route requires structured remote model support')
        }
        disposeAdapter = installNativeLlmAdapter(ctx, {
          provider: config.nativeDsh.provider,
          model: config.nativeDsh.model,
          ...(config.nativeDsh.maxTokens === undefined
            ? {}
            : { maxTokens: config.nativeDsh.maxTokens }),
          complete: async (request) => {
            const completion = await model.completeNative!(request)
            if (completion.audit !== undefined) audits.push(completion.audit)
            return completion
          },
        })
        const native = await runNativeProposal({
          ctx,
          backend: tools,
          sessionId: `proposal-${config.parentSourceHash.slice(-32)}`,
          cwd: workRoot,
          provider: config.nativeDsh.provider,
          model: config.nativeDsh.model,
          ...(config.nativeDsh.maxTokens === undefined
            ? {}
            : { maxTokens: config.nativeDsh.maxTokens }),
          ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
          prompt: buildNativeProposalInstruction({
            parentSourceHash: config.parentSourceHash,
            width: config.width,
            ...(config.treeV2Parent === undefined ? {} : { treeV2Parent: config.treeV2Parent }),
          }),
          tcbPromptSections: [TCB_PROPOSAL_SECTION satisfies NativePromptSection],
          proposalPath: join(workRoot, 'proposal.json'),
          audits,
        })
        result.ok = true
        result.runtime = 'native-dsh'
        result.turns = native.turns
        result.proposal = native.proposal
        result.native = {
          eventCount: native.eventCount,
          toolCalls: native.toolTrace.length,
          transcriptPath: native.transcriptPath,
        }
      } finally {
        disposeAdapter?.()
        await nativeBoot.loaderFiber.dispose()
      }
    } else {
      // Recorded/offline route only. A remote route against a non-native
      // capsule never reaches this branch: the supervisor refuses the
      // compatibility-loop downgrade before staging (sandbox.ts), and a
      // native capsule sets config.nativeDsh (the branch above).
      const gateway = openModelGateway({
        model: createRecordedProposerPolicy({
          width: config.width,
          ...(config.treeV2Parent === undefined ? {} : { treeV2Parent: config.treeV2Parent }),
        }),
        receiptsPath: join(workRoot, 'gateway-receipts.jsonl'),
      })
      try {
        const loop = await runProposerAgentLoop({
          gateway,
          tools,
          sections,
          instruction: buildProposalInstruction({
            parentSourceHash: config.parentSourceHash,
            width: config.width,
            ...(config.treeV2Parent === undefined ? {} : { treeV2Parent: config.treeV2Parent }),
          }),
          transcriptPath: join(workRoot, 'transcript.jsonl'),
          proposalPath: join(workRoot, 'proposal.json'),
          ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
        })
        result.ok = true
        result.runtime = 'recorded-loop'
        result.turns = loop.turns
        result.usage = loop.usage
        result.proposal = loop.proposal
      } finally {
        await gateway.close()
      }
    }
    await writeFile(
      join(workRoot, 'worker-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    )
    return 0
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
    await writeFile(
      join(sandboxRoot, 'work', 'worker-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    ).catch(() => undefined)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
