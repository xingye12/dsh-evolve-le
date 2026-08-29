/**
 * Budget double-entry ledger contract tests (Gate 3, specs/06 §8): frozen
 * limits, worst-case spent+reserved checks, per-action balances, unpriced
 * usage accounting, hash-chained persistence, and fail-closed on any
 * invariant breach — a rejected append must leave the file untouched.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BudgetError,
  BudgetLedger,
  budgetLedgerPath,
  replayBudgetLedger,
} from '../../src/state/budget.js'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fresh(prefix: string, limits = { usd: 1_000_000 }) {
  const runDir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(runDir)
  return { runDir, ledger: await BudgetLedger.open(runDir, 'run-budget', limits) }
}

const T0 = '2026-08-14T00:00:00.000Z'
const T1 = '2026-08-14T00:00:01.000Z'

describe('lifecycle', () => {
  it('reserves, settles, and refunds with correct chained totals', async () => {
    const { runDir, ledger } = await fresh('dsh-bud-life-')
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 500_000,
      occurredAt: T0,
    })
    await ledger.append({
      kind: 'settle',
      dimension: 'usd',
      actionId: 'a1',
      amount: 300_000,
      occurredAt: T0,
    })
    await ledger.append({
      kind: 'refund',
      dimension: 'usd',
      actionId: 'a1',
      amount: 50_000,
      occurredAt: T1,
    })
    expect(ledger.totals()['usd']).toEqual({ reserved: 250_000, spent: 250_000, unpriced: 0 })
    expect(ledger.head.seq).toBe(3)
    // Reopen replays the same chain and totals.
    const reopened = await BudgetLedger.open(runDir, 'run-budget', { usd: 1_000_000 })
    expect(reopened.totals()).toEqual(ledger.totals())
    expect(reopened.head).toEqual(ledger.head)
  })

  it('accounts unpriced usage explicitly instead of zeroing it', async () => {
    const { ledger } = await fresh('dsh-bud-unpriced-')
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 10,
      occurredAt: T0,
    })
    await ledger.append({
      kind: 'settle',
      dimension: 'usd',
      actionId: 'a1',
      amount: 0,
      unpricedUnits: 7,
      occurredAt: T1,
    })
    expect(ledger.totals()['usd']).toEqual({ reserved: 10, spent: 0, unpriced: 7 })
    await expect(
      ledger.append({
        kind: 'settle',
        dimension: 'usd',
        actionId: 'a1',
        amount: 0,
        occurredAt: T1,
      }),
    ).rejects.toThrow(/no unpriced usage/)
  })
})

describe('invariants (fail closed)', () => {
  it('rejects oversubscription of a frozen limit and appends nothing', async () => {
    const { runDir, ledger } = await fresh('dsh-bud-over-', { usd: 1_000 })
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 800,
      occurredAt: T0,
    })
    await expect(
      ledger.append({
        kind: 'reserve',
        dimension: 'usd',
        actionId: 'a2',
        amount: 400,
        occurredAt: T1,
      }),
    ).rejects.toThrow(/frozen limit/)
    const text = await readFile(budgetLedgerPath(runDir), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
  })

  it('rejects settle beyond reserved (global and per-action)', async () => {
    const { ledger } = await fresh('dsh-bud-settle-')
    // Two reservations so the global pool (200) can absorb the settle while
    // the per-action balance (100) cannot — this isolates the per-action check.
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 100,
      occurredAt: T0,
    })
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a2',
      amount: 100,
      occurredAt: T0,
    })
    await expect(
      ledger.append({
        kind: 'settle',
        dimension: 'usd',
        actionId: 'a1',
        amount: 150,
        occurredAt: T1,
      }),
    ).rejects.toThrow(/exceeds action reserved/)
    // Per-action isolation: an action with no reservation cannot spend the
    // global pool either.
    await expect(
      ledger.append({
        kind: 'settle',
        dimension: 'usd',
        actionId: 'a3',
        amount: 50,
        occurredAt: T1,
      }),
    ).rejects.toThrow(/exceeds action reserved/)
  })

  it('rejects refund beyond spent', async () => {
    const { ledger } = await fresh('dsh-bud-refund-')
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 100,
      occurredAt: T0,
    })
    await expect(
      ledger.append({
        kind: 'refund',
        dimension: 'usd',
        actionId: 'a1',
        amount: 1,
        occurredAt: T1,
      }),
    ).rejects.toThrow(/exceeds spent/)
  })

  it('rejects negative, float, and zero-nothing entries', async () => {
    const { ledger } = await fresh('dsh-bud-shape-')
    await expect(
      ledger.append({
        kind: 'reserve',
        dimension: 'usd',
        actionId: 'a1',
        amount: -5,
        occurredAt: T0,
      }),
    ).rejects.toThrow(BudgetError)
    await expect(
      ledger.append({
        kind: 'reserve',
        dimension: 'usd',
        actionId: 'a1',
        amount: 1.5,
        occurredAt: T0,
      }),
    ).rejects.toThrow(BudgetError)
    await expect(
      ledger.append({
        kind: 'reserve',
        dimension: 'usd',
        actionId: 'a1',
        amount: 0,
        occurredAt: T0,
      }),
    ).rejects.toThrow(/zero-amount/)
  })
})

describe('persistence integrity', () => {
  it('fails closed on a tampered ledger line', async () => {
    const { runDir, ledger } = await fresh('dsh-bud-tamper-')
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 500,
      occurredAt: T0,
    })
    const path = budgetLedgerPath(runDir)
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"amount":500', '"amount":900'))
    await expect(replayBudgetLedger(runDir, 'run-budget', { usd: 10_000 })).rejects.toThrow(
      /entryHash does not cover/,
    )
  })

  it('fails closed on a broken chain and on blank lines', async () => {
    const { runDir, ledger } = await fresh('dsh-bud-chain-')
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 500,
      occurredAt: T0,
    })
    await ledger.append({
      kind: 'release',
      dimension: 'usd',
      actionId: 'a1',
      amount: 500,
      occurredAt: T1,
    })
    const path = budgetLedgerPath(runDir)
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    // Drop the first entry: seq 2 arrives where 1 is expected.
    await writeFile(path, `${lines[1]}\n`)
    await expect(replayBudgetLedger(runDir, 'run-budget', { usd: 10_000 })).rejects.toThrow(
      /seq 2 != 1/,
    )
    await writeFile(path, `${lines.join('\n')}\n\n`)
    await expect(replayBudgetLedger(runDir, 'run-budget', { usd: 10_000 })).rejects.toThrow(
      /blank line/,
    )
  })

  it('cross-checks mirrored journal totals (recovery path)', async () => {
    const { ledger } = await fresh('dsh-bud-xcheck-')
    await ledger.append({
      kind: 'reserve',
      dimension: 'usd',
      actionId: 'a1',
      amount: 500,
      occurredAt: T0,
    })
    await ledger.append({
      kind: 'settle',
      dimension: 'usd',
      actionId: 'a1',
      amount: 200,
      occurredAt: T1,
    })
    expect(() => ledger.assertMatches({})).toThrow(/mismatch/)
    expect(() =>
      ledger.assertMatches({ usd: { reserved: 300, spent: 200, unpriced: 0 } }),
    ).not.toThrow()
  })
})
