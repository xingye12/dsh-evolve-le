/**
 * Tree-v2 live run profiles (specs/07, docs/tree-v2-implementation-spec.md).
 *
 * One profile pins the complete search + budget envelope for a paid tree-v2
 * run so the CLI init arguments are derived, never hand-assembled. Every
 * profile is pre-registered here BEFORE the run starts; a profile that does
 * not exist in this module cannot be run live.
 *
 * This module is imported by the paid runner scripts (record-*.ts) and by the
 * contract test packages/dsh-evolve-le/tests/tree-v2-live-profile.test.ts. It
 * must stay free of side effects: importing it never launches a run.
 */

export interface TreeV2LiveProfile {
  /** Admitted-candidate target for the run (archive admission count). */
  kTarget: number
  /** Cold-start trials per admitted node. */
  coldStartTrials: number
  /** UCB shortlist size for expansion selection. */
  shortlistSize: number
  /** Hard cap on solver trials (discovery + cold starts). */
  maxSolverTrials: number
  /** Hard cap on discovery trials inside maxSolverTrials. */
  maxDiscoveryTrials: number
  /** Discovery batch width per expansion. */
  discoveryBatchSize: number
  /** Proposal width per expansion. */
  proposalWidth: number
  /** Harbor task-trial budget (must cover maxSolverTrials). */
  taskTrials: number
  /** Wall-clock budget in minutes. */
  wallClockMinutes: number
  /**
   * ADR-058: the search phase's share of wallClockMinutes (minutes).
   * Optional: absent = the ADR-048 frozen 1800 default — the preserved
   * 49×2 formal profile keeps its pre-registered semantics byte-identical.
   * The driver derives the tournament wall budget from it.
   */
  wallClockSearchMinutes?: number
  /** Live-solver token budget (ADR-030), paired with the solver route. */
  solverTokens: number
  /**
   * ADR-042 (specs/04 §4.2): pre-registered benchmark baseline matrix. When
   * present the driver replaces stable-demo discovery with the full matrix
   * and freezes the zero-success pool after it; absent = §4.1 discovery.
   */
  benchmarkBaseline?: { taskCount: number; attemptsPerTask: number; batchSize: number }
  /**
   * ADR-045 (k80 formal profile): UCB-Air exponent in per-mille (600 = 0.6).
   * Optional: absent = the frozen 600 default. The formal k80 profile
   * pre-registers 800 — at 0.6 the final gate alone needs N ≥ 80^(5/3)
   * ≈ 1486 trials, which no feasible wall clock can fund.
   */
  ucbAirAlphaPerMille?: number
  /**
   * ADR-045: proposal-call budget (default 20). The formal k80 search needs
   * ~50 expansions at the K=10 pilot's observed ~1.67 admitted/expansion.
   */
  proposalCalls?: number
  /** ADR-045: proposer token budget (default 20M), paired with proposalCalls. */
  proposerTokens?: number
  /**
   * ADR-045: Harbor wave width / concurrent trials (default 4). Rides the
   * dedicated `--concurrent-trials` CLI flag, never a --set key.
   */
  concurrentTrials?: number
  /**
   * ADR-047 (specs/03 §11): champion tournament envelope — eligibility
   * floor, coverage per development task, trial budget, and cluster
   * bootstrap resamples for the 90% LCB. Optional: absent = no tournament
   * (stable-demo never enters one). The formal profile pre-registers
   * 12 / 1 / 360 / 100 000.
   */
  tournament?: {
    minEligibilityTrials: number
    coverageAttemptsPerTask: number
    maxTrials: number
    bootstrapResamples: number
  }
  /**
   * ADR-049: the run-config profile class the init freezes (default
   * stable-demo). The formal profile selects `terminal-bench-formal`, which
   * unlocks the tournament gate and demands the pre-registered sealed plan.
   */
  runProfile?: 'stable-demo' | 'terminal-bench-formal'
  /**
   * ADR-056: optional bounded LLM Agent Debugger. The route must name the
   * frozen zen-compatible route; the three envelope fields must equal the
   * TCB-frozen defaults (run-config.ts) verbatim — the record script's
   * config gate compares the frozen document against this profile.
   */
  agentDebugger?: {
    route: string
    maxOutputTokens: number
    requestTimeoutMs: number
    maxInputBytes: number
  }
  /**
   * ADR-056: attribution budgets, required iff agentDebugger is configured.
   * The driver reserves the full envelope per call, so the token figure must
   * cover calls × (maxInputBytes/4 + maxOutputTokens) at minimum.
   */
  attributionCalls?: number
  attributionTokens?: number
}

/**
 * Pre-registered live profiles. The envelopes are sized so discovery plus
 * every admitted node's cold start fits inside maxSolverTrials.
 *
 * solverTokens must equal taskTrials × 2_000_000 — the solve gateway's frozen
 * per-trial token cap (DEFAULT_SOLVE_TRIAL_BUDGET.maxTotalTokens). The
 * controller reserves floor(solverTokens / taskTrials) per trial and the
 * ledger fails closed when a settle exceeds its action's reservation, so a
 * smaller figure lets one maxed-out trial crash the run mid-flight (the K=3
 * attempt-1 BudgetError: settle 419863 > reserved 400000). At this size the
 * solver-token dimension can never trip before task-trials.
 */
export const TREE_V2_LIVE_PROFILES: Record<
  'k3' | 'k10' | 'k80' | 'k80Repair3' | 'treeV2Smoke',
  TreeV2LiveProfile
> = {
  /** Stable-demo envelope: the smallest paid run that exercises the full loop. */
  k3: {
    kTarget: 3,
    coldStartTrials: 1,
    shortlistSize: 2,
    maxSolverTrials: 15,
    maxDiscoveryTrials: 12,
    discoveryBatchSize: 6,
    proposalWidth: 3,
    taskTrials: 15,
    wallClockMinutes: 960,
    solverTokens: 30_000_000,
  },
  /** Gate 8 pilot envelope, carried over for the tree-v2 protocol.
   * maxDiscoveryTrials is the specs/04 §4.1 hard cap of 12 (two batches) —
   * the schema (run.config.schema.json maximum 12) rejects anything larger
   * at init; the profile's original 48 was never schema-legal (ADR-041).
   *
   * ADR-042: the benchmarkBaseline matrix replaces the §4.1 discovery phase
   * (maxDiscoveryTrials is dormant for this profile): 24 observed tasks × 1
   * attempt = 24 baseline trials, batches of 6 (four waves-worth of §4.1
   * accounting), zero-success pool freeze after the full matrix. Supply:
   * D + K×P = 24 + 10×24 (worst pool) ≥ minimumTrials 49 with margin — the
   * attempt-1 rehearsal's 26-vs-47 starvation is structurally impossible
   * here (P ≥ 3 suffices; the expected pool at the observed ~40% baseline
   * failure rate is ≈ 9.6). */
  k10: {
    kTarget: 10,
    coldStartTrials: 1,
    shortlistSize: 2,
    maxSolverTrials: 60,
    maxDiscoveryTrials: 12,
    discoveryBatchSize: 6,
    proposalWidth: 3,
    taskTrials: 60,
    wallClockMinutes: 960,
    solverTokens: 120_000_000,
    benchmarkBaseline: { taskCount: 24, attemptsPerTask: 1, batchSize: 6 },
  },
  /**
   * ADR-045/049 FORMAL search envelope (specs/03 §2 terminal-bench-formal):
   * alpha=0.8 pre-registered — final gate ceil(80^1.25)=240, minimum 255 —
   * inside a 400-trial search envelope, the guard-inclusive 49×2 benchmark
   * baseline matrix (39 observed + 10 guard, ADR-046/049), the champion
   * tournament (294 funded of 360, ADR-047), a 46h wall clock (the ADR-048
   * phased amendment of the specs/00 §6.3 16h objective: 1800 search +
   * 960 tournament), and 8 concurrent Harbor trials. taskTrials 760 spans
   * both paid phases (400 + 360); solverTokens 1 520M funds every trial at
   * the frozen 2M gateway cap. The profile selects the terminal-bench-formal
   * run-config profile, which demands the pre-registered sealed plan receipt
   * (ADR-048) and unlocks the tournament gate. maxDiscoveryTrials is dormant
   * (benchmarkBaseline present), same as k10.
   */
  k80: {
    kTarget: 80,
    coldStartTrials: 3,
    shortlistSize: 5,
    maxSolverTrials: 400,
    maxDiscoveryTrials: 12,
    discoveryBatchSize: 6,
    proposalWidth: 3,
    taskTrials: 760,
    wallClockMinutes: 2760,
    solverTokens: 1_520_000_000,
    ucbAirAlphaPerMille: 800,
    proposalCalls: 60,
    proposerTokens: 60_000_000,
    concurrentTrials: 8,
    benchmarkBaseline: { taskCount: 49, attemptsPerTask: 2, batchSize: 8 },
    tournament: {
      minEligibilityTrials: 12,
      coverageAttemptsPerTask: 1,
      maxTrials: 360,
      bootstrapResamples: 100_000,
    },
    runProfile: 'terminal-bench-formal',
  },
  /**
   * repair3 successor-only K=80 search protocol.  This deliberately keeps
   * repair2's 49×2 profile immutable: it spends one baseline attempt per
   * task, freezes every real observed failure into the pool, and preserves
   * the 12-way Harbor envelope.  Its one-attempt calibration is explicitly
   * not interchangeable with the historical 49×2 formal baseline.
   *
   * ADR-058: the search phase's wall clock is 3600 min (60 h) — the post
   * ADR-054 cadence projection needs ≈45–60 h for 80 children, so the
   * ADR-048 1800 search share would end the run BUDGET_EXHAUSTED at ~25–40
   * children. The envelope is 4560 = 3600 search + 960 tournament; the
   * tournament (960) and sealed (720, sealed-plan.json) phases, the $500
   * ceiling and the +5pp gate are unchanged.
   */
  k80Repair3: {
    kTarget: 80,
    coldStartTrials: 3,
    shortlistSize: 5,
    maxSolverTrials: 400,
    maxDiscoveryTrials: 12,
    discoveryBatchSize: 6,
    proposalWidth: 3,
    taskTrials: 760,
    wallClockMinutes: 4560,
    wallClockSearchMinutes: 3600,
    solverTokens: 1_520_000_000,
    ucbAirAlphaPerMille: 800,
    proposalCalls: 60,
    proposerTokens: 60_000_000,
    concurrentTrials: 12,
    benchmarkBaseline: { taskCount: 49, attemptsPerTask: 1, batchSize: 12 },
    tournament: {
      minEligibilityTrials: 12,
      coverageAttemptsPerTask: 1,
      maxTrials: 360,
      bootstrapResamples: 100_000,
    },
    runProfile: 'terminal-bench-formal',
    // ADR-056 pre-registration (repair3): the debugger rides the same
    // compatible route as solver/proposer, under the TCB-frozen envelope.
    // One attribution call per failure-index build (≤ proposalCalls) with
    // margin; the token figure covers calls × the reserved full envelope
    // (524 288/4 + 8 192 = 139 264 tokens/call → 80 × 139 264 ≈ 11.2M,
    // 16M adds headroom against envelope-max reservations).
    agentDebugger: {
      route: 'deepseek/zen-compatible',
      maxOutputTokens: 8_192,
      requestTimeoutMs: 180_000,
      maxInputBytes: 524_288,
    },
    attributionCalls: 80,
    attributionTokens: 16_000_000,
  },
  /**
   * ADR-059 paid 1-job Harbor smoke (the repair-3 launch gate): the smallest
   * pre-registered live run that exercises the full tree-v2 trial path —
   * real Harbor job → capsule boot through the egress proxy → TCB solve
   * gateway → live route → task verifier → receipt-chain settle. A 2×1
   * benchmark-baseline matrix (the first two observed handles of the frozen
   * ceremony), one live expansion/proposal and one q0 cold start; every
   * trial funds at the frozen 2M gateway cap (solverTokens = taskTrials ×
   * 2M, so the dimension never trips before task-trials). Worst case ≈ 4
   * trials / $1.20 solver + one live proposal; stable-demo profile class —
   * no tournament, no sealed demands. Claims no improvement signal.
   *
   * ADR-059 amendment (2026-09-09): the launch-gate calibration rejected a
   * 1×1 matrix — bestCaseSupply 2 < minimumTrials 3 (finalGate
   * ceil(K^(1/alpha))=1 + q0×shortlist=2), because the matrix can only
   * supply one admitted node's cold start beyond its own trial. The matrix
   * is 2×1 (bestCaseSupply 4), shortlistSize stays 2 (schema minimum);
   * terminal shapes shift to K_REACHED at 3 trials and
   * NO_REAL_FAILURE_SIGNAL at 2.
   */
  treeV2Smoke: {
    kTarget: 1,
    coldStartTrials: 1,
    shortlistSize: 2,
    maxSolverTrials: 4,
    maxDiscoveryTrials: 1,
    discoveryBatchSize: 1,
    proposalWidth: 2,
    taskTrials: 4,
    wallClockMinutes: 120,
    solverTokens: 8_000_000,
    concurrentTrials: 1,
    benchmarkBaseline: { taskCount: 2, attemptsPerTask: 1, batchSize: 1 },
  },
}

export interface TreeV2InitArgsInput {
  runsRoot: string
  runId: string
  masterSeed: string
  tasksRoot: string
  /** The tree-v2 baseline candidate package (becomes the migration root). */
  treeV2BaselineSource: string
  /** The legacy v1 baseline source bound by the migration receipt. */
  legacyBaselineSource: string
  jobsRoot: string
  nativeDshCatalogRoot: string
  nativeDshClosureSha256: string
  credentialFile: string
  modelBaseUrl: string
  modelName: string
  artifactHost: string
  artifactPort: number
  /** ADR-028 second amendment: credential-free proxy for trial containers. */
  trialContainerProxy?: string
}

/**
 * Build the `dsh-evolve-le init` argument vector for one tree-v2 live run.
 * Both the proposer and the solver select the live zen-compatible route; the
 * profile's search/budget envelope lands through `--set` overrides so the
 * frozen run.config.json records exactly what was pre-registered.
 */
export function buildTreeV2InitArgs(
  profile: TreeV2LiveProfile,
  input: TreeV2InitArgsInput,
): string[] {
  return [
    'init',
    '--runs-root',
    input.runsRoot,
    '--run-id',
    input.runId,
    '--master-seed',
    input.masterSeed,
    '--tasks-root',
    input.tasksRoot,
    '--baseline-source',
    input.treeV2BaselineSource,
    '--candidate-protocol',
    'tree-v2',
    '--legacy-baseline-source',
    input.legacyBaselineSource,
    '--jobs-root',
    input.jobsRoot,
    // ADR-049: the profile class is a dedicated CLI flag (stable-demo is the
    // frozen default; only the formal profile emits it).
    ...(profile.runProfile !== undefined ? ['--profile', profile.runProfile] : []),
    '--native-dsh-catalog-root',
    input.nativeDshCatalogRoot,
    '--native-dsh-closure-sha256',
    input.nativeDshClosureSha256,
    '--credential-file',
    input.credentialFile,
    '--proposer-route',
    'deepseek/zen-compatible',
    '--solver-route',
    'deepseek/zen-compatible',
    '--solver-base-url',
    input.modelBaseUrl,
    '--solver-model',
    input.modelName,
    '--solver-temperature',
    '0',
    '--artifact-host',
    input.artifactHost,
    '--artifact-port',
    String(input.artifactPort),
    ...(input.trialContainerProxy !== undefined
      ? ['--trial-container-proxy', input.trialContainerProxy]
      : []),
    '--prefetch-images',
    // Harbor wave width is a dedicated CLI flag (cli.ts validates 1..12),
    // never a --set key; absent = the frozen 4 default.
    ...(profile.concurrentTrials !== undefined
      ? ['--concurrent-trials', String(profile.concurrentTrials)]
      : []),
    '--set',
    `kTarget=${String(profile.kTarget)}`,
    '--set',
    `coldStartTrials=${String(profile.coldStartTrials)}`,
    '--set',
    `shortlistSize=${String(profile.shortlistSize)}`,
    '--set',
    `maxSolverTrials=${String(profile.maxSolverTrials)}`,
    '--set',
    `maxDiscoveryTrials=${String(profile.maxDiscoveryTrials)}`,
    '--set',
    `discoveryBatchSize=${String(profile.discoveryBatchSize)}`,
    '--set',
    `proposalWidth=${String(profile.proposalWidth)}`,
    '--set',
    `taskTrials=${String(profile.taskTrials)}`,
    '--set',
    `wallClockMinutes=${String(profile.wallClockMinutes)}`,
    // ADR-058: the search-phase share is an explicit --set carrier; absent =
    // the ADR-048 frozen 1800 default (the 49×2 k80 args stay byte-identical).
    ...(profile.wallClockSearchMinutes !== undefined
      ? ['--set', `wallClockSearchMinutes=${String(profile.wallClockSearchMinutes)}`]
      : []),
    '--set',
    `solverTokens=${String(profile.solverTokens)}`,
    // ADR-045: alpha, proposal-call and proposer-token budgets are optional
    // carriers — absent = the frozen defaults (600 / 20 / 20M), so the k3
    // and k10 documents stay byte-identical to their frozen configs.
    ...(profile.ucbAirAlphaPerMille !== undefined
      ? ['--set', `ucbAirAlphaPerMille=${String(profile.ucbAirAlphaPerMille)}`]
      : []),
    ...(profile.proposalCalls !== undefined
      ? ['--set', `proposalCalls=${String(profile.proposalCalls)}`]
      : []),
    ...(profile.proposerTokens !== undefined
      ? ['--set', `proposerTokens=${String(profile.proposerTokens)}`]
      : []),
    // ADR-042: the benchmark baseline matrix rides the same flat --set
    // surface; defaultRunConfig composes the three carriers into
    // search.benchmarkBaseline (all three required together).
    ...(profile.benchmarkBaseline !== undefined
      ? [
          '--set',
          `baselineTaskCount=${String(profile.benchmarkBaseline.taskCount)}`,
          '--set',
          `baselineAttemptsPerTask=${String(profile.benchmarkBaseline.attemptsPerTask)}`,
          '--set',
          `baselineBatchSize=${String(profile.benchmarkBaseline.batchSize)}`,
        ]
      : []),
    // ADR-049: the tournament envelope rides the same flat surface — four
    // carriers composed into search.tournament (all four required together).
    ...(profile.tournament !== undefined
      ? [
          '--set',
          `tournamentMinEligibilityTrials=${String(profile.tournament.minEligibilityTrials)}`,
          '--set',
          `tournamentCoverageAttemptsPerTask=${String(profile.tournament.coverageAttemptsPerTask)}`,
          '--set',
          `tournamentMaxTrials=${String(profile.tournament.maxTrials)}`,
          '--set',
          `tournamentBootstrapResamples=${String(profile.tournament.bootstrapResamples)}`,
        ]
      : []),
    // ADR-056: the debugger route is a dedicated CLI flag; the envelope
    // fields are TCB-frozen defaults, not --set carriers. The attribution
    // budgets ride the same flat surface as the other budget dimensions.
    ...(profile.agentDebugger !== undefined
      ? ['--agent-debugger-route', profile.agentDebugger.route]
      : []),
    ...(profile.attributionTokens !== undefined
      ? ['--set', `attributionTokens=${String(profile.attributionTokens)}`]
      : []),
    ...(profile.attributionCalls !== undefined
      ? ['--set', `attributionCalls=${String(profile.attributionCalls)}`]
      : []),
  ]
}

/**
 * Paid-run gate: a tree-v2 live run spends real money, so the runner script
 * must be invoked with the exact confirmation token. Anything else fails
 * closed with instructions, never a partial launch.
 */
export function requireLiveConfirmation(value: string | undefined): void {
  if (value !== 'confirm') {
    throw new Error(
      'tree-v2 live run refused: this run spends real solver/proposer budget. ' +
        'Re-run with DSH_TREE_V2_LIVE_CONFIRM=confirm to proceed.',
    )
  }
}

/**
 * Terminal stop reasons a completed run may report without tripping the
 * record-script gate (specs/03): the stable-demo success states, the two
 * budget boundaries, the no-signal early stop, the consecutive-failure
 * boundary and its `NO_ADMISSIBLE_CHILD` result, and the search-exhaustion
 * state `NO_ADMISSIBLE_TASK` (every admitted candidate has tried every pool
 * handle — legal inside a 60-trial envelope over a small pool, ADR-041).
 * Attempt 12's run legitimately stopped with `NO_ADMISSIBLE_CHILD`
 * (specs/03 §7: the sole protocol result once the frozen
 * consecutive-expansion-failure cap trips) and was mis-scored because the
 * gate list omitted it (ADR-040).
 */
export const REGISTERED_TERMINAL_STOP_REASONS: readonly string[] = [
  'STABLE_ITERATION_VERIFIED',
  'K_REACHED',
  'BUDGET_EXHAUSTED',
  'TRIAL_CAP',
  'WALL_CLOCK_EXHAUSTED',
  'NO_REAL_FAILURE_SIGNAL',
  'MAX_CONSECUTIVE_EXPANSION_FAILURES',
  'NO_ADMISSIBLE_CHILD',
  'NO_ADMISSIBLE_TASK',
  // ADR-047/049 formal states: the champion lock ends the paid search +
  // tournament phases, the no-improvement verdict ends the tournament
  // without touching sealed, and the information-flow monitor's abort is a
  // first-class stop, not a record-script failure.
  'CHAMPION_LOCKED',
  'NO_DEVELOPMENT_IMPROVEMENT',
  'SAFETY_ABORTED',
]

export interface TreeV2TrialShape {
  trials: number
  discoveryTrials: number
  expansionAttempts: number
  admittedNonBaseline: number
  proposalCalls: number
  /**
   * ADR-049: champion-tournament observations — present only when the run
   * entered the tournament (formal profile + K_REACHED). `trials` stays the
   * search-phase count; the two phases are bounded separately.
   */
  tournamentTrials?: number
}

export interface TreeV2EnvelopeVerdict {
  ok: boolean
  detail: string
  problems: string[]
}

/**
 * ADR-040: the pre-registered trial-shape envelope mirrors the protocol's
 * actual taxonomy (specs/03 §6–8): discovery batch + one cold start per
 * admitted node + ordinary UCB-Air/Thompson evaluations, with the profile
 * caps and the wave-snapshot admission overshoot bound
 * (K + shortlistSize − 1: expansion is legal while admitted < K and one wave
 * admits at most shortlistSize nodes). Proposal calls must equal expansion
 * attempts. Pure — contract-tested against the attempt-12 and attempt-13
 * shapes; the old `discovery + expansions×coldStart` encoding rejected both.
 */
export function trialShapeWithinPreRegisteredEnvelope(
  shape: TreeV2TrialShape,
  profile: TreeV2LiveProfile,
): TreeV2EnvelopeVerdict {
  const problems: string[] = []
  const coldStarts = shape.admittedNonBaseline * profile.coldStartTrials
  const ordinary = shape.trials - shape.discoveryTrials - coldStarts
  // ADR-042 (specs/04 §4.2): a benchmark-baseline profile pre-registers its
  // exact matrix — the driver runs every (task, attempt) pair before the
  // pool freezes, so the baseline trial count must equal the matrix exactly
  // (no early batch stop, no all-success early exit below it).
  if (profile.benchmarkBaseline !== undefined) {
    const matrixTrials =
      profile.benchmarkBaseline.taskCount * profile.benchmarkBaseline.attemptsPerTask
    if (shape.discoveryTrials !== matrixTrials) {
      problems.push(
        `discovery=${shape.discoveryTrials} is not the pre-registered benchmark baseline matrix ` +
          `${profile.benchmarkBaseline.taskCount}×${profile.benchmarkBaseline.attemptsPerTask}=${matrixTrials}`,
      )
    }
  } else {
    // ADR-041: the driver freezes the failure pool only at a batch boundary
    // containing a real failure, so an all-success first batch honestly funds
    // a second one (maxDiscoveryTrials) — any funded batch multiple is legal,
    // not just the first batch. Still rejected: a partial batch, zero, or
    // discovery past the funded cap.
    if (
      shape.discoveryTrials <= 0 ||
      shape.discoveryTrials > profile.maxDiscoveryTrials ||
      shape.discoveryTrials % profile.discoveryBatchSize !== 0
    ) {
      problems.push(
        `discovery=${shape.discoveryTrials} is not a funded batch multiple of ` +
          `discoveryBatchSize=${profile.discoveryBatchSize} within maxDiscoveryTrials=${profile.maxDiscoveryTrials}`,
      )
    }
  }
  if (ordinary < 0) {
    problems.push(
      `trials=${shape.trials} cannot cover discovery=${shape.discoveryTrials} + ` +
        `admittedNonBaseline=${shape.admittedNonBaseline}×q0=${profile.coldStartTrials}`,
    )
  }
  // ADR-049: taskTrials spans BOTH paid phases — the search envelope and the
  // champion tournament. The combined total is the budget boundary; the
  // per-phase caps below are the protocol boundaries.
  const totalTrials = shape.trials + (shape.tournamentTrials ?? 0)
  if (totalTrials > profile.taskTrials) {
    problems.push(`total trials=${totalTrials} > taskTrials=${profile.taskTrials}`)
  }
  if (shape.trials > profile.maxSolverTrials) {
    problems.push(`trials=${shape.trials} > maxSolverTrials=${profile.maxSolverTrials}`)
  }
  // Tournament rows require a tournament envelope, and the envelope's
  // maxTrials is the tournament-phase cap.
  if (shape.tournamentTrials !== undefined) {
    if (profile.tournament === undefined) {
      problems.push(
        `tournamentTrials=${shape.tournamentTrials} reported by a profile without a tournament envelope`,
      )
    } else if (shape.tournamentTrials > profile.tournament.maxTrials) {
      problems.push(
        `tournamentTrials=${shape.tournamentTrials} > tournament.maxTrials=${profile.tournament.maxTrials}`,
      )
    }
  }
  // Dormant for benchmark-baseline profiles: the matrix replaces the §4.1
  // discovery cap entirely (ADR-042), and the exact-matrix check above is
  // the bound — the pre-registered matrix may legitimately exceed 12.
  if (profile.benchmarkBaseline === undefined && shape.discoveryTrials > profile.maxDiscoveryTrials) {
    problems.push(
      `discovery=${shape.discoveryTrials} > maxDiscoveryTrials=${profile.maxDiscoveryTrials}`,
    )
  }
  const overshootBound = profile.kTarget + profile.shortlistSize - 1
  if (shape.admittedNonBaseline > overshootBound) {
    problems.push(
      `admittedNonBaseline=${shape.admittedNonBaseline} exceeds the wave-snapshot ` +
        `overshoot bound kTarget+shortlistSize−1=${overshootBound}`,
    )
  }
  if (shape.proposalCalls !== shape.expansionAttempts) {
    problems.push(
      `proposalCalls=${shape.proposalCalls} ≠ expansionAttempts=${shape.expansionAttempts}`,
    )
  }
  const ordinaryTag = ordinary >= 0 ? ` ordinary=${ordinary}` : ''
  const tournamentTag =
    shape.tournamentTrials !== undefined ? ` tournament=${shape.tournamentTrials}` : ''
  return {
    ok: problems.length === 0,
    detail:
      `trials=${shape.trials} discovery=${shape.discoveryTrials} ` +
      `admitted=${shape.admittedNonBaseline} coldStarts=${coldStarts}${ordinaryTag} ` +
      `expansions=${shape.expansionAttempts} proposals=${shape.proposalCalls}${tournamentTag}`,
    problems,
  }
}

export interface TrialUsageAttribution {
  /** The receipt chain for the job verified (TCB-side, content-addressed). */
  chainVerified: boolean
  /** Receipt-verified request count; 0 = the agent never reached the gateway. */
  chainRequests: number
  /** Exception recorded and no ACP initialize record: the agent never booted. */
  neverInitialized: boolean
}

/**
 * ADR-040 gate 1: every live trial's spend is attributed through the TCB
 * receipt chain. A verified chain with requests > 0 covers the trial
 * (Harbor's capsule report is a cross-check, not the authority); a
 * never-booted trial with an empty chain is the honest zero; anything else
 * is unattributable and fails closed.
 */
export function receiptChainCoversTrial(
  attribution: TrialUsageAttribution,
): { ok: boolean; detail: string } {
  // A never-booted agent cannot have reached the gateway: a missing receipt
  // file is then the honest zero, not an attribution failure (K=10 attempt 1).
  if (attribution.neverInitialized && attribution.chainRequests === 0) {
    return { ok: true, detail: 'honest zero: the agent never booted and never called the gateway' }
  }
  if (!attribution.chainVerified) {
    return { ok: false, detail: 'receipt chain failed verification — unattributable' }
  }
  if (attribution.chainRequests > 0) {
    return { ok: true, detail: `receipt chain covers ${attribution.chainRequests} requests` }
  }
  return { ok: false, detail: 'unattributable: no gateway requests and no never-booted record' }
}

export interface HarborUsageCrossCheck {
  /** Harbor's result carries the capsule's completed report (metadata set). */
  capsuleCompleted: boolean
  /** Harbor's record carries positive usage (n_input_tokens > 0, cost > 0). */
  harborUsagePositive: boolean
}

/**
 * ADR-040 gate 2: wherever upstream Harbor preserves the capsule's completed
 * report, the record must carry positive usage — the capsule's figures come
 * only from gateway replies. Trials Harbor hard-killed (AgentTimeoutError
 * discards the report) are exempt by construction; the chain covers them
 * (gate 1) and the kill stays visible in the raw result.
 */
export function harborUsageReportedWhenCapsuleCompleted(
  crossCheck: HarborUsageCrossCheck,
): { ok: boolean; detail: string } {
  if (!crossCheck.capsuleCompleted) {
    return { ok: true, detail: 'exempt: the capsule never completed its report (killed trial)' }
  }
  return crossCheck.harborUsagePositive
    ? { ok: true, detail: 'Harbor carries the capsule usage report' }
    : { ok: false, detail: 'the capsule completed its report but Harbor carries no positive usage' }
}
