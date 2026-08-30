/**
 * Run-config contract tests (Gate 5, specs/07 §7): the versioned config is
 * the frozen input to the run manifest — schema violations, semantic
 * violations and credential-shape mistakes must fail closed before any paid
 * launch, and the stable-demo defaults must carry K=3 / ≤15 trials / no
 * sealed access plus the compatible Zen/high/1M/32k route.
 */
import { describe, expect, it } from 'vitest'
import {
  defaultRunConfig,
  loadRunConfig,
  proposalSandboxLimits,
  REMOTE_PROPOSAL_SANDBOX_LIMITS,
  RUN_CONFIG_SCHEMA_ID,
  STABLE_DEMO_DEFAULTS,
  validateRunConfig,
  type RunConfig,
} from '../src/config/run-config.js'
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

  it('the compatible Zen/high/1M/32k route is preserved as an optional route', () => {
    const zen = STABLE_DEMO_DEFAULTS.zenCompatibleRoute
    expect(zen.provider).toBe('zen-compatible')
    expect(zen.contextWindowTokens).toBe(1_000_000)
    expect(zen.maxOutputTokens).toBe(32_768)
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
