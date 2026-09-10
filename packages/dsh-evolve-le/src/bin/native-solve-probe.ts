/**
 * Hermetic native-DSH solve admission: exercise the packed ACP bridge through
 * a real Cordis Loader and upstream AgentLoop. The deterministic adapter uses
 * each agent-scoped solve tool exactly once; the local ACP stand-in records
 * effects without a model, network, or task workspace.
 *
 * Usage: `node runner/bin/native-solve-probe.js <cordis.yml>`
 */

import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { Context } from '@deepseek-ai/cordis'
import { createNativeSolveAgent } from '../acp/native-solve-agent.js'
import { bootLoader } from '../cordis/boot.js'
import { hasNativeDshComposition } from '../dsh/native-composition.js'
import { installNativeLlmAdapter } from '../dsh/native-llm-adapter.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'

const TEST_PROVIDER = 'dsh-evolve-solve-admission'
const TEST_MODEL = 'dsh-evolve-solve-admission-model'
const TEST_RESPONSE = 'native DSH solve admission completed'
const WORKSPACE = '/workspace'

interface NativeSolveProbeReport {
  config: string
  nativeComposition: boolean
  solve?: {
    completionCount: number
    eventCount: number
    toolCallEventCount: number
    toolResultEventCount: number
    terminalCalls: string[]
    readPaths: string[]
    writes: string[]
    assistantChunks: string[]
    /** Bounded solve-policy messages injected by the real AgentLoop. */
    candidateCheckpointCount: number
    /** Content address of framed checkpoint messages; text is not exposed. */
    candidateCheckpointSha256: string
    strategyUsage: {
      workflowInvocations: number
      strategyToolInvocations: number
      agentEventInvocations: number
      sessionEventInvocations: number
    }
  }
  phases: { before: CordisInventory; afterBoot?: CordisInventory; afterUnload: CordisInventory }
  handles: { before: ProcessHandleInventory; afterUnload: ProcessHandleInventory }
  timings: { bootMs: number; solveMs?: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

function initializeProtocolStreams(): void {
  void process.stdout
  void process.stderr
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output)
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output)
  }
}

/** Extract only the TCB wrapper produced by native-solve-agent's pre-step hook. */
function checkpointDigest(events: readonly unknown[]): { count: number; sha256: string } {
  const strings: string[] = []
  for (const event of events) collectStrings(event, strings)
  const checkpoints: string[] = []
  const open = '<candidate-solve-checkpoint>'
  const close = '</candidate-solve-checkpoint>'
  for (const text of strings) {
    let from = 0
    while (true) {
      const start = text.indexOf(open, from)
      if (start < 0) break
      const end = text.indexOf(close, start + open.length)
      if (end < 0) break
      checkpoints.push(text.slice(start, end + close.length))
      from = end + close.length
    }
  }
  const framed = checkpoints.map((checkpoint) => `${String(Buffer.byteLength(checkpoint))}:${checkpoint}`).join('\n')
  return {
    count: checkpoints.length,
    sha256: `sha256:${createHash('sha256').update(framed).digest('hex')}`,
  }
}

async function settleTeardown(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  }
}

function solveConnection(effects: {
  terminalCalls: string[]
  readPaths: string[]
  writes: string[]
  assistantChunks: string[]
}): AgentSideConnection {
  return {
    async sessionUpdate(params: {
      update?: { sessionUpdate?: string; content?: { type?: string; text?: string } }
    }) {
      const update = params.update
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        effects.assistantChunks.push(update.content.text ?? '')
      }
    },
    async createTerminal(params: { command: string; args?: string[]; cwd: string }) {
      effects.terminalCalls.push(
        `${params.cwd}:${params.command}${params.args === undefined ? '' : ` ${params.args.join(' ')}`}`,
      )
      return {
        async waitForExit() {
          return { exitCode: 0 }
        },
        async currentOutput() {
          return { output: 'native solve command output\n' }
        },
        async kill() {},
        async release() {},
      }
    },
    async readTextFile(params: { path: string }) {
      effects.readPaths.push(params.path)
      return { content: 'native solve read content\n' }
    },
    async writeTextFile(params: { path: string; content: string }) {
      effects.writes.push(`${params.path}:${params.content}`)
    },
  } as unknown as AgentSideConnection
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: native-solve-probe <cordis.yml>\n')
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
    const report: NativeSolveProbeReport = {
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
  let solve: NativeSolveProbeReport['solve']
  let solveMs: number | undefined
  let failure: string | undefined
  let disposeAdapter: (() => void) | undefined
  let unloadStart = 0
  try {
    if (!nativeComposition) {
      throw new Error('ctx.agents.create() is unavailable after native capsule boot')
    }
    const effects = {
      terminalCalls: [] as string[],
      readPaths: [] as string[],
      writes: [] as string[],
      assistantChunks: [] as string[],
    }
    const connection = solveConnection(effects)
    let completionCount = 0
    disposeAdapter = installNativeLlmAdapter(ctx, {
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
      complete: async (request) => {
        completionCount += 1
        const expected = ['solve_exec', 'solve_read', 'solve_write'] as const
        const names = new Set(request.tools.map((tool) => tool.name))
        if (!expected.every((name) => names.has(name))) {
          throw new Error('native solve AgentLoop did not expose every agent-scoped solve tool')
        }
        switch (completionCount) {
          case 1:
            return {
              responseText: '',
              toolCalls: [
                {
                  id: 'native-solve-exec',
                  name: 'solve_exec',
                  arguments: '{"command":"printf","args":["native-solve"]}',
                },
              ],
              promptTokens: 3,
              completionTokens: 5,
            }
          case 2:
            return {
              responseText: '',
              toolCalls: [
                {
                  id: 'native-solve-read',
                  name: 'solve_read',
                  arguments: '{"path":"/workspace/input.txt"}',
                },
              ],
              promptTokens: 5,
              completionTokens: 5,
            }
          case 3:
            return {
              responseText: '',
              toolCalls: [
                {
                  id: 'native-solve-write',
                  name: 'solve_write',
                  arguments: '{"path":"/workspace/output.txt","content":"native solve output\\n"}',
                },
              ],
              promptTokens: 5,
              completionTokens: 5,
            }
          case 4:
            return { responseText: TEST_RESPONSE, promptTokens: 5, completionTokens: 5 }
          default:
            throw new Error(
              `native solve AgentLoop made unexpected completion ${String(completionCount)}`,
            )
        }
      },
    })
    const agent = createNativeSolveAgent(ctx, connection, {
      provider: TEST_PROVIDER,
      model: TEST_MODEL,
    })
    const started = performance.now()
    try {
      const session = await agent.newSession({ cwd: WORKSPACE } as never)
      await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'exercise native solve tools' }],
      } as never)
      const live = agent.sessions.get(session.sessionId)
      const events = live?.handle.agent.session?.events ?? []
      if (live === undefined) throw new Error('native solve session disappeared before probe readout')
      const toolCallEventCount = events.filter((event) => event.type === 'tool/call').length
      const toolResultEventCount = events.filter((event) => event.type === 'tool/result').length
      const checkpoints = checkpointDigest(events)
      solve = {
        completionCount,
        eventCount: events.length,
        toolCallEventCount,
        toolResultEventCount,
        candidateCheckpointCount: checkpoints.count,
        candidateCheckpointSha256: checkpoints.sha256,
        strategyUsage: live.strategyUsage,
        ...effects,
      }
      if (completionCount !== 4) {
        throw new Error(`native solve completed ${String(completionCount)} model turns, expected 4`)
      }
      if (toolCallEventCount !== 3 || toolResultEventCount !== 3) {
        throw new Error(
          `native solve dispatch emitted ${String(toolCallEventCount)} call and ${String(toolResultEventCount)} result events`,
        )
      }
      if (
        effects.terminalCalls.length !== 1 ||
        effects.readPaths.join(',') !== '/workspace/input.txt' ||
        effects.writes.join(',') !== '/workspace/output.txt:native solve output\n'
      ) {
        throw new Error(`native solve ACP effects were unexpected: ${JSON.stringify(effects)}`)
      }
      if (!effects.assistantChunks.includes(TEST_RESPONSE)) {
        throw new Error(
          'native solve ACP bridge did not stream the deterministic assistant response',
        )
      }
    } finally {
      solveMs = performance.now() - started
      await agent.dispose()
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
  const report: NativeSolveProbeReport = {
    config,
    nativeComposition,
    ...(solve === undefined ? {} : { solve }),
    phases: { before, afterBoot, afterUnload },
    handles: { before: handlesBefore, afterUnload: handlesAfterUnload },
    timings: { bootMs, ...(solveMs === undefined ? {} : { solveMs }), unloadMs },
    quiescent,
    ...(failure === undefined ? {} : { error: failure }),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return failure === undefined && quiescent ? 0 : 1
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
