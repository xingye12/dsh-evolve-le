/**
 * Run-config contract tests (Gate 5, specs/07 §7): the versioned config is
 * the frozen input to the run manifest — schema violations, semantic
 * violations and credential-shape mistakes must fail closed before any paid
 * launch, and the stable-demo defaults must carry K=3 / ≤15 trials / no
 * sealed access plus the compatible Zen/high/1M/131k route.
 */
import { describe, expect, it } from 'vitest'
import {
  defaultRunConfig,
  liveSolveLimitsFromAgentTimeout,
  loadRunConfig,
  proposalSandboxLimits,
  REMOTE_PROPOSAL_SANDBOX_LIMITS,
  RUN_CONFIG_SCHEMA_ID,
  SOLVE_AGENT_LIMITS,
  STABLE_DEMO_DEFAULTS,
  solverTrackOf,
  validateRunConfig,
  type ModelRouteConfig,
  type RunConfig,
} from '../src/config/run-config.js'
import { solverRoutePlan } from '../src/proposer/remote-runner.js'
import { canonicalHash } from '../src/state/canonical.js'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function validConfig(): RunConfig {
  return defaultRunConfig({
    runId: 'gate5-unit',
    masterSeed: 'unit-test-master-seed-0',
    tasksRoot: '/tmp/dsh-tasks',
    baselineSourceDir: '/repo/packages/candidate-baseline',
    jobsRoot: '/tmp/dsh-jobs',
  })
}

describe('run config schema (specs/07 §7)', () => {
  it('stable-demo defaults: K=3, ≤15 solver trials, sealed access off', () => {
    expect(STABLE_DEMO_DEFAULTS.search.kTarget).toBe(3)
    expect(STABLE_DEMO_DEFAULTS.search.maxSolverTrials).toBeLessThanOrEqual(15)
    expect(STABLE_DEMO_DEFAULTS.search.ucbAirAlphaPerMille).toBe(600)
    expect(STABLE_DEMO_DEFAULTS.search.coldStartTrials).toBe(1)
    expect(STABLE_DEMO_DEFAULTS.search.maxConsecutiveExpansionFailures).toBe(3)
  })

  it('the compatible Zen/high/1M/131k route is preserved as an optional route', () => {
    const zen = STABLE_DEMO_DEFAULTS.zenCompatibleRoute
    expect(zen.provider).toBe('zen-compatible')
    expect(zen.contextWindowTokens).toBe(1_000_000)
    expect(zen.maxOutputTokens).toBe(131_072)
    // The recorded proposer route needs no credential; the zen route demands one.
    const config = validConfig()
    const recorded = config.modelRoutes.find((route) => route.provider === 'recorded')
    const compatible = config.modelRoutes.find((route) => route.provider === 'zen-compatible')
    expect(recorded?.credentialFile).toBeUndefined()
    expect(compatible?.credentialFile).toMatch(/^\//)
  })

  it('accepts the default document and hashes it canonically', () => {
    const result = validateRunConfig(validConfig())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.$schema).toBe(RUN_CONFIG_SCHEMA_ID)
      expect(result.configHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(validateRunConfig(validConfig()).ok).toBe(true)
    }
  })

  it('requires separately frozen budgets for a live Agent Debugger route', () => {
    const config = validConfig()
    // The default Zen route intentionally carries only route-selection facts;
    // a live role must freeze its concrete endpoint/model/temperature too.
    const modelRoutes = config.modelRoutes.map((route) =>
      route.id === 'deepseek/zen-compatible'
        ? {
            ...route,
            baseUrl: 'https://example.test/v1',
            model: 'deepseek-reasoner',
            temperature: 1,
          }
        : route,
    )
    const withoutBudget = validateRunConfig({
      ...config,
      modelRoutes,
      agentDebugger: {
        route: 'deepseek/zen-compatible',
        maxOutputTokens: 8192,
        requestTimeoutMs: 180_000,
        maxInputBytes: 524_288,
      },
    })
    expect(withoutBudget.ok).toBe(false)
    if (!withoutBudget.ok)
      expect(withoutBudget.error.errors.join('\n')).toContain('attributionTokens')
    const accepted = validateRunConfig({
      ...config,
      modelRoutes,
      agentDebugger: {
        route: 'deepseek/zen-compatible',
        maxOutputTokens: 8192,
        requestTimeoutMs: 180_000,
        maxInputBytes: 524_288,
      },
      budget: { ...config.budget, attributionCalls: 6, attributionTokens: 600_000 },
    })
    expect(accepted.ok).toBe(true)
  })

  it('requires an explicit legacy source when tree-v2 migration is selected', () => {
    const withoutLegacy = defaultRunConfig({
      runId: 'tree-v2-no-legacy',
      masterSeed: 'tree-v2-no-legacy-seed',
      tasksRoot: '/tmp/dsh-tasks',
      baselineSourceDir: '/repo/packages/candidate-tree-v2-baseline',
      jobsRoot: '/tmp/dsh-jobs',
      candidateProtocol: 'tree-v2',
    })
    const rejected = validateRunConfig(withoutLegacy)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.errors.join('\n')).toContain('legacyBaselineSourceDir')

    const accepted = validateRunConfig({
      ...withoutLegacy,
      benchmark: {
        ...withoutLegacy.benchmark,
        legacyBaselineSourceDir: '/repo/packages/candidate-baseline',
      },
    })
    expect(accepted.ok).toBe(true)
  })

  it('forbids a legacy migration source on a legacy-v1 run', () => {
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      benchmark: {
        ...config.benchmark,
        legacyBaselineSourceDir: '/repo/packages/candidate-baseline',
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.join('\n')).toContain('candidateProtocol')
  })

  it('rejects schema violations with every path listed', () => {
    const broken = { ...validConfig(), search: { ...validConfig().search, kTarget: 0 } }
    const result = validateRunConfig(broken)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.some((line) => line.includes('kTarget'))).toBe(true)
  })

  it('rejects a proposer route that is not in the route table', () => {
    const result = validateRunConfig({ ...validConfig(), proposerRoute: 'no/such-route' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain('no/such-route')
    }
  })

  it('rejects a zen-compatible route without a credential file', () => {
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      modelRoutes: config.modelRoutes.map((route) =>
        route.provider === 'zen-compatible' ? { ...route, credentialFile: undefined } : route,
      ),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.join('\n')).toContain('credentialFile')
  })

  it('requires a frozen retry policy on every zen-compatible route (ADR-033)', () => {
    const config = validConfig()
    // Select the zen route as the proposer route — the retry check applies to
    // the selected route, and an inert route is not the surface at risk.
    // Delete the key, don't set undefined — canonical hashing rejects
    // undefined values, and a real legacy document simply lacks the key.
    const result = validateRunConfig({
      ...config,
      proposerRoute: 'deepseek/zen-compatible',
      modelRoutes: config.modelRoutes.map((route) => {
        if (route.provider !== 'zen-compatible') return route
        const stripped = { ...route }
        delete stripped.retry
        return stripped
      }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain('retry policy (ADR-033)')
    }
  })

  it('rejects malformed retry policies (ADR-033)', () => {
    const config = validConfig()
    const mutate = (retry: unknown) =>
      validateRunConfig({
        ...config,
        proposerRoute: 'deepseek/zen-compatible',
        modelRoutes: config.modelRoutes.map((route) =>
          route.provider === 'zen-compatible'
            ? { ...route, retry: retry as ModelRouteConfig['retry'] }
            : route,
        ),
      })
    // Bounds and types fail in the JSON schema before the semantic check runs.
    for (const retry of [
      { maxAttempts: 0, backoffMs: [] },
      { maxAttempts: 2.5, backoffMs: [500] },
      { maxAttempts: 4, backoffMs: [500, 1500, -1] },
    ]) {
      const result = mutate(retry)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.errors.join('\n')).toContain('/retry/')
    }
    // The length invariant is semantic (the JSON schema cannot express it):
    // backoffMs.length must equal maxAttempts - 1.
    const length = mutate({ maxAttempts: 4, backoffMs: [500] })
    expect(length.ok).toBe(false)
    if (!length.ok) {
      expect(length.error.errors.join('\n')).toContain('retry policy must be')
    }
  })

  it('rejects a discovery+cold-start plan the trial cap cannot fund', () => {
    const result = validateRunConfig({
      ...validConfig(),
      search: {
        ...validConfig().search,
        maxDiscoveryTrials: 12,
        kTarget: 3,
        coldStartTrials: 1,
        maxSolverTrials: 13,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.join('\n')).toContain('maxSolverTrials')
  })

  it('accepts the K=10 pilot profile: K admitted candidates, 6+6 discovery, funded cold starts', () => {
    // specs/03 §2 + specs/07 §10: the pilot's K=10 counts ADMITTED non-baseline
    // candidates (kTarget), never the discovery sample size. Its own §4.2
    // baseline freeze uses the §4.1 discovery protocol (6+6, hard cap 12),
    // and the trial cap must fund discovery plus every admitted child's q0 —
    // including the W_p overshoot the last wave may produce (10..12 children).
    // ADR-026 sized the cap from the measured attempt-5 curve (6 freeze + 12
    // q0 + ~2.8 pool trials per child ≈ 49): 60 funds K=10 with headroom; the
    // ADR-025 cap of 48 exhausted at 12 admitted with 2 q0s unfunded.
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      search: {
        ...config.search,
        kTarget: 10,
        maxDiscoveryTrials: 12,
        maxSolverTrials: 60,
      },
      budget: { ...config.budget, taskTrials: 60 },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts the pre-registered 76h repair3 envelope and fails closed beyond it (ADR-058)', () => {
    // ADR-030 live pilot: ~50 live Harbor trials at minutes-to-half-an-hour
    // each cannot fit the 16h formal efficiency objective (specs/00 §6.3), so
    // the schema admits pre-registered rehearsal budgets beyond 16h — the
    // deviation is recorded in the STATUS preRegistration. ADR-045 later
    // pre-registers 1800 (30h) as the explicit formal k80 wall-clock
    // amendment; ADR-058 amends the repair3 envelope to 4560 (3600 search +
    // 960 tournament). The first launch attempt died in init because the old
    // global 960 maximum contradicted the schema's own "advisory for
    // stable-demo" clause; this pins the reconciled bound.
    const config = validConfig()
    const pilot = validateRunConfig({
      ...config,
      budget: { ...config.budget, wallClockMinutes: 4560 },
    })
    expect(pilot.ok).toBe(true)
    const beyond = validateRunConfig({
      ...config,
      budget: { ...config.budget, wallClockMinutes: 4561 },
    })
    expect(beyond.ok).toBe(false)
    if (!beyond.ok) {
      expect(beyond.error.errors.join('\n')).toContain('wallClockMinutes')
    }
  })

  it('pairs the ADR-058 search share with the envelope and requires a positive tournament budget', () => {
    const config = validConfig()
    const paired = validateRunConfig({
      ...config,
      budget: { ...config.budget, wallClockMinutes: 4560, wallClockSearchMinutes: 3600 },
    })
    expect(paired.ok).toBe(true)
    // A share that eats the whole envelope is a mis-registration: the
    // tournament would get zero wall budget, never a silent pass.
    const eatsEnvelope = validateRunConfig({
      ...config,
      budget: { ...config.budget, wallClockMinutes: 4560, wallClockSearchMinutes: 4560 },
    })
    expect(eatsEnvelope.ok).toBe(false)
    if (!eatsEnvelope.ok) {
      expect(eatsEnvelope.error.errors.join('\n')).toContain('wallClockSearchMinutes')
    }
  })

  it('rejects a K=10 plan the trial cap cannot fund', () => {
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      search: {
        ...config.search,
        kTarget: 10,
        maxDiscoveryTrials: 12,
        maxSolverTrials: 21,
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.join('\n')).toContain('maxSolverTrials')
  })

  it('rejects a discovery batch above the specs/04 §4.1 batch size', () => {
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      search: { ...config.search, discoveryBatchSize: 7 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain('discoveryBatchSize')
    }
  })

  it('rejects budget.taskTrials below the solver-trial cap and sealed access on', () => {
    const trials = validateRunConfig({
      ...validConfig(),
      budget: { ...validConfig().budget, taskTrials: 2 },
    })
    expect(trials.ok).toBe(false)
    const sealed = validateRunConfig({ ...validConfig(), sealedAccess: true })
    expect(sealed.ok).toBe(false)
  })

  it('loads from disk and fails closed on unreadable JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-config-'))
    const path = join(dir, 'run.config.json')
    writeFileSync(path, `${JSON.stringify(validConfig(), null, 2)}\n`, 'utf8')
    expect(loadRunConfig(path).ok).toBe(true)
    writeFileSync(path, '{not json', 'utf8')
    const result = loadRunConfig(path)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors[0]).toContain('cannot read')
  })
})

describe('proposal sandbox limits by proposer route (Gate 8)', () => {
  const base = (): RunConfig =>
    defaultRunConfig({
      runId: 'sandbox-limits-test',
      masterSeed: 'sandbox-limits-seed',
      tasksRoot: '/nonexistent/tasks',
      baselineSourceDir: '/nonexistent/baseline',
      jobsRoot: '/nonexistent/jobs',
    })

  it('gives networked proposer routes the raised one-shot budget', () => {
    const document = base()
    document.proposerRoute = 'deepseek/zen-compatible'
    document.modelRoutes = document.modelRoutes.map((route) =>
      route.id === 'deepseek/zen-compatible'
        ? { ...route, baseUrl: 'http://127.0.0.1:9/v1', model: 'deepseek-v4-flash', temperature: 0 }
        : route,
    )
    // Real-model turns are slow (Gate 8 smoke: >120s requests, ~10 min per
    // proposal) — the sandbox must not kill the worker at the 300s default.
    expect(proposalSandboxLimits(document)).toEqual({ ...REMOTE_PROPOSAL_SANDBOX_LIMITS })
    expect(REMOTE_PROPOSAL_SANDBOX_LIMITS.timeoutMs).toBeGreaterThan(300_000)
  })

  it('keeps the fast recorded-route defaults untouched', () => {
    expect(proposalSandboxLimits(base())).toEqual({})
  })
})

describe('solver route (ADR-030, specs/00 §4 / specs/02 §13)', () => {
  /** A networked proposer + a paired live solver over the same route table. */
  const liveBase = (): RunConfig => {
    const document = defaultRunConfig({
      runId: 'solver-route-test',
      masterSeed: 'solver-route-seed-0',
      tasksRoot: '/nonexistent/tasks',
      baselineSourceDir: '/nonexistent/baseline',
      jobsRoot: '/nonexistent/jobs',
      proposerRoute: 'deepseek/zen-compatible',
      solverRoute: 'deepseek/zen-compatible',
      solverTokens: 4_000_000,
      modelBaseUrl: 'http://127.0.0.1:9/v1',
      modelName: 'deepseek-v4-flash',
      modelTemperature: 0,
    })
    return {
      ...document,
      budget: { ...document.budget, solverTokens: 4_000_000 },
    }
  }

  it('accepts a paired networked solverRoute with budget.solverTokens', () => {
    const result = validateRunConfig(liveBase())
    expect(result.ok).toBe(true)
  })

  it('defaults live solver runs to four concurrent trials and image prefetch', () => {
    const document = liveBase()
    expect(document.benchmark.harbor.concurrentTrials).toBe(4)
    expect(document.benchmark.harbor.prefetchImages).toBe(true)
  })

  it('accepts the ADR-045 formal K=80 live-solver shape with eight-way waves', () => {
    // ADR-045: the amended k80 envelope (400 solver/task trials, alpha=0.8)
    // rides eight-way Harbor waves — the schema and CLI caps (1..8) both
    // admit it, and the value freezes into benchmark.harbor.concurrentTrials.
    const document = liveBase()
    const result = validateRunConfig({
      ...document,
      search: {
        ...document.search,
        kTarget: 80,
        maxDiscoveryTrials: 12,
        maxSolverTrials: 400,
        ucbAirAlphaPerMille: 800,
      },
      budget: { ...document.budget, taskTrials: 400, solverTokens: 800_000_000 },
      benchmark: {
        ...document.benchmark,
        harbor: { ...document.benchmark.harbor, concurrentTrials: 8 },
      },
    })
    expect(result.ok).toBe(true)
    // The freeze must land in the VALIDATED document, not the input.
    if (result.ok) {
      expect(result.config.benchmark.harbor.concurrentTrials).toBe(8)
      expect(result.config.benchmark.harbor.prefetchImages).toBe(true)
    }
  })

  it('accepts a separately frozen formal repair run with twelve-way waves', () => {
    const document = liveBase()
    const result = validateRunConfig({
      ...document,
      search: {
        ...document.search,
        kTarget: 80,
        maxDiscoveryTrials: 12,
        maxSolverTrials: 400,
        ucbAirAlphaPerMille: 800,
        benchmarkBaseline: { taskCount: 49, attemptsPerTask: 2, batchSize: 12 },
      },
      budget: { ...document.budget, taskTrials: 400, solverTokens: 800_000_000 },
      benchmark: {
        ...document.benchmark,
        harbor: { ...document.benchmark.harbor, concurrentTrials: 12 },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.benchmark.harbor.concurrentTrials).toBe(12)
  })

  it('rejects disabling image prefetch for a live solver run', () => {
    const document = liveBase()
    const result = validateRunConfig({
      ...document,
      benchmark: {
        ...document.benchmark,
        harbor: { ...document.benchmark.harbor, prefetchImages: false },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain('prefetchImages')
    }
  })

  it('rejects a solver route that is not in the route table', () => {
    const result = validateRunConfig({ ...liveBase(), solverRoute: 'no/such-route' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.join('\n')).toContain('no/such-route')
  })

  it('rejects a recorded provider as the solver route (no upstream endpoint)', () => {
    const result = validateRunConfig({
      ...liveBase(),
      solverRoute: 'dsh-evolve-le/recorded-proposer',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain(
        'solver route dsh-evolve-le/recorded-proposer',
      )
    }
  })

  it('rejects a solver route without baseUrl/model/temperature', () => {
    const document = liveBase()
    const stripped = {
      ...document,
      modelRoutes: document.modelRoutes.map((route) =>
        route.id === 'deepseek/zen-compatible'
          ? { ...route, baseUrl: undefined, model: undefined, temperature: undefined }
          : route,
      ),
    }
    // The proposer needs the same fields, so first move the proposer aside to
    // isolate the solver-side completeness check.
    const proposerStripped = {
      ...stripped,
      proposerRoute: 'dsh-evolve-le/recorded-proposer',
    }
    const result = validateRunConfig(proposerStripped)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain('solver route deepseek/zen-compatible')
    }
  })

  it('rejects solverRoute without budget.solverTokens and the reverse', () => {
    const paired = liveBase()
    const noTokensDoc = {
      ...paired,
      budget: { ...paired.budget, solverTokens: undefined },
    }
    const noTokens = validateRunConfig(noTokensDoc)
    expect(noTokens.ok).toBe(false)
    if (!noTokens.ok) {
      expect(noTokens.error.errors.join('\n')).toContain('budget.solverTokens')
    }
    const noRouteDoc = { ...paired, solverRoute: undefined }
    const noRoute = validateRunConfig(noRouteDoc)
    expect(noRoute.ok).toBe(false)
    if (!noRoute.ok) {
      expect(noRoute.error.errors.join('\n')).toContain('solverRoute')
    }
  })

  it('rejects an ephemeral artifact port for a configured solver route (R2)', () => {
    // The gateway URL is frozen into the job config; a port-0 listener would
    // break harbor's same-config resume idempotency. The schema's minimum 1024
    // is the enforcement point — this pins it.
    const document = liveBase()
    const result = validateRunConfig({
      ...document,
      benchmark: {
        ...document.benchmark,
        artifactEndpoint: { ...document.benchmark.artifactEndpoint, port: 0 },
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.errors.join('\n')).toContain('port')
  })

  it('derives the track: self iff solver and proposer share one route', () => {
    const self = liveBase()
    expect(solverTrackOf(self)).toBe('self')
    const built = defaultRunConfig({
      runId: 'assisted-test',
      masterSeed: 'assisted-seed-0',
      tasksRoot: '/nonexistent/tasks',
      baselineSourceDir: '/nonexistent/baseline',
      jobsRoot: '/nonexistent/jobs',
      proposerRoute: 'deepseek/zen-compatible',
      modelBaseUrl: 'http://127.0.0.1:9/v1',
      modelName: 'deepseek-v4-flash',
      modelTemperature: 0,
      solverRoute: 'deepseek/zen-compatible',
      solverTokens: 1_000_000,
    })
    // same route id => self even when built through defaultRunConfig
    expect(solverTrackOf(built)).toBe('self')
    const split = { ...self, solverRoute: 'other/route' }
    expect(solverTrackOf(split)).toBe('assisted')
    expect(
      solverTrackOf(
        defaultRunConfig({
          runId: 'plain',
          masterSeed: 'plain-seed-0',
          tasksRoot: '/t',
          baselineSourceDir: '/b',
          jobsRoot: '/j',
        }),
      ),
    ).toBe(null)
  })

  it('builds the frozen route plan for a live solver, null otherwise', () => {
    const plan = solverRoutePlan(liveBase())
    expect(plan).not.toBe(null)
    if (plan !== null) {
      expect(plan.routeId).toBe('deepseek/zen-compatible')
      expect(plan.model).toBe('deepseek-v4-flash')
      expect(plan.inputUsdPerMTok).toBe(0.14)
      expect(plan.outputUsdPerMTok).toBe(0.28)
    }
    const plain = defaultRunConfig({
      runId: 'plain2',
      masterSeed: 'plain2-seed-0',
      tasksRoot: '/t',
      baselineSourceDir: '/b',
      jobsRoot: '/j',
    })
    expect(solverRoutePlan(plain)).toBe(null)
  })

  it('freezes solve-agent limits that bound a runaway live trial', () => {
    expect(SOLVE_AGENT_LIMITS.maxTurns).toBeGreaterThanOrEqual(8)
    expect(SOLVE_AGENT_LIMITS.commandTimeoutMs).toBeGreaterThanOrEqual(60_000)
    expect(SOLVE_AGENT_LIMITS.requestTimeoutMs).toBe(660_000)
    // The task's 900 s TB agent limit becomes Harbor's 2700 s effective
    // ceiling at multiplier 3. The capsule returns five minutes earlier so
    // usage/report teardown can finish before Harbor's hard kill.
    expect(liveSolveLimitsFromAgentTimeout('2700000').wallClockMs).toBe(2_400_000)
    // The shortest pinned task is 600 s: it still receives 25 minutes of
    // actual capsule time, rather than the former fixed 29 minutes.
    expect(liveSolveLimitsFromAgentTimeout('1800000').wallClockMs).toBe(1_500_000)
    expect(() => liveSolveLimitsFromAgentTimeout(undefined)).toThrow(/DSH_SOLVE_AGENT_TIMEOUT_MS/)
    expect(() => liveSolveLimitsFromAgentTimeout('300000')).toThrow(/teardown reserve/)
  })

  it('legacy documents without solver fields still validate and hash identically', () => {
    // Pinned before the solver surface existed (canonical keys are sorted, so
    // optional fields cannot perturb a document that lacks them). Guards
    // `commandAudit` and manifest re-derivation over pre-ADR-030 run roots.
    // The tree-v2 protocol selection (candidateProtocol) is a NEW required
    // field: pre-tree-v2 run roots do not carry it, so the pinned document
    // below is the pre-tree-v2 shape — candidateProtocol is stripped before
    // hashing, and validation of a present-day legacy document is checked
    // separately. The pin moved at ADR-033 (the zen route's frozen retry
    // policy joined the route lock).
    const legacy = defaultRunConfig({
      runId: 'legacy-fixture',
      masterSeed: 'legacy-fixture-seed-0',
      tasksRoot: '/tmp/dsh-tasks',
      baselineSourceDir: '/repo/packages/candidate-baseline',
      jobsRoot: '/tmp/dsh-jobs',
      proposerRoute: 'deepseek/zen-compatible',
      modelBaseUrl: 'http://127.0.0.1:9/v1',
      modelName: 'deepseek-v4-flash',
      modelTemperature: 0,
    })
    expect(legacy.solverRoute).toBeUndefined()
    expect(legacy.candidateProtocol).toBe('legacy-v1')
    const result = validateRunConfig(JSON.parse(JSON.stringify(legacy)) as unknown)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.configHash).toBe(
        'sha256:8a471607b90233dbac87accab8d6b913a13b0e74be7b5f9693b0a03148c5c2d7',
      )
    }
    // The pre-tree-v2 document shape (no candidateProtocol key) keeps the
    // hash pinned before ADR-030 — this is the identity historical run roots
    // re-derive through commandAudit. (Moved at ADR-033: the zen route's
    // frozen retry policy joined the route lock, so the fixture's hash moved.)
    const { candidateProtocol: _dropped, ...preTreeV2 } = legacy
    expect(`sha256:${canonicalHash(preTreeV2)}`).toBe(
      'sha256:8c8fb769107c9804ae9c4e1da683b8005797f4aab242e36285ef67de482492fb',
    )
  })

  it('defaultRunConfig accepts solverRoute + solverTokens and validates', () => {
    const document = defaultRunConfig({
      runId: 'solver-defaults',
      masterSeed: 'solver-defaults-seed',
      tasksRoot: '/t',
      baselineSourceDir: '/b',
      jobsRoot: '/j',
      modelBaseUrl: 'http://127.0.0.1:9/v1',
      modelName: 'deepseek-v4-flash',
      modelTemperature: 0,
      solverRoute: 'deepseek/zen-compatible',
      solverTokens: 2_000_000,
    })
    expect(document.solverRoute).toBe('deepseek/zen-compatible')
    expect(document.budget.solverTokens).toBe(2_000_000)
    expect(validateRunConfig(document).ok).toBe(true)
  })

  it('freezes a complete native DSH runtime lock and rejects partial or malformed locks', () => {
    const document = defaultRunConfig({
      runId: 'native-lock',
      masterSeed: 'native-lock-seed',
      tasksRoot: '/t',
      baselineSourceDir: '/b',
      jobsRoot: '/j',
      nativeDshCatalogRoot: '/opt/dsh-rc5',
      nativeDshDependencyClosureSha256: 'a'.repeat(64),
    })
    expect(document.nativeDsh).toEqual({
      catalogRoot: '/opt/dsh-rc5',
      dependencyClosureSha256: 'a'.repeat(64),
    })
    expect(validateRunConfig(document).ok).toBe(true)
    expect(
      validateRunConfig({
        ...document,
        nativeDsh: { ...document.nativeDsh!, catalogRoot: 'relative/dsh' },
      }).ok,
    ).toBe(false)
    expect(() =>
      defaultRunConfig({
        runId: 'native-lock-partial',
        masterSeed: 'native-lock-partial-seed',
        tasksRoot: '/t',
        baselineSourceDir: '/b',
        jobsRoot: '/j',
        nativeDshCatalogRoot: '/opt/dsh-rc5',
      }),
    ).toThrow(/must be supplied together/)
  })
})

describe('run config: benchmark baseline (specs/04 §4.2, ADR-042)', () => {
  it('accepts the K=10 benchmark baseline profile (24×1×6)', () => {
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      search: {
        ...config.search,
        kTarget: 10,
        maxSolverTrials: 60,
        benchmarkBaseline: { taskCount: 24, attemptsPerTask: 1, batchSize: 6 },
      },
      budget: { ...config.budget, taskTrials: 60 },
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a matrix + K×q0 plan the trial cap cannot fund', () => {
    const config = validConfig()
    const result = validateRunConfig({
      ...config,
      search: {
        ...config.search,
        kTarget: 10,
        maxSolverTrials: 55,
        benchmarkBaseline: { taskCount: 24, attemptsPerTask: 2, batchSize: 6 },
      },
      budget: { ...config.budget, taskTrials: 60 },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.errors.join('\n')).toContain('benchmark baseline matrix')
    }
  })

  it('accepts the guard-inclusive taskCount 49 (ADR-049) and rejects 50', () => {
    // ADR-049: the schema maximum moved 48→49 — the formal matrix is the
    // full development population (39 observed + 10 guard), and only a
    // larger matrix is a schema violation. The cap funds the matrix plus
    // K*q0 (the stable-demo defaults would reject the 98-trial matrix on
    // the envelope, not on taskCount).
    const config = validConfig()
    const at49 = validateRunConfig({
      ...config,
      search: {
        ...config.search,
        maxSolverTrials: 400,
        benchmarkBaseline: { taskCount: 49, attemptsPerTask: 2, batchSize: 8 },
      },
      budget: { ...config.budget, taskTrials: 400 },
    })
    expect(at49.ok).toBe(true)
    const at50 = validateRunConfig({
      ...config,
      search: {
        ...config.search,
        maxSolverTrials: 400,
        benchmarkBaseline: { taskCount: 50, attemptsPerTask: 1, batchSize: 6 },
      },
      budget: { ...config.budget, taskTrials: 400 },
    })
    expect(at50.ok).toBe(false)
    if (!at50.ok) {
      expect(at50.error.errors.join('\n')).toContain('taskCount')
    }
  })

  it('composes the three flat --set carriers into search.benchmarkBaseline', () => {
    const config = defaultRunConfig({
      runId: 'gate5-unit',
      masterSeed: 'unit-test-master-seed-0',
      tasksRoot: '/tmp/dsh-tasks',
      baselineSourceDir: '/repo/packages/candidate-baseline',
      jobsRoot: '/tmp/dsh-jobs',
      overrides: {
        kTarget: 10,
        maxSolverTrials: 60,
        baselineTaskCount: 24,
        baselineAttemptsPerTask: 1,
        baselineBatchSize: 6,
      },
    })
    expect(config.search.benchmarkBaseline).toEqual({
      taskCount: 24,
      attemptsPerTask: 1,
      batchSize: 6,
    })
    expect(validateRunConfig(config).ok).toBe(true)
  })

  it('refuses a partial benchmark baseline: all three carriers required together', () => {
    expect(() =>
      defaultRunConfig({
        runId: 'gate5-unit',
        masterSeed: 'unit-test-master-seed-0',
        tasksRoot: '/tmp/dsh-tasks',
        baselineSourceDir: '/repo/packages/candidate-baseline',
        jobsRoot: '/tmp/dsh-jobs',
        overrides: { baselineTaskCount: 24 },
      }),
    ).toThrow(/baselineTaskCount, baselineAttemptsPerTask and baselineBatchSize together/)
  })

  it('composes the four flat tournament carriers into search.tournament (ADR-049)', () => {
    const config = defaultRunConfig({
      runId: 'gate5-unit',
      masterSeed: 'unit-test-master-seed-0',
      tasksRoot: '/tmp/dsh-tasks',
      baselineSourceDir: '/repo/packages/candidate-baseline',
      jobsRoot: '/tmp/dsh-jobs',
      profile: 'terminal-bench-formal',
      overrides: {
        maxSolverTrials: 400,
        baselineTaskCount: 49,
        baselineAttemptsPerTask: 2,
        baselineBatchSize: 8,
        tournamentMinEligibilityTrials: 12,
        tournamentCoverageAttemptsPerTask: 1,
        tournamentMaxTrials: 360,
        tournamentBootstrapResamples: 100_000,
      },
    })
    expect(config.search.tournament).toEqual({
      minEligibilityTrials: 12,
      coverageAttemptsPerTask: 1,
      maxTrials: 360,
      bootstrapResamples: 100_000,
    })
    expect(validateRunConfig(config).ok).toBe(true)
  })

  it('refuses a partial tournament envelope: all four carriers required together', () => {
    expect(() =>
      defaultRunConfig({
        runId: 'gate5-unit',
        masterSeed: 'unit-test-master-seed-0',
        tasksRoot: '/tmp/dsh-tasks',
        baselineSourceDir: '/repo/packages/candidate-baseline',
        jobsRoot: '/tmp/dsh-jobs',
        overrides: { tournamentMaxTrials: 360 },
      }),
    ).toThrow(
      /tournamentMinEligibilityTrials, tournamentCoverageAttemptsPerTask, tournamentMaxTrials and tournamentBootstrapResamples together/,
    )
  })
})
