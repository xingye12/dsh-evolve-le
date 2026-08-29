/**
 * Shared scenario builder for Gate 3 state tests: appends events through the
 * REAL journal (hash chain, HEAD commits) and mirrors budget entries through
 * the REAL ledger, so reducer tests always fold exactly what recovery would
 * read from disk. The clock is a deterministic counter — no Date.now().
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BudgetLedger,
  type BudgetDimension,
  type BudgetKind,
  type BudgetLimits,
} from '../../src/state/budget.js'
import { Journal, type JournalConfig, type JournalEvent } from '../../src/state/journal.js'
import type { ReducerConfig } from '../../src/state/reducer.js'
import { readJournal } from '../../src/state/journal.js'

export const RUN_ID = 'run-test'

export interface Scenario {
  runDir: string
  journal: Journal
  ledger: BudgetLedger
  config: JournalConfig
  reducerConfig: ReducerConfig
  events: JournalEvent[]
  emit(type: string, payload: Record<string, unknown>): Promise<JournalEvent>
  budgetEntry(input: {
    kind: BudgetKind
    dimension: BudgetDimension
    actionId: string | null
    amount: number
    unpricedUnits?: number
  }): Promise<JournalEvent>
  state(): Promise<JournalEvent[]>
  close(): Promise<void>
}

export async function openScenario(
  prefix: string,
  limits: BudgetLimits = { usd: 1_000_000_000, 'task-trials': 100 },
): Promise<{ scenario: Scenario; cleanup: () => Promise<void> }> {
  const runDir = await mkdtemp(join(tmpdir(), prefix))
  const config: JournalConfig = { runId: RUN_ID, segmentMaxBytes: 1 << 20 }
  const journal = await Journal.open(runDir, config)
  const ledger = await BudgetLedger.open(runDir, RUN_ID, limits)
  const events: JournalEvent[] = []
  let tick = 0
  const at = (): string => new Date(1_700_000_000_000 + (tick += 1)).toISOString()
  const scenario: Scenario = {
    runDir,
    journal,
    ledger,
    config,
    reducerConfig: { runId: RUN_ID, budgetLimits: limits },
    events,
    async emit(type, payload) {
      const event = await journal.append({ type, actor: 'controller', occurredAt: at(), payload })
      events.push(event)
      return event
    },
    async budgetEntry({ kind, dimension, actionId, amount, unpricedUnits }) {
      const entry = await ledger.append({
        kind,
        dimension,
        actionId,
        amount,
        unpricedUnits,
        occurredAt: at(),
      })
      return scenario.emit('budget.entry', {
        kind,
        dimension,
        actionId,
        amount,
        unpricedUnits: unpricedUnits ?? 0,
        entryHash: entry.entryHash,
      })
    },
    async state() {
      const read = await readJournal(runDir, config)
      return read.events
    },
    async close() {
      await journal.close()
    },
  }
  return { scenario, cleanup: () => rm(runDir, { recursive: true, force: true }) }
}

/** A full reservation→launch→collect→commit saga for one evaluation action. */
export async function runEvaluationAction(
  scenario: Scenario,
  input: {
    actionId: string
    waveId: string
    candidateId: string
    opaqueTaskId: string
    attempt?: number
    outcome?: 'success' | 'failure' | 'missing' | 'timeout'
    costUsdMicros?: number | null
    order?: 'normal' | 'skip-launch'
  },
): Promise<void> {
  const attempt = input.attempt ?? 1
  const outcome = input.outcome ?? 'success'
  await scenario.emit('action.reserved', {
    actionId: input.actionId,
    kind: 'evaluation',
    idempotencyKey: `eval-${input.actionId}`,
    request: { candidateId: input.candidateId, opaqueTaskId: input.opaqueTaskId, attempt },
    waveId: input.waveId,
    budget: [
      { dimension: 'usd', amount: 500_000 },
      { dimension: 'task-trials', amount: 1 },
    ],
  })
  await scenario.budgetEntry({
    kind: 'reserve',
    dimension: 'usd',
    actionId: input.actionId,
    amount: 500_000,
  })
  await scenario.budgetEntry({
    kind: 'reserve',
    dimension: 'task-trials',
    actionId: input.actionId,
    amount: 1,
  })
  if (input.order !== 'skip-launch') {
    await scenario.emit('action.launched', {
      actionId: input.actionId,
      externalJobId: `job-${input.actionId}`,
      provider: 'fake-provider',
    })
  }
  await scenario.emit('action.observed-terminal', {
    actionId: input.actionId,
    fact: { outcome },
  })
  await scenario.emit('artifact.collected', {
    actionId: input.actionId,
    artifact: {
      algorithm: 'sha256',
      digest: 'b'.repeat(64),
      size: 100,
      mediaType: 'application/vnd.dsh-evolve-le.trajectory+json',
      label: 'DEV_OBSERVED',
    },
  })
  const reward = outcome === 'success' ? 1 : 0
  await scenario.emit('action.committed', {
    actionId: input.actionId,
    observation: {
      actionId: input.actionId,
      candidateId: input.candidateId,
      opaqueTaskId: input.opaqueTaskId,
      split: 'dev-observed',
      attempt,
      outcome,
      reward,
      costUsdMicros: input.costUsdMicros ?? 100,
      durationMs: 5_000,
    },
  })
  // No trusted cost receipt arrives for missing/timeout outcomes: the usage
  // is recorded as unpriced, never silently zero-priced.
  const priced = outcome === 'missing' || outcome === 'timeout' ? 0 : 100
  const unpriced = outcome === 'missing' || outcome === 'timeout' ? 1 : 0
  await scenario.budgetEntry({
    kind: 'settle',
    dimension: 'usd',
    actionId: input.actionId,
    amount: priced,
    unpricedUnits: unpriced,
  })
  await scenario.budgetEntry({
    kind: 'settle',
    dimension: 'task-trials',
    actionId: input.actionId,
    amount: 1,
  })
}
