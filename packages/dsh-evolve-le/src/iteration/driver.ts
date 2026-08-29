/**
 * Iteration driver (Gate 5, specs/07 §7): one closed loop behind one command —
 * propose → build → real Loader → Harbor evaluate → normalize → Archive
 * commit — over the durable controller. The driver owns no hidden state: the
 * controller journal is the truth source, and every driver-local fact (run
 * manifest, split ceremony, failure pool, search counters, capsule records,
 * archive catalog) is a content-checked file under the run root that must
 * re-derive identically on resume or fail closed.
 *
 * Selection policy (specs/03): discovery runs the baseline on observed tasks
 * in frozen ceremony order until a real failure appears (hard cap
 * `maxDiscoveryTrials`, state `NO_REAL_FAILURE_SIGNAL` if none does); the
 * failure pool freezes before any proposal; UCB-Air then alternates expansion
 * (parent Thompson draw → evidence export → proposal saga → trusted rebuild →
 * admission) and evaluation (cold start from the pool, then node Thompson),
 * stopping at K, the trial cap, budget exhaustion, or
 * `NO_ADMISSIBLE_CHILD` after `maxConsecutiveExpansionFailures`.
 *
 * Concealment invariants (CLAUDE.md rule 5): the ceremony document handed
 * around holds observed handles, opaque guard ids and the sealed root only;
 * the guard map goes to the provider bridge (TCB) and nowhere else; the
 * proposer export is label-filtered and canary-checked by the controller.
 * @module @dsh-evolve-le/core/iteration/driver
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCandidate } from '../builder/pipeline.js'
import { loadCandidateSource } from '../candidate/store.js'
import {
  Controller,
  TERMINAL_ACTIONS,
  type ControllerConfig,
  type ProposalResult,
} from '../controller/controller.js'
import type { ProposalRunner } from '../controller/controller.js'
import type { BenchmarkProvider } from '../controller/provider.js'
import { buildArchiveCatalog } from '../proposer/catalog.js'
import { createEvidenceExport, PROPOSER_READ_LABELS } from '../proposer/export.js'
import { deriveCanaryTokens } from '../proposer/canary.js'
import type { RunConfig } from '../config/run-config.js'
import { proposalSandboxLimits } from '../config/run-config.js'
import { drawNodeThompson, drawParentThompson } from '../selection/thompson.js'
import { shouldExpand } from '../selection/ucbair.js'
import { runSplitCeremony, type SplitCeremony } from '../split/ceremony.js'
import { stateHashOf } from '../state/reducer.js'
import type { RngReceipt } from '../state/rng.js'
import type { ObjectRef } from '../state/object-store.js'
import { hashDrawInput, sampleIndex } from '../state/rng.js'
import { openObjectStore } from '../state/object-store.js'
import { canonicalHash } from '../state/canonical.js'

export const ITERATION_PROTOCOL = 'dsh-evolve-le/iteration/v1'
export const SEARCH_STATE_PROTOCOL = 'dsh-evolve-le/search-state/v1'
export const FAILURE_POOL_PROTOCOL = 'dsh-evolve-le/failure-pool/v1'

/** A trusted-builder capsule the driver can hand to the provider bridge. */
export interface BuiltCapsule {
  candidateId: string
  sourceDigest: string
  archiveSha256: string
  /** Assembled capsule directory (propose-mode boot input). */
  capsuleDir: string
  /** Staged canonical source tree (child parent-diff baseline). */
  stagedSourceDir: string
  /** Capsule tar.gz on disk (content-addressed name). */
  archivePath: string
}

export type BuildCapsuleFn = (sourceDir: string, parentTreeDir?: string) => Promise<BuiltCapsule>

/**
 * Trusted bridge to the benchmark provider: publish a capsule and bind it to
 * a candidate id, and hand over the TCB-only guard map. Implemented by the
 * CLI over the Harbor provider + artifact endpoint; tests bind a fake.
 */
export interface ProviderBridge {
  registerCapsule(
    candidateId: string,
    capsule: { archiveSha256: string; archivePath: string },
  ): Promise<void>
  setGuardMap(guardMap: Record<string, string>): Promise<void>
}

export interface IterationDriverInput {
  config: RunConfig
  /** Canonical config hash (from `validateRunConfig`); frozen into the manifest. */
  configHash: string
  /** Existing run root (holds controller/, objects/, capsules/, exports/). */
  runRoot: string
  /** Pinned task handles (the full dataset population, inventory order). */
  handles: readonly string[]
  provider: BenchmarkProvider
  bridge: ProviderBridge
  /** Defaults to the trusted builder; tests substitute a deterministic fake. */
  buildCapsule?: BuildCapsuleFn
  /** Sandbox runner seam (tests); defaults to the real one-shot sandbox. */
  proposalRunner?: ProposalRunner
  /**
   * Controller boundary seam (specs/06 §16): the CLI's crash drill kills the
   * process here after the Nth durably committed observation (Gate 6 resume
   * equivalence); tests throw to emulate process death at a safe point.
   */
  onBoundary?: ControllerConfig['onBoundary']
  clock?: () => string
  /** Canary count per export (default 4, as pinned by the Gate 4 loop). */
  canaryCount?: number
}

export type StopReason =
  | 'K_REACHED'
  | 'TRIAL_CAP'
  | 'BUDGET_EXHAUSTED'
  | 'NO_ADMISSIBLE_CHILD'
  | 'NO_REAL_FAILURE_SIGNAL'
  | 'NO_ADMISSIBLE_TASK'

export interface DriveReport {
  runId: string
  phase: string
  stopReason: StopReason
  /**
   * `STABLE_ITERATION_VERIFIED` iff K admitted non-baseline children over at
   * least two lineage depths each carry a frozen-pool evaluation (specs/03
   * §11); otherwise `STOPPED:<stopReason>`.
   */
  status: string
  /** Committed observations (discovery + search). */
  trials: number
  discoveryTrials: number
  admittedNonBaseline: number
  /** Longest parent chain from the baseline to any candidate. */
  lineageDepthMax: number
  expansionAttempts: number
  consecutiveExpansionFailures: number
  failurePool: string[]
  stateHash: string
  budget: Record<string, { spent: number; reserved: number }>
}

export class IterationDriverError extends Error {
  constructor(message: string) {
    super(`iteration: ${message}`)
    this.name = 'IterationDriverError'
  }
}

interface CapsuleRecord {
  protocol: typeof ITERATION_PROTOCOL
  candidateId: string
  sourceDigest: string
  archiveSha256: string
  /** Paths relative to the run root. */
  capsuleDir: string
  stagedSourceDir: string
  archivePath: string
}

interface SearchState {
  protocol: typeof SEARCH_STATE_PROTOCOL
  protocolVersion: 1
  expansionAttempts: number
  consecutiveExpansionFailures: number
  maxConsecutiveExpansionFailures: number
}

interface FailurePoolDoc {
  protocol: typeof FAILURE_POOL_PROTOCOL
  handles: string[]
  frozenFromObservations: number
  poolHash: string
}

const CANARY_COUNT = 4

/**
 * Default capsule build: the trusted builder, in scratch OUTSIDE the repo
 * (the lint stage must see a real tree), admitted-or-throw.
 */
const defaultBuildCapsule: BuildCapsuleFn = async (sourceDir, parentTreeDir) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'dsh-iterate-build-'))
  const build = await buildCandidate({
    sourceDir,
    workRoot,
    ...(parentTreeDir !== undefined ? { parentTreeDir } : {}),
  })
  if (build.outcome !== 'admitted' || build.capsule === undefined) {
    throw new IterationDriverError(
      `trusted builder rejected ${sourceDir}: ${build.rejection?.reason ?? 'unknown'}`,
    )
  }
  return {
    candidateId: build.candidateId,
    sourceDigest: build.sourceDigest,
    archiveSha256: build.capsule.archiveSha256,
    capsuleDir: build.artifacts.capsuleDir,
    stagedSourceDir: join(build.artifacts.workRoot, 'staged-src'),
    archivePath: build.artifacts.capsuleArchive,
  }
}

function shortId(candidateId: string): string {
  return candidateId.replace(/^c_?/, '').slice(0, 8)
}

export class IterationDriver {
  private readonly buildCapsule: BuildCapsuleFn
  private readonly canaryCount: number
  private controller: Controller | undefined

  constructor(private readonly input: IterationDriverInput) {
    this.buildCapsule = input.buildCapsule ?? defaultBuildCapsule
    this.canaryCount = input.canaryCount ?? CANARY_COUNT
  }

  private get runRoot(): string {
    return this.input.runRoot
  }

  private get config(): RunConfig {
    return this.input.config
  }

  /** Read a JSON file if present. */
  private async readJson<T>(path: string): Promise<T | null> {
    if (!existsSync(path)) return null
    return JSON.parse(await readFile(path, 'utf8')) as T
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  /** Freeze a document once: an existing copy must be identical, else fail closed. */
  private async freeze<T extends object>(path: string, doc: T): Promise<T> {
    const existing = await this.readJson<T>(path)
    if (existing !== null) {
      if (canonicalHash(existing) !== canonicalHash(doc)) {
        throw new IterationDriverError(
          `${path} is frozen and does not match the re-derived document`,
        )
      }
      return existing
    }
    await this.writeJson(path, doc)
    return doc
  }

  private capsulesRoot(): string {
    return join(this.runRoot, 'capsules')
  }

  private recordPath(candidateId: string): string {
    return join(this.capsulesRoot(), `${candidateId}.json`)
  }

  /** Persist a built capsule under the run root and bind it on the bridge. */
  private async persistCapsule(built: BuiltCapsule): Promise<CapsuleRecord> {
    const capsulesRoot = this.capsulesRoot()
    const archivePath = join(capsulesRoot, `${built.archiveSha256}.tar.gz`)
    const capsuleDir = join(capsulesRoot, built.candidateId, 'capsule')
    const stagedSourceDir = join(capsulesRoot, built.candidateId, 'src')
    if (!existsSync(archivePath)) {
      await mkdir(capsulesRoot, { recursive: true })
      await cp(built.archivePath, archivePath)
    }
    if (!existsSync(capsuleDir)) {
      await rm(capsuleDir, { recursive: true, force: true })
      await cp(built.capsuleDir, capsuleDir, { recursive: true })
    }
    if (!existsSync(stagedSourceDir)) {
      await rm(stagedSourceDir, { recursive: true, force: true })
      await cp(built.stagedSourceDir, stagedSourceDir, { recursive: true })
    }
    const record: CapsuleRecord = {
      protocol: ITERATION_PROTOCOL,
      candidateId: built.candidateId,
      sourceDigest: built.sourceDigest,
      archiveSha256: built.archiveSha256,
      capsuleDir: 'capsules/' + `${built.candidateId}/capsule`,
      stagedSourceDir: 'capsules/' + `${built.candidateId}/src`,
      archivePath: 'capsules/' + `${built.archiveSha256}.tar.gz`,
    }
    await this.freeze(this.recordPath(built.candidateId), record)
    await this.input.bridge.registerCapsule(built.candidateId, {
      archiveSha256: built.archiveSha256,
      archivePath: join(this.runRoot, record.archivePath),
    })
    return record
  }

  private async loadRecord(candidateId: string): Promise<CapsuleRecord> {
    const record = await this.readJson<CapsuleRecord>(this.recordPath(candidateId))
    if (record === null) {
      throw new IterationDriverError(`no capsule record for ${candidateId} (partial run?)`)
    }
    return record
  }

  /** Ensure a capsule record exists and is bound (idempotent across resumes). */
  private async ensureCapsuleBound(
    candidateId: string,
    build: () => Promise<BuiltCapsule>,
  ): Promise<CapsuleRecord> {
    const existing = await this.readJson<CapsuleRecord>(this.recordPath(candidateId))
    if (existing !== null) {
      await this.input.bridge.registerCapsule(candidateId, {
        archiveSha256: existing.archiveSha256,
        archivePath: join(this.runRoot, existing.archivePath),
      })
      return existing
    }
    return this.persistCapsule(await build())
  }

  private nextRngCounter(stream: string): number {
    const state = this.controller?.state
    if (state === undefined) return 1
    let max = 0
    for (const key of Object.keys(state.rngReceipts)) {
      const [keyStream, counterText] = key.split('\0')
      if (keyStream !== stream) continue
      const counter = Number.parseInt(counterText ?? '0', 10)
      if (Number.isFinite(counter) && counter > max) max = counter
    }
    return max + 1
  }

  /** The frozen search counters (specs/03 §7: recoverable, version-checked). */
  private async loadSearchState(): Promise<SearchState> {
    const path = join(this.runRoot, 'search-state.json')
    const frozen = this.config.search.maxConsecutiveExpansionFailures
    const existing = await this.readJson<SearchState>(path)
    if (existing !== null) {
      if (
        existing.protocol !== SEARCH_STATE_PROTOCOL ||
        existing.protocolVersion !== 1 ||
        existing.maxConsecutiveExpansionFailures !== frozen
      ) {
        throw new IterationDriverError(
          'search-state protocol/maxConsecutiveExpansionFailures disagree with the frozen run config',
        )
      }
      return existing
    }
    const fresh: SearchState = {
      protocol: SEARCH_STATE_PROTOCOL,
      protocolVersion: 1,
      expansionAttempts: 0,
      consecutiveExpansionFailures: 0,
      maxConsecutiveExpansionFailures: frozen,
    }
    await this.writeJson(path, fresh)
    return fresh
  }

  private async saveSearchState(state: SearchState): Promise<void> {
    await this.writeJson(join(this.runRoot, 'search-state.json'), state)
  }

  // -------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------

  async drive(): Promise<DriveReport> {
    const { config, runRoot } = this
    const controllerDir = join(runRoot, 'controller')
    const objectsRoot = join(runRoot, 'objects')

    // --- ceremony: idempotent, concealment-checked -----------------------
    const ceremony = runSplitCeremony({
      runId: config.runId,
      masterSeed: config.masterSeed,
      handles: [...this.input.handles],
    })
    await this.freeze(join(runRoot, 'split-ceremony.json'), ceremony.ceremony)
    await this.input.bridge.setGuardMap(ceremony.sealedStore.guardMap)

    // --- run manifest: the config freeze point (specs/06 §2) -------------
    const manifest = {
      schemaVersion: 1,
      protocol: ITERATION_PROTOCOL,
      runId: config.runId,
      profile: config.profile,
      configHash: this.input.configHash,
      datasetHandlesHash: `sha256:${canonicalHash([...this.input.handles].sort())}`,
      sealedRoot: ceremony.ceremony.sealedRoot,
      sealedCount: ceremony.ceremony.sealedCount,
      config,
    }
    await this.freeze(join(runRoot, 'run-manifest.json'), manifest)

    let searchState = await this.loadSearchState()

    const controller = await Controller.open(
      controllerDir,
      objectsRoot,
      {
        runId: config.runId,
        budgetLimits: {
          usd: config.budget.usd,
          'proposer-tokens': config.budget.proposerTokens,
          'proposal-calls': config.budget.proposalCalls,
          'task-trials': config.budget.taskTrials,
          'wall-clock-seconds': config.budget.wallClockMinutes * 60,
        },
        ...(this.input.proposalRunner !== undefined
          ? { proposalRunner: this.input.proposalRunner as ProposalRunner }
          : {}),
        ...(this.input.onBoundary !== undefined ? { onBoundary: this.input.onBoundary } : {}),
      },
      this.input.provider,
      this.input.clock,
    )
    this.controller = controller
    try {
      if (controller.state.phase === 'DRAFT') {
        await controller.changePhase('PREFLIGHT', `run manifest frozen ${this.input.configHash}`)
      }

      // --- baseline: build once, register, admit -------------------------
      const baselineId = await this.ensureBaseline()

      // --- discovery → frozen failure pool --------------------------------
      const pool = await this.discoverFailures(baselineId)

      let stopReason: StopReason
      if (pool === null) {
        stopReason = 'NO_REAL_FAILURE_SIGNAL'
      } else {
        const searched = await this.search(baselineId, pool)
        stopReason = searched.stopReason
        searchState = searched.searchState
      }

      // --- archive catalog ------------------------------------------------
      const catalog = buildArchiveCatalog(controller.state, {
        createdFromStateHash: `sha256:${stateHashOf(controller.state)}`,
      })
      await this.writeJson(join(runRoot, 'archive-catalog.json'), catalog)

      const observations = Object.values(controller.state.observations)
      const lineageDepthMax = this.lineageDepthMax()
      const children = this.admittedIds().filter((id) => id !== baselineId)
      const childrenEvaluatedOnPool =
        pool !== null &&
        children.every((id) =>
          observations.some(
            (observation) =>
              observation.candidateId === id && pool.includes(observation.opaqueTaskId),
          ),
        )
      const stableVerified =
        stopReason === 'K_REACHED' &&
        children.length >= config.search.kTarget &&
        lineageDepthMax >= 2 &&
        childrenEvaluatedOnPool
      const report: DriveReport = {
        runId: config.runId,
        phase: controller.state.phase,
        stopReason,
        status: stableVerified ? 'STABLE_ITERATION_VERIFIED' : `STOPPED:${stopReason}`,
        trials: observations.length,
        discoveryTrials: observations.filter((o) => o.candidateId === baselineId).length,
        admittedNonBaseline: this.admittedIds().length - 1,
        lineageDepthMax,
        expansionAttempts: searchState.expansionAttempts,
        consecutiveExpansionFailures: searchState.consecutiveExpansionFailures,
        failurePool: pool ?? [],
        stateHash: controller.status().stateHash,
        budget: Object.fromEntries(
          Object.entries(controller.status().budget).map(([dimension, totals]) => [
            dimension,
            { spent: totals.spent, reserved: totals.reserved },
          ]),
        ),
      }
      await this.writeJson(join(runRoot, 'drive-report.json'), report)
      return report
    } finally {
      await controller.close().catch(() => undefined)
      this.controller = undefined as Controller | undefined
    }
  }

  /** Candidates eligible as parents/evaluation subjects (baseline included). */
  private admittedIds(): string[] {
    const state = this.controller?.state
    if (state === undefined) return []
    return Object.values(state.candidates)
      .filter((candidate) => candidate.status === 'admitted' || candidate.status === 'dev-champion')
      .map((candidate) => candidate.candidateId)
      .sort()
  }

  /** Longest parent chain from the baseline to any registered candidate. */
  private lineageDepthMax(): number {
    const state = this.controller?.state
    if (state === undefined) return 0
    const depthOf = (candidateId: string, seen: Set<string>): number => {
      const candidate = state.candidates[candidateId]
      if (
        candidate === undefined ||
        candidate.parentCandidateId === null ||
        seen.has(candidateId)
      ) {
        return 0
      }
      seen.add(candidateId)
      return 1 + depthOf(candidate.parentCandidateId, seen)
    }
    return Math.max(0, ...Object.keys(state.candidates).map((id) => depthOf(id, new Set())))
  }

  private async ensureBaseline(): Promise<string> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const existing = Object.values(controller.state.candidates).find(
      (candidate) => candidate.parentCandidateId === null,
    )
    if (existing !== undefined) {
      await this.ensureCapsuleBound(existing.candidateId, () => {
        throw new IterationDriverError(`baseline ${existing.candidateId} has no capsule record`)
      })
      if (existing.status === 'registered') {
        await controller.changeCandidateStatus({
          candidateId: existing.candidateId,
          to: 'admitted',
          reason: 'lineage root baseline admitted by the trusted builder',
        })
      }
      return existing.candidateId
    }
    const built = await this.buildCapsule(this.config.benchmark.baselineSourceDir)
    const record = await this.persistCapsule(built)
    await controller.registerCandidate({
      candidateId: built.candidateId,
      sourceHash: built.sourceDigest,
      parentCandidateId: null,
      proposalActionId: null,
    })
    await controller.changeCandidateStatus({
      candidateId: built.candidateId,
      to: 'admitted',
      reason: `lineage root baseline admitted by the trusted builder (${record.archiveSha256.slice(0, 16)}…)`,
    })
    return built.candidateId
  }

  /**
   * Baseline failure discovery (specs/04 §4.1): observed tasks in frozen
   * ceremony order, batches of `discoveryBatchSize`, one attempt each, hard
   * cap `maxDiscoveryTrials`. Returns the frozen failure pool, or null when
   * no real failure signal exists (run must stop honestly).
   *
   * Crash resume: a crash can leave a planned batch partially run — the wave
   * and its member order are durable, so the same batch is finished before
   * any new decision (never re-planned, never shifted by `done.length`); at a
   * batch boundary the pool freezes before another paid batch may start.
   */
  private async discoverFailures(baselineId: string): Promise<string[] | null> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const config = this.config
    const ceremony = await this.readJson<SplitCeremony>(join(this.runRoot, 'split-ceremony.json'))
    if (ceremony === null) throw new IterationDriverError('split ceremony missing')
    const poolPath = join(this.runRoot, 'failure-pool.json')
    const batchSize = config.search.discoveryBatchSize

    let poolDoc = await this.readJson<FailurePoolDoc>(poolPath)
    while (poolDoc === null) {
      const done = Object.values(controller.state.observations)
        .filter((observation) => observation.candidateId === baselineId)
        .map((observation) => observation.opaqueTaskId)
      const failures = Object.values(controller.state.observations)
        .filter(
          (observation) =>
            observation.candidateId === baselineId && observation.outcome !== 'success',
        )
        .map((observation) => observation.opaqueTaskId)
        .sort()

      if (done.length % batchSize === 0) {
        // Batch boundary: freeze on any real failure BEFORE paying for more.
        if (failures.length > 0) {
          poolDoc = {
            protocol: FAILURE_POOL_PROTOCOL,
            handles: failures,
            frozenFromObservations: Object.keys(controller.state.observations).length,
            poolHash: `sha256:${canonicalHash(failures)}`,
          }
          await this.freeze(poolPath, poolDoc)
          await controller.changePhase(
            'CALIBRATED',
            `failure pool frozen: ${failures.length} handle(s) over ${done.length} discovery trial(s)`,
          )
          break
        }
        if (done.length >= config.search.maxDiscoveryTrials) {
          return null // NO_REAL_FAILURE_SIGNAL: frozen order exhausted, no failure
        }
      }

      const batchIndex = Math.floor(done.length / batchSize)
      const waveId = `discovery-${batchIndex + 1}`
      const batch = ceremony.observedHandles.slice(
        batchIndex * batchSize,
        (batchIndex + 1) * batchSize,
      )
      const members = batch.map((handle) => `eval-${shortId(baselineId)}-${handle}`)
      const wave = controller.state.waves[waveId]
      if (wave === undefined) {
        await controller.planWave(waveId, 'dev-observed', members)
      } else if (
        wave.members.length !== members.length ||
        wave.members.some((member, index) => member !== members[index])
      ) {
        throw new IterationDriverError(
          `discovery wave ${waveId} disagrees with the frozen ceremony order`,
        )
      }
      for (const handle of batch) {
        await controller.runEvaluation({
          actionId: `eval-${shortId(baselineId)}-${handle}`,
          candidateId: baselineId,
          opaqueTaskId: handle,
          attempt: 1,
          split: 'dev-observed',
          waveId,
          estimate: this.trialEstimate(),
        })
      }
      await controller.commitWave(waveId)
    }
    if (controller.state.phase === 'PREFLIGHT' || controller.state.phase === 'DRAFT') {
      await controller.changePhase(
        'CALIBRATED',
        `failure pool re-frozen on resume: ${poolDoc.handles.length} handle(s)`,
      )
    }
    return poolDoc.handles
  }

  /** Worst-case reservation per development trial (frozen by the config). */
  private trialEstimate(): Array<{ dimension: 'usd' | 'task-trials'; amount: number }> {
    return [
      {
        dimension: 'usd',
        amount: Math.floor(this.config.budget.usd / this.config.budget.taskTrials),
      },
      { dimension: 'task-trials', amount: 1 },
    ]
  }

  /** Worst-case reservation per proposal dispatch (frozen by the config). */
  private proposalEstimate(): Array<{
    dimension: 'usd' | 'proposer-tokens' | 'proposal-calls'
    amount: number
  }> {
    const calls = this.config.budget.proposalCalls
    return [
      { dimension: 'usd', amount: Math.floor(this.config.budget.usd / calls) },
      {
        dimension: 'proposer-tokens',
        amount: Math.floor(this.config.budget.proposerTokens / calls),
      },
      { dimension: 'proposal-calls', amount: 1 },
    ]
  }

  /** True when the next reservation of `estimate` cannot fit the frozen limits. */
  private budgetWouldExhaust(
    estimate: ReadonlyArray<{ dimension: string; amount: number }>,
  ): boolean {
    const state = this.controller?.state
    if (state === undefined) return true
    const limits: Record<string, number> = {
      usd: this.config.budget.usd,
      'proposer-tokens': this.config.budget.proposerTokens,
      'proposal-calls': this.config.budget.proposalCalls,
      'task-trials': this.config.budget.taskTrials,
      'wall-clock-seconds': this.config.budget.wallClockMinutes * 60,
    }
    for (const { dimension, amount } of estimate) {
      const limit = limits[dimension]
      if (limit === undefined) continue
      const totals = state.budget[dimension]
      const used = (totals?.spent ?? 0) + (totals?.reserved ?? 0) + amount
      if (used > limit) return true
    }
    return false
  }

  /** Handles a candidate has already been evaluated on. */
  private triedHandles(candidateId: string): Set<string> {
    const state = this.controller?.state
    if (state === undefined) return new Set()
    return new Set(
      Object.values(state.observations)
        .filter((observation) => observation.candidateId === candidateId)
        .map((observation) => observation.opaqueTaskId),
    )
  }

  /**
   * Deterministic task draw from the frozen pool (specs/03 §6 exception 1):
   * prefer handles no candidate has consumed yet (global low coverage), then
   * handles this candidate has not run; sampled through the 'task-sampler'
   * stream with the receipt journaled.
   */
  private async sampleTask(candidateId: string, pool: readonly string[]): Promise<string | null> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const state = controller.state
    const tried = this.triedHandles(candidateId)
    const anyoneTried = new Set(Object.values(state.observations).map((o) => o.opaqueTaskId))
    const fresh = pool.filter((handle) => !anyoneTried.has(handle))
    const perCandidate = pool.filter((handle) => !tried.has(handle))
    const candidates = fresh.length > 0 ? fresh : perCandidate
    if (candidates.length === 0) return null
    const counter = this.nextRngCounter('task-sampler')
    const { index, raw } = sampleIndex({
      masterSeed: this.config.masterSeed,
      runId: this.config.runId,
      stream: 'task-sampler',
      counter,
      population: candidates.length,
    })
    const handle = candidates[index] as string
    const receipt: RngReceipt = {
      stream: 'task-sampler',
      counter,
      algorithm: 'dsh-evolve-le/counter-hmac-sha256/v1',
      inputHash: hashDrawInput({ candidateId, pool: candidates }),
      raw,
      result: handle,
    }
    await controller.recordRngDraw(receipt)
    return handle
  }

  /** The UCB-Air search loop (specs/03 §7–8); returns the stop reason and the
   * final frozen counters (the report must not read a stale copy). */
  private async search(
    baselineId: string,
    pool: readonly string[],
  ): Promise<{ stopReason: StopReason; searchState: SearchState }> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const config = this.config
    const searchState = await this.loadSearchState()
    const alpha = config.search.ucbAirAlphaPerMille / 1000
    if (controller.state.phase === 'CALIBRATED' || controller.state.phase === 'PREFLIGHT') {
      await controller.changePhase('SEARCHING', 'ucb-air loop start (failure pool frozen)')
    }

    // Crash resume (specs/06 §12): a crash mid-saga leaves a nonterminal
    // evaluation action with its request durably reserved — complete it (the
    // saga is exactly-once by key) before any new decision is drawn.
    for (const action of Object.values(controller.state.actions)) {
      if (action.kind !== 'evaluation' || TERMINAL_ACTIONS.has(action.status)) continue
      await controller.resumeEvaluation(action.actionId)
      if (action.waveId !== null) {
        await controller.commitWave(action.waveId).catch(() => undefined)
      }
    }

    for (;;) {
      const state = controller.state
      const observations = Object.values(state.observations)
      const completedTrials = observations.length
      const admitted = this.admittedIds()
      const admittedNonBaseline = admitted.length - 1

      // K is reached only once every admitted child has its q0 cold-start
      // trials from the frozen pool (specs/03 §6 exception 1, §7: after K only
      // evaluation is allowed — the loop never stops on admission alone).
      const coldStartsPending = admitted.some(
        (candidateId) =>
          candidateId !== baselineId &&
          this.triedHandles(candidateId).size < config.search.coldStartTrials,
      )
      if (admittedNonBaseline >= config.search.kTarget && !coldStartsPending) {
        return { stopReason: 'K_REACHED', searchState }
      }
      if (completedTrials >= config.search.maxSolverTrials)
        return { stopReason: 'TRIAL_CAP', searchState }
      if (
        searchState.consecutiveExpansionFailures >= config.search.maxConsecutiveExpansionFailures
      ) {
        return { stopReason: 'NO_ADMISSIBLE_CHILD', searchState }
      }

      const expand = shouldExpand({
        completedTrials,
        pendingEvaluations: 0, // serial driver: every wave commits before the next decision
        admittedCandidates: admitted.length,
        kTarget: config.search.kTarget,
        alpha,
      })

      if (expand) {
        if (this.budgetWouldExhaust(this.proposalEstimate()))
          return { stopReason: 'BUDGET_EXHAUSTED', searchState }
        const admittedChild = await this.expand(pool)
        searchState.expansionAttempts += 1
        if (admittedChild) {
          searchState.consecutiveExpansionFailures = 0
        } else {
          searchState.consecutiveExpansionFailures += 1
        }
        await this.saveSearchState(searchState)
        if (
          searchState.consecutiveExpansionFailures >= config.search.maxConsecutiveExpansionFailures
        ) {
          return { stopReason: 'NO_ADMISSIBLE_CHILD', searchState }
        }
        continue
      }

      const next = await this.pickEvaluation(pool)
      if (next === null) return { stopReason: 'NO_ADMISSIBLE_TASK', searchState }
      if (this.budgetWouldExhaust(this.trialEstimate()))
        return { stopReason: 'BUDGET_EXHAUSTED', searchState }
      // Serial search evaluations are single-decision waves: the action runs
      // wave-less (reservation order IS the decision order), so no wave plan
      // can outlive its reservation across a crash.
      await controller.runEvaluation({
        actionId: `eval-${shortId(next.candidateId)}-${next.handle}`,
        candidateId: next.candidateId,
        opaqueTaskId: next.handle,
        attempt: 1,
        split: 'dev-observed',
        waveId: null,
        estimate: this.trialEstimate(),
      })
    }
  }

  /** Pick (candidate, handle) for the next serial evaluation. */
  private async pickEvaluation(
    pool: readonly string[],
  ): Promise<{ candidateId: string; handle: string } | null> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const admitted = this.admittedIds()
    const rootId = admitted.find(
      (candidateId) => controller.state.candidates[candidateId]?.parentCandidateId === null,
    )

    // Exception 1 (specs/03 §6): an admitted node below its q0 cold-start
    // count takes its pool trial from the frozen pool first.
    const cold = admitted.find(
      (candidateId) =>
        candidateId !== rootId &&
        this.triedHandles(candidateId).size < this.config.search.coldStartTrials,
    )
    if (cold !== undefined) {
      const handle = await this.sampleTask(cold, pool)
      if (handle !== null) {
        return { candidateId: cold, handle }
      }
    }

    const eligible = admitted.filter((candidateId) =>
      pool.some((handle) => !this.triedHandles(candidateId).has(handle)),
    )
    if (eligible.length === 0) return null
    const counter = this.nextRngCounter('scheduler-thompson')
    const draw = drawNodeThompson({
      masterSeed: this.config.masterSeed,
      runId: this.config.runId,
      counter,
      candidates: eligible.map((candidateId) => controller.state.candidates[candidateId]!),
      observations: Object.values(controller.state.observations),
    })
    await controller.recordRngDraw(draw.receipt)
    const handle = await this.sampleTask(draw.winner, pool)
    if (handle === null) return null
    return { candidateId: draw.winner, handle }
  }

  /**
   * One expansion (specs/03 §5, §7): parent Thompson draw → label-filtered
   * evidence export → proposal saga in the one-shot sandbox → trusted child
   * rebuilds → admission. Returns true when at least one child was admitted.
   */
  private async expand(pool: readonly string[]): Promise<boolean> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const state = controller.state
    const admitted = this.admittedIds()

    // Parent draw over the admitted population (clade Beta, tau=1).
    const counter = this.nextRngCounter('scheduler-thompson')
    const parentDraw = drawParentThompson({
      masterSeed: this.config.masterSeed,
      runId: this.config.runId,
      counter,
      candidates: admitted.map((candidateId) => state.candidates[candidateId]!),
      observations: Object.values(state.observations),
    })
    await controller.recordRngDraw(parentDraw.receipt)
    const parentId = parentDraw.winner
    const parentRecord = await this.loadRecord(parentId)

    // Evidence export: the frozen failure-pool trajectories, DEV_OBSERVED only.
    const failureRefs = Object.values(state.observations)
      .filter(
        (observation) =>
          observation.outcome !== 'success' && pool.includes(observation.opaqueTaskId),
      )
      .sort((a, b) => (a.actionId < b.actionId ? -1 : 1))
      .map((observation) => state.actions[observation.actionId]?.artifacts[0])
      .filter((ref): ref is ObjectRef => ref !== undefined)
    if (failureRefs.length === 0) {
      throw new IterationDriverError('failure pool has no stored trajectories to export')
    }
    const exportsRoot = join(this.runRoot, 'exports')
    await mkdir(exportsRoot, { recursive: true })
    const actionId = `prop-${Object.values(state.actions).filter((a) => a.kind === 'proposal').length + 1}`
    // Derived (not random) canaries: the manifest the proposer reads — and
    // every artifact digest downstream of it — must replay identically after a
    // crash/resume or same-seed rerun, so the tokens are keyed to the export
    // principal under the run's master seed.
    const canaryTokens = deriveCanaryTokens({
      masterSeed: this.config.masterSeed,
      runId: this.config.runId,
      principal: `proposer:${actionId}`,
      count: this.canaryCount,
    })
    const store = await openObjectStore(join(this.runRoot, 'objects'))
    const created = await createEvidenceExport({
      exportsRoot,
      store,
      principal: `proposer:${actionId}`,
      purpose: 'candidate-expansion',
      allowedLabels: [...PROPOSER_READ_LABELS],
      refs: failureRefs,
      createdFromStateHash: `sha256:${stateHashOf(state)}`,
      canaryTokens,
    })

    const catalog = buildArchiveCatalog(state, {
      createdFromStateHash: `sha256:${stateHashOf(state)}`,
    })
    const result: ProposalResult = await controller.runProposal({
      actionId,
      request: {
        parentCandidateId: parentId,
        parentSourceHash: parentRecord.sourceDigest,
        exportId: created.exportId,
        width: this.config.search.proposalWidth,
      },
      estimate: this.proposalEstimate(),
      // Networked routes get the raised one-shot budget (Gate 8); recorded
      // routes keep the fast sandbox defaults.
      ...proposalSandboxLimits(this.config),
      capsuleDir: join(this.runRoot, parentRecord.capsuleDir),
      parentTreeDir: join(this.runRoot, parentRecord.stagedSourceDir),
      exportDir: created.dir,
      catalog,
      canaryTokens,
    })
    if (result.status !== 'COMMITTED' || result.summary.admitted.length === 0) {
      return false
    }

    // Trusted rebuild of every admitted child → admission (specs/03 §2).
    const candidatesRoot = join(this.runRoot, 'controller', 'candidates')
    let admittedAny = false
    for (const verdict of result.summary.admitted) {
      const stored = await loadCandidateSource(candidatesRoot, verdict.sourceHash)
      const built = await this.buildCapsule(
        stored.treeDir,
        join(this.runRoot, parentRecord.stagedSourceDir),
      )
      if (built.candidateId !== stored.candidateId) {
        throw new IterationDriverError(
          `rebuild identity mismatch: ${built.candidateId} != registered ${stored.candidateId}`,
        )
      }
      const record = await this.persistCapsule(built)
      const child = controller.state.candidates[built.candidateId]
      if (child?.status === 'registered') {
        await controller.changeCandidateStatus({
          candidateId: built.candidateId,
          to: 'admitted',
          reason: `trusted rebuild admitted (${record.archiveSha256.slice(0, 16)}…)`,
        })
      }
      admittedAny = true
    }
    return admittedAny
  }
}
