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

/** One mounted candidate section with its observable content (ADR-039). */
interface SectionSurface {
  name: string
  order: number
  text: string
}

interface ProbeReport {
  config: string
  sections: { afterBoot: string[]; afterUnload: string[] }
  /**
   * ADR-039: additive content view of the candidate sections the Loader
   * mounted — the runtime fingerprint must see mounted TEXT, not just names,
   * or content-only evolution can never satisfy the target-mode contract.
   * The legacy name lists above stay for the boot receipts that pin them.
   */
  sectionSurfaces: { afterBoot: SectionSurface[]; afterUnload: SectionSurface[] }
  strategy: {
    toolsAfterBoot: string[]
    toolsAfterUnload: string[]
    skillsAfterBoot: string[]
    skillsAfterUnload: string[]
    agentEventsAfterBoot: string[]
    agentEventsAfterUnload: string[]
    sessionEventsAfterBoot: string[]
    sessionEventsAfterUnload: string[]
    workflowsAfterBoot: string[]
    workflowsAfterUnload: string[]
  }
  phases: { before: CordisInventory; afterBoot: CordisInventory; afterUnload: CordisInventory }
  handles: {
    before: ProcessHandleInventory
    afterBoot?: ProcessHandleInventory
    afterStrategyInventory?: ProcessHandleInventory
    afterUnload: ProcessHandleInventory
  }
  timings: { bootMs: number; unloadMs: number }
  quiescent: boolean
  error?: string
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as unknown as { get?: (serviceName: string) => unknown }).get
  const provided = typeof get === 'function' ? (get.call(ctx, name) as T | undefined) : undefined
  if (provided !== undefined) return provided
  return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
}

type SectionSnapshot = { name?: string; order?: number; text?: string }

async function candidateSections(
  ctx: Context,
): Promise<{ names: string[]; surfaces: SectionSurface[] }> {
  const service = serviceOf<{
    snapshot?: () => SectionSnapshot[]
    assemble?: () => Promise<{ sections: SectionSnapshot[] }>
  }>(ctx, 'systemPrompt')
  if (service === null || service === undefined) return { names: [], surfaces: [] }
  const records: SectionSnapshot[] =
    typeof service.snapshot === 'function'
      ? service.snapshot()
      : typeof service.assemble === 'function'
        ? (await service.assemble()).sections
        : []
  const candidateRecords = records.filter(
    (section) => typeof section.name === 'string' && section.name.startsWith('candidate:'),
  )
  return {
    names: candidateRecords.map((section) => section.name as string),
    // ADR-039: content view for the runtime fingerprint. Sections without a
    // text (a service that only exposes names) degrade to names — the Loader
    // probe still reports what the mounted surface exposes.
    surfaces: candidateRecords.map((section) => ({
      name: section.name as string,
      order: typeof section.order === 'number' ? section.order : -1,
      text: typeof section.text === 'string' ? section.text : '',
    })),
  }
}

async function sectionNames(ctx: Context): Promise<string[]> {
  return (await candidateSections(ctx)).names
}

async function registeredNames(
  ctx: Context,
  serviceName: 'tools' | 'skills' | 'candidateWorkflows',
): Promise<string[]> {
  if (serviceName === 'tools') {
    const service = serviceOf<{
      snapshot?: () => { name: string }[]
      schemas?: () => { name: string }[]
    }>(ctx, 'tools')
    if (service === undefined) return []
    if (typeof service.schemas === 'function') {
      return service
        .schemas()
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('candidate_'))
    }
    if (typeof service.snapshot === 'function')
      return service
        .snapshot()
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('candidate_'))
    return []
  }
  if (serviceName === 'candidateWorkflows') {
    const service = serviceOf<{ snapshot?: () => { name: string }[] }>(ctx, 'candidateWorkflows')
    return (
      service
        ?.snapshot?.()
        .map((entry) => entry.name)
        .filter((name) => name.startsWith('candidate-workflow:')) ?? []
    )
  }
  const service = serviceOf<{
    snapshot?: () =>
      | { skills: { name: string }[] }
      | { name: string }[]
      | Promise<{ skills: { name: string }[] } | { name: string }[]>
    list?: () => Promise<{ name: string }[]>
  }>(ctx, 'skills')
  if (service === undefined) return []
  if (typeof service.snapshot === 'function') {
    // Native dsh-skill discovers providers asynchronously. The compatibility
    // probe stub returns synchronously, so normalize both public contracts.
    const snapshot = await service.snapshot()
    const entries = Array.isArray(snapshot) ? snapshot : snapshot.skills
    return entries.map((entry) => entry.name).filter((name) => name.startsWith('candidate-'))
  }
  if (typeof service.list === 'function') {
    return (await service.list())
      .map((entry) => entry.name)
      .filter((name) => name.startsWith('candidate-'))
  }
  return []
}

function registeredEvents(inventory: CordisInventory, surface: 'agent' | 'session'): string[] {
  return inventory.listeners
    .map((listener) => listener.event)
    .filter((name) => name.startsWith(`candidate:${surface}/`))
    .sort()
}

function initializeProtocolStreams(): void {
  // Node creates stdio PipeWraps lazily. The runner owns its JSON/error
  // protocol, so establish those fixed handles before taking the baseline.
  void process.stdout
  void process.stderr
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: candidate-probe <cordis.yml>\n')
    return 2
  }
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)

  initializeProtocolStreams()
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
      sectionSurfaces: { afterBoot: [], afterUnload: [] },
      strategy: {
        toolsAfterBoot: [],
        toolsAfterUnload: [],
        skillsAfterBoot: [],
        skillsAfterUnload: [],
        agentEventsAfterBoot: [],
        agentEventsAfterUnload: [],
        sessionEventsAfterBoot: [],
        sessionEventsAfterUnload: [],
        workflowsAfterBoot: [],
        workflowsAfterUnload: [],
      },
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
  const handlesAfterBoot = snapshotProcessHandles()
  const sectionsAfterBoot = await candidateSections(ctx)
  const toolsAfterBoot = await registeredNames(ctx, 'tools')
  const skillsAfterBoot = await registeredNames(ctx, 'skills')
  const workflowsAfterBoot = await registeredNames(ctx, 'candidateWorkflows')
  const handlesAfterStrategyInventory = snapshotProcessHandles()

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
    sections: { afterBoot: sectionsAfterBoot.names, afterUnload: await sectionNames(ctx) },
    sectionSurfaces: {
      afterBoot: sectionsAfterBoot.surfaces,
      afterUnload: (await candidateSections(ctx)).surfaces,
    },
    strategy: {
      toolsAfterBoot,
      toolsAfterUnload: await registeredNames(ctx, 'tools'),
      skillsAfterBoot,
      skillsAfterUnload: await registeredNames(ctx, 'skills'),
      agentEventsAfterBoot: registeredEvents(afterBoot, 'agent'),
      agentEventsAfterUnload: registeredEvents(afterUnload, 'agent'),
      sessionEventsAfterBoot: registeredEvents(afterBoot, 'session'),
      sessionEventsAfterUnload: registeredEvents(afterUnload, 'session'),
      workflowsAfterBoot,
      workflowsAfterUnload: await registeredNames(ctx, 'candidateWorkflows'),
    },
    phases: { before, afterBoot, afterUnload },
    handles: {
      before: handlesBefore,
      afterBoot: handlesAfterBoot,
      afterStrategyInventory: handlesAfterStrategyInventory,
      afterUnload: handlesAfter,
    },
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
