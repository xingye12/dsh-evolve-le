import { describe, expect, it } from 'vitest'
import {
  TREE_V2_LIVE_PROFILES,
  buildTreeV2InitArgs,
  requireLiveConfirmation,
  trialShapeWithinPreRegisteredEnvelope,
  receiptChainCoversTrial,
  harborUsageReportedWhenCapsuleCompleted,
  REGISTERED_TERMINAL_STOP_REASONS,
} from '../../../scripts/lib/tree-v2-live-profile.js'
import { DEFAULT_SOLVE_TRIAL_BUDGET } from '../src/solver/gateway.js'
import { calibrateSearch } from '../src/selection/calibration.js'

describe('tree-v2 live run profiles', () => {
  it('pins K=3 to the stable-demo 15-trial envelope', () => {
    expect(TREE_V2_LIVE_PROFILES.k3).toMatchObject({
      kTarget: 3,
      coldStartTrials: 1,
      maxSolverTrials: 15,
      taskTrials: 15,
      wallClockMinutes: 960,
    })
  })

  it('pins independent K=10 and K=80 search envelopes', () => {
    expect(TREE_V2_LIVE_PROFILES.k10).toMatchObject({
      kTarget: 10,
      coldStartTrials: 1,
      maxSolverTrials: 60,
      benchmarkBaseline: { taskCount: 24, attemptsPerTask: 1, batchSize: 6 },
    })
    // ADR-045/049: the k80 envelope is pre-registered at alpha=0.8 — final
    // gate ceil(80^1.25)=240, minimum 255 — inside a 400-trial search
    // envelope, the guard-inclusive 49×2 benchmark baseline matrix, the
    // champion tournament (294 funded of 360), a 46h wall clock, and the
    // 760-trial total task budget (400 search + 360 tournament).
    expect(TREE_V2_LIVE_PROFILES.k80).toMatchObject({
      kTarget: 80,
      coldStartTrials: 3,
      shortlistSize: 5,
      ucbAirAlphaPerMille: 800,
      maxSolverTrials: 400,
      taskTrials: 760,
      wallClockMinutes: 2760,
      solverTokens: 1_520_000_000,
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
    })
    expect(TREE_V2_LIVE_PROFILES.k80.maxSolverTrials).toBe(400)
    // repair3 is a separately named successor protocol.  It must not mutate
    // the preserved 49×2 profile that repair2 recorded.
    expect(TREE_V2_LIVE_PROFILES.k80Repair3).toMatchObject({
      kTarget: 80,
      coldStartTrials: 3,
      concurrentTrials: 12,
      benchmarkBaseline: { taskCount: 49, attemptsPerTask: 1, batchSize: 12 },
      runProfile: 'terminal-bench-formal',
      // ADR-058: the search phase owns 3600 min of the 4560 envelope; the
      // 49×2 profile stays on the ADR-048 1800 default (field absent).
      wallClockMinutes: 4560,
      wallClockSearchMinutes: 3600,
    })
    expect(TREE_V2_LIVE_PROFILES.k80.wallClockSearchMinutes).toBeUndefined()
  })

  it('pins the ADR-059 1-job harbor smoke envelope', () => {
    expect(TREE_V2_LIVE_PROFILES.treeV2Smoke).toMatchObject({
      kTarget: 1,
      coldStartTrials: 1,
      shortlistSize: 2,
      maxSolverTrials: 4,
      taskTrials: 4,
      wallClockMinutes: 120,
      solverTokens: 8_000_000,
      concurrentTrials: 1,
      benchmarkBaseline: { taskCount: 2, attemptsPerTask: 1, batchSize: 1 },
    })
    // The smoke is stable-demo class: no tournament, no formal profile
    // demands, no debugger — the smallest paid run that exists.
    expect(TREE_V2_LIVE_PROFILES.treeV2Smoke.tournament).toBeUndefined()
    expect(TREE_V2_LIVE_PROFILES.treeV2Smoke.runProfile).toBeUndefined()
    expect(TREE_V2_LIVE_PROFILES.treeV2Smoke.agentDebugger).toBeUndefined()
  })

  it('funds every trial at the gateway per-trial token cap', () => {
    // The controller reserves floor(solverTokens / taskTrials) per trial and
    // the ledger fails closed when a receipt-verified settle exceeds its
    // action's reservation. A profile that under-funds a trial lets one
    // maxed-out trial (up to DEFAULT_SOLVE_TRIAL_BUDGET.maxTotalTokens)
    // crash the run mid-flight instead of stopping at a budget boundary.
    for (const [name, profile] of Object.entries(TREE_V2_LIVE_PROFILES)) {
      const perTrial = Math.floor(profile.solverTokens / profile.taskTrials)
      expect(perTrial, `profile ${name}`).toBeGreaterThanOrEqual(
        DEFAULT_SOLVE_TRIAL_BUDGET.maxTotalTokens,
      )
    }
  })

  it('builds init arguments that select tree-v2, both live routes and the migration source', () => {
    const args = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.k3, {
      runsRoot: '/state/runs',
      runId: 'tree-v2-k3-test',
      masterSeed: 'tree-v2-k3-test-seed',
      tasksRoot: '/state/tasks',
      treeV2BaselineSource: '/repo/packages/candidate-tree-v2-baseline',
      legacyBaselineSource: '/repo/packages/candidate-baseline',
      jobsRoot: '/state/jobs',
      nativeDshCatalogRoot: '/repo/scratch/native-dsh-catalog',
      nativeDshClosureSha256: 'a'.repeat(64),
      credentialFile: '/run/secrets/model.key',
      modelBaseUrl: 'https://model.invalid/v1',
      modelName: 'solver-model',
      artifactHost: '172.17.0.1',
      artifactPort: 18443,
    })
    expect(args).toEqual(
      expect.arrayContaining([
        '--candidate-protocol',
        'tree-v2',
        '--legacy-baseline-source',
        '/repo/packages/candidate-baseline',
        '--proposer-route',
        'deepseek/zen-compatible',
        '--solver-route',
        'deepseek/zen-compatible',
        '--native-dsh-catalog-root',
        '/repo/scratch/native-dsh-catalog',
      ]),
    )
    expect(args).toContain('kTarget=3')
  })

  it('emits the three benchmark baseline carriers for k10 and none for k3 (ADR-042)', () => {
    const input = {
      runsRoot: '/state/runs',
      runId: 'tree-v2-k10-test',
      masterSeed: 'tree-v2-k10-test-seed',
      tasksRoot: '/state/tasks',
      treeV2BaselineSource: '/repo/packages/candidate-tree-v2-baseline',
      legacyBaselineSource: '/repo/packages/candidate-baseline',
      jobsRoot: '/state/jobs',
      nativeDshCatalogRoot: '/repo/scratch/native-dsh-catalog',
      nativeDshClosureSha256: 'a'.repeat(64),
      credentialFile: '/run/secrets/model.key',
      modelBaseUrl: 'https://model.invalid/v1',
      modelName: 'solver-model',
      artifactHost: '172.17.0.1',
      artifactPort: 18443,
    }
    const k10 = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.k10, input)
    expect(k10).toContain('baselineTaskCount=24')
    expect(k10).toContain('baselineAttemptsPerTask=1')
    expect(k10).toContain('baselineBatchSize=6')
    const k3 = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.k3, input)
    expect(k3).not.toContain('baselineTaskCount=')
    expect(k3).not.toContain('baselineAttemptsPerTask=')
    expect(k3).not.toContain('baselineBatchSize=')
  })

  it('emits the ADR-045 k80 carriers: alpha, proposal budget, concurrency, matrix', () => {
    const input = {
      runsRoot: '/state/runs',
      runId: 'tree-v2-k80-test',
      masterSeed: 'tree-v2-k80-test-seed',
      tasksRoot: '/state/tasks',
      treeV2BaselineSource: '/repo/packages/candidate-tree-v2-baseline',
      legacyBaselineSource: '/repo/packages/candidate-baseline',
      jobsRoot: '/state/jobs',
      nativeDshCatalogRoot: '/repo/scratch/native-dsh-catalog',
      nativeDshClosureSha256: 'a'.repeat(64),
      credentialFile: '/run/secrets/model.key',
      modelBaseUrl: 'https://model.invalid/v1',
      modelName: 'solver-model',
      artifactHost: '172.17.0.1',
      artifactPort: 18443,
    }
    const k80 = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.k80, input)
    expect(k80).toContain('ucbAirAlphaPerMille=800')
    expect(k80).toContain('proposalCalls=60')
    expect(k80).toContain('proposerTokens=60000000')
    expect(k80).toContain('baselineTaskCount=49')
    expect(k80).toContain('baselineAttemptsPerTask=2')
    expect(k80).toContain('baselineBatchSize=8')
    // ADR-049: the formal profile selects the terminal-bench-formal protocol
    // (tournament + sealed gates) and carries the tournament envelope as the
    // four flat --set keys.
    const profileIndex = k80.indexOf('--profile')
    expect(profileIndex).toBeGreaterThanOrEqual(0)
    expect(k80[profileIndex + 1]).toBe('terminal-bench-formal')
    expect(k80).toContain('tournamentMinEligibilityTrials=12')
    expect(k80).toContain('tournamentCoverageAttemptsPerTask=1')
    expect(k80).toContain('tournamentMaxTrials=360')
    expect(k80).toContain('tournamentBootstrapResamples=100000')
    // concurrentTrials rides the dedicated CLI flag, never --set.
    const concurrentIndex = k80.indexOf('--concurrent-trials')
    expect(concurrentIndex).toBeGreaterThanOrEqual(0)
    expect(k80[concurrentIndex + 1]).toBe('8')
    const repair3 = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.k80Repair3, input)
    expect(repair3).toContain('baselineTaskCount=49')
    expect(repair3).toContain('baselineAttemptsPerTask=1')
    expect(repair3).toContain('baselineBatchSize=12')
    // ADR-058: the search share rides the flat --set surface for repair3;
    // the preserved 49×2 k80 args stay byte-identical without it.
    expect(repair3).toContain('wallClockSearchMinutes=3600')
    expect(k80).not.toContain('wallClockSearchMinutes=')
    // ADR-059: the smoke emits the 2×1×1 matrix and serial concurrency,
    // stays stable-demo class (no --profile carrier).
    const smoke = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.treeV2Smoke, input)
    expect(smoke).toContain('baselineTaskCount=2')
    expect(smoke).toContain('baselineAttemptsPerTask=1')
    expect(smoke).toContain('baselineBatchSize=1')
    expect(smoke).not.toContain('--profile')
    expect(smoke).not.toContain('tournamentMinEligibilityTrials=')
    const smokeConcurrentIndex = smoke.indexOf('--concurrent-trials')
    expect(smoke[smokeConcurrentIndex + 1]).toBe('1')
    const repair3ConcurrentIndex = repair3.indexOf('--concurrent-trials')
    expect(repair3[repair3ConcurrentIndex + 1]).toBe('12')
    // k3/k10 keep the frozen defaults: no alpha/call/token/concurrency carriers.
    const k3 = buildTreeV2InitArgs(TREE_V2_LIVE_PROFILES.k3, input)
    expect(k3).not.toContain('ucbAirAlphaPerMille=')
    expect(k3).not.toContain('proposalCalls=')
    expect(k3).not.toContain('proposerTokens=')
    expect(k3).not.toContain('--concurrent-trials')
    expect(k3).not.toContain('--profile')
    expect(k3).not.toContain('tournamentMinEligibilityTrials=')
  })

  it('requires exact paid-run confirmation', () => {
    expect(() => requireLiveConfirmation(undefined)).toThrow(/DSH_TREE_V2_LIVE_CONFIRM=confirm/)
    expect(() => requireLiveConfirmation('yes')).toThrow(/DSH_TREE_V2_LIVE_CONFIRM=confirm/)
    expect(() => requireLiveConfirmation('confirm')).not.toThrow()
  })

  // ADR-040: the envelope must mirror the protocol's trial taxonomy, not the
  // old `discovery + expansions×coldStart` encoding that rejected both
  // attempt 12 (6 discovery, 0 admitted, 3 expansions) and attempt 13
  // (14 = 6 discovery + 4 admitted×1 cold start + 4 ordinary evaluations).
  describe('trial shape envelope (ADR-040)', () => {
    const k3 = TREE_V2_LIVE_PROFILES.k3

    it('accepts the actual attempt-13 shape (14 = 6 discovery + 4×1 cold start + 4 ordinary)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 14,
          discoveryTrials: 6,
          expansionAttempts: 2,
          admittedNonBaseline: 4,
          proposalCalls: 2,
        },
        k3,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('accepts the actual attempt-12 shape (6 discovery, 0 admitted, 3 expansions)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 6,
          discoveryTrials: 6,
          expansionAttempts: 3,
          admittedNonBaseline: 0,
          proposalCalls: 3,
        },
        k3,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects a shape the old formula mis-encodes (ordinary evaluations are legal)', () => {
      // The old formula demanded trials === discovery + expansions×coldStart;
      // here expansions admitted no node but ordinary evals ran — legal.
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 8,
          discoveryTrials: 6,
          expansionAttempts: 1,
          admittedNonBaseline: 0,
          proposalCalls: 1,
        },
        k3,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects discovery below the pre-registered batch width', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 6,
          discoveryTrials: 5,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/discovery/)
    })

    // ADR-041: the driver freezes the failure pool only at a batch boundary
    // that contains a real failure — an all-success first batch funds a
    // second one (maxDiscoveryTrials), so any funded batch multiple is a
    // legal discovery count, not just the first batch.
    it('accepts a funded second discovery batch (12 of k3 maxDiscoveryTrials=12)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 12,
          discoveryTrials: 12,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        k3,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects discovery beyond the funded maxDiscoveryTrials', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 13,
          discoveryTrials: 13,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/discovery/)
    })

    it('rejects a partial discovery batch (7 is not a batch multiple)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 7,
          discoveryTrials: 7,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/discovery/)
    })

    it('accepts the k10 pre-registered benchmark baseline matrix (24 = 24 tasks × 1 attempt)', () => {
      // ADR-042 (specs/04 §4.2): the k10 profile pre-registers the full
      // baseline matrix — the driver runs every (task, attempt) pair before
      // the zero-success pool freezes, so the baseline trial count must
      // equal the matrix exactly (the §4.1 discovery phase is replaced, and
      // its 12-cap becomes dormant for this profile).
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 24,
          discoveryTrials: 24,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k10,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects k10 baseline trials below the pre-registered matrix (12 ≠ 24)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 12,
          discoveryTrials: 12,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k10,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/benchmark baseline matrix 24×1=24/)
    })

    it('rejects a partial k10 matrix (18 ≠ 24)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 18,
          discoveryTrials: 18,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k10,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/benchmark baseline matrix 24×1=24/)
    })

    it('accepts the k80 pre-registered benchmark baseline matrix (98 = 49 tasks × 2 attempts)', () => {
      // ADR-049: the formal k80 profile pre-registers the guard-inclusive
      // 49-task matrix (39 observed + 10 guard) × 2 attempts = 98 baseline
      // trials before the zero-success pool freezes.
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 98,
          discoveryTrials: 98,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects k80 baseline trials below the pre-registered matrix (49 ≠ 98)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 49,
          discoveryTrials: 49,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/benchmark baseline matrix 49×2=98/)
    })

    it('accepts the smoke terminal shapes: K_REACHED (3) and NO_REAL_FAILURE_SIGNAL (2)', () => {
      // ADR-059 (amended 2026-09-09): a 2×1 matrix; a real failure funds one
      // expansion with one q0 cold start (trials=3, K=1 reached), an
      // all-success matrix stops NO_REAL_FAILURE_SIGNAL (trials=2). Both are
      // the only funded shapes.
      const smoke = TREE_V2_LIVE_PROFILES.treeV2Smoke
      const reached = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 3,
          discoveryTrials: 2,
          expansionAttempts: 1,
          admittedNonBaseline: 1,
          proposalCalls: 1,
        },
        smoke,
      )
      expect(reached.ok, reached.problems.join('; ')).toBe(true)
      const noSignal = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 2,
          discoveryTrials: 2,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        smoke,
      )
      expect(noSignal.ok, noSignal.problems.join('; ')).toBe(true)
    })

    it('rejects a smoke baseline above the pre-registered 2×1 matrix', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 3,
          discoveryTrials: 3,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.treeV2Smoke,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/benchmark baseline matrix 2×1=2/)
    })

    it('passes the launch-gate calibration on the amended smoke envelope (ADR-059)', () => {
      // The doctor's search-calibration gate: minimumTrials = finalGate
      // ceil(K^(1/alpha)) + q0×shortlist = 1 + 2 = 3; the 2×1 matrix supplies
      // matrixTrials 2 + K×taskCount 2 = 4 ≥ 3 (a 1×1 matrix supplies 2 < 3 —
      // the rejection the smoke attempt 1 recorded).
      const verdict = calibrateSearch({
        kTarget: TREE_V2_LIVE_PROFILES.treeV2Smoke.kTarget,
        coldStartTrials: TREE_V2_LIVE_PROFILES.treeV2Smoke.coldStartTrials,
        shortlistSize: TREE_V2_LIVE_PROFILES.treeV2Smoke.shortlistSize,
        ucbAirAlphaPerMille: 600,
        maxSolverTrials: TREE_V2_LIVE_PROFILES.treeV2Smoke.maxSolverTrials,
        taskTrials: TREE_V2_LIVE_PROFILES.treeV2Smoke.taskTrials,
        benchmarkBaseline: TREE_V2_LIVE_PROFILES.treeV2Smoke.benchmarkBaseline,
      })
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('accepts repair3’s one-attempt matrix and rejects a partial one', () => {
      const complete = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 49,
          discoveryTrials: 49,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k80Repair3,
      )
      expect(complete.ok, complete.problems.join('; ')).toBe(true)
      const partial = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 48,
          discoveryTrials: 48,
          expansionAttempts: 0,
          admittedNonBaseline: 0,
          proposalCalls: 0,
        },
        TREE_V2_LIVE_PROFILES.k80Repair3,
      )
      expect(partial.ok).toBe(false)
      expect(partial.problems.join('; ')).toMatch(/benchmark baseline matrix 49×1=49/)
    })

    it('accepts a k80 matrix with the search-phase trials on top (98 + cold starts + ordinary)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 120,
          discoveryTrials: 98,
          expansionAttempts: 4,
          admittedNonBaseline: 4,
          proposalCalls: 4,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects k80 trials above the amended 400-trial search envelope', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 401,
          discoveryTrials: 98,
          expansionAttempts: 40,
          admittedNonBaseline: 80,
          proposalCalls: 40,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/taskTrials|maxSolverTrials/)
    })

    it('rejects k80 admission beyond the wave-snapshot overshoot bound (K + shortlist − 1 = 84)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 300,
          discoveryTrials: 98,
          expansionAttempts: 30,
          admittedNonBaseline: 85,
          proposalCalls: 30,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/overshoot|admitted/)
    })

    // ADR-049: the formal run's trial budget spans two phases — the search
    // envelope (≤ maxSolverTrials) and the champion tournament (≤
    // tournament.maxTrials) — each bounded separately, with the combined
    // total inside taskTrials.
    it('accepts the full formal shape: 400-trial search + 294-trial tournament inside 760', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 400,
          discoveryTrials: 98,
          expansionAttempts: 50,
          admittedNonBaseline: 80,
          proposalCalls: 50,
          tournamentTrials: 294,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('accepts a search that stopped early (no tournament entered)', () => {
      // BUDGET_EXHAUSTED / TRIAL_CAP before K_REACHED: no tournament rows —
      // the search-phase bounds alone bound the run.
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 150,
          discoveryTrials: 98,
          expansionAttempts: 8,
          admittedNonBaseline: 6,
          proposalCalls: 8,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects tournament trials above the pre-registered maxTrials (361 > 360)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 400,
          discoveryTrials: 98,
          expansionAttempts: 50,
          admittedNonBaseline: 80,
          proposalCalls: 50,
          tournamentTrials: 361,
        },
        TREE_V2_LIVE_PROFILES.k80,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/tournament/)
    })

    it('rejects tournament trials reported by a profile without a tournament envelope', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 14,
          discoveryTrials: 6,
          expansionAttempts: 2,
          admittedNonBaseline: 4,
          proposalCalls: 2,
          tournamentTrials: 1,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/tournament/)
    })

    it('rejects a combined total above taskTrials (per-phase caps are not the only bound)', () => {
      // Defense in depth: a profile whose phase caps sum past taskTrials must
      // still fail closed on the combined total.
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 400,
          discoveryTrials: 98,
          expansionAttempts: 50,
          admittedNonBaseline: 80,
          proposalCalls: 50,
          tournamentTrials: 300,
        },
        { ...TREE_V2_LIVE_PROFILES.k80, taskTrials: 699 },
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/taskTrials/)
    })

    it('accepts a k10 matrix with the search-phase trials on top (24 + cold starts + ordinary)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 30,
          discoveryTrials: 24,
          expansionAttempts: 3,
          admittedNonBaseline: 5,
          proposalCalls: 3,
        },
        TREE_V2_LIVE_PROFILES.k10,
      )
      expect(verdict.ok, verdict.problems.join('; ')).toBe(true)
    })

    it('rejects trials that cannot cover discovery + cold starts', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 5,
          discoveryTrials: 6,
          expansionAttempts: 1,
          admittedNonBaseline: 1,
          proposalCalls: 1,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/cannot cover/)
    })

    it('rejects trials above taskTrials and maxSolverTrials', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 16,
          discoveryTrials: 6,
          expansionAttempts: 2,
          admittedNonBaseline: 5,
          proposalCalls: 2,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/taskTrials/)
    })

    it('rejects admission beyond the wave-snapshot overshoot bound (K + shortlist − 1)', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 14,
          discoveryTrials: 6,
          expansionAttempts: 2,
          admittedNonBaseline: 5,
          proposalCalls: 2,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/overshoot|admitted/)
    })

    it('rejects proposal calls that do not equal expansion attempts', () => {
      const verdict = trialShapeWithinPreRegisteredEnvelope(
        {
          trials: 8,
          discoveryTrials: 6,
          expansionAttempts: 2,
          admittedNonBaseline: 1,
          proposalCalls: 1,
        },
        k3,
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.problems.join('; ')).toMatch(/proposal/)
    })

    it('registers NO_ADMISSIBLE_CHILD as a terminal stop reason (attempt 12 false failure)', () => {
      expect(REGISTERED_TERMINAL_STOP_REASONS).toContain('NO_ADMISSIBLE_CHILD')
    })

    it('registers NO_ADMISSIBLE_TASK as a terminal stop reason (search exhaustion, ADR-041)', () => {
      // A 60-trial k10 search over a small frozen pool can legitimately end
      // when every admitted candidate has tried every pool handle — the
      // driver emits NO_ADMISSIBLE_TASK from its frozen StopReason union, and
      // mis-scoring it would repeat the attempt-12 NO_ADMISSIBLE_CHILD false
      // failure (ADR-040).
      expect(REGISTERED_TERMINAL_STOP_REASONS).toContain('NO_ADMISSIBLE_TASK')
    })

    // ADR-047/049: the formal run's own terminal states must be registered —
    // the champion lock ends the paid search+champion phases, the
    // no-improvement verdict ends the tournament without touching sealed,
    // and the information-flow monitor's abort is a first-class stop, not a
    // record-script failure.
    it('registers the formal terminal states (CHAMPION_LOCKED, NO_DEVELOPMENT_IMPROVEMENT, SAFETY_ABORTED)', () => {
      expect(REGISTERED_TERMINAL_STOP_REASONS).toContain('CHAMPION_LOCKED')
      expect(REGISTERED_TERMINAL_STOP_REASONS).toContain('NO_DEVELOPMENT_IMPROVEMENT')
      expect(REGISTERED_TERMINAL_STOP_REASONS).toContain('SAFETY_ABORTED')
    })
  })

  describe('usage attribution verdicts (ADR-040)', () => {
    it('covers a killed live trial through its verified receipt chain', () => {
      // Attempt 13's AgentTimeoutError trial: Harbor discarded the capsule
      // report (no metadata, no usage) but the gateway recorded 25 requests.
      const verdict = receiptChainCoversTrial({
        chainVerified: true,
        chainRequests: 25,
        neverInitialized: false,
      })
      expect(verdict.ok, verdict.detail).toBe(true)
      // The capsule never completed its report, so the Harbor cross-check is
      // exempt by construction.
      expect(
        harborUsageReportedWhenCapsuleCompleted({
          capsuleCompleted: false,
          harborUsagePositive: false,
        }).ok,
      ).toBe(true)
    })

    it('treats a never-booted trial with an empty chain as the honest zero', () => {
      const verdict = receiptChainCoversTrial({
        chainVerified: true,
        chainRequests: 0,
        neverInitialized: true,
      })
      expect(verdict.ok, verdict.detail).toBe(true)
    })

    it('treats a never-booted trial with a MISSING receipt file as the honest zero', () => {
      // verifySolveReceipts fails closed on a missing file; the never-booted
      // record is the only classification that makes that failure honest.
      const verdict = receiptChainCoversTrial({
        chainVerified: false,
        chainRequests: 0,
        neverInitialized: true,
      })
      expect(verdict.ok, verdict.detail).toBe(true)
    })

    it('keeps receipt coverage ahead of the never-initialized heuristic', () => {
      // Attempt 13's killed trial: Harbor lost the initialize record
      // (neverInitialized true) but the chain proves 25 real requests — the
      // chain is the authority, not the classification.
      const verdict = receiptChainCoversTrial({
        chainVerified: true,
        chainRequests: 25,
        neverInitialized: true,
      })
      expect(verdict.ok, verdict.detail).toBe(true)
    })

    it('fails closed on a trial with no chain coverage and no honest-zero classification', () => {
      const verdict = receiptChainCoversTrial({
        chainVerified: true,
        chainRequests: 0,
        neverInitialized: false,
      })
      expect(verdict.ok).toBe(false)
      expect(verdict.detail).toMatch(/unattributable/)
    })

    it('requires positive Harbor usage whenever the capsule completed its report', () => {
      expect(
        harborUsageReportedWhenCapsuleCompleted({
          capsuleCompleted: true,
          harborUsagePositive: false,
        }).ok,
      ).toBe(false)
      expect(
        harborUsageReportedWhenCapsuleCompleted({
          capsuleCompleted: true,
          harborUsagePositive: true,
        }).ok,
      ).toBe(true)
    })
  })
})
