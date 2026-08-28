/**
 * Capsule runner probe (Gate 1): boot the packed capsule composition through
 * the real Cordis Loader inside a fresh one-shot process, record the prompt
 * sections registered by the candidate before and after unload, snapshot the
 * full Cordis/process inventory for the unload invariant, and exit with a
 * bounded, JSON-only protocol on stdout.
 *
 * The compiled file ships inside every capsule at `runner/probe.js` next to
 * `runner/cordis/boot.js`; its bare imports resolve against the capsule's
 * flat pinned `node_modules/`. It never touches the network.
 *
 * Usage: `node runner/probe.js <cordis.yml>`
 * stdout is a single JSON document; exit 0 when quiescent, 1 when not,
 * 2 when boot itself failed (error captured in the document).
 * @module @dsh-evolve-le/core/bin/candidate-probe
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

interface ProbeReport {
  config: string
  sections: { afterBoot: string[]; afterUnload: string[] }
  phases: { before: CordisInventory; afterBoot: CordisInventory; afterUnload: CordisInventory }
  handles: { before: ProcessHandleInventory; afterUnload: ProcessHandleInventory }
  timings: { bootMs: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

function sectionNames(ctx: Context): string[] {
  const service = (ctx as unknown as { systemPrompt?: { snapshot?: () => { name: string }[] } })
    .systemPrompt
  if (service === null || service === undefined || typeof service.snapshot !== 'function') return []
  return service.snapshot().map((section) => section.name)
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: candidate-probe <cordis.yml>\n')
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
    const report: ProbeReport = {
      config: absolute,
      sections: { afterBoot: [], afterUnload: [] },
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
  const sectionsAfterBoot = sectionNames(ctx)

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
  const report: ProbeReport = {
    config: absolute,
    sections: { afterBoot: sectionsAfterBoot, afterUnload: sectionNames(ctx) },
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
