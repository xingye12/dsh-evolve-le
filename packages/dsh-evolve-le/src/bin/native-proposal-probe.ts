/**
 * Hermetic native-DSH proposal admission (Gate 2): execute a bounded
 * proposal through the packed AgentLoop. A deterministic in-process adapter
 * invokes the native proposal tools; this verifies the real tool/session
 * path without turning admission into a model evaluation.
 *
 * Usage: `node runner/bin/native-proposal-probe.js <cordis.propose.yml>`
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from '../cordis/boot.js'
import { hasNativeDshComposition } from '../dsh/native-composition.js'
import { installNativeLlmAdapter } from '../dsh/native-llm-adapter.js'
import { runNativeProposal } from '../dsh/native-proposal-runner.js'
import type { ProposalOutput } from '../proposer/protocol.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'

const TEST_PROVIDER = 'dsh-evolve-proposal-admission'
const TEST_MODEL = 'dsh-evolve-proposal-admission-model'
const PROPOSAL_TOOLS = [
  'proposal_list_files',
  'proposal_write_child',
  'proposal_finish',
] as const

interface NativeProposalProbeReport {
  config: string
  nativeComposition: boolean
  proposal?: {
    childCount: number
    eventCount: number
    toolTraceEventCount: number
    toolCallEventCount: number
    toolResultEventCount: number
    backendWrites: string[]
  }
  phases: { before: CordisInventory; afterBoot?: CordisInventory; afterUnload: CordisInventory }
  handles: { before: ProcessHandleInventory; afterUnload: ProcessHandleInventory }
  timings: { bootMs: number; proposalMs?: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

function initializeProtocolStreams(): void {
  void process.stdout
  void process.stderr
}

async function settleTeardown(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  }
}

function proposalDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/proposal/v1',
    parentSourceHash: `sha256:${'a'.repeat(64)}`,
    children: [
      {
        childName: 'native-probe-child',
        hypothesis: 'Native DSH proposal tools preserve bounded child authoring.',
        donorCandidates: [],
        evidenceRefs: ['b'.repeat(64)],
        targetFailureModes: ['native-proposal-admission'],
        strategySurfaces: ['tools'],
      },
    ],
  }
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: native-proposal-probe <cordis.propose.yml>\n')
    return 2
  }
  const config = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
  initializeProtocolStreams()
  const ctx = new Context()
  const before = snapshotCordisInventory(ctx)
  const handlesBefore = snapshotProcessHandles()
  const bootStart = performance.now()
  let booted: Awaited<ReturnType<typeof bootLoader>>
  try {
    booted = await bootLoader(config, { context: ctx })
  } catch (error) {
    const report: NativeProposalProbeReport = {
      config,
      nativeComposition: false,
      phases: { before, afterUnload: before },
      handles: { before: handlesBefore, afterUnload: handlesBefore },
      timings: { bootMs: performance.now() - bootStart, unloadMs: 0 },
      quiescent: false,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 2
  }

  const bootMs = performance.now() - bootStart
  const afterBoot = snapshotCordisInventory(ctx)
  const nativeComposition = hasNativeDshComposition(ctx)
  let proposal: NativeProposalProbeReport['proposal']
  let proposalMs: number | undefined
  let failure: string | undefined
  let disposeAdapter: (() => void) | undefined
  let probeRoot: string | undefined
  let unloadStart = 0
  try {
    if (!nativeComposition) {
      throw new Error('ctx.agents.create() is unavailable after native capsule boot')
    }
    const backendWrites: string[] = []
    let completionCount = 0
    disposeAdapter = installNativeLlmAdapter(ctx, {
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      complete: async (request) => {
        completionCount += 1
        if (completionCount === 1) {
          const available = new Set(request.tools.map((tool) => tool.name))
          for (const name of PROPOSAL_TOOLS) {
            if (!available.has(name)) {
              throw new Error(`native AgentLoop did not expose ${name} in its proposal scope`)
            }
          }
          return {
            responseText: '',
            toolCalls: [
              {
                id: 'native-admission-list',
                name: 'proposal_list_files',
                arguments: JSON.stringify({ path: 'parent' }),
              },
            ],
            promptTokens: 3,
            completionTokens: 5,
          }
        }
        if (completionCount === 2) {
          return {
            responseText: '',
            toolCalls: [
              {
                id: 'native-admission-write',
                name: 'proposal_write_child',
                arguments: JSON.stringify({
                  childName: 'native-probe-child',
                  path: 'src/index.ts',
                  content: 'export const nativeProposalProbe = true\n',
                }),
              },
            ],
            promptTokens: 5,
            completionTokens: 5,
          }
        }
        if (completionCount === 3) {
          return {
            responseText: '',
            toolCalls: [
              {
                id: 'native-admission-finish',
                name: 'proposal_finish',
                arguments: JSON.stringify({ proposal: proposalDocument() }),
              },
            ],
            promptTokens: 5,
            completionTokens: 5,
          }
        }
        throw new Error(`native AgentLoop made unexpected completion ${String(completionCount)}`)
      },
    })
    probeRoot = await mkdtemp(join(tmpdir(), 'dsh-native-proposal-probe-'))
    const started = performance.now()
    const result = await runNativeProposal({
      ctx,
      sessionId: 'native-admission-proposal',
      cwd: '/tmp',
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      prompt: 'Submit the deterministic native proposal using the bounded proposal tools.',
      proposalPath: join(probeRoot, 'proposal.json'),
      backend: {
        async listInput(path) {
          if (path !== 'parent') throw new Error(`unexpected proposal input path ${path}`)
          return ['candidate.json', 'src/index.ts']
        },
        async readInput(path) {
          throw new Error(`unexpected proposal read ${path}`)
        },
        async writeChildFile(childName, path, content) {
          backendWrites.push(`${childName}/${path}:${content}`)
        },
        // The admission probe's deterministic bundle is a v1 envelope; the
        // TCB finalization boundary passes it through untouched.
        async finalizeProposal(proposal) {
          return proposal as ProposalOutput
        },
      },
    })
    proposalMs = performance.now() - started
    const toolCallEventCount = result.toolTrace.filter((event) => event.type === 'tool/call').length
    const toolResultEventCount = result.toolTrace.filter((event) => event.type === 'tool/result').length
    proposal = {
      childCount: result.proposal.children.length,
      eventCount: result.eventCount,
      toolTraceEventCount: result.toolTrace.length,
      toolCallEventCount,
      toolResultEventCount,
      backendWrites,
    }
    if (result.proposal.children[0]?.childName !== 'native-probe-child') {
      throw new Error('native DSH proposal did not return the expected child bundle')
    }
    if (result.eventCount === 0) throw new Error('native DSH proposal emitted no session events')
    if (toolCallEventCount !== 3 || toolResultEventCount !== 3) {
      throw new Error(
        `native proposal dispatch emitted ${String(toolCallEventCount)} call and ${String(toolResultEventCount)} result events`,
      )
    }
    if (backendWrites.length !== 1 || !backendWrites[0]?.startsWith('native-probe-child/src/index.ts:')) {
      throw new Error(`native proposal backend writes were unexpected: ${JSON.stringify(backendWrites)}`)
    }
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
  } finally {
    unloadStart = performance.now()
    disposeAdapter?.()
    await booted.loaderFiber.dispose().catch((error: unknown) => {
      failure ??= error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
    if (probeRoot !== undefined) await rm(probeRoot, { recursive: true, force: true })
  }
  const unloadMs = performance.now() - unloadStart
  await settleTeardown()
  const afterUnload = snapshotCordisInventory(ctx)
  const handlesAfterUnload = snapshotProcessHandles()
  const quiescent =
    JSON.stringify(afterUnload) === JSON.stringify(before) &&
    JSON.stringify(handlesAfterUnload) === JSON.stringify(handlesBefore)
  const report: NativeProposalProbeReport = {
    config,
    nativeComposition,
    ...(proposal === undefined ? {} : { proposal }),
    phases: { before, afterBoot, afterUnload },
    handles: { before: handlesBefore, afterUnload: handlesAfterUnload },
    timings: { bootMs, ...(proposalMs === undefined ? {} : { proposalMs }), unloadMs },
    quiescent,
    ...(failure === undefined ? {} : { error: failure }),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return failure === undefined && quiescent ? 0 : 1
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
