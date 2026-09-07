/**
 * Hermetic native-DSH admission turn (Gate 2): load a packed capsule through
 * the real Cordis Loader, register a deterministic in-process LLM adapter,
 * and drive one turn through ctx.agents.create(). This proves that the staged
 * native spine owns the agent/session loop and that candidate setup works in
 * the unpublished agent Fiber; it is deliberately not a model evaluation.
 *
 * Usage: `node runner/bin/native-turn-probe.js <cordis.yml>`
 * stdout is one JSON document. Exit 0 only when the turn and full unload
 * invariant succeed.
 */

import { isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from '../cordis/boot.js'
import { hasNativeDshComposition } from '../dsh/native-composition.js'
import { installNativeLlmAdapter } from '../dsh/native-llm-adapter.js'
import { runNativeDshTurn } from '../dsh/native-runner.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'

const TEST_PROVIDER = 'dsh-evolve-admission'
const TEST_MODEL = 'dsh-evolve-admission-model'
const TEST_RESPONSE = 'native DSH admission turn completed'
const STRATEGY_TOOL = 'candidate_strategy_snapshot'

interface NativeTurnProbeReport {
  config: string
  nativeComposition: boolean
  turn?: {
    assistantText: string
    eventCount: number
    toolTraceEventCount: number
    toolCallEventCount: number
    toolResultEventCount: number
  }
  phases: { before: CordisInventory; afterBoot?: CordisInventory; afterUnload: CordisInventory }
  handles: { before: ProcessHandleInventory; afterUnload: ProcessHandleInventory }
  timings: { bootMs: number; turnMs?: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

function initializeProtocolStreams(): void {
  // Keep stdout/stderr PipeWraps inside the process baseline; this runner
  // writes exactly one report on stdout after all teardown has completed.
  void process.stdout
  void process.stderr
}

async function settleTeardown(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  }
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: native-turn-probe <cordis.yml>\n')
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
    const report: NativeTurnProbeReport = {
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
  let turn: NativeTurnProbeReport['turn']
  let turnMs: number | undefined
  let failure: string | undefined
  let disposeAdapter: (() => void) | undefined
  let unloadStart = 0
  try {
    if (!nativeComposition) {
      throw new Error('ctx.agents.create() is unavailable after native capsule boot')
    }
    let completionCount = 0
    disposeAdapter = installNativeLlmAdapter(ctx, {
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      complete: async (request) => {
        completionCount += 1
        if (completionCount === 1) {
          if (!request.tools.some((tool) => tool.name === STRATEGY_TOOL)) {
            throw new Error(`native AgentLoop did not expose ${STRATEGY_TOOL} in its agent scope`)
          }
          return {
            responseText: '',
            toolCalls: [{ id: 'native-admission-strategy', name: STRATEGY_TOOL, arguments: '{}' }],
            promptTokens: 3,
            completionTokens: 5,
          }
        }
        if (completionCount !== 2) {
          throw new Error(`native AgentLoop made unexpected completion ${String(completionCount)}`)
        }
        return { responseText: TEST_RESPONSE, promptTokens: 5, completionTokens: 5 }
      },
    })
    const started = performance.now()
    const result = await runNativeDshTurn(ctx, {
      sessionId: 'native-admission-turn',
      cwd: '/tmp',
      mode: 'solve',
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      prompt: 'Reply with the deterministic admission confirmation only.',
    })
    turnMs = performance.now() - started
    const toolCallEventCount = result.toolTrace.filter((event) => event.type === 'tool/call').length
    const toolResultEventCount = result.toolTrace.filter((event) => event.type === 'tool/result').length
    turn = {
      assistantText: result.assistantText,
      eventCount: result.eventCount,
      toolTraceEventCount: result.toolTrace.length,
      toolCallEventCount,
      toolResultEventCount,
    }
    if (result.assistantText !== TEST_RESPONSE) {
      throw new Error(`unexpected native DSH response ${JSON.stringify(result.assistantText)}`)
    }
    if (result.eventCount === 0) throw new Error('native DSH turn emitted no session events')
    if (toolCallEventCount !== 1 || toolResultEventCount !== 1) {
      throw new Error(
        `native ${STRATEGY_TOOL} dispatch emitted ${String(toolCallEventCount)} call and ${String(toolResultEventCount)} result events`,
      )
    }
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error)
  } finally {
    unloadStart = performance.now()
    disposeAdapter?.()
    await booted.loaderFiber.dispose().catch((error: unknown) => {
      failure ??= error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
  }
  const unloadMs = performance.now() - unloadStart
  await settleTeardown()
  const afterUnload = snapshotCordisInventory(ctx)
  const handlesAfterUnload = snapshotProcessHandles()
  const quiescent =
    JSON.stringify(afterUnload) === JSON.stringify(before) &&
    JSON.stringify(handlesAfterUnload) === JSON.stringify(handlesBefore)
  const report: NativeTurnProbeReport = {
    config,
    nativeComposition,
    ...(turn === undefined ? {} : { turn }),
    phases: { before, afterBoot, afterUnload },
    handles: { before: handlesBefore, afterUnload: handlesAfterUnload },
    timings: { bootMs, ...(turnMs === undefined ? {} : { turnMs }), unloadMs },
    quiescent,
    ...(failure === undefined ? {} : { error: failure }),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return failure === undefined && quiescent ? 0 : 1
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
