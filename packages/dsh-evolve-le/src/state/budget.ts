/**
 * Budget double-entry ledger (specs/06 §8). An independent append-only
 * ledger — not a mutable total in state — where every reservation freezes an
 * upper bound before launch:
 *
 * ```text
 * available -> reserved -> spent | released
 * ```
 *
 * All amounts are non-negative safe integers in integral units (USD in
 * micros, at most six decimals; tokens, trials, calls, seconds, slots,
 * bytes). Both the per-action and the global balances are checked on every
 * mutation, and the worst case `spent + reserved` can never exceed a frozen
 * limit, so concurrent reservations cannot oversell. Any schema, precision,
 * balance, or arithmetic violation is `EVIDENCE_CORRUPT` — no repair
 * records, no continued running.
 *
 * The controller appends a ledger entry first, then commits a journal
 * `budget.entry` event carrying the entry hash; the reducer mirrors totals
 * from the journal and recovery cross-checks both views.
 * @module @dsh-evolve-le/core/state/budget
 */

import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, parseCanonicalJson, sha256Hex } from './canonical.js'

export const BUDGET_PROTOCOL = 'dsh-evolve-le/budget-ledger/v1'
export const BUDGET_SCHEMA_VERSION = 1
export const BUDGET_GENESIS_HASH = `sha256:${'0'.repeat(64)}`

export const BUDGET_DIMENSIONS = [
  'usd',
  'solver-tokens',
  'proposer-tokens',
  'task-trials',
  'proposal-calls',
  'wall-clock-seconds',
  'concurrency-slots',
  'storage-bytes',
] as const

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number]
export type BudgetKind = 'reserve' | 'settle' | 'release' | 'refund'

/** Frozen per-dimension limits (integral units; micros for USD). */
export type BudgetLimits = Partial<Record<BudgetDimension, number>>

export interface BudgetEntry {
  schemaVersion: typeof BUDGET_SCHEMA_VERSION
  runId: string
  seq: number
  occurredAt: string
  kind: BudgetKind
  dimension: BudgetDimension
  /** Owning action; null only for controller-level accounting. */
  actionId: string | null
  amount: number
  /** Usage that has no price: `amount` may be 0 only when this is > 0. */
  unpricedUnits: number
  previousHash: string
  entryHash: string
}

/** Mirrored totals per dimension — what the reducer keeps in state. */
export interface BudgetTotals {
  reserved: number
  spent: number
  unpriced: number
}

interface ActionBalance {
  reserved: number
  spent: number
}

export interface BudgetAccounting {
  dimensions: Map<BudgetDimension, BudgetTotals>
  actions: Map<string, ActionBalance>
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(`budget: ${message}`)
    this.name = 'BudgetError'
  }
}

export function budgetLedgerPath(runDir: string): string {
  return join(runDir, 'budget-ledger.jsonl')
}

export function emptyAccounting(): BudgetAccounting {
  return { dimensions: new Map(), actions: new Map() }
}

function hashEntry(entry: Omit<BudgetEntry, 'entryHash'>): string {
  return `sha256:${sha256Hex(canonicalJson(entry))}`
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Fold one entry into the accounting, enforcing every invariant before the
 * totals change: non-negative, no overflow, per-action reservation bounds,
 * refund ≤ spent, and the frozen `spent + reserved ≤ limit` worst case.
 */
export function applyBudgetEntry(
  accounting: BudgetAccounting,
  limits: BudgetLimits,
  entry: BudgetEntry,
): void {
  const totals = accounting.dimensions.get(entry.dimension) ?? {
    reserved: 0,
    spent: 0,
    unpriced: 0,
  }
  const action =
    entry.actionId === null
      ? undefined
      : (accounting.actions.get(`${entry.dimension}\0${entry.actionId}`) ?? {
          reserved: 0,
          spent: 0,
        })
  const next: BudgetTotals = { ...totals }
  const nextAction: ActionBalance | undefined = action === undefined ? undefined : { ...action }
  const where = `${entry.dimension}/${entry.actionId ?? 'global'}`
  switch (entry.kind) {
    case 'reserve': {
      next.reserved += entry.amount
      if (nextAction !== undefined) nextAction.reserved += entry.amount
      break
    }
    case 'settle': {
      if (entry.amount > totals.reserved) {
        throw new BudgetError(
          `settle ${entry.amount} exceeds reserved ${totals.reserved} (${where})`,
        )
      }
      if (nextAction !== undefined) {
        if (entry.amount > action!.reserved) {
          throw new BudgetError(
            `settle ${entry.amount} exceeds action reserved ${action!.reserved} (${where})`,
          )
        }
        nextAction.reserved -= entry.amount
        nextAction.spent += entry.amount
      }
      next.reserved -= entry.amount
      next.spent += entry.amount
      next.unpriced += entry.unpricedUnits
      break
    }
    case 'release': {
      if (entry.amount > totals.reserved) {
        throw new BudgetError(
          `release ${entry.amount} exceeds reserved ${totals.reserved} (${where})`,
        )
      }
      if (nextAction !== undefined) {
        if (entry.amount > action!.reserved) {
          throw new BudgetError(
            `release ${entry.amount} exceeds action reserved ${action!.reserved} (${where})`,
          )
        }
        nextAction.reserved -= entry.amount
      }
      next.reserved -= entry.amount
      break
    }
    case 'refund': {
      if (entry.amount > totals.spent) {
        throw new BudgetError(`refund ${entry.amount} exceeds spent ${totals.spent} (${where})`)
      }
      if (nextAction !== undefined) {
        if (entry.amount > action!.spent) {
          throw new BudgetError(
            `refund ${entry.amount} exceeds action spent ${action!.spent} (${where})`,
          )
        }
        nextAction.spent -= entry.amount
        nextAction.reserved += entry.amount
      }
      next.spent -= entry.amount
      next.reserved += entry.amount
      break
    }
    default:
      throw new BudgetError(`unknown kind ${String(entry.kind)}`)
  }
  if (next.reserved < 0 || next.spent < 0 || next.unpriced < 0) {
    throw new BudgetError(`negative balance after ${entry.kind} (${where})`)
  }
  if (nextAction !== undefined && (nextAction.reserved < 0 || nextAction.spent < 0)) {
    throw new BudgetError(`negative action balance after ${entry.kind} (${where})`)
  }
  if (!Number.isSafeInteger(next.reserved + next.spent)) {
    throw new BudgetError(`overflow in ${entry.dimension}`)
  }
  const limit = limits[entry.dimension]
  if (limit !== undefined && next.reserved + next.spent > limit) {
    throw new BudgetError(
      `${entry.kind} would push spent+reserved to ${next.reserved + next.spent} over frozen limit ${limit} (${where})`,
    )
  }
  accounting.dimensions.set(entry.dimension, next)
  if (nextAction !== undefined && entry.actionId !== null) {
    accounting.actions.set(`${entry.dimension}\0${entry.actionId}`, nextAction)
  }
}

/** Parse and runtime-validate one persisted ledger line (fail closed). */
export function parseBudgetEntry(
  line: string,
  runId: string,
  expected: { seq: number; previousHash: string },
): BudgetEntry {
  const raw = parseCanonicalJson(line.endsWith('\n') ? line.slice(0, -1) : line)
  const record = raw as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (
    keys !==
    'actionId,amount,dimension,entryHash,kind,occurredAt,previousHash,runId,schemaVersion,seq,unpricedUnits'
  ) {
    throw new BudgetError(`entry has wrong field set: ${keys}`)
  }
  if (record['schemaVersion'] !== BUDGET_SCHEMA_VERSION) throw new BudgetError('schemaVersion')
  if (record['runId'] !== runId) throw new BudgetError('runId mismatch')
  if (record['seq'] !== expected.seq) {
    throw new BudgetError(`seq ${String(record['seq'])} != ${expected.seq}`)
  }
  if (!BUDGET_DIMENSIONS.includes(record['dimension'] as BudgetDimension)) {
    throw new BudgetError(`unknown dimension ${String(record['dimension'])}`)
  }
  if (!['reserve', 'settle', 'release', 'refund'].includes(record['kind'] as string)) {
    throw new BudgetError(`unknown kind ${String(record['kind'])}`)
  }
  if (record['actionId'] !== null && typeof record['actionId'] !== 'string') {
    throw new BudgetError('actionId must be a string or null')
  }
  if (typeof record['actionId'] === 'string' && record['actionId'] === '') {
    throw new BudgetError('actionId must be null or non-empty')
  }
  if (!isSafeCount(record['amount'])) throw new BudgetError('amount must be a safe count')
  if (!isSafeCount(record['unpricedUnits'])) {
    throw new BudgetError('unpricedUnits must be a safe count')
  }
  if (record['kind'] === 'settle' && record['amount'] === 0 && record['unpricedUnits'] === 0) {
    throw new BudgetError('settle of zero with no unpriced usage is not an accounting fact')
  }
  if (record['previousHash'] !== expected.previousHash) {
    throw new BudgetError('previousHash does not chain')
  }
  if (
    typeof record['entryHash'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record['entryHash'])
  ) {
    throw new BudgetError('entryHash must be sha256:<64-hex>')
  }
  const { entryHash: _entryHash, ...envelope } = record as unknown as BudgetEntry
  if (hashEntry(envelope) !== record['entryHash']) {
    throw new BudgetError('entryHash does not cover the entry')
  }
  return record as unknown as BudgetEntry
}

/** Replay the whole ledger under the given limits (fail closed). */
export async function replayBudgetLedger(
  runDir: string,
  runId: string,
  limits: BudgetLimits,
): Promise<{ entries: BudgetEntry[]; accounting: BudgetAccounting }> {
  const text = await readFile(budgetLedgerPath(runDir), 'utf8').catch(() => null)
  if (text === null) return { entries: [], accounting: emptyAccounting() }
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.some((line) => line === '')) throw new BudgetError('blank line in ledger')
  const entries: BudgetEntry[] = []
  const accounting = emptyAccounting()
  let previousHash = BUDGET_GENESIS_HASH
  for (let index = 0; index < lines.length; index += 1) {
    const entry = parseBudgetEntry(lines[index] ?? '', runId, {
      seq: index + 1,
      previousHash,
    })
    applyBudgetEntry(accounting, limits, entry)
    entries.push(entry)
    previousHash = entry.entryHash
  }
  return { entries, accounting }
}

export interface BudgetAppend {
  kind: BudgetKind
  dimension: BudgetDimension
  actionId: string | null
  amount: number
  unpricedUnits?: number
  occurredAt: string
}

/**
 * Single-writer ledger handle. Every append validates the entry against the
 * full replayed accounting before it touches the file, fsyncs the line, and
 * only then returns the durable entry — the journal event that mirrors it
 * comes after.
 */
export class BudgetLedger {
  private constructor(
    private readonly path: string,
    private readonly runId: string,
    private readonly limits: BudgetLimits,
    private readonly accounting: BudgetAccounting,
    private lastSeq: number,
    private lastHash: string,
  ) {}

  static async open(runDir: string, runId: string, limits: BudgetLimits): Promise<BudgetLedger> {
    const { entries, accounting } = await replayBudgetLedger(runDir, runId, limits)
    const last = entries.at(-1)
    return new BudgetLedger(
      budgetLedgerPath(runDir),
      runId,
      limits,
      accounting,
      last?.seq ?? 0,
      last?.entryHash ?? BUDGET_GENESIS_HASH,
    )
  }

  get head(): { seq: number; entryHash: string } {
    return { seq: this.lastSeq, entryHash: this.lastHash }
  }

  totals(): Record<string, BudgetTotals> {
    const out: Record<string, BudgetTotals> = {}
    for (const [dimension, value] of this.accounting.dimensions) {
      out[dimension] = { reserved: value.reserved, spent: value.spent, unpriced: value.unpriced }
    }
    return out
  }

  /** Validate + append + fsync one entry; throws on any invariant. */
  async append(input: BudgetAppend): Promise<BudgetEntry> {
    const unpricedUnits = input.unpricedUnits ?? 0
    if (!isSafeCount(input.amount)) throw new BudgetError('amount must be a safe count')
    if (!isSafeCount(unpricedUnits)) throw new BudgetError('unpricedUnits must be a safe count')
    if (input.amount === 0 && unpricedUnits === 0) {
      throw new BudgetError('zero-amount entry with no unpriced usage')
    }
    const envelope: Omit<BudgetEntry, 'entryHash'> = {
      schemaVersion: BUDGET_SCHEMA_VERSION,
      runId: this.runId,
      seq: this.lastSeq + 1,
      occurredAt: input.occurredAt,
      kind: input.kind,
      dimension: input.dimension,
      actionId: input.actionId,
      amount: input.amount,
      unpricedUnits,
      previousHash: this.lastHash,
    }
    const entry: BudgetEntry = { ...envelope, entryHash: hashEntry(envelope) }
    // Validate against the current accounting first — the file is only
    // touched when the entry would keep every invariant.
    applyBudgetEntry(this.accounting, this.limits, entry)
    const line = `${canonicalJson(entry)}\n`
    const handle = await open(this.path, 'a')
    try {
      await handle.writeFile(line, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.lastSeq = entry.seq
    this.lastHash = entry.entryHash
    return entry
  }

  /** Cross-check the mirrored journal totals against the ledger (recovery). */
  assertMatches(mirrored: Record<string, BudgetTotals>): void {
    for (const dimension of BUDGET_DIMENSIONS) {
      const mine = this.accounting.dimensions.get(dimension) ?? {
        reserved: 0,
        spent: 0,
        unpriced: 0,
      }
      const theirs = mirrored[dimension] ?? { reserved: 0, spent: 0, unpriced: 0 }
      if (
        mine.reserved !== theirs.reserved ||
        mine.spent !== theirs.spent ||
        mine.unpriced !== theirs.unpriced
      ) {
        throw new BudgetError(
          `journal/ledger mismatch for ${dimension}: ledger ${canonicalJson(mine)} vs journal ${canonicalJson(theirs)}`,
        )
      }
    }
  }
}
