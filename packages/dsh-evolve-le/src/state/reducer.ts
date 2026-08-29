/**
 * Pure state reducer (specs/06 §5, specs/00 §8, specs/03). The reducer owns
 * run phase, candidate statuses and lineage, observations, pending/reserved
 * actions, RNG receipts, budget mirrors, external job mappings, locks, and
 * information-flow state. It reads nothing — no clock, no RNG, no
 * filesystem; every fact arrives in the event payload.
 *
 * `stateHash` is computed over the *core* (everything except journal
 * bookkeeping fields `seq`/`lastEventHash`), with all collections emitted in
 * deterministic key order. That is what makes completion-order permutation
 * inside a wave produce the identical hash: committing member actions in any
 * order yields the same core, while the journal still records the exact
 * commit order. Every violation — unknown event type, illegal phase edge,
 * out-of-band action transition, double lock, budget overrun — throws, and
 * the controller must translate that into a terminal `PROTOCOL_INVALID` /
 * `EVIDENCE_CORRUPT` run, never a silent repair.
 * @module @dsh-evolve-le/core/state/reducer
 */

import { canonicalHash, canonicalJson } from './canonical.js'
import {
  applyBudgetEntry,
  BUDGET_DIMENSIONS,
  type BudgetAccounting,
  type BudgetDimension,
  type BudgetLimits,
  type BudgetTotals,
} from './budget.js'
import { GENESIS_PREVIOUS_HASH } from './journal.js'
import { validateRef, type ObjectRef } from './object-store.js'
import { validateRngReceipt, type RngReceipt } from './rng.js'

export const REDUCER_VERSION = 'dsh-evolve-le/reducer/v1'
export const STATE_SCHEMA_VERSION = 1

export type RunPhase =
  | 'DRAFT'
  | 'PREFLIGHT'
  | 'CALIBRATED'
  | 'SEARCHING'
  | 'CANDIDATE_LOCKED'
  | 'SEALED_EVALUATED'
  | 'PROMOTED'
  | 'REJECTED'
  | 'FULL_EVALUATED'
  | 'RELEASED'
  | 'PREFLIGHT_FAILED'
  | 'CALIBRATION_INFEASIBLE'
  | 'BUDGET_EXHAUSTED'
  | 'SAFETY_ABORTED'
  | 'EVIDENCE_CORRUPT'
  | 'PROTOCOL_INVALID'
  | 'OPERATOR_STOPPED'

const EARLY_TERMINALS: RunPhase[] = [
  'PREFLIGHT_FAILED',
  'CALIBRATION_INFEASIBLE',
  'BUDGET_EXHAUSTED',
  'SAFETY_ABORTED',
  'EVIDENCE_CORRUPT',
  'PROTOCOL_INVALID',
  'OPERATOR_STOPPED',
]

/** Allowed phase edges (specs/00 §8); everything else is a violation. */
const PHASE_EDGES: Record<RunPhase, RunPhase[]> = {
  DRAFT: ['PREFLIGHT', ...EARLY_TERMINALS],
  PREFLIGHT: [
    'CALIBRATED',
    'PREFLIGHT_FAILED',
    ...EARLY_TERMINALS.filter((p) => p !== 'PREFLIGHT_FAILED'),
  ],
  CALIBRATED: [
    'SEARCHING',
    'CALIBRATION_INFEASIBLE',
    ...EARLY_TERMINALS.filter((p) => p !== 'CALIBRATION_INFEASIBLE'),
  ],
  SEARCHING: ['CANDIDATE_LOCKED', ...EARLY_TERMINALS],
  CANDIDATE_LOCKED: ['SEALED_EVALUATED', ...EARLY_TERMINALS],
  SEALED_EVALUATED: ['PROMOTED', 'REJECTED', ...EARLY_TERMINALS],
  PROMOTED: ['FULL_EVALUATED', ...EARLY_TERMINALS],
  REJECTED: ['FULL_EVALUATED', ...EARLY_TERMINALS],
  FULL_EVALUATED: ['RELEASED', ...EARLY_TERMINALS],
  RELEASED: [],
  PREFLIGHT_FAILED: [],
  CALIBRATION_INFEASIBLE: [],
  BUDGET_EXHAUSTED: [],
  SAFETY_ABORTED: [],
  EVIDENCE_CORRUPT: [],
  PROTOCOL_INVALID: [],
  OPERATOR_STOPPED: [],
}

export function isTerminalPhase(phase: RunPhase): boolean {
  return (PHASE_EDGES[phase] ?? []).length === 0
}

export type ActionStatus =
  | 'PLANNED'
  | 'RESERVED'
  | 'LAUNCHING'
  | 'RUNNING'
  | 'COLLECTING'
  | 'COMMITTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED'

/** PLANNED/LAUNCHING are controller-memory only; they are never persisted. */
const ACTION_EDGES: Record<ActionStatus, ActionStatus[]> = {
  PLANNED: ['RESERVED'],
  RESERVED: ['LAUNCHING', 'RUNNING', 'FAILED', 'CANCELLED', 'ABANDONED'],
  LAUNCHING: ['RUNNING', 'FAILED', 'CANCELLED', 'ABANDONED'],
  RUNNING: ['COLLECTING', 'FAILED', 'CANCELLED', 'ABANDONED'],
  COLLECTING: ['COMMITTED', 'FAILED', 'CANCELLED', 'ABANDONED'],
  COMMITTED: [],
  FAILED: [],
  CANCELLED: [],
  ABANDONED: [],
}

export type ObservationOutcome = 'success' | 'failure' | 'missing' | 'timeout'

/** One trial fact (specs/03 §4): reward is binary; missing/timeout are f+. */
export interface Observation {
  actionId: string
  candidateId: string
  /** Opaque dev task id — sealed task identity never reaches dev state. */
  opaqueTaskId: string
  split: 'dev-observed' | 'dev-guard'
  attempt: number
  outcome: ObservationOutcome
  reward: 0 | 1
  costUsdMicros: number | null
  durationMs: number | null
}

export type CandidateStatus =
  | 'registered'
  | 'admitted'
  | 'dev-champion'
  | 'locked'
  | 'sealed-evaluated'
  | 'promoted'
  | 'rejected'
  | 'full-evaluated'

const CANDIDATE_EDGES: Record<CandidateStatus, CandidateStatus[]> = {
  registered: ['admitted', 'dev-champion'],
  admitted: ['dev-champion'],
  'dev-champion': ['locked'],
  locked: ['sealed-evaluated'],
  'sealed-evaluated': ['promoted', 'rejected'],
  promoted: ['full-evaluated'],
  rejected: ['full-evaluated'],
  'full-evaluated': [],
}

export interface ActionState {
  actionId: string
  kind: string
  status: ActionStatus
  idempotencyKey: string
  waveId: string | null
  /** Global monotonically increasing at reservation time. */
  reservationSeq: number
  externalJobId: string | null
  artifacts: ObjectRef[]
  requestHash: string
  budgetReservations: Array<{ dimension: string; amount: number }>
  /** Set on FAILED/CANCELLED/ABANDONED; the journal keeps the exact seq. */
  failure: { reason: string } | null
}

export interface WaveState {
  waveId: string
  split: 'dev-observed' | 'dev-guard' | null
  members: string[]
  status: 'open' | 'committed'
  decisionSnapshotHash: string | null
}

export interface CandidateState {
  candidateId: string
  sourceHash: string
  parentCandidateId: string | null
  proposalActionId: string | null
  status: CandidateStatus
}

export interface RunState {
  schemaVersion: typeof STATE_SCHEMA_VERSION
  runId: string
  /** Journal bookkeeping — excluded from the core hash. */
  seq: number
  lastEventHash: string
  phase: RunPhase
  phaseEnteredAtSeq: number
  actions: Record<string, ActionState>
  waves: Record<string, WaveState>
  candidates: Record<string, CandidateState>
  observations: Record<string, Observation>
  /** `${stream}\0${counter}` → receipt. */
  rngReceipts: Record<string, RngReceipt>
  budget: Record<string, BudgetTotals>
  /** Per-action mirror balances (actionId -> dimension -> reserved/spent). */
  budgetByAction: Record<string, Record<string, { reserved: number; spent: number }>>
  externalJobs: Record<string, string>
  locks: {
    candidateLock: { candidateId: string; lockHash: string } | null
    sealedRevealed: { candidateId: string } | null
  }
  reservationCounter: number
}

export interface ReducerConfig {
  runId: string
  budgetLimits: BudgetLimits
}

export class ReducerError extends Error {
  constructor(message: string) {
    super(`reducer: ${message}`)
    this.name = 'ReducerError'
  }
}

export function initialState(config: ReducerConfig): RunState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId: config.runId,
    seq: 0,
    lastEventHash: GENESIS_PREVIOUS_HASH,
    phase: 'DRAFT',
    phaseEnteredAtSeq: 0,
    actions: {},
    waves: {},
    candidates: {},
    observations: {},
    rngReceipts: {},
    budget: {},
    budgetByAction: {},
    externalJobs: {},
    locks: { candidateLock: null, sealedRevealed: null },
    reservationCounter: 0,
  }
}

type Fields = Record<string, unknown>

/** Exact field-set + shape validation per event type (fail closed). */
function validatePayload(type: string, payload: Fields): void {
  const keys = Object.keys(payload).sort().join(',')
  const expect = (wanted: string): void => {
    if (keys !== wanted) {
      throw new ReducerError(`${type} payload fields ${keys} != ${wanted}`)
    }
  }
  const nonEmptyString = (value: unknown, what: string): void => {
    if (typeof value !== 'string' || value === '') {
      throw new ReducerError(`${type}.${what} must be a non-empty string`)
    }
  }
  switch (type) {
    case 'run.phase.changed': {
      expect('reason,to')
      nonEmptyString(payload['to'], 'to')
      if (typeof payload['reason'] !== 'string') throw new ReducerError('reason must be a string')
      break
    }
    case 'action.reserved': {
      expect('actionId,budget,idempotencyKey,kind,request,waveId')
      nonEmptyString(payload['actionId'], 'actionId')
      nonEmptyString(payload['kind'], 'kind')
      nonEmptyString(payload['idempotencyKey'], 'idempotencyKey')
      if (typeof payload['request'] !== 'object' || payload['request'] === null) {
        throw new ReducerError('request must be an object')
      }
      if (payload['waveId'] !== null && typeof payload['waveId'] !== 'string') {
        throw new ReducerError('waveId must be a string or null')
      }
      if (!Array.isArray(payload['budget'])) throw new ReducerError('budget must be an array')
      for (const item of payload['budget'] as Fields[]) {
        const itemKeys = Object.keys(item).sort().join(',')
        if (itemKeys !== 'amount,dimension') {
          throw new ReducerError(`budget item fields ${itemKeys}`)
        }
        if (
          typeof item['amount'] !== 'number' ||
          !Number.isSafeInteger(item['amount']) ||
          item['amount'] <= 0
        ) {
          throw new ReducerError('budget amount must be a positive safe integer')
        }
        if (typeof item['dimension'] !== 'string' || item['dimension'] === '') {
          throw new ReducerError('budget dimension must be non-empty')
        }
      }
      canonicalJson(payload['request'])
      break
    }
    case 'action.launched': {
      expect('actionId,externalJobId,provider')
      nonEmptyString(payload['actionId'], 'actionId')
      nonEmptyString(payload['externalJobId'], 'externalJobId')
      nonEmptyString(payload['provider'], 'provider')
      break
    }
    case 'action.observed-terminal': {
      expect('actionId,fact')
      nonEmptyString(payload['actionId'], 'actionId')
      if (typeof payload['fact'] !== 'object' || payload['fact'] === null) {
        throw new ReducerError('fact must be an object')
      }
      canonicalJson(payload['fact'])
      break
    }
    case 'artifact.collected': {
      expect('actionId,artifact')
      nonEmptyString(payload['actionId'], 'actionId')
      if (typeof payload['artifact'] !== 'object' || payload['artifact'] === null) {
        throw new ReducerError('artifact must be an object ref')
      }
      canonicalJson(payload['artifact'])
      break
    }
    case 'action.committed': {
      expect('actionId,observation')
      nonEmptyString(payload['actionId'], 'actionId')
      if (payload['observation'] !== null) validateObservation(payload['observation'] as Fields)
      break
    }
    case 'action.terminal': {
      expect('actionId,reason,status')
      nonEmptyString(payload['actionId'], 'actionId')
      nonEmptyString(payload['reason'], 'reason')
      if (!['FAILED', 'CANCELLED', 'ABANDONED'].includes(payload['status'] as string)) {
        throw new ReducerError('terminal status must be FAILED/CANCELLED/ABANDONED')
      }
      break
    }
    case 'wave.planned': {
      expect('members,split,waveId')
      nonEmptyString(payload['waveId'], 'waveId')
      if (!['dev-observed', 'dev-guard', null].includes(payload['split'] as string | null)) {
        throw new ReducerError('split must be dev-observed/dev-guard/null')
      }
      if (!Array.isArray(payload['members']) || payload['members'].length === 0) {
        throw new ReducerError('members must be a non-empty array')
      }
      for (const member of payload['members'] as unknown[]) {
        if (typeof member !== 'string' || member === '') {
          throw new ReducerError('members must be non-empty strings')
        }
      }
      break
    }
    case 'wave.committed': {
      expect('decisionSnapshotHash,waveId')
      nonEmptyString(payload['waveId'], 'waveId')
      nonEmptyString(payload['decisionSnapshotHash'], 'decisionSnapshotHash')
      break
    }
    case 'rng.drawn': {
      expect('receipt')
      validateRngReceipt(payload['receipt'])
      break
    }
    case 'candidate.registered': {
      expect('candidateId,parentCandidateId,proposalActionId,sourceHash')
      nonEmptyString(payload['candidateId'], 'candidateId')
      nonEmptyString(payload['sourceHash'], 'sourceHash')
      if (
        payload['parentCandidateId'] !== null &&
        typeof payload['parentCandidateId'] !== 'string'
      ) {
        throw new ReducerError('parentCandidateId must be a string or null')
      }
      if (payload['proposalActionId'] !== null && typeof payload['proposalActionId'] !== 'string') {
        throw new ReducerError('proposalActionId must be a string or null')
      }
      break
    }
    case 'candidate.status.changed': {
      expect('candidateId,reason,to')
      nonEmptyString(payload['candidateId'], 'candidateId')
      nonEmptyString(payload['to'], 'to')
      if (typeof payload['reason'] !== 'string') throw new ReducerError('reason must be a string')
      if (!((payload['to'] as string) in CANDIDATE_EDGES)) {
        throw new ReducerError(`unknown candidate status ${String(payload['to'])}`)
      }
      break
    }
    case 'candidate.locked': {
      expect('candidateId,lockHash')
      nonEmptyString(payload['candidateId'], 'candidateId')
      nonEmptyString(payload['lockHash'], 'lockHash')
      break
    }
    case 'sealed.revealed': {
      expect('candidateId,revealReceiptHash')
      nonEmptyString(payload['candidateId'], 'candidateId')
      nonEmptyString(payload['revealReceiptHash'], 'revealReceiptHash')
      break
    }
    case 'budget.entry': {
      expect('actionId,amount,dimension,entryHash,kind,unpricedUnits')
      nonEmptyString(payload['entryHash'], 'entryHash')
      if (typeof payload['actionId'] !== 'string' && payload['actionId'] !== null) {
        throw new ReducerError('actionId must be a string or null')
      }
      if (
        typeof payload['amount'] !== 'number' ||
        !Number.isSafeInteger(payload['amount']) ||
        payload['amount'] < 0
      ) {
        throw new ReducerError('amount must be a non-negative safe integer')
      }
      if (
        typeof payload['unpricedUnits'] !== 'number' ||
        !Number.isSafeInteger(payload['unpricedUnits']) ||
        payload['unpricedUnits'] < 0
      ) {
        throw new ReducerError('unpricedUnits must be a non-negative safe integer')
      }
      if (payload['amount'] === 0 && payload['unpricedUnits'] === 0) {
        throw new ReducerError('budget entry carries no accounting fact')
      }
      break
    }
    default:
      throw new ReducerError(`unknown event type ${type}`)
  }
}

function validateObservation(observation: Fields): void {
  const keys = Object.keys(observation).sort().join(',')
  if (
    keys !==
    'actionId,attempt,candidateId,costUsdMicros,durationMs,opaqueTaskId,outcome,reward,split'
  ) {
    throw new ReducerError(`observation fields ${keys}`)
  }
  for (const field of ['actionId', 'candidateId', 'opaqueTaskId'] as const) {
    if (typeof observation[field] !== 'string' || observation[field] === '') {
      throw new ReducerError(`observation.${field} must be a non-empty string`)
    }
  }
  if (!['dev-observed', 'dev-guard'].includes(observation['split'] as string)) {
    throw new ReducerError('observation.split must be dev-observed/dev-guard')
  }
  if (
    typeof observation['attempt'] !== 'number' ||
    !Number.isSafeInteger(observation['attempt']) ||
    observation['attempt'] < 1
  ) {
    throw new ReducerError('observation.attempt must be a positive safe integer')
  }
  if (!['success', 'failure', 'missing', 'timeout'].includes(observation['outcome'] as string)) {
    throw new ReducerError('observation.outcome is unknown')
  }
  if (observation['reward'] !== 0 && observation['reward'] !== 1) {
    throw new ReducerError('observation.reward must be 0 or 1')
  }
  if (
    (observation['reward'] as number) === 1 &&
    !['success'].includes(observation['outcome'] as string)
  ) {
    throw new ReducerError('reward 1 is only valid with outcome success')
  }
  for (const field of ['costUsdMicros', 'durationMs'] as const) {
    const value = observation[field]
    if (
      value !== null &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new ReducerError(`observation.${field} must be null or a non-negative integer`)
    }
  }
}

export function observationKey(
  candidateId: string,
  opaqueTaskId: string,
  split: string,
  attempt: number,
): string {
  return `${candidateId}\0${opaqueTaskId}\0${split}\0${attempt}`
}

function requireAction(state: RunState, actionId: string): ActionState {
  const action = state.actions[actionId]
  if (action === undefined) throw new ReducerError(`unknown action ${actionId}`)
  return action
}

function transitionAction(action: ActionState, to: ActionStatus, reason?: string): void {
  if (!(ACTION_EDGES[action.status] ?? []).includes(to)) {
    throw new ReducerError(`action ${action.actionId} cannot go ${action.status} -> ${to}`)
  }
  action.status = to
  if (to === 'FAILED' || to === 'CANCELLED' || to === 'ABANDONED') {
    action.failure = { reason: reason ?? `terminal:${to}` }
  }
}

/**
 * Rebuild the budget accounting mirror from state, apply one mirrored entry
 * (invariants enforced by {@link applyBudgetEntry}), and store both the
 * dimension totals and the per-action balances back.
 */
function mirrorBudget(state: RunState, config: ReducerConfig, payload: Fields): void {
  const kind = payload['kind']
  const dimension = payload['dimension']
  if (!['reserve', 'settle', 'release', 'refund'].includes(kind as string)) {
    throw new ReducerError(`budget.entry kind ${String(kind)} is unknown`)
  }
  if (!BUDGET_DIMENSIONS.includes(dimension as BudgetDimension)) {
    throw new ReducerError(`budget.entry dimension ${String(dimension)} is unknown`)
  }
  if (
    typeof payload['entryHash'] !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(payload['entryHash'])
  ) {
    throw new ReducerError('budget.entry entryHash must be sha256:<64-hex>')
  }
  const accounting: BudgetAccounting = {
    dimensions: new Map(
      Object.entries(state.budget).map(([name, totals]) => [
        name as BudgetDimension,
        { ...totals },
      ]),
    ),
    actions: new Map(
      Object.entries(state.budgetByAction).flatMap(([actionId, byDimension]) =>
        Object.entries(byDimension).map(([name, balance]) => [
          `${name}\0${actionId}`,
          { ...balance },
        ]),
      ),
    ),
  }
  const actionId = payload['actionId'] as string | null
  applyBudgetEntry(accounting, config.budgetLimits, {
    schemaVersion: 1,
    runId: config.runId,
    seq: 0,
    occurredAt: '',
    kind: kind as never,
    dimension: dimension as BudgetDimension,
    actionId,
    amount: payload['amount'] as number,
    unpricedUnits: payload['unpricedUnits'] as number,
    previousHash: GENESIS_PREVIOUS_HASH,
    entryHash: payload['entryHash'] as string,
  })
  for (const [name, totals] of accounting.dimensions) {
    state.budget[name] = { ...totals }
  }
  if (actionId !== null) {
    const balance = accounting.actions.get(`${String(dimension)}\0${actionId}`) ?? {
      reserved: 0,
      spent: 0,
    }
    const byDimension = state.budgetByAction[actionId] ?? {}
    byDimension[dimension as string] = { ...balance }
    state.budgetByAction[actionId] = byDimension
  }
}

/**
 * Apply one validated journal event to the state. Purity: no allocation of
 * time/randomness, no I/O — only payload facts move the state forward.
 */
export function reduceEvent(state: RunState, event: Fields, config: ReducerConfig): RunState {
  if (event['schemaVersion'] !== STATE_SCHEMA_VERSION) {
    throw new ReducerError('event schemaVersion')
  }
  if (event['runId'] !== config.runId) throw new ReducerError('event runId mismatch')
  if (event['seq'] !== state.seq + 1) {
    throw new ReducerError(`event seq ${String(event['seq'])} != expected ${state.seq + 1}`)
  }
  if (event['previousHash'] !== state.lastEventHash) {
    throw new ReducerError('event does not chain onto state')
  }
  const type = event['type']
  if (typeof type !== 'string') throw new ReducerError('event type must be a string')
  const payloadRecord = event['payload']
  if (typeof payloadRecord !== 'object' || payloadRecord === null || Array.isArray(payloadRecord)) {
    throw new ReducerError('payload must be an object')
  }
  const payload: Fields = payloadRecord as Fields
  validatePayload(type, payload)
  const next: RunState = structuredClone(state)
  next.seq = event['seq'] as number
  next.lastEventHash = event['eventHash'] as string

  switch (type) {
    case 'run.phase.changed': {
      const to = payload['to'] as RunPhase
      if (!(to in PHASE_EDGES)) throw new ReducerError(`unknown phase ${to}`)
      if (!(PHASE_EDGES[next.phase] ?? []).includes(to)) {
        throw new ReducerError(`phase ${next.phase} -> ${to} is not a legal edge`)
      }
      next.phase = to
      next.phaseEnteredAtSeq = next.seq
      break
    }
    case 'action.reserved': {
      const actionId = payload['actionId'] as string
      if (next.actions[actionId] !== undefined) {
        throw new ReducerError(`action ${actionId} already exists`)
      }
      const waveId = payload['waveId'] as string | null
      if (waveId !== null && next.waves[waveId] === undefined) {
        throw new ReducerError(`action reserved into unknown wave ${waveId}`)
      }
      next.reservationCounter += 1
      next.actions[actionId] = {
        actionId,
        kind: payload['kind'] as string,
        status: 'RESERVED',
        idempotencyKey: payload['idempotencyKey'] as string,
        waveId,
        reservationSeq: next.reservationCounter,
        externalJobId: null,
        artifacts: [],
        requestHash: canonicalHash(payload['request']),
        budgetReservations: structuredClone(payload['budget']) as Array<{
          dimension: string
          amount: number
        }>,
        failure: null,
      }
      break
    }
    case 'action.launched': {
      const action = requireAction(next, payload['actionId'] as string)
      transitionAction(action, 'RUNNING')
      action.externalJobId = payload['externalJobId'] as string
      next.externalJobs[action.actionId] = action.externalJobId
      break
    }
    case 'action.observed-terminal': {
      const action = requireAction(next, payload['actionId'] as string)
      transitionAction(action, 'COLLECTING')
      break
    }
    case 'artifact.collected': {
      const action = requireAction(next, payload['actionId'] as string)
      if (action.status !== 'COLLECTING') {
        throw new ReducerError(`artifact collected while action is ${action.status}`)
      }
      validateRef(payload['artifact'])
      action.artifacts.push(structuredClone(payload['artifact']) as ObjectRef)
      break
    }
    case 'action.committed': {
      const action = requireAction(next, payload['actionId'] as string)
      transitionAction(action, 'COMMITTED')
      const observation = payload['observation'] as Fields | null
      if (observation !== null) {
        const key = observationKey(
          observation['candidateId'] as string,
          observation['opaqueTaskId'] as string,
          observation['split'] as string,
          observation['attempt'] as number,
        )
        if (next.observations[key] !== undefined) {
          throw new ReducerError(`duplicate observation identity ${key}`)
        }
        next.observations[key] = structuredClone(observation) as unknown as Observation
      }
      break
    }
    case 'action.terminal': {
      const action = requireAction(next, payload['actionId'] as string)
      transitionAction(action, payload['status'] as ActionStatus, payload['reason'] as string)
      break
    }
    case 'wave.planned': {
      const waveId = payload['waveId'] as string
      if (next.waves[waveId] !== undefined) throw new ReducerError(`wave ${waveId} already exists`)
      const members = payload['members'] as string[]
      const seen = new Set<string>()
      for (const member of members) {
        if (seen.has(member)) throw new ReducerError(`duplicate wave member ${member}`)
        seen.add(member)
        if (next.actions[member] !== undefined) {
          throw new ReducerError(`wave member ${member} reserved before wave.planned`)
        }
      }
      next.waves[waveId] = {
        waveId,
        split: payload['split'] as WaveState['split'],
        members: [...members],
        status: 'open',
        decisionSnapshotHash: null,
      }
      break
    }
    case 'wave.committed': {
      const wave = next.waves[payload['waveId'] as string]
      if (wave === undefined) throw new ReducerError(`unknown wave ${String(payload['waveId'])}`)
      if (wave.status !== 'open') throw new ReducerError(`wave ${wave.waveId} already committed`)
      const pending = wave.members.filter((member) => {
        const status = next.actions[member]?.status
        return (
          status !== 'COMMITTED' &&
          status !== 'FAILED' &&
          status !== 'CANCELLED' &&
          status !== 'ABANDONED'
        )
      })
      if (pending.length > 0) {
        throw new ReducerError(
          `wave ${wave.waveId} still has nonterminal members: ${pending.join(',')}`,
        )
      }
      const snapshot = waveDecisionSnapshot(next, wave)
      if (snapshot !== (payload['decisionSnapshotHash'] as string)) {
        throw new ReducerError(
          `wave ${wave.waveId} decision snapshot ${String(payload['decisionSnapshotHash'])} != recomputed ${snapshot}`,
        )
      }
      wave.status = 'committed'
      wave.decisionSnapshotHash = snapshot
      break
    }
    case 'rng.drawn': {
      const receipt = structuredClone(payload['receipt']) as RngReceipt
      const key = `${receipt.stream}\0${receipt.counter}`
      const existing = next.rngReceipts[key]
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(receipt)) {
          throw new ReducerError(`conflicting rng receipt for ${key}`)
        }
        break
      }
      next.rngReceipts[key] = receipt
      break
    }
    case 'candidate.registered': {
      const candidateId = payload['candidateId'] as string
      if (next.candidates[candidateId] !== undefined) {
        throw new ReducerError(`candidate ${candidateId} already exists`)
      }
      next.candidates[candidateId] = {
        candidateId,
        sourceHash: payload['sourceHash'] as string,
        parentCandidateId: (payload['parentCandidateId'] as string | null) ?? null,
        proposalActionId: (payload['proposalActionId'] as string | null) ?? null,
        status: 'registered',
      }
      break
    }
    case 'candidate.status.changed': {
      const candidate = next.candidates[payload['candidateId'] as string]
      if (candidate === undefined)
        throw new ReducerError(`unknown candidate ${String(payload['candidateId'])}`)
      const to = payload['to'] as CandidateStatus
      if (!(CANDIDATE_EDGES[candidate.status] ?? []).includes(to)) {
        throw new ReducerError(
          `candidate ${candidate.candidateId} cannot go ${candidate.status} -> ${to}`,
        )
      }
      candidate.status = to
      break
    }
    case 'candidate.locked': {
      if (next.locks.candidateLock !== null) {
        throw new ReducerError('candidate lock is one-shot and already taken')
      }
      const candidateId = payload['candidateId'] as string
      const candidate = next.candidates[candidateId]
      if (candidate === undefined) throw new ReducerError(`unknown candidate ${candidateId}`)
      next.locks.candidateLock = {
        candidateId,
        lockHash: payload['lockHash'] as string,
      }
      break
    }
    case 'sealed.revealed': {
      if (next.locks.sealedRevealed !== null) {
        throw new ReducerError('sealed reveal is one-shot and already taken')
      }
      next.locks.sealedRevealed = {
        candidateId: payload['candidateId'] as string,
      }
      break
    }
    case 'budget.entry': {
      mirrorBudget(next, config, payload as Fields)
      break
    }
    default:
      throw new ReducerError(`unknown event type ${type}`)
  }
  return next
}

/** Deterministic decision snapshot over a wave's member observations. */
export function waveDecisionSnapshot(state: RunState, wave: WaveState): string {
  const lines = Object.values(state.observations)
    .filter((observation) => wave.members.includes(observation.actionId))
    .map((observation) => canonicalJson(observation))
    .sort()
  return canonicalHash({ waveId: wave.waveId, observations: lines })
}

/** Replay events from genesis (the reducer is a strict fold). */
export function replayEvents(events: Fields[], config: ReducerConfig): RunState {
  let state = initialState(config)
  for (const event of events) state = reduceEvent(state, event, config)
  return state
}

/**
 * The order-insensitive core of the state: everything except journal
 * bookkeeping, with all collections emitted in deterministic key order.
 * This is the value `stateHash` covers.
 */
export function hashableCore(state: RunState): Fields {
  const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const sortedActions = Object.values(state.actions)
    .sort((a, b) => byKey(a.actionId, b.actionId))
    .map((action) => ({
      ...action,
      artifacts: [...action.artifacts].sort((a, b) => byKey(a.digest, b.digest)),
    }))
  const sortedObservations = Object.entries(state.observations)
    .sort(([a], [b]) => byKey(a, b))
    .map(([_key, observation]) => observation)
  const sortedWaves = Object.values(state.waves)
    .sort((a, b) => byKey(a.waveId, b.waveId))
    .map((wave) => ({ ...wave, members: [...wave.members] }))
  const sortedCandidates = Object.values(state.candidates).sort((a, b) =>
    byKey(a.candidateId, b.candidateId),
  )
  const sortedReceipts = Object.entries(state.rngReceipts)
    .sort(([a], [b]) => byKey(a, b))
    .map(([_key, receipt]) => receipt)
  const sortedBudgetByAction = Object.fromEntries(
    Object.entries(state.budgetByAction)
      .sort(([a], [b]) => byKey(a, b))
      .map(([actionId, byDimension]) => [
        actionId,
        Object.fromEntries(Object.entries(byDimension).sort(([a], [b]) => byKey(a, b))),
      ]),
  )
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    phase: state.phase,
    actions: sortedActions,
    waves: sortedWaves,
    candidates: sortedCandidates,
    observations: sortedObservations,
    rngReceipts: sortedReceipts,
    budget: Object.fromEntries(Object.entries(state.budget).sort(([a], [b]) => byKey(a, b))),
    budgetByAction: sortedBudgetByAction,
    externalJobs: Object.fromEntries(
      Object.entries(state.externalJobs).sort(([a], [b]) => byKey(a, b)),
    ),
    locks: state.locks,
    reservationCounter: state.reservationCounter,
  }
}

export function stateHashOf(state: RunState): string {
  return canonicalHash(hashableCore(state))
}
