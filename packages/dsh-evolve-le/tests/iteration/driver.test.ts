/**
 * Iteration-driver contract tests (Gate 5, specs/07 §7): the closed loop —
 * discovery → frozen failure pool → expansion (parent Thompson → export →
 * proposal saga → trusted rebuild → admission) → evaluation → stop — over the
 * durable controller, with the benchmark provider and the capsule builder
 * faked but every planning/selection/journal/replay path real.
 *
 * Pins:
 * - one command reaches the full loop and stops at K with a real admitted child;
 * - a repeated drive re-runs nothing (no second launch, no second proposal);
 * - no real failure signal stops honestly as NO_REAL_FAILURE_SIGNAL;
 * - repeated failed expansions stop as NO_ADMISSIBLE_CHILD at the frozen cap;
 * - an exhausted budget stops the loop BEFORE the next paid launch;
 * - the controller-visible ceremony/manifest documents never name guard or
 *   sealed tasks, and the guard map travels only to the provider bridge.
 *
 * Gate 6 (specs/07 §8): the stable K=3 shape — three admitted children over
 * at least two lineage depths, every child cold-started from the frozen
 * baseline-failure pool (`STABLE_ITERATION_VERIFIED`), and a crash after a
 * committed external effect resuming to the same terminal state.
 */
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  IterationDriver,
  parentComparableObservations,
  type BuildCapsuleFn,
} from '../../src/iteration/driver.js'
import type { Observation } from '../../src/state/reducer.js'
import { FakeProvider, type ScriptedResult } from '../../src/controller/provider.js'
import type { ControllerConfig } from '../../src/controller/controller.js'
import { defaultRunConfig, validateRunConfig, type RunConfig } from '../../src/config/run-config.js'
import { runSplitCeremony, type SplitCounts } from '../../src/split/ceremony.js'
import { deriveCanaryTokens, canaryFingerprint } from '../../src/proposer/canary.js'
import { journalDirOf } from '../../src/state/journal.js'
import { captureCanonicalSource, candidateIdFromDigest } from '../../src/candidate/canonical.js'
import { solverRoutePlan } from '../../src/proposer/remote-runner.js'
import { remoteRoutePlanHash } from '../../src/proposer/remote-gateway.js'
import {
  cleanupFixtureDirs,
  driverFor,
  fakeBridge,
  fakeBuildCapsule,
  fakeSandboxRunner,
  FORMAL_OVERRIDES,
  formalRun,
  HANDLES,
  journalText,
  lockDoc,
  makeDriver,
  newRun,
  scriptBaselineTournament,
  scriptMatrixFailures,
  SEALED_RECEIPT,
  shortId,
  tickClock,
  TOUR_COUNTS,
  TOUR_HANDLES,
  TOUR_MATRIX,
  withTournament,
  type Bridge,
} from './fixture.js'

afterAll(async () => {
  await cleanupFixtureDirs()
})

describe('iteration driver: closed loop', () => {
  it('uses only the frozen failure-pool task stratum for parent Thompson evidence', () => {
    const observation = (fields: Partial<Observation>): Observation => ({
      actionId: 'act-1',
      candidateId: 'root',
      opaqueTaskId: 'pool-failure',
      split: 'dev-observed',
      attempt: 1,
      outcome: 'failure',
      reward: 0,
      costUsdMicros: null,
      durationMs: null,
      ...fields,
    })

    const comparable = parentComparableObservations(
      [
        observation(),
        // This baseline pass establishes that this handle is outside the
        // zero-success pool.  It must not inflate root's parent Beta prior.
        observation({
          actionId: 'baseline-pass',
          opaqueTaskId: 'solved-task',
          outcome: 'success',
          reward: 1,
        }),
        observation({ actionId: 'guard', candidateId: 'child', split: 'dev-guard' }),
        observation({ actionId: 'child-failure', candidateId: 'child' }),
      ],
      ['pool-failure'],
    )

    expect(comparable).toEqual([
      expect.objectContaining({ actionId: 'act-1' }),
      expect.objectContaining({ actionId: 'child-failure' }),
    ])
  })

  it('refuses the built-in admission pipeline without a frozen native DSH lock', async () => {
    const fx = await newRun('dsh-drive-native-lock-')
    expect(
      () =>
        new IterationDriver({
          config: fx.config,
          configHash: fx.configHash,
          runRoot: fx.runRoot,
          handles: HANDLES,
          provider: new FakeProvider({ outcome: 'success' }),
          bridge: fakeBridge(),
        }),
    ).toThrow(/native DSH runtime lock is required/)
  })

  it('reaches K with a real admitted child and a frozen failure pool', async () => {
    const fx = await newRun('dsh-drive-k-')
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })

    // Script the second discovery task to fail: the pool freezes after one batch.
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const failing = ceremony.ceremony.observedHandles[1]!
    provider.script(`eval-eval-${shortId(baselineId)}-${failing}`, { outcome: 'failure' })

    const driver = makeDriver(fx, provider, bridge, runner)
    const report = await driver.drive()

    expect(report.stopReason).toBe('K_REACHED')
    expect(report.status).toBe('STOPPED:K_REACHED') // depth 1 alone is not stable-verified
    expect(report.failurePool).toEqual([failing])
    expect(report.discoveryTrials).toBe(2)
    // Gate 6 semantics: K stops only after the child's q0 cold start from the
    // frozen pool — 2 discovery trials + 1 child pool trial.
    expect(report.trials).toBe(3)
    expect(report.admittedNonBaseline).toBe(1)
    expect(report.expansionAttempts).toBe(1)
    expect(report.consecutiveExpansionFailures).toBe(0)
    expect(runner.calls).toHaveLength(1)
    // The child is bound on the provider with its capsule identity.
    expect(bridge.capsules.size).toBe(2)
    expect(provider.counters.launchEffects).toHaveLength(3)
    // The child really carries a new source (lineage registered, admitted).
    const manifest = JSON.parse(await readFile(join(fx.runRoot, 'run-manifest.json'), 'utf8')) as {
      configHash: string
    }
    expect(manifest.configHash).toBe(fx.configHash)
    const catalog = JSON.parse(
      await readFile(join(fx.runRoot, 'archive-catalog.json'), 'utf8'),
    ) as {
      entries: Array<{ candidateId: string }>
    }
    expect(catalog.entries.length).toBe(2)
  }, 120_000)

  it('a repeated drive re-runs nothing (no new launch, proposal, or score)', async () => {
    const fx = await newRun('dsh-drive-idem-')
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const failing = ceremony.ceremony.observedHandles[1]!
    provider.script(`eval-eval-${shortId(baselineId)}-${failing}`, { outcome: 'failure' })

    const first = await makeDriver(fx, provider, bridge, runner).drive()
    const launches = provider.counters.launchEffects.length
    const proposals = runner.calls.length
    const bridgeCalls = bridge.capsules.size

    const second = await makeDriver(fx, provider, bridge, runner).drive()
    expect(second.stopReason).toBe(first.stopReason)
    expect(second.trials).toBe(first.trials)
    expect(second.stateHash).toBe(first.stateHash)
    expect(provider.counters.launchEffects).toHaveLength(launches)
    expect(runner.calls).toHaveLength(proposals)
    expect(bridge.capsules.size).toBe(bridgeCalls)
  }, 120_000)

  it('stops honestly as NO_REAL_FAILURE_SIGNAL when every discovery trial passes', async () => {
    const fx = await newRun('dsh-drive-nofail-')
    const provider = new FakeProvider({ outcome: 'success' })
    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner()).drive()
    expect(report.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(report.failurePool).toEqual([])
    expect(report.admittedNonBaseline).toBe(0)
    // No proposal may have run: no failure evidence → no expansion.
    const searchState = JSON.parse(
      await readFile(join(fx.runRoot, 'search-state.json'), 'utf8'),
    ) as { expansionAttempts: number }
    expect(searchState.expansionAttempts).toBe(0)
  })

  it('applies a four-trial provider wave during discovery', async () => {
    class ConcurrentProvider extends FakeProvider {
      active = 0
      maxActive = 0

      override async launch(request: unknown, idempotencyKey: string) {
        this.active += 1
        this.maxActive = Math.max(this.maxActive, this.active)
        try {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
          return await super.launch(request, idempotencyKey)
        } finally {
          this.active -= 1
        }
      }
    }

    const fx = await newRun(
      'dsh-drive-c4-',
      {
        kTarget: 1,
        maxDiscoveryTrials: 4,
        discoveryBatchSize: 4,
        maxSolverTrials: 5,
        taskTrials: 5,
      },
      undefined,
      undefined,
      4,
    )
    const provider = new ConcurrentProvider({ outcome: 'success' })
    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner()).drive()

    expect(report.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(report.discoveryTrials).toBe(4)
    expect(provider.maxActive).toBe(4)
  })

  it('fails closed when a discovery trial is infra-dead: no pool freeze, no further paid launch (ADR-028)', async () => {
    // Attempt 7's live defect: the baseline's AgentSetupTimeoutError trial
    // normalized to outcome 'missing' and its handle froze into the pool as a
    // "baseline failure" — an agent that never ran is not a capability fact.
    // The driver must throw before freezing (and before paying for the rest of
    // the batch or any proposal), leaving the run root honestly unfrozen.
    const fx = await newRun('dsh-drive-infra-dead-')
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const dead = ceremony.ceremony.observedHandles[0]!
    provider.script(`eval-eval-${shortId(baselineId)}-${dead}`, { outcome: 'missing' })

    const runner = fakeSandboxRunner()
    await expect(makeDriver(fx, provider, fakeBridge(), runner).drive()).rejects.toThrow(
      /infra-dead discovery trial\(s\) \[.*\]: an agent that never ran is not a capability fact/,
    )
    // Nothing froze and nothing beyond the discovery batch was paid for.
    await expect(access(join(fx.runRoot, 'failure-pool.json'))).rejects.toThrow(/ENOENT/)
    expect(runner.calls).toHaveLength(0)
  })

  it('stops as NO_ADMISSIBLE_CHILD after the frozen consecutive-failure cap', async () => {
    const fx = await newRun('dsh-drive-nochild-')
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const failing = ceremony.ceremony.observedHandles[1]!
    provider.script(`eval-eval-${shortId(baselineId)}-${failing}`, { outcome: 'failure' })
    const runner = fakeSandboxRunner({ failWorker: true })

    const report = await makeDriver(fx, provider, fakeBridge(), runner).drive()
    expect(report.stopReason).toBe('NO_ADMISSIBLE_CHILD')
    expect(report.expansionAttempts).toBe(2)
    expect(report.consecutiveExpansionFailures).toBe(2)
    expect(report.admittedNonBaseline).toBe(0)
    // ADR-044: both failed expansions are durable rejection records, and the
    // second expansion's request carried the first one's reasons.
    const searchState = JSON.parse(
      await readFile(join(fx.runRoot, 'search-state.json'), 'utf8'),
    ) as { proposalRejections?: Array<{ actionId: string; batchErrors: string[] }> }
    expect(searchState.proposalRejections).toHaveLength(2)
    expect(searchState.proposalRejections!.map((entry) => entry.actionId)).toEqual([
      'prop-1',
      'prop-2',
    ])
    expect(searchState.proposalRejections![0]!.batchErrors.join(' ')).toContain('worker failed')
    expect(runner.priorRejectionCalls).toHaveLength(2)
    expect(runner.priorRejectionCalls[0]).toEqual([])
    expect(runner.priorRejectionCalls[1]!.map((entry) => entry.actionId)).toEqual(['prop-1'])
  }, 120_000)

  it('drains admitted q0 cold starts before another UCB expansion (ADR-052)', async () => {
    // This is the K=80 failure shape at compact scale: a large frozen
    // baseline makes N^alpha keep admitting new nodes.  q0 is an experimental
    // constraint (§6), so it must preempt that expansion gate; otherwise the
    // envelope can contain admitted nodes with zero observations.
    const fx = await newRun('dsh-drive-cold-before-expand-', {
      kTarget: 10,
      proposalWidth: 1,
      coldStartTrials: 1,
      maxSolverTrials: 40,
      taskTrials: 40,
      maxConsecutiveExpansionFailures: 2,
    })
    fx.config.search.benchmarkBaseline = { taskCount: 4, attemptsPerTask: 2, batchSize: 4 }
    fx.config.search.ucbAirAlphaPerMille = 1000
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    for (const handle of ceremony.ceremony.observedHandles.slice(0, 4)) {
      provider.script(`eval-eval-${shortId(baselineId)}-${handle}-a1`, { outcome: 'failure' })
      provider.script(`eval-eval-${shortId(baselineId)}-${handle}-a2`, { outcome: 'failure' })
    }

    const runner = fakeSandboxRunner()
    let observedFirstChild = false
    const stopAfterFirstChild: ControllerConfig['onBoundary'] = (point, actionId) => {
      if (
        point === 'action-committed' &&
        actionId?.startsWith('eval-') === true &&
        !actionId.includes(shortId(baselineId))
      ) {
        observedFirstChild = true
        // With alpha=1 and N=8 the legacy scheduler would have dispatched
        // seven more expansions before this first child evaluation.
        expect(runner.calls).toHaveLength(1)
        throw new Error('stop after q0 ordering assertion')
      }
    }

    await expect(
      makeDriver(fx, provider, fakeBridge(), runner, { onBoundary: stopAfterFirstChild }).drive(),
    ).rejects.toThrow('stop after q0 ordering assertion')
    expect(observedFirstChild).toBe(true)
  }, 120_000)

  it('reserves no more than q0 cold starts for a child inside a wide wave', async () => {
    // The formal profile has q0=3 but uses 12 Harbor slots.  A scheduler that
    // only consults committed observations sees the same child as cold for all
    // twelve draws and silently turns q0 into the concurrency width.  Keep the
    // pool at four handles so the fourth reservation catches the old bug: it
    // was another cold-start dispatch solely because the first three had not
    // committed yet.
    const fx = await newRun(
      'dsh-drive-q0-virtual-reservations-',
      {
        kTarget: 1,
        proposalWidth: 1,
        coldStartTrials: 3,
        maxSolverTrials: 20,
        taskTrials: 20,
      },
      undefined,
      undefined,
      12,
    )
    fx.config.search.benchmarkBaseline = { taskCount: 4, attemptsPerTask: 2, batchSize: 4 }
    const provider = new FakeProvider({ outcome: 'failure' })
    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner()).drive()

    expect(report.stopReason).toBe('K_REACHED')
    expect(report.discoveryTrials).toBe(8)
    expect(report.trials).toBe(11)
    expect(provider.counters.launchEffects).toHaveLength(11)
  }, 120_000)

  it('does not export a known never-initialized failure as proposer evidence', async () => {
    const fx = await newRun('dsh-drive-proposer-actionability-', {
      kTarget: 1,
      proposalWidth: 1,
      maxSolverTrials: 8,
      taskTrials: 8,
    })
    fx.config.search.benchmarkBaseline = { taskCount: 2, attemptsPerTask: 2, batchSize: 2 }
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const [dead, actionable] = ceremony.ceremony.observedHandles
    expect(dead).toBeDefined()
    expect(actionable).toBeDefined()
    for (const attempt of ['a1', 'a2']) {
      provider.script(`eval-eval-${shortId(baselineId)}-${dead!}-${attempt}`, {
        outcome: 'failure',
        trajectory: Buffer.from(
          JSON.stringify({ trial: { outcome: { agentParticipation: 'never-initialized' } } }),
        ),
      })
      provider.script(`eval-eval-${shortId(baselineId)}-${actionable!}-${attempt}`, {
        outcome: 'failure',
        trajectory: Buffer.from(
          JSON.stringify({ trial: { outcome: { agentParticipation: 'ran' } } }),
        ),
        diagnosticBundle: Buffer.from(
          JSON.stringify({ events: [{ index: 0 }], tests: [{ index: 0 }] }),
        ),
      })
    }
    const runner = fakeSandboxRunner()
    let attributed = 0
    const configured = validateRunConfig({
      ...fx.config,
      modelRoutes: fx.config.modelRoutes.map((route) =>
        route.id === 'deepseek/zen-compatible'
          ? {
              ...route,
              baseUrl: 'https://example.test/v1',
              model: 'deepseek-reasoner',
              temperature: 1,
            }
          : route,
      ),
      agentDebugger: {
        route: 'deepseek/zen-compatible',
        maxOutputTokens: 8192,
        requestTimeoutMs: 180_000,
        maxInputBytes: 524_288,
      },
      budget: { ...fx.config.budget, attributionCalls: 4, attributionTokens: 300_000 },
    })
    if (!configured.ok) throw new Error(configured.error.errors.join('; '))
    const liveFx = { ...fx, config: configured.config, configHash: configured.configHash }

    await makeDriver(liveFx, provider, fakeBridge(), runner, {
      failureAttributor: {
        async attributeWithReceipt(input) {
          attributed += 1
          expect(input.traces).toHaveLength(2)
          return {
            outcome: 'ok' as const,
            artifact: Buffer.from(
              JSON.stringify({
                protocol: 'dsh-evolve-le/agent-debugger/v2',
                source: 'test',
                traces: input.traces.map((trace) => ({
                  diagnosticTraceDigest: trace.diagnosticTraceDigest,
                  evidence: [{ source: 'events', index: 0 }],
                })),
              }),
            ),
            receipt: {
              routeId: 'deepseek/zen-compatible',
              routeHash: `sha256:${'a'.repeat(64)}`,
              inputSha256: `sha256:${'b'.repeat(64)}`,
              status: 'ok' as const,
              responseSha256: `sha256:${'c'.repeat(64)}`,
              promptTokens: 100,
              completionTokens: 200,
              costUsdMicros: 12,
              modelReportedUsage: true,
              attempts: [{ outcome: 'ok' }],
            },
          }
        },
        async attribute() {
          throw new Error('durable debugger must not fall back to legacy direct storage')
        },
      },
    }).drive()

    expect(attributed).toBeGreaterThan(0)
    const controllerJournal = await journalText(fx.runRoot)
    expect(controllerJournal).toContain('"kind":"attribution"')
    expect(controllerJournal).toContain('attribution-receipt')
    expect(controllerJournal).toContain('failure-attribution')
    expect(runner.exportDirs.length).toBeGreaterThan(0)
    for (const exportDir of runner.exportDirs) {
      const objectNames = await readdir(join(exportDir, 'objects'))
      const objectBytes = await Promise.all(
        objectNames.map((name) => readFile(join(exportDir, 'objects', name), 'utf8')),
      )
      // The identical actionable trajectories dedupe in CAS; both normalized
      // action facts remain distinct and the trusted failure index is one
      // extra, compact entry point for diagnosis.
      expect(objectBytes).toHaveLength(6)
      expect(objectBytes.join('\n')).not.toContain('never-initialized')
      expect(objectBytes.join('\n')).toContain('"actionId"')
      const index = objectBytes
        .map(
          (bytes) =>
            JSON.parse(bytes) as {
              protocol?: string
              entries?: Array<{ diagnosticTraceDigest?: string }>
              attributionDigest?: string
            },
        )
        .find((value) => value.protocol === 'dsh-evolve-le/failure-index/v1')
      expect(index?.entries).toHaveLength(2)
      expect(index?.attributionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(index?.entries?.every((entry) => entry.diagnosticTraceDigest !== undefined)).toBe(true)
      expect(objectBytes.join('\n')).toContain('dsh-evolve-le/agent-debugger/v2')
    }
  }, 120_000)

  it('a child the trusted builder rejects is skipped, never a run crash (specs/03 §7)', async () => {
    // Live Gate 8 defect (ADR-026): prop batches whose children fail their
    // own contract tests crashed the whole run out of expand() because the
    // rebuild bridge was admitted-or-throw. specs/03 §7 pre-registers the
    // opposite: 全部 build reject counts as ONE expansion failure. Here the
    // builder rejects the first child rebuild; the run must keep going, keep
    // the child registered-and-unadmitted, and carry the reason in the report.
    const fx = await newRun('dsh-drive-reject-')
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const failing = ceremony.ceremony.observedHandles[1]!
    provider.script(`eval-eval-${shortId(baselineId)}-${failing}`, { outcome: 'failure' })

    let childRebuilds = 0
    const rejectingBuild: BuildCapsuleFn = async (sourceDir, parentTreeDir) => {
      if (parentTreeDir === undefined) return fakeBuildCapsule(sourceDir) // baseline
      childRebuilds += 1
      if (childRebuilds === 1) {
        // The exact live shape: the candidate's own spec suite fails.
        return {
          outcome: 'rejected',
          stage: 'typeLintUnit',
          reason: 'candidate tests failed: × registers exactly one candidate:identity section',
        }
      }
      return fakeBuildCapsule(sourceDir, parentTreeDir)
    }

    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner(), {
      buildCapsule: rejectingBuild,
    }).drive()

    // The loop survived the rejection and finished by protocol.
    expect(['K_REACHED', 'NO_ADMISSIBLE_CHILD']).toContain(report.stopReason)
    expect(report.rebuildRejections.length).toBe(1)
    expect(report.rebuildRejections[0]).toMatchObject({
      actionId: 'prop-1',
      stage: 'typeLintUnit',
    })
    expect(report.rebuildRejections[0]?.reason).toContain('candidate tests failed')
    // The rejected child is auditable but NOT admitted: absent from the
    // archive catalog, and the admitted count matches the catalog exactly.
    const catalog = JSON.parse(
      await readFile(join(fx.runRoot, 'archive-catalog.json'), 'utf8'),
    ) as { entries: Array<{ candidateId: string; parentCandidateId: string | null }> }
    const catalogued = catalog.entries.filter((entry) => entry.parentCandidateId !== null)
    expect(catalogued.length).toBe(report.admittedNonBaseline)
    expect(catalogued.map((entry) => entry.candidateId)).not.toContain(
      report.rebuildRejections[0]?.candidateId,
    )
  }, 120_000)

  it('a crash mid-rebuild abandons the intent: one failure, children registered, resume proceeds', async () => {
    // specs/03 §7: 恢复时仍未完成且没有 admitted child 的 intent 计作一次失败.
    // A builder-ENVIRONMENT throw (the only kind that still crashes) kills
    // the process after the proposal committed; the resume must close the
    // intent as ONE failure, record its never-rebuilt children, re-bind the
    // capsules built by the dead process, and drive on to the protocol stop.
    const fx = await newRun('dsh-drive-abandon-')
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const failing = ceremony.ceremony.observedHandles[1]!
    provider.script(`eval-eval-${shortId(baselineId)}-${failing}`, { outcome: 'failure' })
    const clock = tickClock()

    const explodingBuild: BuildCapsuleFn = async (sourceDir, parentTreeDir) => {
      if (parentTreeDir !== undefined) throw new Error('simulated builder environment death')
      return fakeBuildCapsule(sourceDir)
    }
    await expect(
      makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner(), {
        buildCapsule: explodingBuild,
        clock,
      }).drive(),
    ).rejects.toThrow(/simulated builder environment death/)

    // Resume in a NEW process shape: fresh bridge (empty capsule registry —
    // rebindCapsuleRecords must repopulate it from the run root) and the
    // healthy builder.
    const resumedBridge = fakeBridge()
    const report = await makeDriver(fx, provider, resumedBridge, fakeSandboxRunner(), {
      clock,
    }).drive()

    expect(report.stopReason).toBe('K_REACHED')
    // The abandoned intent was closed as exactly one failure + attempt.
    expect(report.abandonedIntents.length).toBeGreaterThanOrEqual(1)
    expect(report.abandonedIntents[0]?.actionId).toBe('prop-1')
    expect(report.expansionAttempts).toBe(2)
    expect(report.consecutiveExpansionFailures).toBe(0)
    // Capsules from the dead process are launchable in the new one.
    expect(resumedBridge.capsules.size).toBeGreaterThanOrEqual(2)
    // The abandoned child never admitted.
    const catalog = JSON.parse(
      await readFile(join(fx.runRoot, 'archive-catalog.json'), 'utf8'),
    ) as { entries: Array<{ candidateId: string }> }
    expect(catalog.entries.map((entry) => entry.candidateId)).not.toContain(
      report.abandonedIntents[0]?.candidateId,
    )

    // Idempotence: a third drive settles nothing new.
    const again = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner(), {
      clock,
    }).drive()
    expect(again.expansionAttempts).toBe(2)
    expect(again.abandonedIntents.length).toBe(report.abandonedIntents.length)
    expect(again.stateHash).toBe(report.stateHash)
  }, 180_000)

  it('an exhausted budget stops the loop BEFORE the next paid launch', async () => {
    // $1 total. Each discovery trial reserves the worst case
    // floor($1 / 15 trials) and settles exactly that (a settle may not exceed
    // its reservation); after two trials the proposal dispatch — a whole-dollar
    // worst case with proposalCalls=1 — cannot fit, so the loop must stop
    // without dispatching it.
    const usdLimit = 1_000_000
    const reservedUsd = Math.floor(usdLimit / 15)
    const fx = await newRun('dsh-drive-budget-', {
      usd: usdLimit,
      proposalCalls: 1,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    for (const handle of ceremony.ceremony.observedHandles.slice(0, 2)) {
      provider.script(`eval-eval-${shortId(baselineId)}-${handle}`, {
        outcome: 'failure',
        costUsdMicros: reservedUsd,
      })
    }

    const report = await makeDriver(fx, provider, bridge, runner).drive()
    expect(report.stopReason).toBe('BUDGET_EXHAUSTED')
    expect(report.failurePool.length).toBeGreaterThan(0)
    expect(report.expansionAttempts).toBe(0)
    // Nothing paid beyond the two discovery trials: no sandbox run, no child
    // capsule, no further provider launch — and the settled cost is accounted.
    expect(runner.calls).toHaveLength(0)
    expect(bridge.capsules.size).toBe(1) // the baseline alone
    expect(provider.counters.launchEffects).toHaveLength(2)
    expect(report.budget['usd']).toEqual({ spent: reservedUsd * 2, reserved: 0 })
    expect(report.budget['task-trials']).toEqual({ spent: 2, reserved: 0 })
  }, 120_000)
})

describe('iteration driver: concealment', () => {
  it('never names guard or sealed tasks in controller-visible documents', async () => {
    const fx = await newRun('dsh-drive-seal-')
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    provider.script(`eval-eval-${shortId(baselineId)}-${ceremony.ceremony.observedHandles[1]!}`, {
      outcome: 'failure',
    })
    await makeDriver(fx, provider, bridge, fakeSandboxRunner()).drive()

    const sealedHandles = ceremony.sealedStore.sealedHandles
    const guardHandles = ceremony.sealedStore.guardHandles
    // Every controller-visible document in the run root (ceremony, manifest,
    // pool, catalog, report — NOT the TCB ledger/journal) must be free of
    // sealed and guard task names.
    async function walk(root: string): Promise<string[]> {
      const out: string[] = []
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) out.push(...(await walk(path)))
        else out.push(path)
      }
      return out
    }
    const visibleRoots = [
      'split-ceremony.json',
      'run-manifest.json',
      'failure-pool.json',
      'search-state.json',
      'archive-catalog.json',
      'drive-report.json',
      'exports',
    ]
    const texts: string[] = []
    for (const name of visibleRoots) {
      const path = join(fx.runRoot, name)
      if (!existsSync(path)) continue
      for (const file of await walk(path)) texts.push(await readFile(file, 'utf8'))
    }
    for (const text of texts) {
      for (const handle of [...sealedHandles, ...guardHandles]) {
        expect(text).not.toContain(handle)
      }
    }
    // The ceremony document itself carries only opaque guard ids + the root.
    const doc = JSON.parse(
      await readFile(join(fx.runRoot, 'split-ceremony.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual(
      [
        'datasetInputHash',
        'guardOpaqueIds',
        'observedHandles',
        'protocol',
        'runId',
        'schemaVersion',
        'sealedCount',
        'sealedRoot',
        'seedCommitment',
        'strata',
      ].sort(),
    )
    // The guard map went exactly once, and only to the provider bridge.
    expect(bridge.guardMaps).toHaveLength(1)
    expect(Object.keys(bridge.guardMaps[0]!).sort()).toEqual(
      [...ceremony.ceremony.guardOpaqueIds].sort(),
    )
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Gate 6 (specs/07 §8): the stable K=3 shape
// ---------------------------------------------------------------------------

/** The stable-demo search shape at a payable fake scale (α/q0 stay default). */
const K3_OVERRIDES: Partial<RunConfig['search']> & Partial<RunConfig['budget']> = {
  kTarget: 3,
  proposalWidth: 2,
  maxDiscoveryTrials: 4,
  discoveryBatchSize: 4,
  maxSolverTrials: 15,
  maxConsecutiveExpansionFailures: 3,
}

async function newK3Run(prefix: string) {
  return newRun(prefix, K3_OVERRIDES)
}

/** Script the whole discovery prefix to fail: the pool freezes after batch 1. */
function scriptDiscoveryFailures(
  provider: FakeProvider,
  ceremony: ReturnType<typeof runSplitCeremony>,
  baselineId: string,
  count: number,
): void {
  for (const handle of ceremony.ceremony.observedHandles.slice(0, count)) {
    provider.script(`eval-eval-${shortId(baselineId)}-${handle}`, { outcome: 'failure' })
  }
}

/** The durable logical terminal state (what a crash-resume must reproduce). */
interface LogicalFacts {
  stopReason: string
  status: string
  admittedNonBaseline: number
  lineageDepthMax: number
  trials: number
  discoveryTrials: number
  expansionAttempts: number
  failurePool: string[]
  /** Sorted (candidate, task, outcome) of every committed observation. */
  observations: string[]
  budgetSpent: Record<string, number>
}

async function logicalFacts(runRoot: string): Promise<LogicalFacts> {
  const read = async (name: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(runRoot, name), 'utf8')) as Record<string, unknown>
  const report = await read('drive-report.json')
  const pool = (await read('failure-pool.json'))['handles'] as string[]
  const catalog = (await read('archive-catalog.json')) as {
    entries: Array<{
      candidateId: string
      parentCandidateId: string | null
      tasks: Array<{ opaqueTaskId: string; attempts: number }>
    }>
  }
  const byId = new Map(catalog.entries.map((entry) => [entry.candidateId, entry]))
  const depthOf = (candidateId: string): number => {
    let depth = 0
    let cursor = byId.get(candidateId)
    while (cursor?.parentCandidateId !== null && cursor?.parentCandidateId !== undefined) {
      depth += 1
      cursor = byId.get(cursor.parentCandidateId)
    }
    return depth
  }
  const children = catalog.entries.filter((entry) => entry.parentCandidateId !== null)
  const budget = report['budget'] as Record<string, { spent: number }>
  return {
    stopReason: report['stopReason'] as string,
    status: report['status'] as string,
    admittedNonBaseline: report['admittedNonBaseline'] as number,
    lineageDepthMax: Math.max(...children.map((child) => depthOf(child.candidateId))),
    trials: report['trials'] as number,
    discoveryTrials: report['discoveryTrials'] as number,
    expansionAttempts: report['expansionAttempts'] as number,
    failurePool: pool,
    observations: catalog.entries
      .flatMap((entry) =>
        entry.tasks.map(
          (task) => `${entry.candidateId}:${task.opaqueTaskId}:${task.successes}/${task.failures}`,
        ),
      )
      .sort(),
    budgetSpent: Object.fromEntries(
      Object.entries(budget).map(([dimension, totals]) => [dimension, totals.spent]),
    ),
  }
}

describe('iteration driver: stable K=3 (Gate 6)', () => {
  it('admits 3 children over 2+ lineage depths, each cold-started from the frozen pool', async () => {
    const fx = await newK3Run('dsh-drive-k3-')
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    scriptDiscoveryFailures(provider, ceremony, baselineId, 4)

    const report = await makeDriver(fx, provider, bridge, runner).drive()

    expect(report.stopReason).toBe('K_REACHED')
    expect(report.status).toBe('STABLE_ITERATION_VERIFIED')
    expect(report.admittedNonBaseline).toBe(3)
    expect(report.discoveryTrials).toBe(4)
    expect(report.expansionAttempts).toBe(3)
    expect(report.trials).toBeLessThanOrEqual(15)
    expect(runner.calls).toHaveLength(3)
    expect(bridge.capsules.size).toBe(4) // baseline + 3 children

    // Two lineage depths minimum, and every child carries a pool evaluation.
    const facts = await logicalFacts(fx.runRoot)
    expect(facts.lineageDepthMax).toBeGreaterThanOrEqual(2)
    const catalog = JSON.parse(
      await readFile(join(fx.runRoot, 'archive-catalog.json'), 'utf8'),
    ) as {
      entries: Array<{
        candidateId: string
        parentCandidateId: string | null
        tasks: Array<{ opaqueTaskId: string; attempts: number }>
      }>
    }
    const poolSet = new Set(facts.failurePool)
    const children = catalog.entries.filter((entry) => entry.parentCandidateId !== null)
    expect(children).toHaveLength(3)
    for (const child of children) {
      const poolTrials = child.tasks
        .filter((task) => poolSet.has(task.opaqueTaskId))
        .reduce((total, task) => total + task.attempts, 0)
      expect(poolTrials).toBeGreaterThanOrEqual(1)
    }
  }, 240_000)

  it('a crash after a committed external effect resumes to the same terminal state', async () => {
    class CrashDrill extends Error {}

    // Both scenarios run at the SAME path: the folded state embeds absolute
    // sandbox paths (a proposal action's externalJobId is its sandbox root),
    // so derived identities — export ids, hence child source digests, hence
    // the Thompson population order — only converge when the root matches.
    const root = await mkdtemp(join(tmpdir(), 'dsh-drive-k3-eq-'))
    const seed = async () => newRun('', K3_OVERRIDES, root)

    // Reference: the same seeds, run cleanly to its terminal state.
    const refFx = await seed()
    const refProvider = new FakeProvider({ outcome: 'success' })
    const refCeremony = runSplitCeremony({
      runId: refFx.config.runId,
      masterSeed: refFx.config.masterSeed,
      handles: HANDLES,
    })
    const refBaseline = candidateIdFromDigest(
      (await captureCanonicalSource(refFx.baselineSourceDir)).sha256,
    )
    scriptDiscoveryFailures(refProvider, refCeremony, refBaseline, 4)
    await makeDriver(refFx, refProvider, fakeBridge(), fakeSandboxRunner(), {
      clock: tickClock(),
    }).drive()
    const reference = await logicalFacts(refFx.runRoot)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })

    // Crashed twin: SIGKILL-equivalent (a throw at a durable boundary) after
    // the FIRST committed observation — mid discovery batch, before any proposal.
    const fx = await seed()
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    scriptDiscoveryFailures(provider, ceremony, baselineId, 4)

    let committed = 0
    const crashBoundary: ControllerConfig['onBoundary'] = (point, actionId) => {
      if (point === 'action-committed' && actionId?.startsWith('eval-')) {
        committed += 1
        if (committed === 1) throw new CrashDrill('crash drill: process death')
      }
    }
    // The crashed drive and its resume share one tick sequence; it replays the
    // reference's sequence from tick 0, so derived identities stay comparable.
    const clock = tickClock()
    await expect(
      makeDriver(fx, provider, bridge, runner, { onBoundary: crashBoundary, clock }).drive(),
    ).rejects.toThrow('crash drill: process death')

    // The crash landed after exactly one durable external effect.
    expect(existsSync(join(fx.runRoot, 'drive-report.json'))).toBe(false)
    expect(existsSync(join(fx.runRoot, 'failure-pool.json'))).toBe(false)
    expect(provider.counters.launchEffects).toHaveLength(1)

    // Resume: same terminal state, exactly-once effects.
    const report = await makeDriver(fx, provider, bridge, runner, { clock }).drive()
    expect(report.stopReason).toBe('K_REACHED')
    const resumed = await logicalFacts(fx.runRoot)
    expect(resumed.stopReason).toBe(reference.stopReason)
    expect(resumed.status).toBe(reference.status)
    expect(resumed.admittedNonBaseline).toBe(reference.admittedNonBaseline)
    expect(resumed.lineageDepthMax).toBe(reference.lineageDepthMax)
    expect(resumed.trials).toBe(reference.trials)
    expect(resumed.discoveryTrials).toBe(reference.discoveryTrials)
    expect(resumed.expansionAttempts).toBe(reference.expansionAttempts)
    expect(resumed.failurePool).toEqual(reference.failurePool)
    expect(resumed.observations).toEqual(reference.observations)
    expect(resumed.budgetSpent).toEqual(reference.budgetSpent)
    // One launch effect per trial, one sandbox per expansion — nothing doubled.
    expect(provider.counters.launchEffects).toHaveLength(reference.trials)
    expect(runner.calls).toHaveLength(reference.expansionAttempts)
  }, 240_000)
})

describe('iteration driver: solver-token wiring (ADR-030)', () => {
  it('reserves and settles solver tokens per trial, and a spent dimension stops the next launch', async () => {
    // 2 tokens over 15 trial slots → each trial reserves
    // max(1, floor(2/15)) = 1. Two discovery trials settle their reservation
    // exactly (a settle may not exceed it); the expansion itself fits (the
    // proposal estimate carries no solver entry) — only the child EVALUATION
    // cannot reserve, so the loop stops without paying for it.
    const fx = await newRun('dsh-drive-solve-1-', undefined, undefined, 2)
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    for (const handle of ceremony.ceremony.observedHandles.slice(0, 2)) {
      provider.script(`eval-eval-${shortId(baselineId)}-${handle}`, {
        outcome: 'failure',
        costUsdMicros: 100,
        solverTokens: 1,
      })
    }

    const report = await makeDriver(fx, provider, bridge, runner).drive()
    expect(report.stopReason).toBe('BUDGET_EXHAUSTED')
    expect(report.failurePool.length).toBeGreaterThan(0)
    // The proposal dispatched (its estimate has no solver-tokens entry) and
    // the child was admitted — proving usd/proposer dimensions still fit.
    expect(runner.calls).toHaveLength(1)
    expect(bridge.capsules.size).toBe(2)
    // Exactly the two discovery trials ever launched; the blocked child
    // evaluation never reached the provider.
    expect(provider.counters.launchEffects).toHaveLength(2)
    expect(report.budget['solver-tokens']).toEqual({ spent: 2, reserved: 0 })
    expect(report.budget['task-trials']).toEqual({ spent: 2, reserved: 0 })

    // The manifest freezes the derived solver facts (R1: only when configured).
    const manifest = JSON.parse(
      await readFile(join(fx.runRoot, 'run-manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    const plan = solverRoutePlan(fx.config)
    if (plan === null) throw new Error('solver route plan missing')
    expect(manifest['solverTrack']).toBe('assisted')
    expect(manifest['solverRouteHash']).toBe(remoteRoutePlanHash(plan))
    expect((manifest['config'] as Record<string, unknown>)['solverRoute']).toBe(
      'deepseek/zen-compatible',
    )
  }, 180_000)

  it('an all-error live trial settles its priced zeros without crashing the ledger (paid smoke attempt 3)', async () => {
    // Every gateway receipt errored (upstream 402): the capsule's agent loop
    // still ended gracefully, so harbor recorded a NORMAL trial whose usage
    // update carried costUsdMicros 0 and zero solver tokens — priced zeros,
    // not nulls. The trial-commit settle used to mirror amount 0 / unpriced 0
    // into the ledger, whose zero-entry guard (an anti-noise invariant, not a
    // bug) crashed collectAndCommit with BudgetError. A priced zero is the
    // observation's fact, not a ledger row: settlement must skip the no-op
    // entry, release the reservation, and let the loop continue.
    const fx = await newRun('dsh-drive-solve-3-', undefined, undefined, 2)
    const provider = new FakeProvider({ outcome: 'success', costUsdMicros: 0, solverTokens: 0 })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()

    // Every trial of the run — discovery and any child evaluation alike —
    // reports the all-error shape; nothing here may throw.
    const report = await makeDriver(fx, provider, bridge, runner).drive()
    expect(report.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(report.failurePool).toHaveLength(0)
    // Trials ran and settled: task-trials carry the count, usd and
    // solver-tokens carry priced zeros with every reservation returned.
    expect(report.budget['task-trials'].spent).toBe(2)
    expect(report.budget['usd']).toEqual({ spent: 0, reserved: 0 })
    expect(report.budget['solver-tokens']).toEqual({ spent: 0, reserved: 0 })
    expect(provider.counters.launchEffects).toHaveLength(2)
  }, 180_000)

  it('a replay manifest carries no solver fields and still freezes on resume (R1)', async () => {
    // Pre-solver run roots froze manifests without solverTrack/solverRouteHash;
    // re-deriving the document under new code must reproduce those bytes or
    // every existing run root would fail freeze() after upgrade.
    const fx = await newRun('dsh-drive-solve-2-')
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const first = await makeDriver(fx, provider, bridge, runner).drive()
    expect(first.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')

    const manifest = JSON.parse(
      await readFile(join(fx.runRoot, 'run-manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    expect('solverTrack' in manifest).toBe(false)
    expect('solverRouteHash' in manifest).toBe(false)
    const config = manifest['config'] as Record<string, unknown>
    expect('solverRoute' in config).toBe(false)
    expect('solverTokens' in (config['budget'] as Record<string, unknown>)).toBe(false)

    // Resume: the re-derived manifest must hash identically — freeze() passing
    // here IS the R1 regression.
    const second = await makeDriver(fx, provider, bridge, runner).drive()
    expect(second.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(second.stateHash).toBe(first.stateHash)
  }, 180_000)

  it('binds a live image-prefetch receipt hash into the solver manifest', async () => {
    const fx = await newRun('dsh-drive-image-manifest-', undefined, undefined, 2)
    const provider = new FakeProvider({ outcome: 'success', solverTokens: 1 })
    const receipt = {
      protocol: 'dsh-evolve-le/image-prefetch/v1',
      path: 'image-prefetch.json' as const,
      sha256: 'sha256:' + 'a'.repeat(64),
      imageCount: 3,
    }
    await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner(), {
      imagePrefetchReceipt: receipt,
    }).drive()
    const manifest = JSON.parse(await readFile(join(fx.runRoot, 'run-manifest.json'), 'utf8')) as {
      imagePrefetchReceipt?: typeof receipt
    }
    expect(manifest.imagePrefetchReceipt).toEqual(receipt)
  }, 180_000)
})

// ---------------------------------------------------------------------------
// Benchmark baseline freeze (specs/04 §4.2, ADR-042)
// ---------------------------------------------------------------------------

describe('iteration driver: benchmark baseline freeze (ADR-042)', () => {
  /** K=1 search over a 4-task × 2-attempt matrix (8 baseline trials + 1 q0). */
  const BASELINE_OVERRIDES: Partial<RunConfig['search']> & Partial<RunConfig['budget']> = {
    kTarget: 1,
    proposalWidth: 2,
    maxSolverTrials: 10,
    maxConsecutiveExpansionFailures: 2,
  }

  async function baselineRun(
    prefix: string,
    matrix: { taskCount: number; attemptsPerTask: number; batchSize: number },
    at?: string,
  ) {
    const fx = await newRun(prefix, BASELINE_OVERRIDES, at)
    // The matrix rides the validated config object directly (the CLI composes
    // it from the flat --set carriers; defaultRunConfig handles both).
    fx.config.search.benchmarkBaseline = matrix
    return fx
  }

  it('freezes the zero-success pool only after the full matrix ran', async () => {
    const fx = await baselineRun('dsh-drive-baseline-freeze-', {
      taskCount: 4,
      attemptsPerTask: 2,
      batchSize: 2,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const short = shortId(baselineId)
    const [h0, h1, h2, h3] = ceremony.ceremony.observedHandles
    // h0: fails both attempts → pool. h1: fails attempt 1, SUCCEEDS attempt 2
    // → NOT pool (the baseline can solve it — the zero-success rule). h2:
    // succeeds both. h3: fails both → pool.
    provider.script(`eval-eval-${short}-${h0}-a1`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-${h0}-a2`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-${h1}-a1`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-${h1}-a2`, { outcome: 'success' })
    provider.script(`eval-eval-${short}-${h3}-a1`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-${h3}-a2`, { outcome: 'failure' })

    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner()).drive()

    expect(report.stopReason).toBe('K_REACHED')
    // 8 matrix trials + 1 child cold start from the frozen pool.
    expect(report.discoveryTrials).toBe(8)
    expect(report.trials).toBe(9)
    expect(report.failurePool).toEqual([h0, h3].sort())
  })

  it('uses the sole observed attempt as repair3 failure-pool evidence', async () => {
    const fx = await baselineRun('dsh-drive-baseline-one-attempt-', {
      taskCount: 4,
      attemptsPerTask: 1,
      batchSize: 2,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const short = shortId(baselineId)
    const [h0, , h2] = ceremony.ceremony.observedHandles
    // With A=1, the zero-success definition is exactly: the sole baseline
    // attempt failed.  Both failures must be retained; successful tasks stay
    // out of the frozen pool.
    provider.script(`eval-eval-${short}-${h0}-a1`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-${h2}-a1`, { outcome: 'failure' })

    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner()).drive()

    expect(report.stopReason).toBe('K_REACHED')
    expect(report.discoveryTrials).toBe(4)
    // Four one-attempt baseline trials plus one q0 cold-start trial.
    expect(report.trials).toBe(5)
    expect(report.failurePool).toEqual([h0, h2].sort())
  })

  it('stops honestly as NO_REAL_FAILURE_SIGNAL when every matrix trial succeeds', async () => {
    const fx = await baselineRun('dsh-drive-baseline-nosignal-', {
      taskCount: 4,
      attemptsPerTask: 2,
      batchSize: 2,
    })
    const report = await makeDriver(
      fx,
      new FakeProvider({ outcome: 'success' }),
      fakeBridge(),
      fakeSandboxRunner(),
    ).drive()
    expect(report.stopReason).toBe('NO_REAL_FAILURE_SIGNAL')
    expect(report.discoveryTrials).toBe(8)
    expect(report.trials).toBe(8)
    expect(report.failurePool).toEqual([])
    await expect(access(join(fx.runRoot, 'failure-pool.json'))).rejects.toThrow(/ENOENT/)
  })

  it('fails closed on an infra-dead matrix trial: no pool freeze, no proposal (ADR-028)', async () => {
    const fx = await baselineRun('dsh-drive-baseline-infradead-', {
      taskCount: 4,
      attemptsPerTask: 2,
      batchSize: 2,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const dead = ceremony.ceremony.observedHandles[0]!
    provider.script(`eval-eval-${shortId(baselineId)}-${dead}-a2`, { outcome: 'missing' })
    const runner = fakeSandboxRunner()
    await expect(makeDriver(fx, provider, fakeBridge(), runner).drive()).rejects.toThrow(
      /infra-dead benchmark baseline trial\(s\) \[.*\]: an agent that never ran is not a capability fact/,
    )
    await expect(access(join(fx.runRoot, 'failure-pool.json'))).rejects.toThrow(/ENOENT/)
    expect(runner.calls).toHaveLength(0)
  })

  it('fails closed when the matrix exceeds the development split (ADR-046)', async () => {
    const fx = await baselineRun('dsh-drive-baseline-overflow-', {
      // Development split is 60 = 48 observed + 12 guard for the pinned
      // 89-task population.
      taskCount: 61,
      attemptsPerTask: 1,
      batchSize: 6,
    })
    await expect(
      makeDriver(
        fx,
        new FakeProvider({ outcome: 'success' }),
        fakeBridge(),
        fakeSandboxRunner(),
      ).drive(),
    ).rejects.toThrow(/exceeds the development split \(60 handles\)/)
  })

  it('a crash mid-matrix resumes to the same terminal state with exactly-once effects', async () => {
    class CrashDrill extends Error {}

    const root = await mkdtemp(join(tmpdir(), 'dsh-drive-baseline-eq-'))
    const matrix = { taskCount: 4, attemptsPerTask: 2, batchSize: 2 }
    const seed = async () => baselineRun('', matrix, root)
    const scriptMatrix = (
      provider: FakeProvider,
      ceremony: ReturnType<typeof runSplitCeremony>,
      baselineId: string,
    ): void => {
      const short = shortId(baselineId)
      // First two tasks fail both attempts → pool of 2; the rest succeed.
      for (const handle of ceremony.ceremony.observedHandles.slice(0, 2)) {
        provider.script(`eval-eval-${short}-${handle}-a1`, { outcome: 'failure' })
        provider.script(`eval-eval-${short}-${handle}-a2`, { outcome: 'failure' })
      }
    }

    // Reference: the same seeds, run cleanly to its terminal state.
    const refFx = await seed()
    const refProvider = new FakeProvider({ outcome: 'success' })
    const refCeremony = runSplitCeremony({
      runId: refFx.config.runId,
      masterSeed: refFx.config.masterSeed,
      handles: HANDLES,
    })
    const refBaseline = candidateIdFromDigest(
      (await captureCanonicalSource(refFx.baselineSourceDir)).sha256,
    )
    scriptMatrix(refProvider, refCeremony, refBaseline)
    await makeDriver(refFx, refProvider, fakeBridge(), fakeSandboxRunner(), {
      clock: tickClock(),
    }).drive()
    const reference = await logicalFacts(refFx.runRoot)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })

    // Crashed twin: process death after the THIRD committed matrix trial.
    const fx = await seed()
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    scriptMatrix(provider, ceremony, baselineId)

    let committed = 0
    const crashBoundary: ControllerConfig['onBoundary'] = (point, actionId) => {
      if (point === 'action-committed' && actionId?.startsWith('eval-')) {
        committed += 1
        if (committed === 3) throw new CrashDrill('crash drill: process death')
      }
    }
    const clock = tickClock()
    await expect(
      makeDriver(fx, provider, bridge, runner, { onBoundary: crashBoundary, clock }).drive(),
    ).rejects.toThrow('crash drill: process death')

    expect(existsSync(join(fx.runRoot, 'drive-report.json'))).toBe(false)
    expect(existsSync(join(fx.runRoot, 'failure-pool.json'))).toBe(false)
    expect(provider.counters.launchEffects).toHaveLength(3)

    // Resume: the deterministic wave schedule re-verifies every existing wave
    // and completes only the missing actions.
    const report = await makeDriver(fx, provider, bridge, runner, { clock }).drive()
    expect(report.stopReason).toBe('K_REACHED')
    const resumed = await logicalFacts(fx.runRoot)
    expect(resumed.stopReason).toBe(reference.stopReason)
    expect(resumed.status).toBe(reference.status)
    expect(resumed.trials).toBe(reference.trials)
    expect(resumed.discoveryTrials).toBe(reference.discoveryTrials)
    expect(resumed.failurePool).toEqual(reference.failurePool)
    expect(resumed.observations).toEqual(reference.observations)
    expect(resumed.budgetSpent).toEqual(reference.budgetSpent)
    expect(provider.counters.launchEffects).toHaveLength(reference.trials)
    expect(runner.calls).toHaveLength(reference.expansionAttempts)
  }, 240_000)
})

describe('iteration driver: dev-guard baseline waves + information-flow monitor (ADR-046)', () => {
  /** The live 72-task population splits 39 observed / 10 guard / 23 sealed. */
  const LIVE_HANDLES = Array.from(
    { length: 72 },
    (_unused, index) => `live-${String(index + 1).padStart(3, '0')}`,
  )
  /** Pre-registered live split: 39 observed / 10 guard / 23 sealed. */
  const LIVE_COUNTS: SplitCounts = { observed: 39, guard: 10, sealed: 23 }
  /** IterationDriverInput.canaryCount default (the monitor derives per guard
   * task + sealed sweep with the same count). */
  const CANARY_COUNT = 4

  /** K=1 search over the benchmark-baseline matrix (mirrors the ADR-042 suite). */
  const BASELINE_OVERRIDES: Partial<RunConfig['search']> & Partial<RunConfig['budget']> = {
    kTarget: 1,
    proposalWidth: 2,
    maxSolverTrials: 10,
    maxConsecutiveExpansionFailures: 2,
  }

  async function baselineRun(
    prefix: string,
    matrix: { taskCount: number; attemptsPerTask: number; batchSize: number },
  ) {
    const fx = await newRun(prefix, BASELINE_OVERRIDES)
    fx.config.search.benchmarkBaseline = matrix
    return fx
  }

  function guardToken(fx: Awaited<ReturnType<typeof newRun>>, opaqueId: string): string {
    return deriveCanaryTokens({
      masterSeed: fx.config.masterSeed,
      runId: fx.config.runId,
      principal: `guard:${opaqueId}`,
      count: CANARY_COUNT,
    })[0]!
  }

  async function journalText(runRoot: string): Promise<string> {
    const dir = journalDirOf(join(runRoot, 'controller'))
    const segments = (await readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort()
    return (await Promise.all(segments.map((name) => readFile(join(dir, name), 'utf8')))).join('\n')
  }

  interface MonitorDoc {
    result: 'clean' | 'aborted'
    hits: Array<{ surface: string; fingerprints: string[] }>
    tokenFingerprints: string[]
    checkedEvents?: number
  }

  async function monitorDoc(runRoot: string): Promise<MonitorDoc> {
    return JSON.parse(await readFile(join(runRoot, 'info-flow-monitor.json'), 'utf8')) as MonitorDoc
  }

  it('runs the 49×2 matrix as 39 observed + 10 opaque guard trials; the pool stays observed-only', async () => {
    // maxSolverTrials must clear the 98 matrix trials (completedTrials counts
    // every observation, baseline included).
    const fx = await newRun('dsh-drive-guardwave-', {
      ...BASELINE_OVERRIDES,
      maxSolverTrials: 110,
    })
    fx.config.search.benchmarkBaseline = { taskCount: 49, attemptsPerTask: 2, batchSize: 8 }
    const provider = new FakeProvider({ outcome: 'success' })
    const bridge = fakeBridge()
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: LIVE_HANDLES,
      counts: LIVE_COUNTS,
    })
    expect(ceremony.ceremony.observedHandles).toHaveLength(39)
    expect(ceremony.ceremony.guardOpaqueIds).toHaveLength(10)
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const short = shortId(baselineId)
    // One observed handle AND the first guard task fail both attempts. The
    // pool must carry the observed handle only: guard ids never enter the
    // proposer evidence supply, not even as failure material (ADR-046).
    const [h0] = ceremony.ceremony.observedHandles
    provider.script(`eval-eval-${short}-${h0}-a1`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-${h0}-a2`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-guard-01-a1`, { outcome: 'failure' })
    provider.script(`eval-eval-${short}-guard-01-a2`, { outcome: 'failure' })

    const report = await makeDriver(fx, provider, bridge, fakeSandboxRunner(), {
      handles: LIVE_HANDLES,
      splitCounts: LIVE_COUNTS,
    }).drive()

    expect(report.stopReason).toBe('K_REACHED')
    expect(report.discoveryTrials).toBe(98)
    expect(report.failurePool).toEqual([h0])
    // The TCB-only guard map reached the provider bridge exactly once, with
    // opaque keys and the real handles as values.
    expect(bridge.guardMaps).toHaveLength(1)
    expect(bridge.guardMaps[0]).toEqual(
      Object.fromEntries(
        ceremony.sealedStore.guardHandles.map((handle, index) => [
          `guard-${String(index + 1).padStart(2, '0')}`,
          handle,
        ]),
      ),
    )
    // Guard trial records embed their own deterministic canary (the
    // designated home); the terminal journal sweep tolerates exactly that
    // and writes the canary-absence receipt.
    const token = guardToken(fx, 'guard-01')
    expect(await journalText(fx.runRoot)).toContain(token)
    const monitor = await monitorDoc(fx.runRoot)
    expect(monitor.result).toBe('clean')
    expect(monitor.tokenFingerprints).toContain(canaryFingerprint(token))
    expect(JSON.stringify(monitor)).not.toContain(token)
  }, 240_000)

  it('fails closed when the matrix exceeds the live development split (49 handles)', async () => {
    const fx = await newRun('dsh-drive-guardwave-overflow-', BASELINE_OVERRIDES)
    fx.config.search.benchmarkBaseline = { taskCount: 50, attemptsPerTask: 1, batchSize: 6 }
    await expect(
      makeDriver(fx, new FakeProvider({ outcome: 'success' }), fakeBridge(), fakeSandboxRunner(), {
        handles: LIVE_HANDLES,
        splitCounts: LIVE_COUNTS,
      }).drive(),
    ).rejects.toThrow(/exceeds the development split \(49 handles\)/)
  })

  it('aborts SAFETY_ABORTED when a guard canary leaks into the proposer export', async () => {
    const fx = await baselineRun('dsh-drive-canary-export-', {
      taskCount: 4,
      attemptsPerTask: 1,
      batchSize: 2,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const token = guardToken(fx, 'guard-01')
    const [h0] = ceremony.ceremony.observedHandles
    // A guard canary contaminating an OBSERVED trajectory: the export's byte
    // scan must refuse it and the run must end SAFETY_ABORTED — not crash,
    // not silently drop the evidence (ADR-046, specs/05 §10).
    provider.script(`eval-eval-${shortId(baselineId)}-${h0}-a1`, {
      outcome: 'failure',
      trajectory: Buffer.from(
        `${JSON.stringify({ steps: [{ role: 'agent', content: `leaked ${token}` }] })}\n`,
        'utf8',
      ),
    })

    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner()).drive()

    expect(report.stopReason).toBe('SAFETY_ABORTED')
    expect(report.phase).toBe('SAFETY_ABORTED')
    expect(report.admittedNonBaseline).toBe(0)
    const monitor = await monitorDoc(fx.runRoot)
    expect(monitor.result).toBe('aborted')
    expect(monitor.hits.map((hit) => hit.surface)).toEqual(['evidence-export'])
    expect(monitor.hits[0]!.fingerprints).toContain(canaryFingerprint(token))
    expect(JSON.stringify(monitor)).not.toContain(token)
  })

  it('aborts SAFETY_ABORTED when a canary surfaces in a proposal result', async () => {
    const fx = await baselineRun('dsh-drive-canary-proposal-', {
      taskCount: 4,
      attemptsPerTask: 1,
      batchSize: 2,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    const ceremony = runSplitCeremony({
      runId: fx.config.runId,
      masterSeed: fx.config.masterSeed,
      handles: HANDLES,
    })
    const baselineId = candidateIdFromDigest(
      (await captureCanonicalSource(fx.baselineSourceDir)).sha256,
    )
    const [h0] = ceremony.ceremony.observedHandles
    provider.script(`eval-eval-${shortId(baselineId)}-${h0}-a1`, { outcome: 'failure' })
    const token = guardToken(fx, 'guard-02')
    // A worker failure whose error text carries a canary: the driver scans
    // the proposal result and aborts before any further expansion.
    const runner = fakeSandboxRunner({ failWorker: true, workerError: `injected ${token}` })

    const report = await makeDriver(fx, provider, fakeBridge(), runner).drive()

    expect(report.stopReason).toBe('SAFETY_ABORTED')
    expect(report.phase).toBe('SAFETY_ABORTED')
    const monitor = await monitorDoc(fx.runRoot)
    expect(monitor.result).toBe('aborted')
    // The driver scan fires first; the terminal sweep then catches the same
    // token in the journaled failure reason — two independent walls, both
    // recorded on the same receipt.
    expect(monitor.hits.map((hit) => hit.surface)).toEqual(['proposal-result', 'journal-sweep'])
    expect(monitor.hits[0]!.fingerprints).toContain(canaryFingerprint(token))
    expect(JSON.stringify(monitor)).not.toContain(token)
  })
})

describe('iteration driver: champion tournament + triple-hash lock (ADR-047)', () => {
  async function monitorDoc(runRoot: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(runRoot, 'info-flow-monitor.json'), 'utf8')) as Record<
      string,
      unknown
    >
  }

  async function catalogChildren(runRoot: string): Promise<string[]> {
    const catalog = JSON.parse(await readFile(join(runRoot, 'archive-catalog.json'), 'utf8')) as {
      entries: Array<{ candidateId: string; parentCandidateId: string | null }>
    }
    return catalog.entries
      .filter((entry) => entry.parentCandidateId !== null)
      .map((entry) => entry.candidateId)
      .sort()
  }

  /** The triple-hash chain (ADR-047): sourceHash/archiveSha256 from the
   * capsule record, runManifestHash = the frozen configHash, and
   * tripleHash = sha256(source || capsule || manifest) — order-sensitive,
   * no separators. */
  async function verifyLockChain(runRoot: string, championId: string): Promise<void> {
    const lock = await lockDoc(runRoot)
    expect(lock.winnerId).toBe(championId)
    const capsule = JSON.parse(
      await readFile(join(runRoot, 'capsules', `${championId}.json`), 'utf8'),
    ) as Record<string, string>
    expect(lock.sourceHash).toBe(capsule.sourceDigest)
    expect(lock.archiveSha256).toBe(capsule.archiveSha256)
    const manifest = JSON.parse(
      await readFile(join(runRoot, 'run-manifest.json'), 'utf8'),
    ) as Record<string, string>
    expect(lock.runManifestHash).toBe(manifest.configHash)
    expect(lock.sealedPlanHash).toBe(SEALED_RECEIPT.sha256)
    expect(lock.tripleHash).toBe(
      createHash('sha256')
        .update(`${lock.sourceHash}${lock.archiveSha256}${lock.runManifestHash}`)
        .digest('hex'),
    )
  }

  it('locks a child champion: full coverage, one lock event, verified lock chain, no sealed contact', async () => {
    const fx = await formalRun('dsh-drive-champion-')
    const provider = new FakeProvider({ outcome: 'success' })
    const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
    scriptBaselineTournament(provider, baselineId, observed, { outcome: 'failure' })

    const report = await driverFor(fx, provider).drive()

    expect(report.stopReason).toBe('CHAMPION_LOCKED')
    expect(report.status).toBe('CHAMPION_LOCKED')
    expect(report.phase).toBe('CANDIDATE_LOCKED')
    // ADR-049: trials is search-phase only (14 matrix + 3 cold starts);
    // the 28 tournament coverage rows report separately.
    expect(report.trials).toBe(17)
    expect(report.tournamentTrials).toBe(28)
    const children = await catalogChildren(fx.runRoot)
    expect(children).toHaveLength(1)
    expect(report.admittedNonBaseline).toBe(1)
    expect([...(report.shortlist ?? [])].sort()).toEqual(children)
    expect(report.championId).toBe(children[0])
    expect(report.championId).not.toBe(baselineId)
    await verifyLockChain(fx.runRoot, report.championId!)
    expect(report.championLockHash).toBe((await lockDoc(fx.runRoot)).tripleHash)

    const journal = await journalText(fx.runRoot)
    // dev-champion → candidate.locked (one-shot) → locked → CANDIDATE_LOCKED.
    expect(journal.split('"type":"candidate.locked"').length - 1).toBe(1)
    expect(journal).toContain('"to":"dev-champion"')
    expect(journal).toContain('"to":"locked"')
    expect(journal).toContain('"to":"CANDIDATE_LOCKED"')
    // Coverage waves planned and committed via the evaluation saga.
    expect(journal).toContain('tournament-0-1-1')
    expect(journal).toContain('guard-01')
    expect(journal).not.toContain('"split":"sealed"')
    // Guard tournament rows ran under opaque ids with the canary embedded;
    // the terminal sweep tolerates exactly that and stays clean.
    const monitor = await monitorDoc(fx.runRoot)
    expect(monitor.result).toBe('clean')
    expect(provider.counters.launchEffects).toHaveLength(45)
    expect(provider.counters.launchEffects.every((id) => !id.includes('seal-'))).toBe(true)
  }, 240_000)

  it('stops NO_DEVELOPMENT_IMPROVEMENT when the baseline wins every paired delta', async () => {
    const fx = await formalRun('dsh-drive-baseline-wins-')
    const provider = new FakeProvider({ outcome: 'success' })
    const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
    scriptBaselineTournament(provider, baselineId, observed, { outcome: 'success' })
    provider.scriptPrefix('tourn-', { outcome: 'failure' })

    const report = await driverFor(fx, provider).drive()

    expect(report.stopReason).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    expect(report.status).toBe('STOPPED:NO_DEVELOPMENT_IMPROVEMENT')
    expect(report.phase).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    expect(report.tournamentTrials).toBe(28)
    expect(report.championId).toBeUndefined()
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
    const journal = await journalText(fx.runRoot)
    expect(journal).not.toContain('candidate.locked')
    expect(journal).not.toContain('"split":"sealed"')

    // The phase is terminal: a resume can never re-enter search or the
    // tournament, and it must not re-run anything.
    const effects = provider.counters.launchEffects.length
    await rm(join(fx.runRoot, 'drive-report.json'))
    const again = await driverFor(fx, provider).drive()
    expect(again.stopReason).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    expect(provider.counters.launchEffects).toHaveLength(effects)
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
  }, 240_000)

  it('tops a sub-eligible child up to 12 observations, then locks it as champion', async () => {
    // The child enters the tournament with 3 observations (< 12) → the q10
    // top-up path: 9 top-up trials, then 28 coverage trials = 37 ≤ maxTrials.
    const fx = await formalRun(
      'dsh-drive-topup-',
      withTournament({ minEligibilityTrials: 12, maxTrials: 60 }),
    )
    const provider = new FakeProvider({ outcome: 'success' })
    const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
    scriptBaselineTournament(provider, baselineId, observed, { outcome: 'failure' })

    const report = await driverFor(fx, provider).drive()

    expect(report.stopReason).toBe('CHAMPION_LOCKED')
    expect(report.tournamentTrials).toBe(37)
    expect(report.championId).toBe((await catalogChildren(fx.runRoot))[0])
    expect(provider.counters.launchEffects).toHaveLength(54) // 14 + 3 + 37
    await verifyLockChain(fx.runRoot, report.championId!)
  }, 240_000)

  it('stops NO_DEVELOPMENT_IMPROVEMENT when the top-up cannot fit the budget', async () => {
    // Top-up needs 9 trials; maxTrials 5 cannot fund them → all-or-nothing,
    // zero tournament launches, no sealed contact (ADR-047, specs/03 §11).
    const fx = await formalRun(
      'dsh-drive-topup-budget-',
      withTournament({ minEligibilityTrials: 12, maxTrials: 5 }),
    )
    const provider = new FakeProvider({ outcome: 'success' })
    await scriptMatrixFailures(provider, fx)

    const report = await driverFor(fx, provider).drive()

    expect(report.stopReason).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    expect(report.tournamentTrials).toBe(0)
    expect(provider.counters.launchEffects).toHaveLength(17) // 14 matrix + 3 cold starts
    expect(provider.counters.launchEffects.every((id) => !id.startsWith('tourn-'))).toBe(true)
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
  }, 240_000)

  it('stops NO_DEVELOPMENT_IMPROVEMENT when coverage cannot fit after the top-up', async () => {
    // Top-up fits (9 ≤ 20) but the 28 coverage trials overflow the remaining
    // 11 → the whole tournament is abandoned, top-up trials included.
    const fx = await formalRun(
      'dsh-drive-coverage-overflow-',
      withTournament({ minEligibilityTrials: 12, maxTrials: 20 }),
    )
    const provider = new FakeProvider({ outcome: 'success' })
    await scriptMatrixFailures(provider, fx)

    const report = await driverFor(fx, provider).drive()

    expect(report.stopReason).toBe('NO_DEVELOPMENT_IMPROVEMENT')
    expect(report.tournamentTrials).toBe(9)
    expect(provider.counters.launchEffects).toHaveLength(26) // 14 + 3 + 9
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
  }, 240_000)

  it('resumes a mid-tournament crash to the same locked terminal state, exactly once', async () => {
    class CrashDrill extends Error {}
    const fx = await formalRun('dsh-drive-champion-crash-')
    const provider = new FakeProvider({ outcome: 'success' })
    const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
    scriptBaselineTournament(provider, baselineId, observed, { outcome: 'failure' })
    const bridge = fakeBridge()
    const runner = fakeSandboxRunner()

    let committed = 0
    const crashBoundary: ControllerConfig['onBoundary'] = (point, actionId) => {
      if (point === 'action-committed' && actionId?.startsWith('tourn-')) {
        committed += 1
        if (committed === 3) throw new CrashDrill('crash drill: process death mid-tournament')
      }
    }
    const clock = tickClock()
    await expect(
      makeDriver(fx, provider, bridge, runner, {
        handles: TOUR_HANDLES,
        splitCounts: TOUR_COUNTS,
        sealedPlanReceipt: SEALED_RECEIPT,
        onBoundary: crashBoundary,
        clock,
      }).drive(),
    ).rejects.toThrow('crash drill: process death mid-tournament')
    expect(existsSync(join(fx.runRoot, 'drive-report.json'))).toBe(false)
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)

    // Resume: pending tournament wave re-planned (same members, same action
    // ids, provider-idempotent relaunch), lock emitted exactly once.
    const report = await makeDriver(fx, provider, bridge, runner, {
      handles: TOUR_HANDLES,
      splitCounts: TOUR_COUNTS,
      sealedPlanReceipt: SEALED_RECEIPT,
      clock,
    }).drive()

    expect(report.stopReason).toBe('CHAMPION_LOCKED')
    expect(report.tournamentTrials).toBe(28)
    expect(report.championLockHash).toBe((await lockDoc(fx.runRoot)).tripleHash)
    expect(provider.counters.launchEffects).toHaveLength(45)
    const journal = await journalText(fx.runRoot)
    expect(journal.split('"type":"candidate.locked"').length - 1).toBe(1)
    await verifyLockChain(fx.runRoot, report.championId!)
  }, 240_000)

  it('re-driving after the lock re-runs nothing and keeps exactly one lock event', async () => {
    const fx = await formalRun('dsh-drive-relock-')
    const provider = new FakeProvider({ outcome: 'success' })
    const { baselineId, observed } = await scriptMatrixFailures(provider, fx)
    scriptBaselineTournament(provider, baselineId, observed, { outcome: 'failure' })

    const first = await driverFor(fx, provider).drive()
    const effects = provider.counters.launchEffects.length

    // Crash between the lock and the report write: the drive-report is gone
    // but everything durable survives.
    await rm(join(fx.runRoot, 'drive-report.json'))
    const again = await driverFor(fx, provider).drive()

    expect(again.stopReason).toBe('CHAMPION_LOCKED')
    expect(again.championId).toBe(first.championId)
    expect(again.championLockHash).toBe(first.championLockHash)
    expect(again.tournamentTrials).toBe(first.tournamentTrials)
    expect(provider.counters.launchEffects).toHaveLength(effects)
    const journal = await journalText(fx.runRoot)
    expect(journal.split('"type":"candidate.locked"').length - 1).toBe(1)
  }, 240_000)

  it('rejects a formal drive without the pre-registered sealed plan receipt', async () => {
    const fx = await formalRun('dsh-drive-no-sealed-receipt-')
    const provider = new FakeProvider({ outcome: 'success' })

    await expect(
      makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner(), {
        handles: TOUR_HANDLES,
        splitCounts: TOUR_COUNTS,
      }).drive(),
    ).rejects.toThrow(/sealed plan receipt/)
    expect(provider.counters.launchEffects).toHaveLength(0)
  })

  it('stable-demo never enters the tournament', async () => {
    const fx = await newRun(
      'dsh-drive-stable-no-tourn-',
      {
        kTarget: 1,
        proposalWidth: 2,
        maxSolverTrials: 30,
        maxConsecutiveExpansionFailures: 2,
        taskTrials: 120,
        wallClockMinutes: 2770,
        benchmarkBaseline: TOUR_MATRIX,
      },
      undefined,
      undefined,
      2,
    )
    const provider = new FakeProvider({ outcome: 'success' })
    await scriptMatrixFailures(provider, fx)

    const report = await makeDriver(fx, provider, fakeBridge(), fakeSandboxRunner(), {
      handles: TOUR_HANDLES,
      splitCounts: TOUR_COUNTS,
    }).drive()

    expect(report.stopReason).toBe('K_REACHED')
    expect(report.status).toBe('STOPPED:K_REACHED') // depth 1 alone is not stable-verified
    expect(report.tournamentTrials).toBeUndefined()
    expect(report.championId).toBeUndefined()
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
    expect(provider.counters.launchEffects.every((id) => !id.startsWith('tourn-'))).toBe(true)
    expect(await journalText(fx.runRoot)).not.toContain('candidate.locked')
  }, 240_000)

  it('stops BUDGET_EXHAUSTED when the tournament outlives wallClock − 1800 minutes', async () => {
    const fx = await formalRun('dsh-drive-tourn-wall-')
    const provider = new FakeProvider({ outcome: 'success' })
    await scriptMatrixFailures(provider, fx)

    // Once the tournament freezes its start, pretend 971 minutes passed:
    // more than the 2770 − 1800 = 970 tournament wall budget (ADR-048).
    let tick = 0
    const base = 1_700_000_000_000
    const clock = () => {
      const t = tick++
      if (existsSync(join(fx.runRoot, 'tournament-start.json'))) {
        return new Date(base + t * 1000 + 971 * 60_000).toISOString()
      }
      return new Date(base + t * 1000).toISOString()
    }

    const report = await driverFor(fx, provider, { clock }).drive()

    expect(report.stopReason).toBe('BUDGET_EXHAUSTED')
    expect(report.status).toBe('STOPPED:BUDGET_EXHAUSTED')
    expect(report.tournamentTrials).toBe(0)
    expect(provider.counters.launchEffects).toHaveLength(17) // search only
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
  }, 240_000)

  it('derives the tournament wall budget from the ADR-058 search share (4560 − 3600)', async () => {
    // repair3 pre-registers wallClockSearchMinutes=3600: the tournament gets
    // wallClockMinutes − 3600, not the ADR-048 1800 default. The envelope is
    // the schema-max 4560, so the pre-registered pair itself is exercised.
    const fx = await formalRun('dsh-drive-tourn-wall-3600-', {
      ...FORMAL_OVERRIDES,
      wallClockMinutes: 4560,
      wallClockSearchMinutes: 3600,
    })
    const provider = new FakeProvider({ outcome: 'success' })
    await scriptMatrixFailures(provider, fx)

    // Once the tournament freezes its start, pretend 961 minutes passed:
    // more than the 4560 − 3600 = 960 tournament wall budget.
    let tick = 0
    const base = 1_700_000_000_000
    const clock = () => {
      const t = tick++
      if (existsSync(join(fx.runRoot, 'tournament-start.json'))) {
        return new Date(base + t * 1000 + 961 * 60_000).toISOString()
      }
      return new Date(base + t * 1000).toISOString()
    }

    const report = await driverFor(fx, provider, { clock }).drive()

    expect(report.stopReason).toBe('BUDGET_EXHAUSTED')
    expect(report.status).toBe('STOPPED:BUDGET_EXHAUSTED')
    expect(report.tournamentTrials).toBe(0)
    expect(provider.counters.launchEffects).toHaveLength(17) // search only
    expect(existsSync(join(fx.runRoot, 'candidate-lock.json'))).toBe(false)
  }, 240_000)
})
