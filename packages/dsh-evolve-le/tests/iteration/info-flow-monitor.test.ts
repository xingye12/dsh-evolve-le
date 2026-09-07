/**
 * Information-flow monitor contract tests (ADR-046, specs/05 §10, specs/03
 * §15 last bullet, specs/04 §7): the run-level canary monitor that owns the
 * SAFETY_ABORTED decision when guard/sealed tokens appear outside their
 * designated homes.
 *
 * Pins:
 * - tokens derive deterministically from (master seed, run, principal) — one
 *   set per guard task (`guard:<opaqueId>`) plus a `sealed:sweep` set;
 *   `guardToken(opaqueId)` is what the driver embeds into guard trial records.
 * - `scan` detects tokens in text and nested fields (fingerprints only).
 * - `sweepJournal` tolerates a guard token ONLY in its designated events —
 *   `action.reserved` / `action.committed` of THAT guard trial carrying the
 *   embedding in `request` / `observation.infoFlowGuardCanary`, appearing
 *   exactly once. Every other occurrence — including a second copy inside a
 *   designated event — is a hit. Sealed tokens have no legal home anywhere.
 * - `reportHit` writes `info-flow-monitor.json` with fingerprints ONLY (never
 *   token bodies), `result: 'aborted'`; hits append across surfaces.
 * - `writeCleanReceipt` writes the canary-absence receipt; after an abort it
 *   fails closed instead of overwriting the lineage invalidation.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  createInfoFlowMonitor,
  INFO_FLOW_MONITOR_PROTOCOL,
  type InfoFlowMonitorDoc,
} from '../../src/iteration/info-flow-monitor.js'
import { CANARY_PATTERN, canaryFingerprint, deriveCanaryTokens } from '../../src/proposer/canary.js'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const GUARDS = ['guard-01', 'guard-02', 'guard-03']
const INPUT = { runId: 'tree-v2-k80-formal', masterSeed: 'monitor-test-seed-1' }

function monitorAt(runRoot: string, input: Partial<typeof INPUT> = {}) {
  return createInfoFlowMonitor({
    runRoot,
    guardOpaqueIds: GUARDS,
    canaryCount: 2,
    ...INPUT,
    ...input,
  })
}

async function docOf(runRoot: string): Promise<InfoFlowMonitorDoc> {
  return JSON.parse(await readFile(join(runRoot, 'info-flow-monitor.json'), 'utf8')) as never
}

describe('info-flow monitor: token derivation', () => {
  it('derives guard and sealed sweep tokens deterministically from the master seed', async () => {
    const rootA = await scratch('dsh-monitor-derive-a-')
    const rootB = await scratch('dsh-monitor-derive-b-')
    const a = monitorAt(rootA)
    const b = monitorAt(rootB)
    expect(a.tokens).toEqual(b.tokens)
    expect(a.tokenFingerprints).toEqual(b.tokenFingerprints)
    // The driver embeds the guard task's own token: same derivation family.
    expect(a.guardToken('guard-02')).toBe(
      deriveCanaryTokens({
        masterSeed: INPUT.masterSeed,
        runId: INPUT.runId,
        principal: 'guard:guard-02',
        count: 2,
      })[0],
    )
    expect(CANARY_PATTERN.test(a.guardToken('guard-02'))).toBe(true)
    // Every monitor token is scannable; fingerprints never expose the bodies.
    expect(a.tokenFingerprints).toContain(canaryFingerprint(a.guardToken('guard-02')))
  })

  it('derives disjoint token families per run id and master seed', async () => {
    const root = await scratch('dsh-monitor-derive-c-')
    const a = monitorAt(root)
    const b = monitorAt(root, { runId: 'tree-v2-k80-formal-2' })
    const c = monitorAt(root, { masterSeed: 'monitor-test-seed-2' })
    expect(a.tokens.some((token) => b.tokens.includes(token))).toBe(false)
    expect(a.tokens.some((token) => c.tokens.includes(token))).toBe(false)
    // Sealed sweep tokens must never collide with any guard token: a sealed
    // token is a leak even inside a guard trial's designated events.
    const guardTokens = GUARDS.map((id) => a.guardToken(id))
    expect(a.tokens.some((token) => guardTokens.includes(token))).toBe(true) // guards included
    expect(new Set(a.tokens).size).toBe(a.tokens.length)
  })

  it('fails closed on an unknown guard opaque id', async () => {
    const root = await scratch('dsh-monitor-derive-d-')
    expect(() => monitorAt(root).guardToken('guard-99')).toThrow(/guard/)
  })
})

describe('info-flow monitor: scan', () => {
  it('detects tokens in text and nested fields, reporting fingerprints only', async () => {
    const root = await scratch('dsh-monitor-scan-')
    const monitor = monitorAt(root)
    const token = monitor.guardToken('guard-01')
    expect(monitor.scan(`prefix ${token} suffix`)).toEqual([
      { tokenFingerprint: canaryFingerprint(token), field: 'text' },
    ])
    const nested = monitor.scan({ deep: { list: [{ body: `x${token}` }] } })
    expect(nested).toEqual([
      { tokenFingerprint: canaryFingerprint(token), field: 'deep.list[0].body' },
    ])
    expect(monitor.scan('no canary here')).toEqual([])
  })
})

describe('info-flow monitor: journal sweep designated homes', () => {
  function guardRequest(opaqueId: string, monitor: ReturnType<typeof monitorAt>) {
    return {
      candidateId: 'c0000',
      opaqueTaskId: opaqueId,
      attempt: 1,
      split: 'dev-guard',
      infoFlowGuardCanary: monitor.guardToken(opaqueId),
    }
  }

  function guardObservation(opaqueId: string, monitor: ReturnType<typeof monitorAt>) {
    return {
      actionId: `eval-x-${opaqueId}-a1`,
      candidateId: 'c0000',
      opaqueTaskId: opaqueId,
      split: 'dev-guard',
      attempt: 1,
      outcome: 'failure',
      reward: 0,
      costUsdMicros: 1,
      durationMs: 1,
      infoFlowGuardCanary: monitor.guardToken(opaqueId),
    }
  }

  it('tolerates the embedding in the guard trial itself and nothing else', async () => {
    const root = await scratch('dsh-monitor-sweep-')
    const monitor = monitorAt(root)
    const token = monitor.guardToken('guard-01')
    expect(
      monitor.sweepJournal([
        { type: 'run.phase.changed', payload: { to: 'SEARCHING', reason: 'start' } },
        {
          type: 'action.reserved',
          payload: { request: guardRequest('guard-01', monitor) },
        },
        {
          type: 'action.committed',
          payload: {
            actionId: 'eval-x-guard-01-a1',
            observation: guardObservation('guard-01', monitor),
          },
        },
      ]),
    ).toEqual([])
    // The SAME token inside another guard trial's record is a leak.
    expect(
      monitor.sweepJournal([
        {
          type: 'action.committed',
          payload: {
            actionId: 'eval-x-guard-02-a1',
            observation: guardObservation('guard-02', monitor),
          },
        },
        {
          type: 'wave.planned',
          payload: { waveId: 'w1', split: 'dev-observed', members: [token] },
        },
      ]),
    ).toEqual([{ tokenFingerprint: canaryFingerprint(token), field: 'text' }])
    // A second copy inside the designated event is a leak too.
    expect(
      monitor.sweepJournal([
        {
          type: 'action.reserved',
          payload: { request: { ...guardRequest('guard-01', monitor), extra: `copy ${token}` } },
        },
      ]),
    ).toEqual([{ tokenFingerprint: canaryFingerprint(token), field: 'text' }])
  })

  it('never tolerates a sealed sweep token, even in guard trial records', async () => {
    const root = await scratch('dsh-monitor-sweep-sealed-')
    const monitor = monitorAt(root)
    const sealed = monitor.tokens.find((token) =>
      GUARDS.every((id) => token !== monitor.guardToken(id)),
    )!
    expect(
      monitor.sweepJournal([
        {
          type: 'action.committed',
          payload: {
            actionId: 'eval-x-guard-01-a1',
            observation: { ...guardObservation('guard-01', monitor), note: sealed },
          },
        },
      ]),
    ).toEqual([{ tokenFingerprint: canaryFingerprint(sealed), field: 'text' }])
  })
})

describe('info-flow monitor: durable receipts', () => {
  it('writes an aborted receipt with fingerprints only; hits append across surfaces', async () => {
    const root = await scratch('dsh-monitor-hit-')
    const monitor = monitorAt(root)
    const token = monitor.guardToken('guard-03')
    const hits = monitor.scan(`leak ${token}`)
    await monitor.reportHit('proposal-result', hits)
    let doc = await docOf(root)
    expect(doc).toMatchObject({
      schemaVersion: 1,
      protocol: INFO_FLOW_MONITOR_PROTOCOL,
      runId: INPUT.runId,
      result: 'aborted',
    })
    expect(doc.hits).toHaveLength(1)
    expect(doc.hits[0]).toMatchObject({
      surface: 'proposal-result',
      fingerprints: [canaryFingerprint(token)],
    })
    expect(typeof doc.hits[0]!.at).toBe('string')
    const text = JSON.stringify(doc)
    expect(text).not.toContain(token)
    // A second surface appends to the same document.
    await monitor.reportHit('journal-sweep', monitor.scan(`again ${token}`))
    doc = await docOf(root)
    expect(doc.hits.map((hit) => hit.surface)).toEqual(['proposal-result', 'journal-sweep'])
    expect(JSON.stringify(doc)).not.toContain(token)
  })

  it('writes the clean canary-absence receipt and refuses to overwrite an abort', async () => {
    const root = await scratch('dsh-monitor-clean-')
    const monitor = monitorAt(root)
    await monitor.writeCleanReceipt(41)
    let doc = await docOf(root)
    expect(doc).toMatchObject({ result: 'clean', checkedEvents: 41 })
    expect(doc.hits).toEqual([])
    expect(doc.tokenFingerprints).toEqual(monitor.tokenFingerprints)
    expect(JSON.stringify(doc)).not.toContain(monitor.guardToken('guard-01'))
    // Once invalidated, the lineage stays invalidated: no clean overwrite.
    await monitor.reportHit('evidence-export', monitor.scan(`x ${monitor.guardToken('guard-01')}`))
    await expect(monitor.writeCleanReceipt(41)).rejects.toThrow(/aborted/)
    doc = await docOf(root)
    expect(doc.result).toBe('aborted')
  })
})
