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
 * `NO_ADMISSIBLE_CHILD` after `maxConsecutiveExpansionFailures`.  A q0 cold
 * start is an experimental obligation: it preempts a further expansion and,
 * once the failure cap is reached, the already-admitted nodes still drain
 * their q0 observations before the terminal result is recorded (ADR-052).
 *
 * Concealment invariants (CLAUDE.md rule 5): the ceremony document handed
 * around holds observed handles, opaque guard ids and the sealed root only;
 * the guard map goes to the provider bridge (TCB) and nowhere else; the
 * proposer export is label-filtered and canary-checked by the controller.
 * ADR-046 adds the dev-guard baseline segment (opaque guard trials with their
 * own embedded canaries, observed-only failure pool) and the run-level
 * information-flow monitor: export/proposal/journal boundaries that see a
 * guard or sealed token outside its designated home end the run
 * SAFETY_ABORTED with a fingerprint-only receipt.
 * @module @dsh-evolve-le/core/iteration/driver
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildCandidate, type BuildInput, type TreeV2BuildReceipts } from '../builder/pipeline.js'
import { captureCanonicalSource } from '../candidate/canonical.js'
import { loadCandidateSource } from '../candidate/store.js'
import { stageDeclaredSource } from '../builder/staging.js'
import {
  Controller,
  DIAGNOSTIC_TRACE_MEDIA_TYPE,
  TERMINAL_ACTIONS,
  type ControllerConfig,
  type ProposalResult,
} from '../controller/controller.js'
import type { ProposalRunner } from '../controller/controller.js'
import type { BenchmarkProvider } from '../controller/provider.js'
import { buildArchiveCatalog } from '../proposer/catalog.js'
import {
  createEvidenceExport,
  EvidenceExportCanaryError,
  PROPOSER_READ_LABELS,
} from '../proposer/export.js'
import { deriveCanaryTokens, type CanaryHit } from '../proposer/canary.js'
import { createInfoFlowMonitor, type InfoFlowMonitor } from './info-flow-monitor.js'
import {
  mergeProposalRejections,
  proposalRejectionOf,
  type ProposalRejectionRecord,
} from '../proposer/feedback.js'
import type { RunConfig } from '../config/run-config.js'
import { proposalSandboxLimits, solverTrackOf } from '../config/run-config.js'
import { solverRoutePlan } from '../proposer/remote-runner.js'
import { remoteRoutePlanHash } from '../proposer/remote-gateway.js'
import {
  FAILURE_ATTRIBUTION_MEDIA_TYPE,
  selectDebuggerTraces,
  type DebuggerTraceInput,
  type DurableFailureAttributor,
  type FailureAttributor,
} from '../attribution/agent-debugger.js'
import { drawNodeThompson, drawParentThompson } from '../selection/thompson.js'
import {
  buildTournamentCoverage,
  drawTournamentShortlist,
  eligibleTournamentNodes,
  scoreTournament,
  tripleLockHash,
  type TournamentCoverageWave,
} from '../selection/tournament.js'
import { shouldExpand } from '../selection/ucbair.js'
import { runSplitCeremony, type SplitCeremony, type SplitCounts } from '../split/ceremony.js'
import { stateHashOf, type Observation } from '../state/reducer.js'
import { readJournal } from '../state/journal.js'
import type { RngReceipt } from '../state/rng.js'
import type { ObjectRef } from '../state/object-store.js'
import { hashDrawInput, sampleIndex } from '../state/rng.js'
import { openObjectStore } from '../state/object-store.js'
import { canonicalHash, canonicalJson } from '../state/canonical.js'
import { persistTreeV2ReceiptDocument } from '../tree-v2/receipts.js'
import { persistTreeV2MigrationReceipt } from '../tree-v2/migration.js'
import type { TreeV2Receipt } from '../tree-v2/contract.js'

export const ITERATION_PROTOCOL = 'dsh-evolve-le/iteration/v1'
export const SEARCH_STATE_PROTOCOL = 'dsh-evolve-le/search-state/v1'
export const FAILURE_POOL_PROTOCOL = 'dsh-evolve-le/failure-pool/v1'
export const TREE_V2_MIGRATION_BINDING_PROTOCOL = 'dsh-evolve-le/tree-v2-migration-binding/v1'

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
  treeV2?: {
    modeFingerprints: Record<'solve' | 'propose', string>
    mechanismOutcomeDigest: string
    admissionReceiptDigest: string
    /** Builder-owned documents copied into the durable run evidence tree. */
    receipts?: TreeV2BuildReceipts
  }
}

export type BuildCapsuleFn = (
  sourceDir: string,
  parentTreeDir?: string,
  treeV2ParentEvidence?: BuildInput['treeV2ParentEvidence'],
) => Promise<BuildCapsuleResult>

/**
 * One trusted-build outcome. A `rejected` verdict is the builder judging the
 * SOURCE TREE (candidate tests, contract stages) and is a per-child result —
 * specs/03 §7 counts an expansion whose builds all reject as ONE failure,
 * never a driver crash. Builder-ENVIRONMENT failures (missing pinned runtime,
 * fs errors) are thrown by the builder itself and stay fail-closed.
 */
export type BuildCapsuleResult =
  | { outcome: 'admitted'; capsule: BuiltCapsule }
  | { outcome: 'rejected'; stage: string; reason: string }

/** A child the trusted builder rejected during a rebuild (specs/03 §7):
 * it stays registered in the store, is never admitted, and the reason is
 * carried into the drive report so the accounting is auditable. */
export interface RebuildRejection {
  actionId: string
  candidateId: string
  stage: string
  reason: string
}

/** A child of an expansion intent a crash left unfinished (specs/03 §7: the
 * intent counts as ONE failure at recovery and is closed, not resumed); the
 * child stays registered, is never rebuilt, never admitted. */
export interface AbandonedIntent {
  actionId: string
  candidateId: string
}

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
  /** Split allocation frozen during init for filtered populations. */
  splitCounts?: SplitCounts
  provider: BenchmarkProvider
  bridge: ProviderBridge
  /** Content-addressed Docker warm-up receipt supplied by the real CLI composition. */
  imagePrefetchReceipt?: {
    protocol: string
    path: 'image-prefetch.json'
    sha256: string
    imageCount: number
  }
  /**
   * Run-scoped verifier image repair receipt. Live solver runs may use a
   * derived task copy whose verifier dependencies were baked before launch;
   * this binds that repair to the manifest instead of silently changing the
   * upstream task environment.
   */
  verifierImageReceipt?: {
    protocol: string
    path: 'verifier-image-receipt.json'
    sha256: string
    taskCount: number
  }
  /**
   * Pre-registered sealed plan receipt (ADR-047/048): mandatory on the
   * `terminal-bench-formal` profile — drive() fails closed before any
   * external effect when it is absent, and the champion lock binds its hash.
   */
  sealedPlanReceipt?: {
    protocol: string
    path: 'sealed-plan.json'
    sha256: string
  }
  /** Defaults to the trusted builder; tests substitute a deterministic fake. */
  buildCapsule?: BuildCapsuleFn
  /** Sandbox runner seam (tests); defaults to the real one-shot sandbox. */
  proposalRunner?: ProposalRunner
  /**
   * Optional TCB Agent Debugger. It may only enrich DEV_OBSERVED evidence;
   * its output is never read by scoring, retry or selection code.
   */
  failureAttributor?: FailureAttributor
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
  | 'SAFETY_ABORTED'
  | 'NO_DEVELOPMENT_IMPROVEMENT'
  | 'CHAMPION_LOCKED'

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
  /**
   * Committed SEARCH-phase observations (discovery + search) — ADR-049:
   * `tourn-` rows are excluded and reported as `tournamentTrials`, so the
   * per-phase envelopes bound the two paid phases separately.
   */
  trials: number
  /** Baseline-candidate search-phase observations (the matrix rows). */
  discoveryTrials: number
  admittedNonBaseline: number
  /** Longest parent chain from the baseline to any candidate. */
  lineageDepthMax: number
  expansionAttempts: number
  consecutiveExpansionFailures: number
  /** Trusted-rebuild rejections (specs/03 §7): registered, never admitted. */
  rebuildRejections: RebuildRejection[]
  /** Children of crash-abandoned intents (specs/03 §7): registered, never
   * rebuilt, never admitted. */
  abandonedIntents: AbandonedIntent[]
  failurePool: string[]
  stateHash: string
  budget: Record<string, { spent: number; reserved: number }>
  /**
   * Champion tournament facts (ADR-047): present only when the run entered
   * the tournament (formal profile + K_REACHED). `tournamentTrials` counts
   * committed `tourn-` observations; the lock fields carry the champion's
   * triple hash on CANDIDATE_LOCKED / NO_DEVELOPMENT_IMPROVEMENT resumes.
   */
  tournamentTrials?: number
  /** Shortlist node ids in draw order (primary path only). */
  shortlist?: string[]
  championId?: string
  championLockHash?: string
}

export class IterationDriverError extends Error {
  constructor(message: string) {
    super(`iteration: ${message}`)
    this.name = 'IterationDriverError'
  }
}

/**
 * A known pre-ACP failure remains a scored FAIL (specs/03 §4), but it cannot
 * be evidence that a candidate-owned mechanism can repair.  Harbor's trusted
 * terminal fact records this explicitly; unknown and legacy trajectory shapes
 * stay eligible so the filter never silently discards an ambiguous failure.
 */
function isCandidateActionableTrajectory(bytes: Buffer): boolean {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      trial?: { outcome?: { agentParticipation?: unknown } }
    }
    return parsed.trial?.outcome?.agentParticipation !== 'never-initialized'
  } catch {
    return true
  }
}

/** A bounded, trusted projection of one raw Harbor terminal fact. */
function failureIndexTerminal(bytes: Buffer): {
  category: string | null
  exceptionType: string | null
  agentParticipation: string | null
  solverRequests: number | null
} {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as {
      trial?: {
        outcome?: { category?: unknown; exceptionType?: unknown; agentParticipation?: unknown }
      }
      solver?: { requests?: unknown }
    }
    const outcome = parsed.trial?.outcome
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
    return {
      category: text(outcome?.category),
      exceptionType: text(outcome?.exceptionType),
      agentParticipation: text(outcome?.agentParticipation),
      solverRequests:
        typeof parsed.solver?.requests === 'number' && Number.isSafeInteger(parsed.solver.requests)
          ? parsed.solver.requests
          : null,
    }
  } catch {
    return { category: null, exceptionType: null, agentParticipation: null, solverRequests: null }
  }
}

/**
 * Parent Thompson compares candidates only on the task stratum that the
 * search will subsequently evaluate: the frozen baseline-failure pool.  A
 * global baseline score is useful to define that pool, but mixing its solved
 * tasks into a child-only failure-pool score gives the root an unearned prior
 * advantage and makes the clade draw depend on two different task mixes.
 */
export function parentComparableObservations(
  observations: readonly Observation[],
  failurePool: readonly string[],
): Observation[] {
  const handles = new Set(failurePool)
  return observations.filter(
    (observation) => observation.split === 'dev-observed' && handles.has(observation.opaqueTaskId),
  )
}

/**
 * Internal abort signal (ADR-046): a monitor token surfaced on a guarded
 * boundary. drive() catches it, reports the hit to the information-flow
 * monitor, and closes the run as SAFETY_ABORTED — never as an ordinary
 * search failure.
 */
class SafetyAbort extends Error {
  constructor(
    readonly surface: string,
    readonly hits: CanaryHit[],
  ) {
    super(`information-flow breach on surface ${surface}: ${hits.length} canary fingerprint(s)`)
    this.name = 'SafetyAbort'
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
  treeV2?: {
    modeFingerprints: Record<'solve' | 'propose', string>
    mechanismOutcomeDigest: string
    admissionReceiptDigest: string
    /** Content-addressed builder receipts; absent on pre-tree-v2/test records. */
    receiptRefs?: Record<string, ObjectRef>
  }
}

interface SearchState {
  protocol: typeof SEARCH_STATE_PROTOCOL
  protocolVersion: 1
  expansionAttempts: number
  consecutiveExpansionFailures: number
  maxConsecutiveExpansionFailures: number
  /** Trusted-rebuild rejections this run (specs/03 §7); absent on pre-ADR-026
   * run roots, normalized to []. */
  rebuildRejections?: RebuildRejection[]
  /** Children of crash-abandoned expansion intents (specs/03 §7); absent on
   * pre-ADR-026 run roots, normalized to []. */
  abandonedIntents?: AbandonedIntent[]
  /** Per-expansion rejected children + reasons (ADR-044), merged idempotently
   * in the same save as the expansion counters; absent on pre-ADR-044 run
   * roots, normalized to []. */
  proposalRejections?: ProposalRejectionRecord[]
}

interface FailurePoolDoc {
  protocol: typeof FAILURE_POOL_PROTOCOL
  handles: string[]
  frozenFromObservations: number
  poolHash: string
}

interface TreeV2MigrationBinding {
  protocol: typeof TREE_V2_MIGRATION_BINDING_PROTOCOL
  legacySourceDigest: string
  treeV2SourceDigest: string
  resultsInherited: false
  receipt: TreeV2Receipt
  receiptRef: ObjectRef
}

const CANARY_COUNT = 4

/**
 * Default capsule build: the trusted builder, in scratch OUTSIDE the repo
 * (the lint stage must see a real tree). The builder's own verdict is
 * returned, not thrown: a rejection is a per-child result (specs/03 §7
 * "全部 build reject …… 计作一次失败"), while builder-environment errors the
 * builder raises itself still propagate and fail the run closed.
 */
const defaultBuildCapsule =
  (nativeDsh: NonNullable<RunConfig['nativeDsh']>): BuildCapsuleFn =>
  async (sourceDir, parentTreeDir, treeV2ParentEvidence) => {
    const workRoot = await mkdtemp(join(tmpdir(), 'dsh-iterate-build-'))
    const build = await buildCandidate({
      sourceDir,
      workRoot,
      nativeDshCatalogRoot: nativeDsh.catalogRoot,
      expectedDependencyClosureSha256: nativeDsh.dependencyClosureSha256,
      ...(parentTreeDir !== undefined ? { parentTreeDir } : {}),
      ...(treeV2ParentEvidence !== undefined ? { treeV2ParentEvidence } : {}),
    })
    if (build.outcome !== 'admitted' || build.capsule === undefined) {
      return {
        outcome: 'rejected',
        stage: build.rejection?.stage ?? 'unknown',
        reason: build.rejection?.reason ?? 'unknown rejection',
      }
    }
    return {
      outcome: 'admitted',
      capsule: {
        candidateId: build.candidateId,
        sourceDigest: build.sourceDigest,
        archiveSha256: build.capsule.archiveSha256,
        capsuleDir: build.artifacts.capsuleDir,
        stagedSourceDir: join(build.artifacts.workRoot, 'staged-src'),
        archivePath: build.artifacts.capsuleArchive,
        ...(build.treeV2 === undefined
          ? {}
          : {
              treeV2: {
                modeFingerprints: build.treeV2.modeFingerprints,
                mechanismOutcomeDigest: build.treeV2.receipts.mechanismOutcome.receiptDigest,
                admissionReceiptDigest: build.treeV2.receipts.admission.receiptDigest,
                receipts: build.treeV2.receipts,
              },
            }),
      },
    }
  }

function shortId(candidateId: string): string {
  return candidateId.replace(/^c_?/, '').slice(0, 8)
}

export class IterationDriver {
  private readonly buildCapsule: BuildCapsuleFn
  private readonly canaryCount: number
  private controller: Controller | undefined
  /** Run-level information-flow monitor (created in drive(), before the matrix). */
  private monitor: InfoFlowMonitor | undefined

  constructor(private readonly input: IterationDriverInput) {
    if (input.buildCapsule !== undefined) {
      this.buildCapsule = input.buildCapsule
    } else if (input.config.nativeDsh !== undefined) {
      this.buildCapsule = defaultBuildCapsule(input.config.nativeDsh)
    } else {
      throw new IterationDriverError(
        'native DSH runtime lock is required when using the built-in candidate admission pipeline',
      )
    }
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
    let treeV2ReceiptRefs: Record<string, ObjectRef> | undefined
    if (built.treeV2?.receipts !== undefined) {
      const store = await openObjectStore(join(this.runRoot, 'objects'))
      treeV2ReceiptRefs = {}
      const receiptFiles = {
        'mechanism-outcome': built.treeV2.receipts.mechanismOutcome,
        'capability-catalog': built.treeV2.receipts.capabilityCatalog,
        'materialization-receipt': built.treeV2.receipts.materialization,
        'admission-receipt': built.treeV2.receipts.admission,
      }
      for (const [name, receipt] of Object.entries(receiptFiles)) {
        treeV2ReceiptRefs[name] = await persistTreeV2ReceiptDocument(
          store,
          name as
            | 'mechanism-outcome'
            | 'capability-catalog'
            | 'materialization-receipt'
            | 'admission-receipt',
          receipt,
        )
      }
    }
    const record: CapsuleRecord = {
      protocol: ITERATION_PROTOCOL,
      candidateId: built.candidateId,
      sourceDigest: built.sourceDigest,
      archiveSha256: built.archiveSha256,
      capsuleDir: 'capsules/' + `${built.candidateId}/capsule`,
      stagedSourceDir: 'capsules/' + `${built.candidateId}/src`,
      archivePath: 'capsules/' + `${built.archiveSha256}.tar.gz`,
      ...(built.treeV2 === undefined
        ? {}
        : {
            treeV2: {
              modeFingerprints: built.treeV2.modeFingerprints,
              mechanismOutcomeDigest: built.treeV2.mechanismOutcomeDigest,
              admissionReceiptDigest: built.treeV2.admissionReceiptDigest,
              ...(treeV2ReceiptRefs === undefined ? {} : { receiptRefs: treeV2ReceiptRefs }),
            },
          }),
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
    if (record.treeV2?.receiptRefs !== undefined) {
      const store = await openObjectStore(join(this.runRoot, 'objects'))
      await store.scrub(Object.values(record.treeV2.receiptRefs))
    }
    return record
  }

  /** Ensure a capsule record exists and is bound (idempotent across resumes). */
  private async ensureCapsuleBound(
    candidateId: string,
    build: () => Promise<BuildCapsuleResult>,
  ): Promise<CapsuleRecord> {
    const existing = await this.readJson<CapsuleRecord>(this.recordPath(candidateId))
    if (existing !== null) {
      await this.input.bridge.registerCapsule(candidateId, {
        archiveSha256: existing.archiveSha256,
        archivePath: join(this.runRoot, existing.archivePath),
      })
      return existing
    }
    const fresh = await build()
    if (fresh.outcome !== 'admitted') {
      throw new IterationDriverError(
        `trusted builder rejected ${candidateId} at ${fresh.stage}: ${fresh.reason}`,
      )
    }
    return this.persistCapsule(fresh.capsule)
  }

  /**
   * Re-bind every persisted capsule record to the fresh provider bridge —
   * resume safety (specs/06 §12): the in-process capsule registry dies with
   * the process, but every admitted candidate must stay launchable or the
   * first post-resume child evaluation dies at the provider boundary.
   */
  private async rebindCapsuleRecords(): Promise<void> {
    const capsulesRoot = this.capsulesRoot()
    const entries = await readdir(capsulesRoot).catch(() => [] as string[])
    for (const entry of entries.filter((name) => name.endsWith('.json'))) {
      const record = await this.readJson<CapsuleRecord>(join(capsulesRoot, entry))
      if (record?.protocol !== ITERATION_PROTOCOL) continue
      await this.input.bridge.registerCapsule(record.candidateId, {
        archiveSha256: record.archiveSha256,
        archivePath: join(this.runRoot, record.archivePath),
      })
    }
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
      // Pre-ADR-026 run roots predate the rejection/abandonment accounting;
      // pre-ADR-044 roots predate proposal-rejection feedback; normalize so
      // one code path reads the state.
      return {
        ...existing,
        rebuildRejections: existing.rebuildRejections ?? [],
        abandonedIntents: existing.abandonedIntents ?? [],
        proposalRejections: existing.proposalRejections ?? [],
      }
    }
    const fresh: SearchState = {
      protocol: SEARCH_STATE_PROTOCOL,
      protocolVersion: 1,
      expansionAttempts: 0,
      consecutiveExpansionFailures: 0,
      maxConsecutiveExpansionFailures: frozen,
      rebuildRejections: [],
      abandonedIntents: [],
      proposalRejections: [],
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

    // --- formal gate (ADR-047/048): the pre-registered sealed plan receipt
    // is mandatory on the formal profile — fail closed before any external
    // effect, not after the search has spent money.
    if (config.profile === 'terminal-bench-formal' && this.input.sealedPlanReceipt === undefined) {
      throw new IterationDriverError(
        'profile terminal-bench-formal requires the pre-registered sealed plan receipt',
      )
    }

    // --- ceremony: idempotent, concealment-checked -----------------------
    const ceremony = runSplitCeremony({
      runId: config.runId,
      masterSeed: config.masterSeed,
      handles: [...this.input.handles],
      ...(this.input.splitCounts !== undefined ? { counts: this.input.splitCounts } : {}),
    })
    await this.freeze(join(runRoot, 'split-ceremony.json'), ceremony.ceremony)
    await this.input.bridge.setGuardMap(ceremony.sealedStore.guardMap)

    // --- information-flow monitor (ADR-046): deterministic canary families
    // for every guard task + the sealed sweep; owns every SAFETY_ABORTED
    // decision in this run.
    this.monitor = createInfoFlowMonitor({
      runRoot,
      runId: config.runId,
      masterSeed: config.masterSeed,
      guardOpaqueIds: ceremony.ceremony.guardOpaqueIds,
      canaryCount: this.canaryCount,
      ...(this.input.clock !== undefined ? { clock: this.input.clock } : {}),
    })

    // --- run manifest: the config freeze point (specs/06 §2) -------------
    // Solver fields spread only when a solver route is configured (ADR-030,
    // R1): an unconditioned key would change the manifest document and fail
    // `freeze()` on resume of every pre-solver run root.
    const solverPlan = solverRoutePlan(config)
    if (
      solverPlan !== null &&
      config.benchmark.harbor.prefetchImages === true &&
      this.input.provider.name === 'terminal-bench-2-1/harbor' &&
      this.input.imagePrefetchReceipt === undefined
    ) {
      throw new IterationDriverError(
        'real live-solver provider has no content-addressed image-prefetch receipt',
      )
    }
    const manifest = {
      schemaVersion: 1,
      protocol: ITERATION_PROTOCOL,
      runId: config.runId,
      profile: config.profile,
      configHash: this.input.configHash,
      datasetHandlesHash: `sha256:${canonicalHash([...this.input.handles].sort())}`,
      sealedRoot: ceremony.ceremony.sealedRoot,
      sealedCount: ceremony.ceremony.sealedCount,
      ...(solverPlan !== null
        ? {
            solverTrack: solverTrackOf(config) ?? 'assisted',
            solverRouteHash: remoteRoutePlanHash(solverPlan),
          }
        : {}),
      ...(solverPlan !== null && this.input.imagePrefetchReceipt !== undefined
        ? { imagePrefetchReceipt: this.input.imagePrefetchReceipt }
        : {}),
      ...(solverPlan !== null && this.input.verifierImageReceipt !== undefined
        ? { verifierImageReceipt: this.input.verifierImageReceipt }
        : {}),
      ...(this.input.sealedPlanReceipt !== undefined
        ? { sealedPlanReceipt: this.input.sealedPlanReceipt }
        : {}),
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
          // Carried only when the run solves live (ADR-030 D2): the presence
          // of the dimension is what gates the controller's solver settles.
          ...(config.budget.solverTokens !== undefined
            ? { 'solver-tokens': config.budget.solverTokens }
            : {}),
          ...(config.budget.attributionTokens !== undefined
            ? { 'attribution-tokens': config.budget.attributionTokens }
            : {}),
          ...(config.budget.attributionCalls !== undefined
            ? { 'attribution-calls': config.budget.attributionCalls }
            : {}),
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
      // Every previously admitted capsule must be launchable in THIS process
      // too — the provider registry is memory-only (specs/06 §12 resume).
      await this.rebindCapsuleRecords()

      // --- baseline: build once, register, admit -------------------------
      const baselineId = await this.ensureBaseline()

      // --- tournament terminal resume (ADR-047) ---------------------------
      // A locked or NO_DEVELOPMENT_IMPROVEMENT run must never re-derive the
      // failure pool: the baseline's tournament rows are part of the record
      // and (e.g. when the baseline won) may leave zero matrix failures — a
      // re-freeze would mislabel the run NO_REAL_FAILURE_SIGNAL. Read the
      // frozen doc read-only and report straight from the reducer.
      const terminalPhase =
        controller.state.phase === 'CANDIDATE_LOCKED' ||
        controller.state.phase === 'NO_DEVELOPMENT_IMPROVEMENT'

      // --- discovery / benchmark baseline → frozen failure pool -----------
      // ADR-042 (specs/04 §4.2): a pre-registered benchmarkBaseline replaces
      // the stable-demo discovery phase with the full matrix.
      const pool = terminalPhase
        ? ((await this.readJson<FailurePoolDoc>(join(runRoot, 'failure-pool.json')))?.handles ??
          null)
        : config.search.benchmarkBaseline !== undefined
          ? await this.freezeBenchmarkBaseline(baselineId)
          : await this.discoverFailures(baselineId)

      const monitor = this.monitor
      if (monitor === undefined) throw new IterationDriverError('information-flow monitor missing')

      let stopReason: StopReason
      let safetyAbort: { surface: string; hits: CanaryHit[] } | null = null
      let tournament: {
        shortlist?: string[]
        championId?: string
        championLockHash?: string
      } | null = null
      try {
        if (terminalPhase) {
          // Resume after a tournament terminal (ADR-047): never re-enter the
          // search loop; the report re-reads the lock facts from the reducer.
          stopReason =
            controller.state.phase === 'CANDIDATE_LOCKED'
              ? 'CHAMPION_LOCKED'
              : 'NO_DEVELOPMENT_IMPROVEMENT'
          const lock = controller.state.locks.candidateLock
          tournament = {
            ...(lock !== null
              ? { championId: lock.candidateId, championLockHash: lock.lockHash }
              : {}),
          }
        } else if (pool === null) {
          stopReason = 'NO_REAL_FAILURE_SIGNAL'
        } else {
          const searched = await this.search(baselineId, pool)
          stopReason = searched.stopReason
          searchState = searched.searchState
          // Champion tournament (ADR-047, specs/03 §11): only after K_REACHED
          // on the formal profile; any other profile stops at K as before.
          if (stopReason === 'K_REACHED' && config.profile === 'terminal-bench-formal') {
            const ran = await this.runTournament(baselineId, pool)
            stopReason = ran.stopReason
            tournament = ran.result
          }
        }
      } catch (error) {
        if (error instanceof SafetyAbort) {
          safetyAbort = { surface: error.surface, hits: error.hits }
          stopReason = 'SAFETY_ABORTED'
        } else {
          throw error
        }
      }

      // --- archive catalog ------------------------------------------------
      const catalog = buildArchiveCatalog(controller.state, {
        createdFromStateHash: `sha256:${stateHashOf(controller.state)}`,
      })
      await this.writeJson(join(runRoot, 'archive-catalog.json'), catalog)

      // --- information-flow close-out (ADR-046, specs/05 §10) -------------
      // A surface abort reports its hit first; then the terminal journal
      // sweep checks every committed event (the guard embedding is the only
      // designated home). A clean run writes the canary-absence receipt; an
      // aborted one stays invalidated.
      if (safetyAbort !== null) {
        await monitor.reportHit(safetyAbort.surface, safetyAbort.hits)
        if (controller.state.phase !== 'SAFETY_ABORTED') {
          await controller.changePhase(
            'SAFETY_ABORTED',
            `information-flow breach on surface ${safetyAbort.surface}`,
          )
        }
      }
      const { events: journalEvents } = await readJournal(controllerDir, {
        runId: config.runId,
        segmentMaxBytes: 1 << 20,
      })
      const sweepHits = monitor.sweepJournal(journalEvents)
      if (sweepHits.length > 0) {
        stopReason = 'SAFETY_ABORTED'
        await monitor.reportHit('journal-sweep', sweepHits)
        if (controller.state.phase !== 'SAFETY_ABORTED') {
          await controller.changePhase(
            'SAFETY_ABORTED',
            'terminal journal sweep found a canary outside its designated home',
          )
        }
      } else if (safetyAbort === null) {
        await monitor.writeCleanReceipt(journalEvents.length)
      }

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
        status:
          stopReason === 'CHAMPION_LOCKED'
            ? 'CHAMPION_LOCKED'
            : stableVerified
              ? 'STABLE_ITERATION_VERIFIED'
              : `STOPPED:${stopReason}`,
        trials: observations.filter((o) => !o.actionId.startsWith('tourn-')).length,
        discoveryTrials: observations.filter(
          (o) => o.candidateId === baselineId && !o.actionId.startsWith('tourn-'),
        ).length,
        admittedNonBaseline: this.admittedIds().length - 1,
        lineageDepthMax,
        expansionAttempts: searchState.expansionAttempts,
        consecutiveExpansionFailures: searchState.consecutiveExpansionFailures,
        rebuildRejections: searchState.rebuildRejections ?? [],
        abandonedIntents: searchState.abandonedIntents ?? [],
        failurePool: pool ?? [],
        stateHash: controller.status().stateHash,
        budget: Object.fromEntries(
          Object.entries(controller.status().budget).map(([dimension, totals]) => [
            dimension,
            { spent: totals.spent, reserved: totals.reserved },
          ]),
        ),
        ...(tournament !== null
          ? {
              tournamentTrials: observations.filter((o) => o.actionId.startsWith('tourn-')).length,
              ...(tournament.shortlist !== undefined ? { shortlist: tournament.shortlist } : {}),
              ...(tournament.championId !== undefined
                ? {
                    championId: tournament.championId,
                    ...(tournament.championLockHash !== undefined
                      ? { championLockHash: tournament.championLockHash }
                      : {}),
                  }
                : {}),
            }
          : {}),
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
      .filter(
        (candidate) =>
          candidate.status === 'admitted' ||
          candidate.status === 'dev-champion' ||
          candidate.status === 'locked',
      )
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
      const record = await this.ensureCapsuleBound(existing.candidateId, () => {
        throw new IterationDriverError(`baseline ${existing.candidateId} has no capsule record`)
      })
      await this.assertBaselineProtocol(record)
      if (this.config.candidateProtocol === 'tree-v2') {
        await this.ensureTreeV2Migration(record)
      }
      if (existing.status === 'registered') {
        await controller.changeCandidateStatus({
          candidateId: existing.candidateId,
          to: 'admitted',
          reason: 'lineage root baseline admitted by the trusted builder',
        })
      }
      return existing.candidateId
    }
    // The baseline is TCB-maintained: a trusted-builder rejection of it is a
    // run-invalid defect, not a per-child result — fail closed (ADR-026).
    const baselineBuild = await this.buildCapsule(this.config.benchmark.baselineSourceDir)
    if (baselineBuild.outcome !== 'admitted') {
      throw new IterationDriverError(
        `trusted builder rejected the baseline source at ${baselineBuild.stage}: ${baselineBuild.reason}`,
      )
    }
    const built = baselineBuild.capsule
    await this.assertBaselineProtocol(built)
    const record = await this.persistCapsule(built)
    if (this.config.candidateProtocol === 'tree-v2') {
      await this.ensureTreeV2Migration(record)
    }
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

  private async assertBaselineProtocol(
    baseline: Pick<BuiltCapsule | CapsuleRecord, 'candidateId' | 'treeV2'>,
  ): Promise<void> {
    if (this.config.candidateProtocol === 'tree-v2' && baseline.treeV2 === undefined) {
      throw new IterationDriverError(
        `configured tree-v2 baseline ${baseline.candidateId} was admitted as legacy-v1`,
      )
    }
    if (this.config.candidateProtocol === 'legacy-v1' && baseline.treeV2 !== undefined) {
      throw new IterationDriverError(
        `configured legacy-v1 baseline ${baseline.candidateId} was admitted as tree-v2`,
      )
    }
  }

  /**
   * Bind a parentless tree-v2 root to the exact legacy source it supersedes.
   * The receipt is frozen before discovery, and explicitly forbids inheriting
   * any old score or trial result.
   */
  private async ensureTreeV2Migration(root: Pick<CapsuleRecord, 'sourceDigest'>): Promise<void> {
    const legacySourceDir = this.config.benchmark.legacyBaselineSourceDir
    if (legacySourceDir === undefined) {
      throw new IterationDriverError('tree-v2 migration has no configured legacy baseline source')
    }
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-tree-v2-legacy-'))
    let legacySourceDigest: string
    try {
      const staged = join(scratch, 'source')
      await stageDeclaredSource(legacySourceDir, staged)
      legacySourceDigest = `sha256:${(await captureCanonicalSource(staged)).sha256}`
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    const store = await openObjectStore(join(this.runRoot, 'objects'))
    const persisted = await persistTreeV2MigrationReceipt(store, {
      legacyCandidateDigest: legacySourceDigest,
      treeV2CandidateDigest: root.sourceDigest,
      sourceDigest: root.sourceDigest,
    })
    const binding: TreeV2MigrationBinding = {
      protocol: TREE_V2_MIGRATION_BINDING_PROTOCOL,
      legacySourceDigest,
      treeV2SourceDigest: root.sourceDigest,
      resultsInherited: false,
      receipt: persisted.receipt,
      receiptRef: persisted.ref,
    }
    await this.freeze(join(this.runRoot, 'tree-v2-migration.json'), binding)
    await store.verify(persisted.ref)
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
      const baselineObservations = Object.values(controller.state.observations).filter(
        (observation) => observation.candidateId === baselineId,
      )
      const done = baselineObservations.map((observation) => observation.opaqueTaskId)
      const failures = baselineObservations
        .filter((observation) => observation.outcome !== 'success')
        .map((observation) => observation.opaqueTaskId)
        .sort()
      // A 'missing' discovery observation means the trial never produced a
      // real outcome (infra death after the pre-registered retry, specs/04 §6).
      // Freezing that handle into the pool would present an unknown baseline
      // capability as a failure — attempt 7 did exactly that and its recorder
      // failed closed. Fail closed HERE, before any further paid launch.
      const infraDead = baselineObservations
        .filter((observation) => observation.outcome === 'missing')
        .map((observation) => observation.opaqueTaskId)
        .sort()
      if (infraDead.length > 0) {
        throw new IterationDriverError(
          `infra-dead discovery trial(s) [${infraDead.join(', ')}]: an agent that never ran is not a capability fact, so the pool cannot freeze — restart the pilot (ADR-028)`,
        )
      }

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
      const batch = ceremony.observedHandles.slice(
        batchIndex * batchSize,
        Math.min((batchIndex + 1) * batchSize, config.search.maxDiscoveryTrials),
      )
      const concurrency = config.benchmark.harbor.concurrentTrials
      // A discovery decision batch may contain several provider waves. Each
      // wave is planned independently so it can commit after its concurrent
      // jobs finish, while the failure pool still freezes at the batch boundary.
      const batchStart = batchIndex * batchSize
      let offset = Math.max(0, done.length - batchStart)
      while (offset < batch.length) {
        const chunk = batch.slice(offset, offset + concurrency)
        const waveIndex = Math.floor(offset / concurrency) + 1
        const waveId = `discovery-${batchIndex + 1}-${waveIndex}`
        const members = chunk.map((handle) => `eval-${shortId(baselineId)}-${handle}`)
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
        const inputs = chunk.map((handle) => ({
          actionId: `eval-${shortId(baselineId)}-${handle}`,
          candidateId: baselineId,
          opaqueTaskId: handle,
          attempt: 1,
          split: 'dev-observed' as const,
          waveId,
          estimate: this.trialEstimate(),
        }))
        await controller.runEvaluationWave(inputs)
        await controller.commitWave(waveId)
        offset += chunk.length
      }
    }
    if (controller.state.phase === 'PREFLIGHT' || controller.state.phase === 'DRAFT') {
      await controller.changePhase(
        'CALIBRATED',
        `failure pool re-frozen on resume: ${poolDoc.handles.length} handle(s)`,
      )
    }
    return poolDoc.handles
  }

  /**
   * Benchmark baseline freeze (specs/04 §4.2, ADR-042, ADR-046): when the
   * config pre-registers `search.benchmarkBaseline`, this replaces the
   * stable-demo discovery phase (specs/04 §4.1) with the full matrix — the
   * first `taskCount` development tasks in frozen ceremony order (observed
   * handles first, then opaque `guard-NN` tasks up to the development split),
   * `attemptsPerTask` attempts each, scheduled in batches of `batchSize`
   * (waves `baseline-<attempt>-<batch>-<wave>`). The failure pool freezes
   * only after the WHOLE matrix produced real outcomes: pool = OBSERVED
   * tasks with zero successful attempts (with attemptsPerTask > 1, a task
   * the baseline solves at least once is solvable by the baseline and is not
   * a search target); guard outcomes never enter the pool — the pool doubles
   * as proposer evidence supply, and a guard id in it would hit the export
   * label check (ADR-046). An empty pool stops the run honestly
   * (NO_REAL_FAILURE_SIGNAL); an infra-dead observation fails closed before
   * any proposal (ADR-028).
   *
   * Guard trials carry their own canary (`infoFlowGuardCanary`, derived from
   * the guard task's family): the designated home the information-flow
   * monitor tolerates at sweep time.
   *
   * Crash resume: the wave schedule is deterministic (ceremony order ×
   * attempt), so re-running it verifies every existing wave's membership and
   * completes only the missing actions — each launch is exactly-once by key
   * (specs/06 §12). No re-planning, no shift by observation count.
   */
  private async freezeBenchmarkBaseline(baselineId: string): Promise<string[] | null> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const config = this.config
    const baseline = config.search.benchmarkBaseline
    if (baseline === undefined) {
      throw new IterationDriverError('benchmarkBaseline not configured')
    }
    const ceremony = await this.readJson<SplitCeremony>(join(this.runRoot, 'split-ceremony.json'))
    if (ceremony === null) throw new IterationDriverError('split ceremony missing')
    const monitor = this.monitor
    if (monitor === undefined) throw new IterationDriverError('information-flow monitor missing')
    const developmentCount = ceremony.observedHandles.length + ceremony.guardOpaqueIds.length
    if (baseline.taskCount > developmentCount) {
      throw new IterationDriverError(
        `benchmarkBaseline.taskCount=${baseline.taskCount} exceeds the development split (${developmentCount} handles)`,
      )
    }
    const observedTasks = ceremony.observedHandles.slice(0, baseline.taskCount)
    // Guard segment (ADR-046): opaque dev-guard tasks fill the matrix up to
    // taskCount once the observed segment is exhausted.
    const guardIds = ceremony.guardOpaqueIds.slice(0, baseline.taskCount - observedTasks.length)
    const tasks = [...observedTasks, ...guardIds]
    const guardSet = new Set(guardIds)
    const concurrency = config.benchmark.harbor.concurrentTrials
    const short = shortId(baselineId)
    const batchCount = Math.ceil(baseline.taskCount / baseline.batchSize)

    for (let attempt = 1; attempt <= baseline.attemptsPerTask; attempt += 1) {
      for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
        const batch = tasks.slice(
          batchIndex * baseline.batchSize,
          Math.min((batchIndex + 1) * baseline.batchSize, tasks.length),
        )
        for (let offset = 0; offset < batch.length; offset += concurrency) {
          const chunk = batch.slice(offset, offset + concurrency)
          const waveIndex = Math.floor(offset / concurrency) + 1
          const waveId = `baseline-${attempt}-${batchIndex + 1}-${waveIndex}`
          // The action id carries the attempt: reserve() early-returns on an
          // existing action id, so an attempt-agnostic id would silently skip
          // every attempt after the first (attempts 2..A share candidate+task).
          const members = chunk.map((handle) => `eval-${short}-${handle}-a${attempt}`)
          const wave = controller.state.waves[waveId]
          if (wave === undefined) {
            // Guard-labeled waves carry at least one opaque guard member.
            await controller.planWave(
              waveId,
              chunk.some((handle) => guardSet.has(handle)) ? 'dev-guard' : 'dev-observed',
              members,
            )
          } else if (
            wave.members.length !== members.length ||
            wave.members.some((member, index) => member !== members[index])
          ) {
            throw new IterationDriverError(
              `baseline wave ${waveId} disagrees with the frozen ceremony order`,
            )
          }
          const inputs = chunk.map((handle) => {
            const isGuard = guardSet.has(handle)
            return {
              actionId: `eval-${short}-${handle}-a${attempt}`,
              candidateId: baselineId,
              opaqueTaskId: handle,
              attempt,
              split: isGuard ? ('dev-guard' as const) : ('dev-observed' as const),
              waveId,
              estimate: this.trialEstimate(),
              ...(isGuard ? { infoFlowGuardCanary: monitor.guardToken(handle) } : {}),
            }
          })
          await controller.runEvaluationWave(inputs)
          await controller.commitWave(waveId)
        }
      }
    }

    const baselineObservations = Object.values(controller.state.observations).filter(
      (observation) => observation.candidateId === baselineId,
    )
    const infraDead = baselineObservations
      .filter((observation) => observation.outcome === 'missing')
      .map((observation) => observation.opaqueTaskId)
      .sort()
    if (infraDead.length > 0) {
      throw new IterationDriverError(
        `infra-dead benchmark baseline trial(s) [${infraDead.join(', ')}]: an agent that never ran is not a capability fact, so the pool cannot freeze — restart the pilot (ADR-028)`,
      )
    }
    const succeeded = new Set(
      baselineObservations
        .filter((observation) => observation.outcome === 'success')
        .map((observation) => observation.opaqueTaskId),
    )
    // Observed-only pool (ADR-046): guard ids never become proposer evidence.
    const failures = observedTasks.filter((handle) => !succeeded.has(handle)).sort()
    if (failures.length === 0) return null // NO_REAL_FAILURE_SIGNAL: no zero-success task

    const poolPath = join(this.runRoot, 'failure-pool.json')
    const existingPool = await this.readJson<FailurePoolDoc>(poolPath)
    if (existingPool !== null) {
      // Resume: post-freeze observations legitimately grew the count frozen
      // into `frozenFromObservations`, so the frozen doc can never re-derive
      // byte-for-byte. The capability fact is the handle set — verify that
      // and keep the frozen doc byte-stable (ADR-047 crash-drill fix).
      if (canonicalHash(existingPool.handles) !== canonicalHash(failures)) {
        throw new IterationDriverError(
          `failure pool ${poolPath} disagrees with the re-derived failure set`,
        )
      }
    } else {
      const poolDoc: FailurePoolDoc = {
        protocol: FAILURE_POOL_PROTOCOL,
        handles: failures,
        frozenFromObservations: Object.keys(controller.state.observations).length,
        poolHash: `sha256:${canonicalHash(failures)}`,
      }
      await this.freeze(poolPath, poolDoc)
      if (controller.state.phase === 'PREFLIGHT' || controller.state.phase === 'DRAFT') {
        await controller.changePhase(
          'CALIBRATED',
          `benchmark baseline frozen: ${failures.length}/${tasks.length} tasks with zero successes over ${baselineObservations.length} baseline trial(s)`,
        )
      }
    }
    return failures
  }

  /** Wall clock now (tests inject a fake; live runs use system time). */
  private now(): string {
    return this.input.clock !== undefined ? this.input.clock() : new Date().toISOString()
  }

  /** One-shot NO_DEVELOPMENT_IMPROVEMENT phase change (ADR-047): idempotent
   * across resumes because the phase itself is terminal. */
  private async stopNoDevelopmentImprovement(reason: string): Promise<void> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    if (controller.state.phase !== 'NO_DEVELOPMENT_IMPROVEMENT') {
      await controller.changePhase('NO_DEVELOPMENT_IMPROVEMENT', reason)
    }
  }

  /**
   * Champion tournament (ADR-047, specs/03 §11): eligibility → q10 shortlist
   * (top-up degradation) → node-major coverage → paired-delta scoring with
   * the 90% cluster-bootstrap LCB → champion triple-hash lock. Only entered
   * after K_REACHED on the formal profile; a champion decision whose winner
   * does not strictly beat the baseline ends NO_DEVELOPMENT_IMPROVEMENT
   * without touching the sealed split.
   *
   * Resume safety: every stage is idempotent. `tournament-start.json` freezes
   * the wall-budget anchor; existing waves are verified, never re-planned;
   * bootstrap scoring runs on the tournament-exclusive 'bootstrap' stream at
   * a fixed counter, so a crash after journaling re-scores to the identical
   * receipts the reducer accepts as idempotent replays; the lock document
   * freezes before the lock events, and each event is guarded by the reducer
   * state it transitions.
   *
   * Wall budget: wallClockMinutes − wallClockSearchMinutes from the frozen
   * start (search owns the first wallClockSearchMinutes; absent = the
   * ADR-048 frozen 1800 default, ADR-058 pre-registers 3600 for repair3).
   * A wave that would cross it stops the run BUDGET_EXHAUSTED — a legal
   * SEARCHING edge.
   */
  private async runTournament(
    baselineId: string,
    pool: readonly string[],
  ): Promise<{
    stopReason: 'NO_DEVELOPMENT_IMPROVEMENT' | 'CHAMPION_LOCKED' | 'BUDGET_EXHAUSTED'
    /** Always set once the tournament is entered — the report's tournament
     * facts (trial count, shortlist) exist even on the NDI/BUDGET paths. */
    result: { shortlist: string[]; championId?: string; championLockHash?: string }
  }> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const tournamentConfig = this.config.search.tournament
    if (tournamentConfig === undefined) {
      throw new IterationDriverError('formal profile requires search.tournament')
    }
    const baseline = this.config.search.benchmarkBaseline
    if (baseline === undefined) {
      throw new IterationDriverError('formal profile requires search.benchmarkBaseline')
    }
    const ceremony = await this.readJson<SplitCeremony>(join(this.runRoot, 'split-ceremony.json'))
    if (ceremony === null) throw new IterationDriverError('split ceremony missing')
    const monitor = this.monitor
    if (monitor === undefined) throw new IterationDriverError('information-flow monitor missing')
    const devTasks = [...ceremony.observedHandles, ...ceremony.guardOpaqueIds]
    const guardSet = new Set(ceremony.guardOpaqueIds)
    // Planning snapshot: pre-tournament only (tournament rows are filtered
    // out of `preTournament`), so a crash/resume mid-tournament re-derives
    // the identical plan. The scoring pass refreshes this below.
    let observations = Object.values(controller.state.observations)
    let byActionId = new Map(observations.map((observation) => [observation.actionId, observation]))
    // Eligibility, top-up need and attempt numbering are all functions of the
    // PRE-tournament observation set only: tournament trials themselves must
    // not move the plan, or a crash/resume mid-tournament would re-derive a
    // different shortlist and different action ids (specs/06 §12).
    const preTournament = (candidateId: string) =>
      observations.filter(
        (observation) =>
          observation.candidateId === candidateId && !observation.actionId.startsWith('tourn-'),
      )
    // Attempt numbering continues after EVERY pre-tournament attempt of the
    // node on the task — including the baseline's matrix trials. The
    // reducer's observation identity is (candidate, task, split, attempt),
    // so a tournament trial that reused the matrix attempt number would
    // collide; the ADR-047 formula `priorAttempts + attempt` is what keeps
    // every identity unique.
    const priorAttempts = (candidateId: string, taskId: string): number =>
      preTournament(candidateId).filter((observation) => observation.opaqueTaskId === taskId).length

    // --- frozen tournament start: the wall-budget anchor across resumes ---
    const startPath = join(this.runRoot, 'tournament-start.json')
    const startDoc = (await this.readJson<{ at: string }>(startPath)) ?? { at: this.now() }
    await this.freeze(startPath, startDoc)
    const searchShareMinutes = this.config.budget.wallClockSearchMinutes ?? 1800
    const wallBudgetMinutes = Math.max(0, this.config.budget.wallClockMinutes - searchShareMinutes)
    const wallExhausted = (): boolean =>
      (Date.parse(this.now()) - Date.parse(startDoc.at)) / 60000 > wallBudgetMinutes

    // --- eligibility + shortlist (specs/03 §11 steps 2–3) -----------------
    const children = this.admittedIds().filter((candidateId) => candidateId !== baselineId)
    const admittedCandidates = children.flatMap((candidateId) => {
      const candidate = controller.state.candidates[candidateId]
      return candidate === undefined ? [] : [candidate]
    })
    const eligible = eligibleTournamentNodes({
      baselineId,
      nodes: children.map((candidateId) => ({
        candidateId,
        observationCount: preTournament(candidateId).length,
        artifactsComplete: existsSync(this.recordPath(candidateId)),
      })),
      minEligibilityTrials: tournamentConfig.minEligibilityTrials,
    })
    let shortlist: string[]
    let topUpNodes: string[] = []
    if (eligible.length >= 5) {
      const population = eligible.flatMap((node) => {
        const candidate = controller.state.candidates[node.candidateId]
        return candidate === undefined ? [] : [candidate]
      })
      const draw = drawTournamentShortlist({
        masterSeed: this.config.masterSeed,
        runId: this.config.runId,
        counter: this.nextRngCounter('tournament'),
        candidates: population,
        observations,
        shortlistSize: this.config.search.shortlistSize,
      })
      await controller.recordRngDraw(draw.draw.receipt)
      shortlist = draw.shortlist
    } else if (eligible.length > 0) {
      // 1..4 eligible: all enter — no RNG consumed (ADR-047).
      shortlist = eligible.map((node) => node.candidateId)
    } else {
      // Degradation (ADR-047): q10 over every admitted child, topped up to
      // the eligibility floor before coverage; a top-up that cannot fit the
      // trial budget ends NO_DEVELOPMENT_IMPROVEMENT with zero tournament
      // trials.
      if (children.length === 0) {
        await this.stopNoDevelopmentImprovement('no admitted child for the tournament top-up')
        return { stopReason: 'NO_DEVELOPMENT_IMPROVEMENT', result: { shortlist: [] } }
      }
      const draw = drawTournamentShortlist({
        masterSeed: this.config.masterSeed,
        runId: this.config.runId,
        counter: this.nextRngCounter('tournament'),
        candidates: admittedCandidates,
        observations,
        shortlistSize: this.config.search.shortlistSize,
      })
      await controller.recordRngDraw(draw.draw.receipt)
      shortlist = draw.shortlist
      topUpNodes = draw.shortlist
    }

    // --- budget gating: top-up must fit; coverage must fit the remainder --
    // The top-up runs FIRST: a coverage overflow afterwards abandons the
    // tournament with the top-up trials already committed (ADR-047: the
    // whole tournament is abandoned, top-up included).
    const concurrency = this.config.benchmark.harbor.concurrentTrials
    const topUpNeed = new Map<string, number>()
    let topUpTrials = 0
    for (const nodeId of topUpNodes) {
      const need = Math.max(0, tournamentConfig.minEligibilityTrials - preTournament(nodeId).length)
      topUpNeed.set(nodeId, need)
      topUpTrials += need
    }
    if (topUpTrials > tournamentConfig.maxTrials) {
      await this.stopNoDevelopmentImprovement(
        `tournament top-up needs ${topUpTrials} trials but the budget caps at ${tournamentConfig.maxTrials}`,
      )
      return { stopReason: 'NO_DEVELOPMENT_IMPROVEMENT', result: { shortlist } }
    }
    // --- top-up waves (pool tasks only; observed split, no guard) ---------
    // Each node's need cycles the frozen pool in order; later visits to the
    // same task increment the attempt so action ids stay unique. The visit
    // counts ALSO shift the coverage attempts past the top-up ones, so a
    // task that appears in both never shares an action id.
    const topUpWaves: TournamentCoverageWave[] = []
    const topUpVisits = new Map<string, number>()
    for (const nodeId of topUpNodes) {
      const need = topUpNeed.get(nodeId) ?? 0
      const members: Array<{ taskId: string; attempt: number }> = []
      const uses = new Map<string, number>()
      for (let index = 0; index < need; index += 1) {
        const taskId = pool[index % pool.length]
        if (taskId === undefined) {
          throw new IterationDriverError('tournament top-up has no pool task to run')
        }
        const used = uses.get(taskId) ?? 0
        uses.set(taskId, used + 1)
        members.push({ taskId, attempt: priorAttempts(nodeId, taskId) + used + 1 })
      }
      for (const member of members) {
        const key = `${nodeId}\0${member.taskId}`
        topUpVisits.set(key, (topUpVisits.get(key) ?? 0) + 1)
      }
      const nodeIdx = shortlist.indexOf(nodeId) + 1 // plan order: baseline first
      for (let offset = 0; offset < members.length; offset += concurrency) {
        topUpWaves.push({
          waveId: `tournament-${nodeIdx}-topup-${Math.floor(offset / concurrency) + 1}-1`,
          nodeIdx,
          members: members.slice(offset, offset + concurrency),
        })
      }
    }
    const coverage = buildTournamentCoverage({
      baselineId,
      shortlist,
      tasks: devTasks,
      attemptsPerTask: tournamentConfig.coverageAttemptsPerTask,
      batchSize: baseline.batchSize,
      concurrency,
      priorAttempts: (candidateId, taskId) =>
        priorAttempts(candidateId, taskId) + (topUpVisits.get(`${candidateId}\0${taskId}`) ?? 0),
    })

    /** Run waves exactly-once by key (specs/06 §12); verifies existing wave
     * membership, completes only missing actions, and checks the tournament
     * wall budget before each wave. Returns 'wall-exhausted' when the wave
     * would cross the frozen limit. */
    const runWaves = async (
      nodes: string[],
      waves: TournamentCoverageWave[],
    ): Promise<'ok' | 'wall-exhausted'> => {
      for (const wave of waves) {
        if (wallExhausted()) return 'wall-exhausted'
        const nodeId = nodes[wave.nodeIdx]
        if (nodeId === undefined) {
          throw new IterationDriverError(`tournament wave ${wave.waveId} has no node`)
        }
        const members = wave.members.map((member) => {
          const isGuard = guardSet.has(member.taskId)
          return {
            actionId: `tourn-${shortId(nodeId)}-${wave.nodeIdx}-${member.taskId}-a${member.attempt}`,
            candidateId: nodeId,
            opaqueTaskId: member.taskId,
            attempt: member.attempt,
            split: isGuard ? ('dev-guard' as const) : ('dev-observed' as const),
            waveId: wave.waveId,
            estimate: this.trialEstimate(),
            ...(isGuard ? { infoFlowGuardCanary: monitor.guardToken(member.taskId) } : {}),
          }
        })
        const existing = controller.state.waves[wave.waveId]
        if (existing === undefined) {
          await controller.planWave(
            wave.waveId,
            wave.members.some((member) => guardSet.has(member.taskId))
              ? 'dev-guard'
              : 'dev-observed',
            members.map((member) => member.actionId),
          )
        } else if (
          existing.members.length !== members.length ||
          existing.members.some((member, index) => member !== members[index]!.actionId)
        ) {
          throw new IterationDriverError(
            `tournament wave ${wave.waveId} disagrees with the coverage plan`,
          )
        }
        await controller.runEvaluationWave(members)
        await controller.commitWave(wave.waveId)
      }
      return 'ok'
    }

    if ((await runWaves(coverage.nodes, topUpWaves)) === 'wall-exhausted') {
      return { stopReason: 'BUDGET_EXHAUSTED', result: { shortlist } }
    }
    if (coverage.trialCount > tournamentConfig.maxTrials - topUpTrials) {
      await this.stopNoDevelopmentImprovement(
        `tournament coverage needs ${coverage.trialCount} trials but only ${tournamentConfig.maxTrials - topUpTrials} remain after the top-up`,
      )
      return { stopReason: 'NO_DEVELOPMENT_IMPROVEMENT', result: { shortlist } }
    }
    if ((await runWaves(coverage.nodes, coverage.waves)) === 'wall-exhausted') {
      return { stopReason: 'BUDGET_EXHAUSTED', result: { shortlist } }
    }
    // Scoring must see the tournament trials just committed; planning
    // (eligibility/top-up/attempt numbering) is unaffected — `preTournament`
    // filters every `tourn-` row out of the plan, so re-snapshotting cannot
    // move it (specs/06 §12).
    observations = Object.values(controller.state.observations)
    byActionId = new Map(observations.map((observation) => [observation.actionId, observation]))

    // --- paired-delta scoring (specs/03 §11 steps 5–6) --------------------
    // Per (node, task): the mean reward over the planned coverage attempts;
    // the paired delta against the baseline feeds the cluster bootstrap.
    const nodeOutcomeMean = (nodeId: string, taskId: string): number => {
      let sum = 0
      let count = 0
      for (let attempt = 1; attempt <= tournamentConfig.coverageAttemptsPerTask; attempt += 1) {
        const coverageAttempt =
          priorAttempts(nodeId, taskId) + (topUpVisits.get(`${nodeId}\0${taskId}`) ?? 0) + attempt
        const actionId = `tourn-${shortId(nodeId)}-${coverage.nodes.indexOf(nodeId)}-${taskId}-a${coverageAttempt}`
        const observation = byActionId.get(actionId)
        if (observation === undefined) {
          throw new IterationDriverError(`tournament observation missing for ${actionId}`)
        }
        sum += observation.reward
        count += 1
      }
      return count === 0 ? 0 : sum / count
    }
    const nodeTournamentObservations = (nodeId: string) =>
      observations.filter(
        (observation) =>
          observation.candidateId === nodeId && observation.actionId.startsWith('tourn-'),
      )
    const score = scoreTournament({
      masterSeed: this.config.masterSeed,
      runId: this.config.runId,
      // Fixed counter: the 'bootstrap' stream is tournament-exclusive and the
      // score is a pure function of the journaled facts, so re-scoring after
      // a crash reproduces byte-identical receipts (idempotent replays).
      counter: 0,
      baselineId,
      nodes: coverage.nodes.map((nodeId) => {
        const rows = nodeTournamentObservations(nodeId)
        const costs = rows
          .map((row) => row.costUsdMicros)
          .filter((value): value is number => value !== null)
        const durations = rows
          .map((row) => row.durationMs)
          .filter((value): value is number => value !== null)
        return {
          candidateId: nodeId,
          deltasPerTask: devTasks.map(
            (taskId) => nodeOutcomeMean(nodeId, taskId) - nodeOutcomeMean(baselineId, taskId),
          ),
          ...(costs.length > 0
            ? {
                meanCostUsdMicros: costs.reduce((sum, value) => sum + value, 0) / costs.length,
                ...(durations.length > 0
                  ? {
                      medianDurationMs: durations.sort((a, b) => a - b)[
                        Math.floor((durations.length - 1) / 2)
                      ],
                    }
                  : {}),
              }
            : {}),
        }
      }),
      resamples: tournamentConfig.bootstrapResamples,
    })
    for (const row of score.rows) await controller.recordRngDraw(row.receipt)
    await this.writeJson(join(this.runRoot, 'tournament-score.json'), {
      protocol: 'dsh-evolve-le/tournament-score/v1',
      runId: this.config.runId,
      baselineId,
      championId: score.championId,
      rows: score.rows.map((row) => ({
        candidateId: row.candidateId,
        deltaPerMille: Math.round(row.delta * 1000),
        lcbPerMille: Math.round(row.lcb * 1000),
        meanCostUsdMicros: row.meanCostUsdMicros ?? null,
        medianDurationMs: row.medianDurationMs ?? null,
      })),
    })

    // --- champion decision: a winner that is not strictly better than the
    // baseline ends NO_DEVELOPMENT_IMPROVEMENT (specs/03 §11 step 7) -------
    const championRow = score.rows.find((row) => row.candidateId === score.championId)
    if (championRow === undefined) {
      throw new IterationDriverError('champion row missing from the tournament score')
    }
    if (score.championId === baselineId || championRow.delta <= 0) {
      await this.stopNoDevelopmentImprovement(
        score.championId === baselineId
          ? 'baseline won the champion tournament'
          : `tournament winner delta ${championRow.delta} is not strictly positive`,
      )
      return { stopReason: 'NO_DEVELOPMENT_IMPROVEMENT', result: { shortlist } }
    }

    // --- champion triple-hash lock (ADR-047 step 2) -----------------------
    const championId = score.championId
    const capsuleRecord = await this.readJson<CapsuleRecord>(this.recordPath(championId))
    if (capsuleRecord === null) {
      throw new IterationDriverError(`champion ${championId} has no capsule record`)
    }
    const lockHash = tripleLockHash(
      capsuleRecord.sourceDigest,
      capsuleRecord.archiveSha256,
      this.input.configHash,
    )
    const lockDoc = {
      protocol: 'dsh-evolve-le/candidate-lock/v1',
      runId: this.config.runId,
      winnerId: championId,
      sourceHash: capsuleRecord.sourceDigest,
      archiveSha256: capsuleRecord.archiveSha256,
      runManifestHash: this.input.configHash,
      sealedPlanHash: this.input.sealedPlanReceipt!.sha256,
      tripleHash: lockHash,
    }
    await this.freeze(join(this.runRoot, 'candidate-lock.json'), lockDoc)

    if (controller.state.candidates[championId] === undefined) {
      throw new IterationDriverError(`unknown champion ${championId}`)
    }
    if (controller.state.locks.candidateLock === null) {
      // Fresh status reads: each emit transitions the reducer state, so the
      // pre-emit snapshot can be stale by the next guard.
      if (controller.state.candidates[championId]!.status !== 'dev-champion') {
        await controller.changeCandidateStatus({
          candidateId: championId,
          to: 'dev-champion',
          reason: `highest tournament LCB (${championRow.lcb})`,
        })
      }
      await controller.lockCandidate({ candidateId: championId, lockHash })
    }
    if (controller.state.candidates[championId]!.status !== 'locked') {
      await controller.changeCandidateStatus({
        candidateId: championId,
        to: 'locked',
        reason: `triple lock ${lockHash.slice(0, 16)}…`,
      })
    }
    if (controller.state.phase !== 'CANDIDATE_LOCKED') {
      await controller.changePhase('CANDIDATE_LOCKED', `champion ${championId} triple-locked`)
    }
    return {
      stopReason: 'CHAMPION_LOCKED',
      result: { shortlist, championId, championLockHash: lockHash },
    }
  }

  /**
   * Worst-case reservation per development trial (frozen by the config). A
   * solver-token run reserves `budget.solverTokens / taskTrials` per trial
   * (ADR-030 D2) — without the reservation the dimension could never trip
   * mid-run and the controller's settle would exceed what it reserved.
   */
  private trialEstimate(): Array<{
    dimension: 'usd' | 'task-trials' | 'solver-tokens'
    amount: number
  }> {
    return [
      {
        dimension: 'usd',
        amount: Math.floor(this.config.budget.usd / this.config.budget.taskTrials),
      },
      { dimension: 'task-trials', amount: 1 },
      ...(this.config.budget.solverTokens !== undefined
        ? [
            {
              dimension: 'solver-tokens' as const,
              // A floor of zero (solverTokens < taskTrials) would admit a
              // trial with nothing reserved: the first token-earning settle
              // would then crash the ledger's settle-≤-reserved invariant
              // instead of stopping the loop. Reserve at least one token so
              // the pre-launch check — not a mid-run crash — is what stops.
              amount: Math.max(
                1,
                Math.floor(this.config.budget.solverTokens / this.config.budget.taskTrials),
              ),
            },
          ]
        : []),
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
    count = 1,
  ): boolean {
    const state = this.controller?.state
    if (state === undefined) return true
    const limits: Record<string, number> = {
      usd: this.config.budget.usd,
      'proposer-tokens': this.config.budget.proposerTokens,
      'proposal-calls': this.config.budget.proposalCalls,
      'task-trials': this.config.budget.taskTrials,
      'wall-clock-seconds': this.config.budget.wallClockMinutes * 60,
      ...(this.config.budget.solverTokens !== undefined
        ? { 'solver-tokens': this.config.budget.solverTokens }
        : {}),
    }
    for (const { dimension, amount } of estimate) {
      const limit = limits[dimension]
      if (limit === undefined) continue
      const totals = state.budget[dimension]
      const used = (totals?.spent ?? 0) + (totals?.reserved ?? 0) + amount * count
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
  private async sampleTask(
    candidateId: string,
    pool: readonly string[],
    selected: ReadonlySet<string> = new Set(),
  ): Promise<string | null> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const state = controller.state
    const tried = this.triedHandles(candidateId)
    const anyoneTried = new Set(Object.values(state.observations).map((o) => o.opaqueTaskId))
    const fresh = pool.filter(
      (handle) => !anyoneTried.has(handle) && !selected.has(`${candidateId}\0${handle}`),
    )
    const perCandidate = pool.filter(
      (handle) => !tried.has(handle) && !selected.has(`${candidateId}\0${handle}`),
    )
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
    const pendingByWave = new Map<string, string[]>()
    const waveLess: string[] = []
    for (const action of Object.values(controller.state.actions)) {
      if (action.kind !== 'evaluation' || TERMINAL_ACTIONS.has(action.status)) continue
      if (action.waveId === null) waveLess.push(action.actionId)
      else {
        const members = pendingByWave.get(action.waveId) ?? []
        members.push(action.actionId)
        pendingByWave.set(action.waveId, members)
      }
    }
    for (const actionId of waveLess) await controller.resumeEvaluation(actionId)
    for (const [waveId, actionIds] of pendingByWave) {
      await controller.resumeEvaluationWave(actionIds)
      await controller.commitWave(waveId).catch(() => undefined)
    }

    await this.settleAbandonedIntents(searchState)

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
      // The failure cap closes the proposal channel, but cannot erase q0
      // obligations already created by a successful admission.  Returning
      // here used to let UCB-Air admit many zero-trial children after a large
      // benchmark baseline, then terminate on three failed proposals with an
      // impossible trial envelope.  Drain those fixed cold starts first.
      if (
        !coldStartsPending &&
        searchState.consecutiveExpansionFailures >= config.search.maxConsecutiveExpansionFailures
      ) {
        return { stopReason: 'NO_ADMISSIBLE_CHILD', searchState }
      }

      // Specs/03 §6 gives q0 a higher priority than Thompson.  It is also
      // higher priority than the UCB-Air expand/evaluate choice: UCB chooses
      // only among optional actions, whereas q0 is a pre-registered design
      // constraint.  The cap similarly forbids only *new* expansions.
      const expand =
        !coldStartsPending &&
        searchState.consecutiveExpansionFailures < config.search.maxConsecutiveExpansionFailures &&
        shouldExpand({
          completedTrials,
          pendingEvaluations: 0,
          admittedCandidates: admitted.length,
          kTarget: config.search.kTarget,
          alpha,
        })

      if (expand) {
        if (this.budgetWouldExhaust(this.proposalEstimate()))
          return { stopReason: 'BUDGET_EXHAUSTED', searchState }
        const expansion = await this.expand(pool, searchState.proposalRejections ?? [])
        searchState.expansionAttempts += 1
        searchState.rebuildRejections = [
          ...(searchState.rebuildRejections ?? []),
          ...expansion.rebuildRejections,
        ]
        if (expansion.proposalRejection !== null) {
          searchState.proposalRejections = mergeProposalRejections(
            searchState.proposalRejections ?? [],
            expansion.proposalRejection,
          )
        }
        if (expansion.admittedAny) {
          searchState.consecutiveExpansionFailures = 0
        } else {
          searchState.consecutiveExpansionFailures += 1
        }
        await this.saveSearchState(searchState)
        const coldStartsNowPending = this.admittedIds().some(
          (candidateId) =>
            candidateId !== baselineId &&
            this.triedHandles(candidateId).size < config.search.coldStartTrials,
        )
        if (
          searchState.consecutiveExpansionFailures >=
            config.search.maxConsecutiveExpansionFailures &&
          !coldStartsNowPending
        ) {
          return { stopReason: 'NO_ADMISSIBLE_CHILD', searchState }
        }
        continue
      }

      const normalWaveSize = Math.min(
        config.benchmark.harbor.concurrentTrials,
        config.search.maxSolverTrials - completedTrials,
      )
      // A wave is decided from one committed snapshot, so q0 must account for
      // reservations made earlier in this same wave.  Without this virtual
      // count, every draw sees an admitted child as still having zero trials
      // until the barrier commits and fills all available Harbor slots with
      // that child.  q0 is a pre-registered trial count, not a concurrency
      // target (specs/03 §6, §8).
      const coldStartDeficits = this.admittedIds()
        .filter((candidateId) => candidateId !== baselineId)
        .map((candidateId) =>
          Math.max(0, config.search.coldStartTrials - this.triedHandles(candidateId).size),
        )
        .filter((deficit) => deficit > 0)
      const waveSize =
        coldStartDeficits.length > 0
          ? Math.min(
              normalWaveSize,
              coldStartDeficits.reduce((sum, deficit) => sum + deficit, 0),
            )
          : normalWaveSize
      const selections: Array<{ candidateId: string; handle: string }> = []
      const selected = new Set<string>()
      const virtualColdStarts = new Map<string, number>()
      for (let index = 0; index < waveSize; index += 1) {
        const next = await this.pickEvaluation(pool, selected, virtualColdStarts)
        if (next === null) break
        const key = `${next.candidateId}\0${next.handle}`
        if (selected.has(key)) break
        selected.add(key)
        selections.push(next)
        const prior = virtualColdStarts.get(next.candidateId) ?? 0
        if (
          this.triedHandles(next.candidateId).size + prior < config.search.coldStartTrials &&
          next.candidateId !== baselineId
        ) {
          virtualColdStarts.set(next.candidateId, prior + 1)
        }
      }
      if (selections.length === 0) return { stopReason: 'NO_ADMISSIBLE_TASK', searchState }
      const estimate = this.trialEstimate()
      if (this.budgetWouldExhaust(estimate, selections.length))
        return { stopReason: 'BUDGET_EXHAUSTED', searchState }
      const waveNumber =
        Object.keys(controller.state.waves).filter((id) => id.startsWith('search-')).length + 1
      const waveId = `search-${waveNumber}`
      await controller.planWave(
        waveId,
        'dev-observed',
        selections.map((next) => `eval-${shortId(next.candidateId)}-${next.handle}`),
      )
      await controller.runEvaluationWave(
        selections.map((next) => ({
          actionId: `eval-${shortId(next.candidateId)}-${next.handle}`,
          candidateId: next.candidateId,
          opaqueTaskId: next.handle,
          attempt: 1,
          split: 'dev-observed' as const,
          waveId,
          estimate,
        })),
      )
      await controller.commitWave(waveId)
    }
  }

  /** Pick (candidate, handle) for the next serial evaluation. */
  private async pickEvaluation(
    pool: readonly string[],
    selected: ReadonlySet<string> = new Set(),
    virtualColdStarts: ReadonlyMap<string, number> = new Map(),
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
        this.triedHandles(candidateId).size + (virtualColdStarts.get(candidateId) ?? 0) <
          this.config.search.coldStartTrials,
    )
    if (cold !== undefined) {
      const handle = await this.sampleTask(cold, pool, selected)
      if (handle !== null) {
        return { candidateId: cold, handle }
      }
    }

    const eligible = admitted.filter((candidateId) =>
      pool.some(
        (handle) =>
          !this.triedHandles(candidateId).has(handle) && !selected.has(`${candidateId}\0${handle}`),
      ),
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
    const handle = await this.sampleTask(draw.winner, pool, selected)
    if (handle === null) return null
    return { candidateId: draw.winner, handle }
  }

  /**
   * One expansion (specs/03 §5, §7): parent Thompson draw → label-filtered
   * evidence export → proposal saga in the one-shot sandbox → trusted child
   * rebuilds → admission. Reports whether any child admitted and every
   * per-child trusted-rebuild rejection for the drive report.
   */
  private async expand(
    pool: readonly string[],
    priorRejections: readonly ProposalRejectionRecord[],
  ): Promise<{
    admittedAny: boolean
    rebuildRejections: RebuildRejection[]
    proposalRejection: ProposalRejectionRecord | null
  }> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const state = controller.state
    const admitted = this.admittedIds()

    // Parent draw over the admitted population (clade Beta, tau=1).  The
    // baseline can have observations on tasks excluded from the zero-success
    // failure pool; they define the pool but are not comparable to a child
    // that is evaluated only inside it (ADR-054).
    const counter = this.nextRngCounter('scheduler-thompson')
    const parentDraw = drawParentThompson({
      masterSeed: this.config.masterSeed,
      runId: this.config.runId,
      counter,
      candidates: admitted.map((candidateId) => state.candidates[candidateId]!),
      observations: parentComparableObservations(Object.values(state.observations), pool),
    })
    await controller.recordRngDraw(parentDraw.receipt)
    const parentId = parentDraw.winner
    const parentRecord = await this.loadRecord(parentId)

    // Evidence export: the frozen failure-pool trajectories, DEV_OBSERVED only.
    const failureObservations = Object.values(state.observations)
      .filter(
        (observation) =>
          observation.outcome !== 'success' && pool.includes(observation.opaqueTaskId),
      )
      .sort((a, b) => (a.actionId < b.actionId ? -1 : 1))
    const store = await openObjectStore(join(this.runRoot, 'objects'))
    const actionableFailureObservations: typeof failureObservations = []
    const trajectoryRefs: ObjectRef[] = []
    const diagnosticRefs = new Map<string, ObjectRef>()
    for (const observation of failureObservations) {
      const ref = state.actions[observation.actionId]?.artifacts[0]
      if (ref === undefined) continue
      if (!isCandidateActionableTrajectory(await store.read(ref))) continue
      actionableFailureObservations.push(observation)
      trajectoryRefs.push(ref)
      const diagnostic = state.actions[observation.actionId]?.artifacts.find(
        (artifact) => artifact.mediaType === DIAGNOSTIC_TRACE_MEDIA_TYPE,
      )
      if (diagnostic !== undefined) diagnosticRefs.set(observation.actionId, diagnostic)
    }
    if (trajectoryRefs.length === 0) {
      throw new IterationDriverError(
        'failure pool has no candidate-actionable stored trajectories to export',
      )
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
    const normalizedTrialRefs = await Promise.all(
      actionableFailureObservations.map((observation) =>
        store.put(Buffer.from(`${canonicalJson(observation)}\n`, 'utf8'), {
          mediaType: 'application/vnd.dsh-evolve-le.normalized-trial+json',
          label: 'DEV_OBSERVED',
        }),
      ),
    )
    // The raw evidence remains available, but this small TCB projection gives
    // the proposer a deterministic, injection-free starting point: one row
    // per candidate-actionable failure plus a neutral support count grouped by
    // terminal category/participation/exception.  It neither recommends a
    // mechanism nor changes scoring; all fields re-derive from stored facts.
    const indexDraft = await Promise.all(
      actionableFailureObservations.map(async (observation, index) => {
        const trajectoryRef = trajectoryRefs[index]!
        const normalizedTrialRef = normalizedTrialRefs[index]!
        const terminal = failureIndexTerminal(await store.read(trajectoryRef))
        const cluster = [
          terminal.category ?? 'unknown-category',
          terminal.agentParticipation ?? 'unknown-participation',
          terminal.exceptionType ?? 'no-exception',
        ].join('|')
        return {
          actionId: observation.actionId,
          candidateId: observation.candidateId,
          opaqueTaskId: observation.opaqueTaskId,
          attempt: observation.attempt,
          outcome: observation.outcome,
          reward: observation.reward,
          durationMs: observation.durationMs,
          trajectoryDigest: `sha256:${trajectoryRef.digest}`,
          normalizedTrialDigest: `sha256:${normalizedTrialRef.digest}`,
          terminal,
          cluster,
        }
      }),
    )
    const clusterSupport = new Map<string, number>()
    for (const entry of indexDraft) {
      clusterSupport.set(entry.cluster, (clusterSupport.get(entry.cluster) ?? 0) + 1)
    }
    let attributionRef: ObjectRef | undefined
    const attributor = this.input.failureAttributor
    if (attributor !== undefined) {
      const traces: DebuggerTraceInput[] = []
      for (const entry of indexDraft) {
        const diagnostic = diagnosticRefs.get(entry.actionId)
        if (diagnostic === undefined) continue
        let bundle: unknown
        try {
          bundle = JSON.parse((await store.read(diagnostic)).toString('utf8')) as unknown
        } catch {
          // Corrupt diagnostic sidecars are not scoring facts.  They stay
          // stored/auditable but are ineligible for an LLM attribution call.
          continue
        }
        traces.push({
          actionId: entry.actionId,
          normalizedTrialDigest: entry.normalizedTrialDigest,
          trajectoryDigest: entry.trajectoryDigest,
          diagnosticTraceDigest: `sha256:${diagnostic.digest}`,
          bundle,
        })
      }
      if (traces.length > 0) {
        const durable = attributor as Partial<DurableFailureAttributor>
        if (durable.attributeWithReceipt !== undefined && this.config.agentDebugger !== undefined) {
          const envelope = this.config.agentDebugger
          const selected = selectDebuggerTraces(traces, envelope.maxInputBytes)
          if (selected.length > 0) {
            const route = this.config.modelRoutes.find(
              (candidate) => candidate.id === envelope.route,
            )
            if (route === undefined)
              throw new IterationDriverError('agentDebugger route disappeared')
            const inputTokens = Math.ceil(envelope.maxInputBytes / 4)
            const totalTokens = inputTokens + envelope.maxOutputTokens
            const usd = Math.ceil(
              inputTokens * (route.inputUsdMicrosPerMTok / 1_000_000) +
                envelope.maxOutputTokens * (route.outputUsdMicrosPerMTok / 1_000_000),
            )
            const result = await controller.runAttribution({
              actionId: `attrib-${actionId}`,
              request: {
                traceDigests: selected.map((trace) => trace.diagnosticTraceDigest),
                maxInputBytes: envelope.maxInputBytes,
                maxOutputTokens: envelope.maxOutputTokens,
                route: envelope.route,
              },
              estimate: [
                { dimension: 'attribution-calls', amount: 1 },
                { dimension: 'attribution-tokens', amount: totalTokens },
                { dimension: 'usd', amount: usd },
              ],
              execute: () => durable.attributeWithReceipt!({ traces: selected }),
            })
            attributionRef = result.attribution ?? undefined
          }
        } else {
          // Deterministic test/recorded seams remain non-networked. A live
          // route must implement DurableFailureAttributor and be configured
          // above, otherwise it cannot evade receipts or the frozen budget.
          const attributed = await attributor.attribute({ traces })
          attributionRef = await store.put(attributed.artifact, {
            mediaType: FAILURE_ATTRIBUTION_MEDIA_TYPE,
            label: 'DEV_OBSERVED',
          })
        }
      }
    }
    const failureIndexRef = await store.put(
      Buffer.from(
        `${canonicalJson({
          protocol: 'dsh-evolve-le/failure-index/v1',
          ...(attributionRef === undefined
            ? {}
            : { attributionDigest: `sha256:${attributionRef.digest}` }),
          entries: indexDraft.map((entry) => ({
            ...entry,
            ...(diagnosticRefs.get(entry.actionId) === undefined
              ? {}
              : {
                  diagnosticTraceDigest: `sha256:${diagnosticRefs.get(entry.actionId)!.digest}`,
                }),
            clusterSupport: clusterSupport.get(entry.cluster) ?? 0,
          })),
        })}\n`,
        'utf8',
      ),
      {
        mediaType: 'application/vnd.dsh-evolve-le.failure-index+json',
        label: 'DEV_OBSERVED',
      },
    )
    const failureRefs = [
      ...trajectoryRefs,
      ...normalizedTrialRefs,
      ...[...diagnosticRefs.values()],
      ...(attributionRef === undefined ? [] : [attributionRef]),
      failureIndexRef,
    ].sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0))
    const monitor = this.monitor
    if (monitor === undefined) throw new IterationDriverError('information-flow monitor missing')
    // Export canary union (ADR-046): proposer-scoped canaries PLUS every
    // monitor token. A guard/sealed canary inside an observed trajectory or
    // normalization means guarded bytes are about to reach the proposer —
    // the export refuses with the typed canary error and the run aborts.
    let created: Awaited<ReturnType<typeof createEvidenceExport>>
    try {
      created = await createEvidenceExport({
        exportsRoot,
        store,
        principal: `proposer:${actionId}`,
        purpose: 'candidate-expansion',
        allowedLabels: [...PROPOSER_READ_LABELS],
        refs: failureRefs,
        createdFromStateHash: `sha256:${stateHashOf(state)}`,
        canaryTokens: [...canaryTokens, ...monitor.tokens],
      })
    } catch (error) {
      if (error instanceof EvidenceExportCanaryError) {
        throw new SafetyAbort('evidence-export', error.hits)
      }
      throw error
    }

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
        ...(parentRecord.treeV2 === undefined
          ? {}
          : {
              treeV2Parent: {
                candidateDigest: parentRecord.sourceDigest,
                mechanismOutcomeDigest: parentRecord.treeV2.mechanismOutcomeDigest,
              },
            }),
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
      // ADR-044: this run's prior rejection verdicts travel with the request
      // and land as input/prior-rejections.json in the sandbox.
      priorRejections,
    })
    // Proposal-result scan (ADR-046): the serialized result (failure reasons,
    // summary texts) must carry no monitor token. This catches the channel
    // the export wall cannot see — e.g. a worker failure whose error text
    // echoes guarded bytes — before any further expansion or paid trial.
    const resultHits = monitor.scan(canonicalJson(result))
    if (resultHits.length > 0) {
      throw new SafetyAbort('proposal-result', resultHits)
    }
    if (result.status !== 'COMMITTED' || result.summary.admitted.length === 0) {
      return {
        admittedAny: false,
        rebuildRejections: [],
        proposalRejection: proposalRejectionOf(result),
      }
    }

    // Trusted rebuild of every admitted child → admission (specs/03 §2). A
    // builder REJECTION is a per-child outcome, not a crash (specs/03 §7:
    // "全部 build reject …… 计作一次失败"): the child stays registered, is
    // never admitted, and the reason rides the drive report. Builder-
    // environment failures still throw and fail the run closed.
    const candidatesRoot = join(this.runRoot, 'controller', 'candidates')
    let admittedAny = false
    const rebuildRejections: RebuildRejection[] = []
    for (const verdict of result.summary.admitted) {
      const stored = await loadCandidateSource(candidatesRoot, verdict.sourceHash)
      let treeV2ParentEvidence: BuildInput['treeV2ParentEvidence']
      if (verdict.treeV2 !== undefined) {
        if (parentRecord.treeV2 === undefined) {
          rebuildRejections.push({
            actionId,
            candidateId: stored.candidateId,
            stage: 'diffBoundary',
            reason:
              'tree-v2 child requires a parent tree-v2 admission record; legacy results cannot be inherited',
          })
          continue
        }
        if (
          verdict.treeV2.requiredParentEvidence.mechanismOutcomeDigest !==
          parentRecord.treeV2.mechanismOutcomeDigest
        ) {
          rebuildRejections.push({
            actionId,
            candidateId: stored.candidateId,
            stage: 'diffBoundary',
            reason: 'tree-v2 mechanismOutcomeDigest does not match the parent admission record',
          })
          continue
        }
        treeV2ParentEvidence = {
          requiredParentEvidence: verdict.treeV2.requiredParentEvidence,
          modeFingerprints: parentRecord.treeV2.modeFingerprints,
        }
      }
      const built = await this.buildCapsule(
        stored.treeDir,
        join(this.runRoot, parentRecord.stagedSourceDir),
        treeV2ParentEvidence,
      )
      if (built.outcome !== 'admitted') {
        rebuildRejections.push({
          actionId,
          candidateId: stored.candidateId,
          stage: built.stage,
          reason: built.reason.slice(0, 500),
        })
        continue
      }
      if (built.capsule.candidateId !== stored.candidateId) {
        throw new IterationDriverError(
          `rebuild identity mismatch: ${built.capsule.candidateId} != registered ${stored.candidateId}`,
        )
      }
      const record = await this.persistCapsule(built.capsule)
      const child = controller.state.candidates[built.capsule.candidateId]
      if (child?.status === 'registered') {
        await controller.changeCandidateStatus({
          candidateId: built.capsule.candidateId,
          to: 'admitted',
          reason: `trusted rebuild admitted (${record.archiveSha256.slice(0, 16)}…)`,
        })
      }
      admittedAny = true
    }
    return {
      admittedAny,
      rebuildRejections,
      proposalRejection: proposalRejectionOf(result),
    }
  }

  /**
   * Close out expansion intents a crash left unfinished (specs/03 §7: "恢复时
   * 仍未完成且没有 admitted child 的 intent，都计作一次失败"): each such intent
   * counts as ONE expansion attempt and ONE consecutive failure unless one of
   * its children had already admitted; its never-rebuilt children stay
   * registered and are recorded as abandoned. Idempotent across repeated
   * resumes — an intent is settled exactly once, in the same durable write as
   * its counters.
   */
  private async settleAbandonedIntents(searchState: SearchState): Promise<void> {
    const controller = this.controller
    if (controller === undefined) throw new IterationDriverError('controller not open')
    const settled = new Set((searchState.rebuildRejections ?? []).map((entry) => entry.candidateId))
    for (const entry of searchState.abandonedIntents ?? []) settled.add(entry.candidateId)

    // Registered children of terminal proposals with no capsule record: the
    // rebuild loop never reached them (only a crash leaves that shape — the
    // fixed expand() records its own rejections, which are settled above).
    const pending = Object.values(controller.state.candidates).filter(
      (candidate) =>
        candidate.parentCandidateId !== null &&
        candidate.proposalActionId !== null &&
        candidate.status === 'registered' &&
        !settled.has(candidate.candidateId) &&
        !existsSync(this.recordPath(candidate.candidateId)),
    )
    if (pending.length === 0) return
    const byIntent = new Map<string, typeof pending>()
    for (const candidate of pending) {
      const actionId = candidate.proposalActionId as string
      byIntent.set(actionId, [...(byIntent.get(actionId) ?? []), candidate])
    }
    for (const [actionId, children] of byIntent) {
      const intentAdmittedChild = this.intentHasAdmittedChild(actionId)
      searchState.expansionAttempts += 1
      if (intentAdmittedChild) {
        searchState.consecutiveExpansionFailures = 0
      } else {
        searchState.consecutiveExpansionFailures += 1
      }
      searchState.abandonedIntents = [
        ...(searchState.abandonedIntents ?? []),
        ...children.map((candidate) => ({ actionId, candidateId: candidate.candidateId })),
      ]
      await this.saveSearchState(searchState)
    }
  }

  /** Did any child of this proposal action reach admission? */
  private intentHasAdmittedChild(actionId: string): boolean {
    const state = this.controller?.state
    if (state === undefined) return false
    return Object.values(state.candidates).some(
      (candidate) =>
        candidate.proposalActionId === actionId &&
        (candidate.status === 'admitted' || candidate.status === 'dev-champion'),
    )
  }
}
