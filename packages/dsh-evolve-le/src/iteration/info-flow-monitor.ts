/**
 * Run-level information-flow monitor (ADR-046, specs/05 §10, specs/03 §15,
 * specs/04 §7): the single owner of the SAFETY_ABORTED decision when a guard
 * or sealed canary token appears outside its designated home.
 *
 * Tokens derive deterministically from the run's (master seed, run id) — one
 * family per guard task (`guard:<opaqueId>`) plus a `sealed:sweep` family —
 * so crash/replay sees the identical set. The driver embeds a guard trial's
 * own token into its `action.reserved` request and `action.committed`
 * observation: those two events, with the token appearing exactly once, are
 * the ONLY legal homes. Every other occurrence — a second copy inside the
 * designated event, the token in any other event, a sealed token anywhere —
 * is a hit. Hits are reported per surface (evidence-export, proposal-result,
 * journal-sweep) and the durable receipt carries sha256 fingerprints ONLY,
 * never token bodies (a receipt that names the token would leak it into
 * evidence and defeat the canary).
 *
 * The receipt is monotonic: once `result: 'aborted'` is written, a later
 * `writeCleanReceipt` fails closed instead of overwriting the lineage
 * invalidation.
 * @module @dsh-evolve-le/core/iteration/info-flow-monitor
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canaryFingerprint,
  deriveCanaryTokens,
  scanFieldsForCanary,
  type CanaryHit,
} from '../proposer/canary.js'
import { canonicalJson } from '../state/canonical.js'
import type { JournalEvent } from '../state/journal.js'

export const INFO_FLOW_MONITOR_PROTOCOL = 'dsh-evolve-le/info-flow-monitor/v1'

export interface InfoFlowMonitorDoc {
  schemaVersion: 1
  protocol: typeof INFO_FLOW_MONITOR_PROTOCOL
  runId: string
  /** 'aborted' once any surface reported a hit; never returns to 'clean'. */
  result: 'clean' | 'aborted'
  /** Fingerprints of every monitor token (guard families + sealed sweep). */
  tokenFingerprints: string[]
  /** Journal events swept when the clean canary-absence receipt was written. */
  checkedEvents?: number
  hits: Array<{ surface: string; fingerprints: string[]; at: string }>
}

export interface InfoFlowMonitor {
  /** Every derived token (guard families first, sealed sweep last). */
  readonly tokens: string[]
  readonly tokenFingerprints: string[]
  /** The first token of the given guard task's family (the embedding token). */
  guardToken(opaqueId: string): string
  /** Scan text or nested fields for monitor tokens (fingerprints only). */
  scan(value: unknown): CanaryHit[]
  /**
   * Sweep journal events: a guard token is legal only in its designated
   * reservation/commit events, exactly once; sealed tokens are never legal.
   */
  sweepJournal(events: readonly JournalEvent[]): CanaryHit[]
  /** Append one surface's hits to the durable receipt (aborted). */
  reportHit(surface: string, hits: readonly CanaryHit[]): Promise<void>
  /**
   * Write the clean canary-absence receipt. Fails closed after an abort:
   * the lineage invalidation is never overwritten.
   */
  writeCleanReceipt(checkedEvents: number): Promise<void>
}

/** Number of occurrences of `needle` inside `text` (split-count, UTF-16). */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** One guard task's designated homes: its own reservation and commit event. */
function isDesignatedHome(event: JournalEvent, opaqueId: string, token: string): boolean {
  const payload = event.payload as Record<string, unknown>
  const candidate =
    event.type === 'action.reserved'
      ? (payload['request'] as Record<string, unknown> | null | undefined)
      : event.type === 'action.committed'
        ? (payload['observation'] as Record<string, unknown> | null | undefined)
        : null
  return (
    candidate !== null &&
    candidate !== undefined &&
    candidate['opaqueTaskId'] === opaqueId &&
    candidate['split'] === 'dev-guard' &&
    candidate['infoFlowGuardCanary'] === token
  )
}

export function createInfoFlowMonitor(input: {
  runRoot: string
  runId: string
  masterSeed: string
  guardOpaqueIds: readonly string[]
  canaryCount: number
  clock?: () => string
}): InfoFlowMonitor {
  const derive = (principal: string): string[] =>
    deriveCanaryTokens({
      masterSeed: input.masterSeed,
      runId: input.runId,
      principal,
      count: input.canaryCount,
    })
  const guardFamilies = input.guardOpaqueIds.map((opaqueId) => ({
    opaqueId,
    tokens: derive(`guard:${opaqueId}`),
  }))
  const sealedTokens = derive('sealed:sweep')
  const tokens = [...guardFamilies.flatMap((family) => family.tokens), ...sealedTokens]
  const tokenFingerprints = tokens.map((token) => canaryFingerprint(token))
  const tokenToOpaque = new Map<string, string>()
  for (const family of guardFamilies) {
    for (const token of family.tokens) tokenToOpaque.set(token, family.opaqueId)
  }
  const sealedSet = new Set(sealedTokens)
  const docPath = join(input.runRoot, 'info-flow-monitor.json')

  const guardToken = (opaqueId: string): string => {
    const family = guardFamilies.find((entry) => entry.opaqueId === opaqueId)
    if (family === undefined) {
      throw new Error(`info-flow-monitor: ${opaqueId} is not a registered guard opaque id`)
    }
    return family.tokens[0] as string
  }

  const readDoc = async (): Promise<InfoFlowMonitorDoc | null> => {
    const text = await readFile(docPath, 'utf8').catch(() => undefined)
    if (text === undefined) return null
    return JSON.parse(text) as InfoFlowMonitorDoc
  }

  const writeDoc = async (doc: InfoFlowMonitorDoc): Promise<void> => {
    await writeFile(docPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  }

  const hitIdentity = (surface: string, fingerprints: readonly string[]): string =>
    `${surface}\0${[...fingerprints].sort().join(',')}`

  const reportHit = async (surface: string, hits: readonly CanaryHit[]): Promise<void> => {
    const fingerprints = hits.map((hit) => hit.tokenFingerprint)
    const now = input.clock?.() ?? new Date().toISOString()
    const doc = await readDoc()
    if (doc === null) {
      await writeDoc({
        schemaVersion: 1,
        protocol: INFO_FLOW_MONITOR_PROTOCOL,
        runId: input.runId,
        result: 'aborted',
        tokenFingerprints,
        hits: [{ surface, fingerprints, at: now }],
      })
      return
    }
    const identity = hitIdentity(surface, fingerprints)
    if (!doc.hits.some((hit) => hitIdentity(hit.surface, hit.fingerprints) === identity)) {
      doc.hits.push({ surface, fingerprints, at: now })
    }
    doc.result = 'aborted'
    await writeDoc(doc)
  }

  const sweepJournal = (events: readonly JournalEvent[]): CanaryHit[] => {
    const hits: CanaryHit[] = []
    for (const event of events) {
      const text = canonicalJson(event)
      for (const token of tokens) {
        const count = countOccurrences(text, token)
        if (count === 0) continue
        const opaqueId = tokenToOpaque.get(token)
        if (
          opaqueId !== undefined &&
          !sealedSet.has(token) &&
          count === 1 &&
          isDesignatedHome(event, opaqueId, token)
        ) {
          continue // the embedding inside the guard trial's own record
        }
        hits.push({ tokenFingerprint: canaryFingerprint(token), field: 'text' })
      }
    }
    return hits
  }

  const writeCleanReceipt = async (checkedEvents: number): Promise<void> => {
    const doc = await readDoc()
    if (doc?.result === 'aborted') {
      throw new Error(
        `info-flow-monitor: run ${input.runId} is already aborted; the lineage stays invalidated`,
      )
    }
    await writeDoc({
      schemaVersion: 1,
      protocol: INFO_FLOW_MONITOR_PROTOCOL,
      runId: input.runId,
      result: 'clean',
      tokenFingerprints,
      checkedEvents,
      hits: [],
    })
  }

  return {
    tokens,
    tokenFingerprints,
    guardToken,
    scan: (value: unknown) => scanFieldsForCanary(value, tokens),
    sweepJournal,
    reportHit,
    writeCleanReceipt,
  }
}
