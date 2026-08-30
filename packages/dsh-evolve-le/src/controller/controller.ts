/**
 * Durable controller (Gate 3, specs/07 §5): the single writer that drives the
 * action saga — durable intent → keyed external effect → durable receipt →
 * commit — plus the §12 recovery sequence and a read-only status view.
 *
 * Crash-safety rules implemented here (specs/06 §13):
 * - every mutation is journaled before its external effect, and the provider
 *   is consulted by idempotency key before launching, so a resume never
 *   duplicates an external effect, a score, or a cost;
 * - artifacts are written to the object store (staging + no-clobber publish)
 *   before the artifact.collected receipt, so a crash mid-write discards
 *   staging and re-collects;
 * - commit and settle are separate durable steps checked against the folded
 *   state, so replay after a crash is idempotent per action;
 * - recovery never starts new actions: it reconciles what already exists.
 */
import {
  BudgetLedger,
  type BudgetDimension,
  type BudgetLimits,
  type BudgetTotals,
} from '../state/budget.js'
import { Journal, readJournal, type JournalConfig, type JournalEvent } from '../state/journal.js'
import { openObjectStore, type ObjectStore } from '../state/object-store.js'
import {
  reduceEvent,
  stateHashOf,
  validatePayload,
  waveDecisionSnapshot,
  type ActionState,
  type ActionStatus,
  type CandidateStatus,
  type Observation,
  type ObservationOutcome,
  type RunPhase,
  type RunState,
  type WaveState,
} from '../state/reducer.js'
import type { RngReceipt } from '../state/rng.js'
import { loadState, writeSnapshot } from '../state/snapshot.js'
import { captureCanonicalSource } from '../candidate/canonical.js'
import { storeCandidateSource } from '../candidate/store.js'
import type { ArchiveCatalog } from '../proposer/catalog.js'
import type { GatewayUsage } from '../proposer/gateway.js'
import { parseProposalOutput, type ProposalOutput } from '../proposer/protocol.js'
import {
  capsuleDigestExcludingOverlay,
  runProposalSandbox,
  supervisorManifestPath,
  verifyProposalSandboxReplay,
  workerResultPath,
  type ProposalSandboxOutcome,
  type RunProposalSandboxOptions,
  type SupervisorManifest,
  type WorkerResultDoc,
} from '../proposer/sandbox.js'
import { verifyRemoteReceipts } from '../proposer/remote-gateway.js'
import {
  readExportManifest,
  validateProposalBundle,
  type ChildVerdict,
} from '../proposer/validate.js'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireWriterLock } from './lock.js'
import type { BenchmarkProvider } from './provider.js'

export type BoundaryPoint =
  | 'intent-durable'
  | 'launch-before-effect'
  | 'launch-effect-done'
  | 'launch-receipt-durable'
  | 'terminal-observed'
  | 'artifact-stored'
  | 'action-committed'
  | 'wave-committed'

export interface ControllerConfig {
  runId: string
  budgetLimits: BudgetLimits
  segmentMaxBytes?: number
  /**
   * Fault-injection seam (specs/06 §16): invoked synchronously at every
   * durable saga boundary. Production callers omit it; the crash harness
   * kills the process here.
   */
  onBoundary?: (point: BoundaryPoint, actionId: string | null) => void | Promise<void>
  /**
   * Sandbox runner seam for the proposal saga: defaults to the real one-shot
   * uid+netns sandbox; tests substitute a lightweight materializer.
   */
  proposalRunner?: ProposalRunner
  /**
   * Wait between provider polls while an external job reports RUNNING
   * (default 2s). A resume after a mid-launch crash can find the orphaned job
   * still executing; the saga waits it out within its attempt budget instead
   * of spinning the whole budget in milliseconds and failing the run.
   */
  providerPollIntervalMs?: number
}

/** The sandbox external effect behind a proposal action. */
export type ProposalRunner = (options: RunProposalSandboxOptions) => Promise<ProposalSandboxOutcome>

/** Controller-level evaluation request (opaque payload to the reducer). */
export interface EvaluationRequest {
  candidateId: string
  opaqueTaskId: string
  attempt: number
  split: 'dev-observed' | 'dev-guard'
}

export interface EvaluationInput extends EvaluationRequest {
  actionId: string
  waveId: string | null
  /** Worst-case reservation per action (specs/06 §8). */
  estimate: Array<{ dimension: BudgetDimension; amount: number }>
}

export const TRAJECTORY_MEDIA_TYPE = 'application/vnd.dsh-evolve-le.trajectory+json'

export const PROPOSAL_TRANSCRIPT_MEDIA_TYPE =
  'application/vnd.dsh-evolve-le.proposal-transcript+jsonl'
export const PROPOSAL_RECEIPTS_MEDIA_TYPE = 'application/vnd.dsh-evolve-le.proposal-receipts+jsonl'
export const PROPOSAL_REMOTE_RECEIPTS_MEDIA_TYPE =
  'application/vnd.dsh-evolve-le.proposal-remote-receipts+jsonl'
export const PROPOSAL_BUNDLE_MEDIA_TYPE = 'application/vnd.dsh-evolve-le.proposal-bundle+json'
export const PROPOSAL_VALIDATION_MEDIA_TYPE =
  'application/vnd.dsh-evolve-le.proposal-validation+json'

/** Controller-level proposal request (the durable journal payload). */
export interface ProposalRequest {
  parentCandidateId: string
  /** Canonical source digest of the parent the children derive from. */
  parentSourceHash: string
  /** The label-filtered export id the sandbox read. */
  exportId: string
  width: number
}

export interface ProposalInput {
  actionId: string
  request: ProposalRequest
  /** Worst-case reservation (proposal-calls ≥ 1, proposer-tokens, usd). */
  estimate: Array<{ dimension: BudgetDimension; amount: number }>
  /** Controller-side sandbox materials, never trusted from the sandbox. */
  capsuleDir: string
  parentTreeDir: string
  exportDir: string
  /** Archive catalog for dedup + donor existence (dev-observed only). */
  catalog: ArchiveCatalog
  /** Canary tokens no proposal field or child source may carry. */
  canaryTokens: readonly string[]
  maxTurns?: number
  timeoutMs?: number
}

/** The durable summary of one proposal action (also its evidence artifact). */
export interface ProposalSummaryDoc {
  schemaVersion: 1
  actionId: string
  sandbox: SupervisorManifest['sandbox']
  capsuleDigest: string
  turns: number | null
  usage: GatewayUsage | null
  admitted: ChildVerdict[]
  rejected: ChildVerdict[]
  batchErrors: string[]
  registeredCandidateIds: string[]
}

export interface ProposalResult {
  actionId: string
  status: ActionStatus
  failureReason: string | null
  sandboxRoot: string
  summary: ProposalSummaryDoc
}

export class ControllerError extends Error {
  constructor(message: string) {
    super(`controller: ${message}`)
    this.name = 'ControllerError'
  }
}

export const TERMINAL_ACTIONS: ReadonlySet<ActionStatus> = new Set([
  'COMMITTED',
  'FAILED',
  'CANCELLED',
  'ABANDONED',
])

export type RecoveryDisposition = 'pending-launch' | 'running' | 'collected' | 'lost'

export interface RecoveryReport {
  resumedFromSnapshot: boolean
  /** Nonterminal actions inspected during recovery, and the disposition. */
  inspected: Array<{
    actionId: string
    externalJobId: string | null
    disposition: RecoveryDisposition
  }>
  wavesCommitted: string[]
  stateHash: string
}

export class Controller {
  private current: RunState
  private readonly committed: JournalEvent[]

  private constructor(
    readonly runDir: string,
    private readonly config: ControllerConfig,
    private readonly journal: Journal,
    private readonly ledger: BudgetLedger,
    private readonly store: ObjectStore,
    private readonly provider: BenchmarkProvider,
    private readonly releaseLock: () => Promise<void>,
    committed: JournalEvent[],
    state: RunState,
    readonly recovery: RecoveryReport,
    private readonly clock: () => string,
  ) {
    this.committed = committed
    this.current = state
  }

  /**
   * Open (or recover) a run per specs/06 §12: lock → verify chain → snapshot
   * + replay → reconcile ledger/objects/jobs → inspect nonterminal actions
   * without starting new ones → collect terminal artifacts → commit finished
   * waves → verify state hash.
   */
  static async open(
    runDir: string,
    objectsRoot: string,
    config: ControllerConfig,
    provider: BenchmarkProvider,
    clock: () => string = () => new Date().toISOString(),
  ): Promise<Controller> {
    const lock = await acquireWriterLock(runDir)
    const journalConfig: JournalConfig = {
      runId: config.runId,
      segmentMaxBytes: config.segmentMaxBytes ?? 1 << 20,
    }
    const reducerConfig = { runId: config.runId, budgetLimits: config.budgetLimits }
    const journal = await Journal.open(runDir, journalConfig)
    const { events } = await readJournal(runDir, journalConfig)
    const loaded = await loadState(runDir, reducerConfig, events)
    const ledger = await BudgetLedger.open(runDir, config.runId, config.budgetLimits)
    // §12 step 5: the ledger and the mirrored journal totals must agree.
    ledger.assertMatches(loaded.state.budget)
    const store = await openObjectStore(objectsRoot)
    // §12 step 5 (objects): every referenced artifact must verify.
    for (const action of Object.values(loaded.state.actions)) {
      for (const ref of action.artifacts) {
        await store.verify(ref)
      }
      const mapped = loaded.state.externalJobs[action.actionId]
      if (mapped !== undefined && action.externalJobId !== mapped) {
        throw new ControllerError(
          `external job mapping for ${action.actionId} disagrees with action state`,
        )
      }
    }

    const controller = new Controller(
      runDir,
      config,
      journal,
      ledger,
      store,
      provider,
      lock.release,
      events,
      loaded.state,
      {
        resumedFromSnapshot: loaded.resumedFromSnapshot,
        inspected: [],
        wavesCommitted: [],
        stateHash: loaded.stateHash,
      },
      clock,
    )
    // §12 steps 6–8: inspect and reconcile; no new actions.
    await controller.reconcile()
    return controller
  }

  get state(): RunState {
    return this.current
  }

  /** §12 steps 6–8: reconcile nonterminal actions and complete waves. */
  private async reconcile(): Promise<void> {
    const pending = Object.values(this.current.actions).filter(
      (action) => !TERMINAL_ACTIONS.has(action.status),
    )
    for (const action of pending) {
      if (action.externalJobId === null) {
        // Crash between intent and launch: the effect never happened; the
        // saga resumes it later with the same idempotency key.
        this.recovery.inspected.push({
          actionId: action.actionId,
          externalJobId: null,
          disposition: 'pending-launch',
        })
        continue
      }
      if (action.kind === 'proposal') {
        // Proposal "jobs" are sandbox roots, not provider jobs. The worker
        // result manifest is written last: present → the effect is done and
        // runProposal resumes collection; absent → the effect never
        // completed and re-running it is safe (deterministic re-stage).
        this.recovery.inspected.push({
          actionId: action.actionId,
          externalJobId: action.externalJobId,
          disposition: existsSync(workerResultPath(action.externalJobId))
            ? 'running'
            : 'pending-launch',
        })
        continue
      }
      const { status } = await this.provider.inspect(action.externalJobId)
      if (status === 'RUNNING') {
        this.recovery.inspected.push({
          actionId: action.actionId,
          externalJobId: action.externalJobId,
          disposition: 'running',
        })
        continue
      }
      if (status === 'LOST' || status === 'UNKNOWN') {
        // Provider-confirmed lost job (specs/06 §12 step 7): record a missing
        // outcome — it counts as a failed trial, with unpriced usage.
        await this.settleMissing(action, `provider-${status.toLowerCase()}`)
        this.recovery.inspected.push({
          actionId: action.actionId,
          externalJobId: action.externalJobId,
          disposition: 'lost',
        })
        continue
      }
      await this.observeAndCollect(action)
      this.recovery.inspected.push({
        actionId: action.actionId,
        externalJobId: action.externalJobId,
        disposition: 'collected',
      })
    }
    // Step 8: commit waves whose members are all terminal, in reservation order.
    for (const wave of Object.values(this.current.waves)) {
      if (wave.status === 'open' && this.waveMembersTerminal(wave)) {
        await this.commitWave(wave.waveId)
        this.recovery.wavesCommitted.push(wave.waveId)
      }
    }
    // Step 9: verify invariants after reconciliation.
    this.ledger.assertMatches(this.current.budget)
    this.recovery.stateHash = stateHashOf(this.current)
  }

  private waveMembersTerminal(wave: WaveState): boolean {
    return wave.members.every((actionId) => {
      const action = this.current.actions[actionId]
      return action !== undefined && TERMINAL_ACTIONS.has(action.status)
    })
  }

  private action(actionId: string): ActionState {
    const action = this.current.actions[actionId]
    if (action === undefined) throw new ControllerError(`unknown action ${actionId}`)
    return action
  }

  private async boundary(point: BoundaryPoint, actionId: string | null): Promise<void> {
    await this.config.onBoundary?.(point, actionId)
  }

  private async emit(type: string, payload: Record<string, unknown>): Promise<JournalEvent> {
    // Validate BEFORE the append: a malformed payload must fail closed while
    // the run root stays replayable — an invalid event that reaches the
    // journal poisons every future replay (crash-safety, specs/06 §12).
    validatePayload(type, payload)
    const event = await this.journal.append({
      type,
      actor: 'controller',
      occurredAt: this.clock(),
      payload,
    })
    this.committed.push(event)
    this.current = reduceEvent(this.current, event as never, {
      runId: this.config.runId,
      budgetLimits: this.config.budgetLimits,
    })
    return event
  }

  private async mirrorBudget(input: {
    kind: 'reserve' | 'settle' | 'release' | 'refund'
    dimension: BudgetDimension
    actionId: string | null
    amount: number
    unpricedUnits?: number
  }): Promise<void> {
    const entry = await this.ledger.append({
      ...input,
      unpricedUnits: input.unpricedUnits ?? 0,
      occurredAt: this.clock(),
    })
    await this.emit('budget.entry', {
      kind: input.kind,
      dimension: input.dimension,
      actionId: input.actionId,
      amount: input.amount,
      unpricedUnits: input.unpricedUnits ?? 0,
      entryHash: entry.entryHash,
    })
  }

  /** The request recorded at reservation time — the journal is the truth source. */
  private requestOf(actionId: string): EvaluationRequest {
    this.action(actionId)
    const reserved = this.committed.find(
      (event) => event.type === 'action.reserved' && event.payload['actionId'] === actionId,
    )
    if (reserved === undefined) throw new ControllerError(`no reservation found for ${actionId}`)
    const request = reserved.payload['request'] as Record<string, unknown>
    if (
      typeof request['candidateId'] !== 'string' ||
      typeof request['opaqueTaskId'] !== 'string' ||
      typeof request['attempt'] !== 'number' ||
      (request['split'] !== 'dev-observed' && request['split'] !== 'dev-guard')
    ) {
      throw new ControllerError(`reservation for ${actionId} does not carry an evaluation request`)
    }
    return {
      candidateId: request['candidateId'],
      opaqueTaskId: request['opaqueTaskId'],
      attempt: request['attempt'],
      split: request['split'],
    }
  }

  async changePhase(to: RunPhase, reason: string): Promise<void> {
    await this.emit('run.phase.changed', { to, reason })
  }

  async planWave(
    waveId: string,
    split: 'dev-observed' | 'dev-guard' | null,
    members: string[],
  ): Promise<void> {
    await this.emit('wave.planned', { waveId, split, members })
  }

  async registerCandidate(input: {
    candidateId: string
    sourceHash: string
    parentCandidateId: string | null
    proposalActionId: string | null
  }): Promise<void> {
    await this.emit('candidate.registered', input)
  }

  /**
   * Candidate lifecycle transition (Gate 5 driver): admission after a trusted
   * rebuild, later gates' champion/lock/reveal steps. The reducer enforces the
   * legal edges; the reason string is durable evidence.
   */
  async changeCandidateStatus(input: {
    candidateId: string
    to: CandidateStatus
    reason: string
  }): Promise<void> {
    await this.emit('candidate.status.changed', input)
  }

  /**
   * Durably record an RNG receipt (specs/06 §9): every scheduler draw the
   * driver acted on lands in the journal, idempotent per stream+counter.
   */
  async recordRngDraw(receipt: RngReceipt): Promise<void> {
    await this.emit('rng.drawn', { receipt })
  }

  /**
   * Full evaluation saga, resumable at every boundary. Each step first checks
   * the folded state, so calling this twice — or after a crash — completes
   * the remaining steps without duplicating any external effect.
   */
  async runEvaluation(input: EvaluationInput): Promise<Observation> {
    if (this.current.actions[input.actionId]?.status === 'COMMITTED') {
      return this.observationOf(input.actionId)
    }
    await this.reserve(input)
    await this.launch(input.actionId)
    await this.awaitTerminal(input.actionId)
    return this.collectAndCommit(input.actionId)
  }

  /**
   * Resume a nonterminal evaluation action whose reservation already carries
   * the request (specs/06 §12): the idempotent saga completes the remaining
   * steps — exactly-once by key — without re-deciding anything.
   */
  async resumeEvaluation(actionId: string): Promise<Observation> {
    const action = this.action(actionId)
    if (action.kind !== 'evaluation') {
      throw new ControllerError(`${actionId} is not an evaluation action`)
    }
    if (action.status === 'COMMITTED') {
      return this.observationOf(actionId)
    }
    if (TERMINAL_ACTIONS.has(action.status)) {
      throw new ControllerError(`${actionId} is already terminal (${action.status})`)
    }
    await this.launch(actionId)
    await this.awaitTerminal(actionId)
    return this.collectAndCommit(actionId)
  }

  // ---------------------------------------------------------------------
  // Proposal saga (Gate 4, specs/07 §6): one sandboxed proposer call per
  // action. The external effect is the one-shot sandbox run; its worker
  // result manifest is written LAST, so "manifest present" is the keyed
  // idempotency marker for the effect and a crash before it is safe to
  // re-run (the sandbox re-stages deterministically from scratch). Nothing
  // the sandbox produced is trusted until the controller-side replay and
  // bundle validation pass.
  // ---------------------------------------------------------------------

  async runProposal(input: ProposalInput): Promise<ProposalResult> {
    const existing = this.current.actions[input.actionId]
    if (existing !== undefined && TERMINAL_ACTIONS.has(existing.status)) {
      return this.proposalResultOf(input.actionId)
    }
    await this.reserveProposalAction(input)
    const sandboxRoot = join(this.runDir, 'sandboxes', input.actionId)
    await this.launchProposalSandbox(input, sandboxRoot)
    return this.collectProposal(input, sandboxRoot)
  }

  private async reserveProposalAction(input: ProposalInput): Promise<void> {
    if (this.current.actions[input.actionId] !== undefined) {
      return // intent already durable
    }
    await this.emit('action.reserved', {
      actionId: input.actionId,
      kind: 'proposal',
      idempotencyKey: `propose-${input.actionId}`,
      request: input.request,
      waveId: null,
      budget: input.estimate,
    })
    for (const { dimension, amount } of input.estimate) {
      await this.mirrorBudget({ kind: 'reserve', dimension, actionId: input.actionId, amount })
    }
    await this.boundary('intent-durable', input.actionId)
  }

  /** Manifest-last idempotency: the effect ran iff its result manifest exists. */
  private async launchProposalSandbox(input: ProposalInput, sandboxRoot: string): Promise<void> {
    if (this.current.externalJobs[input.actionId] !== undefined) {
      return // launch receipt already durable
    }
    await this.boundary('launch-before-effect', input.actionId)
    if (!existsSync(workerResultPath(sandboxRoot))) {
      const runner = this.config.proposalRunner ?? runProposalSandbox
      await runner({
        sandboxRoot,
        capsuleDir: input.capsuleDir,
        exportDir: input.exportDir,
        parentTreeDir: input.parentTreeDir,
        parentSourceHash: input.request.parentSourceHash,
        width: input.request.width,
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      })
    }
    await this.boundary('launch-effect-done', input.actionId)
    await this.emit('action.launched', {
      actionId: input.actionId,
      externalJobId: sandboxRoot,
      provider: 'proposal-sandbox',
    })
    await this.boundary('launch-receipt-durable', input.actionId)
  }

  /** Read the sandbox's durable facts (supervisor manifest + worker result). */
  private async readSandboxFacts(
    sandboxRoot: string,
  ): Promise<{ supervisor: SupervisorManifest; worker: WorkerResultDoc }> {
    const supervisor = JSON.parse(
      await readFile(supervisorManifestPath(sandboxRoot), 'utf8'),
    ) as SupervisorManifest
    const worker = JSON.parse(
      await readFile(workerResultPath(sandboxRoot), 'utf8'),
    ) as WorkerResultDoc
    return { supervisor, worker }
  }

  private async collectProposal(
    input: ProposalInput,
    sandboxRoot: string,
  ): Promise<ProposalResult> {
    let facts: { supervisor: SupervisorManifest; worker: WorkerResultDoc }
    try {
      facts = await this.readSandboxFacts(sandboxRoot)
    } catch (error) {
      // Missing or corrupt manifests: the effect is unattributable — fail
      // the action (rule 7), keeping whatever the sandbox dir still holds.
      await this.observeExternalTerminal(input.actionId, { kind: 'proposal-sandbox' })
      await this.putSandboxArtifacts(input.actionId, sandboxRoot)
      return this.failProposal(
        input.actionId,
        `sandbox manifests unreadable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const { supervisor, worker } = facts
    const capsule = await capsuleDigestExcludingOverlay(join(sandboxRoot, 'input', 'capsule'))
    const capsuleVerified = capsule.digest === supervisor.capsuleDigest
    const dacProbes = worker.dacProbes ?? []
    const dacHeld = dacProbes.length > 0 && dacProbes.every((probe) => probe.outcome === 'EACCES')
    await this.observeExternalTerminal(input.actionId, {
      kind: 'proposal-sandbox',
      sandbox: supervisor.sandbox.kind,
      uid: worker.uid,
      workerOk: worker.ok,
      dacHeld,
      capsuleVerified,
      turns: worker.turns ?? null,
    })
    await this.putSandboxArtifacts(input.actionId, sandboxRoot, supervisor)

    const hardFailure =
      worker.uid === 0
        ? 'worker ran as root'
        : !worker.ok
          ? `worker failed: ${worker.error?.slice(0, 300) ?? 'no error recorded'}`
          : !dacHeld
            ? 'DAC boundary did not hold against the controller/sealed canaries'
            : !capsuleVerified
              ? 'capsule tree drifted during the run'
              : null
    if (hardFailure !== null) {
      return this.failProposal(input.actionId, hardFailure)
    }
    return this.validateAndCommitProposal(input, sandboxRoot, supervisor, worker)
  }

  /** Persist whatever the sandbox produced — failed runs keep evidence too. */
  private async putSandboxArtifacts(
    actionId: string,
    sandboxRoot: string,
    supervisor?: SupervisorManifest,
  ): Promise<void> {
    if (this.action(actionId).artifacts.length > 0) {
      for (const ref of this.action(actionId).artifacts) await this.store.verify(ref)
      return
    }
    const put = async (path: string, mediaType: string): Promise<void> => {
      const bytes = await readFile(path).catch(() => undefined)
      if (bytes === undefined) return
      const ref = await this.store.put(bytes, { mediaType, label: 'CONTROLLER_INTERNAL' })
      await this.emit('artifact.collected', { actionId, artifact: ref })
    }
    await put(join(sandboxRoot, 'work', 'transcript.jsonl'), PROPOSAL_TRANSCRIPT_MEDIA_TYPE)
    await put(join(sandboxRoot, 'work', 'gateway-receipts.jsonl'), PROPOSAL_RECEIPTS_MEDIA_TYPE)
    await put(join(sandboxRoot, 'work', 'proposal.json'), PROPOSAL_BUNDLE_MEDIA_TYPE)
    if (supervisor?.model?.kind === 'remote') {
      // The controller-side proxy receipt chain — the authoritative usage and
      // integrity anchor for networked routes (specs/05 §7).
      await put(supervisor.model.receiptsPath, PROPOSAL_REMOTE_RECEIPTS_MEDIA_TYPE)
    }
    await this.boundary('artifact-stored', actionId)
  }

  private async validateAndCommitProposal(
    input: ProposalInput,
    sandboxRoot: string,
    supervisor: SupervisorManifest,
    worker: WorkerResultDoc,
  ): Promise<ProposalResult> {
    let usage = worker.usage ?? null
    let summary: ProposalSummaryDoc | undefined
    try {
      const proposal: ProposalOutput =
        worker.proposal ??
        (JSON.parse(await readFile(join(sandboxRoot, 'work', 'proposal.json'), 'utf8')) as never)
      parseProposalOutput(proposal)

      // Controller-side integrity verification. Recorded routes: rebuild the
      // transcript/proposal/children from the frozen sandbox inputs with the
      // recorded TCB policy and demand byte equality. Remote routes: the
      // controller cannot re-derive a networked model's responses, so anchor
      // the worker transcript to the proxy's receipt chain instead (specs/05
      // §7) — every turn must match a successful receipt with the same prompt
      // hash and a response whose sha256 equals the recorded one, on the
      // frozen route, with no gaps. Section identity is already enforced inside
      // the worker (declaredMatch) and re-anchored by the trusted builder when
      // each admitted child re-boots. (`model` is optional on read so a
      // pre-Gate-8 run root still resumes through the recorded-replay branch.)
      if (supervisor.model?.kind === 'remote') {
        const verification = await verifyRemoteReceipts({
          receiptsPath: supervisor.model.receiptsPath,
          transcriptPath: join(sandboxRoot, 'work', 'transcript.jsonl'),
          routeHash: supervisor.model.routeHash,
        })
        if (!verification.ok) {
          return this.failProposal(
            input.actionId,
            `remote receipt verification failed: ${verification.problems.join('; ').slice(0, 500)}`,
            usage,
          )
        }
        // Authoritative accounting: API-reported tokens at frozen prices.
        usage = verification.usage
      } else {
        const replayDir = join(this.runDir, 'replays', input.actionId)
        await rm(replayDir, { recursive: true, force: true })
        const replay = await verifyProposalSandboxReplay(sandboxRoot, { replayDir })
        if (
          !replay.sectionsMatch ||
          !replay.transcriptMatches ||
          !replay.proposalMatches ||
          !replay.childrenMatch
        ) {
          return this.failProposal(
            input.actionId,
            `replay verification failed (sections ${replay.sectionsMatch}, transcript ${replay.transcriptMatches}, proposal ${replay.proposalMatches}, children ${replay.childrenMatch})`,
            usage,
          )
        }
      }

      const parentSource = await captureCanonicalSource(input.parentTreeDir)
      if (`sha256:${parentSource.sha256}` !== input.request.parentSourceHash) {
        return this.failProposal(
          input.actionId,
          'parent tree no longer hashes to the declared parentSourceHash',
          usage,
        )
      }
      const exportManifest = await readExportManifest(input.exportDir)
      const validation = await validateProposalBundle({
        proposal,
        childrenRoot: join(sandboxRoot, 'work', 'children'),
        parentSource,
        exportManifest,
        catalog: input.catalog,
        canaryTokens: input.canaryTokens,
      })
      if (validation.batchErrors.length > 0) {
        return this.failProposal(
          input.actionId,
          `bundle rejected: ${validation.batchErrors.join('; ').slice(0, 500)}`,
          usage,
        )
      }

      // Import admitted children into the content-addressed candidate store;
      // each import registers the lineage in the folded state exactly once.
      const candidatesRoot = join(this.runDir, 'candidates')
      const registeredCandidateIds: string[] = []
      for (const verdict of validation.admitted) {
        const stored = await storeCandidateSource(
          candidatesRoot,
          join(sandboxRoot, 'work', 'children', verdict.childName),
        )
        if (stored.sourceHash !== verdict.sourceHash) {
          return this.failProposal(
            input.actionId,
            `stored child ${verdict.childName} hash ${stored.sourceHash} != validated ${verdict.sourceHash}`,
            usage,
          )
        }
        if (this.current.candidates[stored.candidateId] === undefined) {
          await this.registerCandidate({
            candidateId: stored.candidateId,
            sourceHash: stored.sourceHash,
            parentCandidateId: input.request.parentCandidateId,
            proposalActionId: input.actionId,
          })
        }
        registeredCandidateIds.push(stored.candidateId)
      }

      const summaryDoc: ProposalSummaryDoc = {
        schemaVersion: 1,
        actionId: input.actionId,
        sandbox: supervisor.sandbox,
        capsuleDigest: supervisor.capsuleDigest,
        turns: worker.turns ?? null,
        usage,
        admitted: validation.admitted,
        rejected: validation.rejected,
        batchErrors: validation.batchErrors,
        registeredCandidateIds,
      }
      summary = summaryDoc
      await this.putProposalSummary(input.actionId, summaryDoc)
      if (TERMINAL_ACTIONS.has(this.action(input.actionId).status)) {
        return this.proposalResultOf(input.actionId)
      }
      await this.emit('action.committed', { actionId: input.actionId, observation: null })
      await this.settleProposalBudget(input.actionId, usage)
    } catch (error) {
      return this.failProposal(
        input.actionId,
        `proposal collection failed: ${error instanceof Error ? error.message : String(error)}`,
        usage,
      )
    }
    // Outside the catch: a fault injected at this boundary must surface, not
    // be converted into a proposal failure (the commit is already durable).
    await this.boundary('action-committed', input.actionId)
    return { ...this.proposalResultOfSync(input.actionId), summary: summary! }
  }

  /** Store the validation summary artifact (idempotent by digest). */
  private async putProposalSummary(actionId: string, summary: ProposalSummaryDoc): Promise<void> {
    const existing = this.action(actionId).artifacts.find(
      (ref) => ref.mediaType === PROPOSAL_VALIDATION_MEDIA_TYPE,
    )
    if (existing !== undefined) {
      await this.store.verify(existing)
      return
    }
    const ref = await this.store.put(Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8'), {
      mediaType: PROPOSAL_VALIDATION_MEDIA_TYPE,
      label: 'CONTROLLER_INTERNAL',
    })
    await this.emit('artifact.collected', { actionId, artifact: ref })
  }

  /**
   * Settle a proposal action's budget: one proposal call, the gateway's own
   * token accounting, and its frozen-route USD cost. Settles are bounded by
   * the per-action reservation, mirroring the evaluation saga.
   */
  private async settleProposalBudget(actionId: string, usage: GatewayUsage | null): Promise<void> {
    const reserved = this.current.budgetByAction[actionId] ?? {}
    const bounded = (dimension: BudgetDimension, amount: number): number =>
      Math.min(amount, reserved[dimension]?.reserved ?? 0)
    await this.mirrorBudget({
      kind: 'settle',
      dimension: 'proposal-calls',
      actionId,
      amount: bounded('proposal-calls', 1),
    })
    await this.mirrorBudget({
      kind: 'settle',
      dimension: 'proposer-tokens',
      actionId,
      amount: bounded('proposer-tokens', usage?.totalTokens ?? 0),
      unpricedUnits: usage === null ? 1 : 0,
    })
    const cost = usage?.costUsdMicros
    await this.mirrorBudget({
      kind: 'settle',
      dimension: 'usd',
      actionId,
      amount: bounded('usd', cost ?? 0),
      unpricedUnits: cost === undefined ? 1 : 0,
    })
    await this.releaseRemainder(actionId)
  }

  /** Fail a proposal action terminally, settling its budget (rule 7: keep it). */
  private async failProposal(
    actionId: string,
    reason: string,
    usage: GatewayUsage | null = null,
  ): Promise<ProposalResult> {
    if (!TERMINAL_ACTIONS.has(this.action(actionId).status)) {
      await this.emit('action.terminal', { actionId, reason, status: 'FAILED' })
      await this.settleProposalBudget(actionId, usage)
      await this.boundary('action-committed', actionId)
    }
    return this.proposalResultOf(actionId)
  }

  /** Rebuild the result view from durable state + the summary artifact. */
  private proposalResultOfSync(actionId: string): Omit<ProposalResult, 'summary'> {
    const action = this.action(actionId)
    return {
      actionId,
      status: action.status,
      failureReason: action.failure?.reason ?? null,
      sandboxRoot: join(this.runDir, 'sandboxes', actionId),
    }
  }

  private async proposalResultOf(actionId: string): Promise<ProposalResult> {
    const action = this.action(actionId)
    const summaryRef = action.artifacts.find(
      (ref) => ref.mediaType === PROPOSAL_VALIDATION_MEDIA_TYPE,
    )
    if (summaryRef === undefined) {
      return {
        ...this.proposalResultOfSync(actionId),
        summary: {
          schemaVersion: 1,
          actionId,
          sandbox: { kind: 'netns', uid: null, detail: 'no summary recorded' },
          capsuleDigest: '',
          turns: null,
          usage: null,
          admitted: [],
          rejected: [],
          batchErrors: [action.failure?.reason ?? 'failed without a summary'],
          registeredCandidateIds: [],
        },
      }
    }
    const summary = JSON.parse(
      (await this.store.read(summaryRef)).toString('utf8'),
    ) as ProposalSummaryDoc
    return { ...this.proposalResultOfSync(actionId), summary }
  }

  private async reserve(input: EvaluationInput): Promise<void> {
    if (this.current.actions[input.actionId] !== undefined) {
      return // intent already durable
    }
    const request: EvaluationRequest = {
      candidateId: input.candidateId,
      opaqueTaskId: input.opaqueTaskId,
      attempt: input.attempt,
      split: input.split,
    }
    await this.emit('action.reserved', {
      actionId: input.actionId,
      kind: 'evaluation',
      idempotencyKey: `eval-${input.actionId}`,
      request,
      waveId: input.waveId,
      budget: input.estimate,
    })
    for (const { dimension, amount } of input.estimate) {
      await this.mirrorBudget({ kind: 'reserve', dimension, actionId: input.actionId, amount })
    }
    await this.boundary('intent-durable', input.actionId)
  }

  /** §13 rows 2–3: launch once per key, even across a crash. */
  private async launch(actionId: string): Promise<void> {
    if (this.current.externalJobs[actionId] !== undefined) {
      return // receipt already durable
    }
    const action = this.action(actionId)
    const request = this.requestOf(actionId)
    await this.boundary('launch-before-effect', actionId)
    // The key lookup covers "crashed during launch, no receipt": the effect
    // may already exist externally under this exact key.
    const known = await this.provider.inspectByKey(action.idempotencyKey)
    const { externalJobId } = known ?? (await this.provider.launch(request, action.idempotencyKey))
    await this.boundary('launch-effect-done', actionId)
    await this.emit('action.launched', {
      actionId,
      externalJobId,
      provider: this.provider.name,
    })
    await this.boundary('launch-receipt-durable', actionId)
  }

  /** Record the external terminal fact (idempotent: RUNNING → COLLECTING once). */
  private async observeExternalTerminal(
    actionId: string,
    fact: Record<string, unknown>,
  ): Promise<void> {
    const status = this.action(actionId).status
    if (status === 'COLLECTING' || TERMINAL_ACTIONS.has(status)) {
      return // the terminal fact is already durable
    }
    await this.emit('action.observed-terminal', { actionId, fact })
    await this.boundary('terminal-observed', actionId)
  }

  /** Poll until the external job reports terminal (LOST/UNKNOWN count too). */
  private async awaitTerminal(actionId: string): Promise<void> {
    const externalJobId = this.current.externalJobs[actionId]
    if (externalJobId === undefined) {
      throw new ControllerError(`action ${actionId} has no external job`)
    }
    const intervalMs = this.config.providerPollIntervalMs ?? 2000
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const { status } = await this.provider.inspect(externalJobId)
      if (status !== 'RUNNING') {
        await this.observeExternalTerminal(actionId, { status })
        return
      }
      if (intervalMs > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
      }
    }
    throw new ControllerError(`job ${externalJobId} never reached a terminal status`)
  }

  /** Recovery path: a nonterminal action whose job is already terminal. */
  private async observeAndCollect(action: ActionState): Promise<void> {
    const externalJobId = action.externalJobId
    if (externalJobId === null) {
      throw new ControllerError(`action ${action.actionId} has no external job to inspect`)
    }
    const { status } = await this.provider.inspect(externalJobId)
    await this.observeExternalTerminal(action.actionId, { status })
    await this.collectAndCommit(action.actionId)
  }

  /** §13 rows 4–7: collect (or validate an already-stored artifact), commit once. */
  private async collectAndCommit(actionId: string): Promise<Observation> {
    const request = this.requestOf(actionId)
    if (this.current.actions[actionId]?.artifacts.length === 0) {
      const externalJobId = this.current.externalJobs[actionId]
      if (externalJobId === undefined) {
        throw new ControllerError(`action ${actionId} has no external job to collect`)
      }
      const terminal = await this.provider.collect(externalJobId)
      // Object-store put is staging → fsync → no-clobber publish: a crash
      // mid-write discards staging; re-collecting re-puts the same bytes.
      const ref = await this.store.put(terminal.trajectory, {
        mediaType: TRAJECTORY_MEDIA_TYPE,
        label: request.split === 'dev-guard' ? 'DEV_GUARD' : 'DEV_OBSERVED',
      })
      await this.emit('artifact.collected', { actionId, artifact: ref })
      await this.boundary('artifact-stored', actionId)
      await this.commitObservation(
        actionId,
        request,
        terminal.outcome,
        terminal.costUsdMicros,
        terminal.durationMs,
      )
    } else {
      // Crash between collect and commit (§13 row 6): collect is idempotent
      // and never re-bills, so re-fetch the fact, validate the stored object
      // still hashes to the recorded digest, then commit exactly once.
      const externalJobId = this.current.externalJobs[actionId]
      if (externalJobId === undefined) {
        throw new ControllerError(`action ${actionId} has no external job to collect`)
      }
      const terminal = await this.provider.collect(externalJobId)
      const [stored] = this.action(actionId).artifacts
      if (stored === undefined) {
        throw new ControllerError(`action ${actionId} has a receipt without an artifact ref`)
      }
      const fresh = await this.store.put(terminal.trajectory, {
        mediaType: TRAJECTORY_MEDIA_TYPE,
        label: request.split === 'dev-guard' ? 'DEV_GUARD' : 'DEV_OBSERVED',
      })
      if (fresh.digest !== stored.digest) {
        throw new ControllerError(
          `collected trajectory for ${actionId} does not match the stored artifact`,
        )
      }
      await this.store.verify(stored)
      await this.commitObservation(
        actionId,
        request,
        terminal.outcome,
        terminal.costUsdMicros,
        terminal.durationMs,
      )
    }
    return this.observationOf(actionId)
  }

  private async commitObservation(
    actionId: string,
    request: EvaluationRequest,
    outcome: ObservationOutcome,
    costUsdMicros: number | null,
    durationMs: number | null,
  ): Promise<void> {
    if (TERMINAL_ACTIONS.has(this.action(actionId).status)) {
      return // committed exactly once
    }
    const observation: Observation = {
      actionId,
      candidateId: request.candidateId,
      opaqueTaskId: request.opaqueTaskId,
      split: request.split,
      attempt: request.attempt,
      outcome,
      reward: outcome === 'success' ? 1 : 0,
      costUsdMicros,
      durationMs,
    }
    await this.emit('action.committed', { actionId, observation })
    // Cost receipt present → settle priced; absent → settle zero and record
    // the usage as unpriced (never silently free).
    const priced = costUsdMicros ?? 0
    const unpriced = costUsdMicros === null ? 1 : 0
    await this.mirrorBudget({
      kind: 'settle',
      dimension: 'usd',
      actionId,
      amount: priced,
      unpricedUnits: unpriced,
    })
    await this.mirrorBudget({ kind: 'settle', dimension: 'task-trials', actionId, amount: 1 })
    // The worst-case remainder is no longer at risk once the trial committed:
    // release it back to available (specs/06 §8). Idempotent — the mirrored
    // per-action balance drives the amount, so a second pass releases zero.
    await this.releaseRemainder(actionId)
    await this.boundary('action-committed', actionId)
  }

  /** Release every remaining worst-case reservation of a settled action. */
  private async releaseRemainder(actionId: string): Promise<void> {
    const perAction = this.current.budgetByAction[actionId] ?? {}
    for (const [dimension, balance] of Object.entries(perAction)) {
      if (balance.reserved > 0) {
        await this.mirrorBudget({
          kind: 'release',
          dimension: dimension as BudgetDimension,
          actionId,
          amount: balance.reserved,
        })
      }
    }
  }

  /** Provider-confirmed lost job: counts as a failed trial, usage unpriced. */
  private async settleMissing(action: ActionState, reason: string): Promise<void> {
    await this.observeExternalTerminal(action.actionId, { status: 'LOST', reason })
    if (TERMINAL_ACTIONS.has(this.action(action.actionId).status)) {
      return
    }
    const request = this.requestOf(action.actionId)
    const observation: Observation = {
      actionId: action.actionId,
      candidateId: request.candidateId,
      opaqueTaskId: request.opaqueTaskId,
      split: request.split,
      attempt: request.attempt,
      outcome: 'missing',
      reward: 0,
      costUsdMicros: null,
      durationMs: null,
    }
    await this.emit('action.committed', { actionId: action.actionId, observation })
    await this.mirrorBudget({
      kind: 'settle',
      dimension: 'usd',
      actionId: action.actionId,
      amount: 0,
      unpricedUnits: 1,
    })
    await this.mirrorBudget({
      kind: 'settle',
      dimension: 'task-trials',
      actionId: action.actionId,
      amount: 1,
    })
    await this.releaseRemainder(action.actionId)
    await this.boundary('action-committed', action.actionId)
  }

  private observationOf(actionId: string): Observation {
    const request = this.requestOf(actionId)
    const key = [request.candidateId, request.opaqueTaskId, request.split, request.attempt].join(
      '\0',
    )
    const observation = this.current.observations[key]
    if (observation === undefined) {
      throw new ControllerError(`action ${actionId} committed without an observation`)
    }
    return observation
  }

  /** §12 step 8: commit an open wave whose members are all terminal. */
  async commitWave(waveId: string): Promise<void> {
    const wave = this.current.waves[waveId]
    if (wave === undefined) throw new ControllerError(`unknown wave ${waveId}`)
    if (wave.status === 'committed') return
    if (!this.waveMembersTerminal(wave)) {
      throw new ControllerError(`wave ${waveId} still has nonterminal members`)
    }
    // Members commit in reservation order regardless of completion order.
    // (The reducer re-verifies the decision snapshot over the observations at
    // fold time, so a member that lacks its observation cannot sneak through.)
    const snapshotHash = waveDecisionSnapshot(this.current, this.current.waves[waveId] ?? wave)
    await this.emit('wave.committed', { waveId, decisionSnapshotHash: snapshotHash })
    await this.boundary('wave-committed', null)
  }

  /** Write a snapshot (derived, disposable cache); the lock stays held. */
  async snapshot(): Promise<void> {
    await writeSnapshot(this.runDir, this.current)
  }

  /**
   * Flush and release: persist a snapshot, close journal handles, then drop
   * the single-writer lock. After this returns there is no worker, file
   * handle, or process belonging to this controller.
   */
  async close(): Promise<void> {
    await this.snapshot()
    await this.journal.close()
    await this.releaseLock()
  }

  status(): RunStatus {
    this.ledger.assertMatches(this.current.budget)
    return statusOf(this.config.runId, this.current, this.ledger, this.recovery.resumedFromSnapshot)
  }
}

export interface RunStatus {
  runId: string
  phase: RunPhase
  seq: number
  stateHash: string
  resumedFromSnapshot: boolean
  reservationCounter: number
  observationCount: number
  actions: Array<{
    actionId: string
    status: ActionStatus
    externalJobId: string | null
    waveId: string | null
  }>
  waves: Array<{ waveId: string; status: string; members: number }>
  budget: Record<string, BudgetTotals>
}

function statusOf(
  runId: string,
  state: RunState,
  ledger: BudgetLedger,
  resumedFromSnapshot: boolean,
): RunStatus {
  return {
    runId,
    phase: state.phase,
    seq: state.seq,
    stateHash: stateHashOf(state),
    resumedFromSnapshot,
    reservationCounter: state.reservationCounter,
    observationCount: Object.keys(state.observations).length,
    actions: Object.values(state.actions)
      .sort((a, b) => a.reservationSeq - b.reservationSeq)
      .map((action) => ({
        actionId: action.actionId,
        status: action.status,
        externalJobId: action.externalJobId,
        waveId: action.waveId,
      })),
    waves: Object.values(state.waves).map((wave) => ({
      waveId: wave.waveId,
      status: wave.status,
      members: wave.members.length,
    })),
    budget: ledger.totals(),
  }
}

/**
 * Read-only status view (specs/07 §5): no lock, no mutation, safe while a
 * controller is running. Reads the journal HEAD-committed prefix, replays or
 * resumes from a snapshot, and cross-checks the ledger.
 */
export async function readRunStatus(runDir: string, config: ControllerConfig): Promise<RunStatus> {
  const journalConfig: JournalConfig = {
    runId: config.runId,
    segmentMaxBytes: config.segmentMaxBytes ?? 1 << 20,
  }
  const { events } = await readJournal(runDir, journalConfig)
  const reducerConfig = { runId: config.runId, budgetLimits: config.budgetLimits }
  const loaded = await loadState(runDir, reducerConfig, events)
  const ledger = await BudgetLedger.open(runDir, config.runId, config.budgetLimits)
  ledger.assertMatches(loaded.state.budget)
  return statusOf(config.runId, loaded.state, ledger, loaded.resumedFromSnapshot)
}
