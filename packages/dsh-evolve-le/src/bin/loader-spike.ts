/**
 * Gate 0 loader-spike bin: boot a real Cordis Loader against a `cordis.yml`,
 * snapshot the observable inventory before boot / after boot / after unload,
 * and exit naturally (no `process.exit`) so a lingering timer or handle would
 * keep the process alive and fail the caller's timeout.
 *
 * Usage: `node lib/bin/loader-spike.js <cordis.yml>`
 * stdout is a single JSON document:
 * `{ config, phases: { before, afterBoot, afterUnload }, handles: { before,
 * afterUnload }, timings, quiescent, error? }`. Exit code 0 when quiescent,
 * 1 when not, 2 when boot itself failed (error captured in the document).
 * @module @dsh-evolve-le/core/bin/loader-spike
 */

import { isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader } from '../cordis/boot.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'

interface SpikeReport {
  config: string
  phases: {
    before: CordisInventory
    afterBoot: CordisInventory
    afterUnload: CordisInventory
  }
  handles: {
    before: ProcessHandleInventory
    afterUnload: ProcessHandleInventory
  }
  timings: { bootMs: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: loader-spike <cordis.yml>\n')
    return 2
  }
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)

  const ctx = new Context()
  const before = snapshotCordisInventory(ctx)
  const handlesBefore = snapshotProcessHandles()

  const bootStart = performance.now()
  let booted: Awaited<ReturnType<typeof bootLoader>> | undefined
  try {
    booted = await bootLoader(absolute, { context: ctx })
  } catch (error) {
    const report: SpikeReport = {
      config: absolute,
      phases: { before, afterBoot: before, afterUnload: before },
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

  const unloadStart = performance.now()
  await booted.loaderFiber.dispose()
  const unloadMs = performance.now() - unloadStart

  // Let teardown's pending I/O (the include flushes its tree file) settle
  // before the final census; a genuinely leaked timer or socket would survive
  // this drain and still fail the check.
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  const afterUnload = snapshotCordisInventory(ctx)
  const handlesAfter = snapshotProcessHandles()
  const report: SpikeReport = {
    config: absolute,
    phases: { before, afterBoot, afterUnload },
    handles: { before: handlesBefore, afterUnload: handlesAfter },
    timings: { bootMs, unloadMs },
    quiescent:
      JSON.stringify(afterUnload) === JSON.stringify(before) &&
      JSON.stringify(handlesAfter) === JSON.stringify(handlesBefore),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.quiescent ? 0 : 1
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
