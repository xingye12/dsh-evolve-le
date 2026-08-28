/**
 * Capsule ACP boot (Gate 1, specs/07 §3): boot the packed capsule composition
 * through the real Cordis Loader, then serve the Agent Client Protocol on
 * `@agentclientprotocol/sdk` 0.25.1 over JSON-RPC stdio (the same wire surface
 * as the locked `@deepseek-ai/dsh-acp` bridge). When the client closes stdin,
 * the app unloads, the unload invariant is checked against the pre-boot
 * baseline, and a final runner report goes to stderr as one JSON line —
 * stdout stays reserved for the protocol.
 *
 * The compiled file ships inside every capsule at `runner/bin/acp-boot.js`;
 * bare imports resolve against the capsule's flat pinned `node_modules/`.
 *
 * Usage: `node runner/bin/acp-boot.js <cordis.yml>`
 * Exit 0 when the unload invariant held, 1 when it did not, 2 on boot failure.
 * @module @dsh-evolve-le/core/bin/acp-boot
 */

import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { createReplayAgent } from '../acp/replay-agent.js'
import { bootLoader } from '../cordis/boot.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'

interface RunnerReport {
  config: string
  sections: { afterBoot: string[]; afterUnload: string[] }
  quiescent: boolean
  timings: { bootMs: number; unloadMs: number }
  error?: string
}

const reportLine = 'dsh-evolve-le-runner-report:'

function sectionNames(ctx: Context): string[] {
  const service = (ctx as unknown as { systemPrompt?: { snapshot?: () => { name: string }[] } })
    .systemPrompt
  if (service === null || service === undefined || typeof service.snapshot !== 'function') return []
  return service.snapshot().map((section) => section.name)
}

/**
 * Teardown may release handles but must never create one: a candidate that
 * leaked a timer, socket, or pipe would raise a kind above its count while
 * the session was serving, or introduce a kind that was not there before.
 * The transport's own stdio wrappers are inside the serving baseline.
 */
function noNewHandles(serving: ProcessHandleInventory, after: ProcessHandleInventory): boolean {
  for (const [kind, count] of Object.entries(after)) {
    if ((serving[kind] ?? 0) < count) return false
  }
  return true
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: acp-boot <cordis.yml>\n')
    return 2
  }
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)

  const ctx = new Context()
  const before: CordisInventory = snapshotCordisInventory(ctx)

  const bootStart = performance.now()
  let booted: Awaited<ReturnType<typeof bootLoader>>
  try {
    booted = await bootLoader(absolute, { context: ctx })
  } catch (error) {
    const report: RunnerReport = {
      config: absolute,
      sections: { afterBoot: [], afterUnload: [] },
      quiescent: false,
      timings: { bootMs: performance.now() - bootStart, unloadMs: 0 },
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    process.stderr.write(`${reportLine}${JSON.stringify(report)}\n`)
    return 2
  }
  const bootMs = performance.now() - bootStart
  const sectionsAfterBoot = sectionNames(ctx)

  // Serve ACP until the client closes stdin (or the stream errors): the SDK
  // resolves `connection.closed` when its underlying stream ends. The factory
  // receives the live connection as its argument (the outer binding is not
  // yet initialized while the constructor runs).
  const connection: AgentSideConnection = new AgentSideConnection(
    (conn) => createReplayAgent(ctx, conn),
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  )
  // The handle baseline is re-taken once the runner's own transport is up:
  // its stdio wrappers are TCB machinery the candidate cannot touch, and the
  // invariant must measure exactly what the prompt turn leaves behind.
  const handlesServing: ProcessHandleInventory = snapshotProcessHandles()
  await connection.closed

  // Release the transport before the census; any handle surviving this is a
  // genuine leak, not transport bookkeeping.
  process.stdin.destroy()
  const unloadStart = performance.now()
  await booted.loaderFiber.dispose()
  const unloadMs = performance.now() - unloadStart
  // Drain teardown I/O (the include plugin flushes its tree file) before the
  // final census; a genuinely leaked timer or socket would survive this.
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  }
  const afterUnload = snapshotCordisInventory(ctx)
  const handlesAfter = snapshotProcessHandles()
  const quiescent =
    JSON.stringify(afterUnload) === JSON.stringify(before) &&
    noNewHandles(handlesServing, handlesAfter)
  const report: RunnerReport = {
    config: absolute,
    sections: { afterBoot: sectionsAfterBoot, afterUnload: sectionNames(ctx) },
    quiescent,
    timings: { bootMs, unloadMs },
  }
  process.stderr.write(`${reportLine}${JSON.stringify(report)}\n`)
  return quiescent ? 0 : 1
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
// The report above already records the machine-checked unload invariant. If
// teardown left references alive (web-stream wrappers over stdio), exit after
// the report had a turn to flush; the unref'd timer never holds the loop open
// itself, and a genuinely leaked handle is named in the report, not hidden.
const forceExit = setTimeout(() => process.exit(exitCode), 250)
forceExit.unref()
