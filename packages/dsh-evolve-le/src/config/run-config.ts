/**
 * Versioned run configuration (Gate 5, specs/07 §7): load, validate and
 * freeze the config that drives one run lineage. The document is validated
 * against `schemas/run.config.schema.json` (strict Ajv) plus the semantic
 * invariants the schema cannot express, and its canonical hash is what the
 * run manifest records at PREFLIGHT — after freezing, any mutation means a
 * new run, not an edit. Credentials are referenced by absolute path only and
 * are checked for existence and mode by preflight, never inlined here
 * (CLAUDE.md rule 8).
 * @module @dsh-evolve-le/core/config/run-config
 */

import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { canonicalHash } from '../state/canonical.js'
import { repoRoot } from '../schema.js'
import { resolve } from 'node:path'
import type { TournamentConfig } from '../selection/tournament.js'

// Re-exported for the config surface; defined in the zero-import capsule
// module so acp-boot can ship it without the ajv/schema graph.
export {
  liveSolveLimitsFromAgentTimeout,
  SOLVE_AGENT_LIMITS,
  SOLVE_AGENT_TIMEOUT_ENV,
  SOLVE_HARBOR_TEARDOWN_RESERVE_MS,
} from '../acp/solve-protocol.js'

export const RUN_CONFIG_SCHEMA_ID = 'https://dsh-evolve-le.local/schemas/run.config.schema.json'
/** Terminal-Bench eligibility ceiling for every evaluation profile. */
export const TERMINAL_BENCH_MAX_AGENT_TIMEOUT_SEC = 1_800

/**
 * Frozen per-request retry policy for live routes (ADR-033): how many
 * attempts one chat completion gets and how long the gateway waits between
 * attempts. Lives in the route plan, so it freezes into the route hash and
 * the run manifest like every other locked request parameter (rule 8).
 */
export interface RouteRetryPolicy {
  /** Total attempts including the first one; 1 disables retrying. */
  maxAttempts: number
  /** Delay before attempt i+1; length must equal maxAttempts - 1. */
  backoffMs: number[]
}

export const DEFAULT_ROUTE_RETRY_POLICY: RouteRetryPolicy = {
  maxAttempts: 4,
  backoffMs: [500, 1_500, 4_500],
}

/** Stable-demo defaults (specs/03 §2, specs/07 §7). */
export const STABLE_DEMO_DEFAULTS = {
  profile: 'stable-demo' as const,
  search: {
    kTarget: 3,
    proposalWidth: 3,
    coldStartTrials: 1,
    ucbAirAlphaPerMille: 600,
    shortlistSize: 2,
    maxSolverTrials: 15,
    maxDiscoveryTrials: 12,
    discoveryBatchSize: 6,
    maxConsecutiveExpansionFailures: 3,
  },
  /** The compatible Zen/high/1M/131k route, preserved as an optional route. */
  zenCompatibleRoute: {
    id: 'deepseek/zen-compatible',
    provider: 'zen-compatible' as const,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 131_072,
    inputUsdMicrosPerMTok: 140_000,
    outputUsdMicrosPerMTok: 280_000,
    retry: DEFAULT_ROUTE_RETRY_POLICY,
  },
  recordedRoute: {
    id: 'dsh-evolve-le/recorded-proposer',
    provider: 'recorded' as const,
    contextWindowTokens: 131_072,
    maxOutputTokens: 16_384,
    inputUsdMicrosPerMTok: 3_000_000,
    outputUsdMicrosPerMTok: 15_000_000,
  },
}

export interface ModelRouteConfig {
  id: string
  provider: 'zen-compatible' | 'recorded'
  contextWindowTokens: number
  maxOutputTokens: number
  inputUsdMicrosPerMTok: number
  outputUsdMicrosPerMTok: number
  credentialFile?: string
  /** OpenAI-compatible endpoint; required when this route is the proposerRoute. */
  baseUrl?: string
  /** Exact upstream model id, frozen into the route plan hash. */
  model?: string
  /** Sampling temperature the TCB proxy locks on every outbound request. */
  temperature?: number
  /** ADR-033: required for zen-compatible routes; frozen into the plan hash. */
  retry?: RouteRetryPolicy
}

/**
 * Trusted native DSH runtime input. The catalog is produced and inspected by
 * preflight; its effective dependency closure is frozen into the run
 * manifest and rechecked by every candidate admission.
 */
export interface NativeDshRuntimeConfig {
  catalogRoot: string
  dependencyClosureSha256: string
}

export interface RunConfig {
  $schema: typeof RUN_CONFIG_SCHEMA_ID
  schemaVersion: 1
  runId: string
  profile: 'stable-demo' | 'terminal-bench-formal'
  /** Candidate lineage contract; tree-v2 starts from an explicit migration root. */
  candidateProtocol: 'legacy-v1' | 'tree-v2'
  masterSeed: string
  search: {
    kTarget: number
    proposalWidth: number
    coldStartTrials: number
    ucbAirAlphaPerMille: number
    shortlistSize: number
    maxSolverTrials: number
    maxDiscoveryTrials: number
    discoveryBatchSize: number
    maxConsecutiveExpansionFailures: number
    /**
     * Pre-registered benchmark baseline freeze (specs/04 §4.2, ADR-042):
     * when present the driver runs the full matrix instead of stable-demo
     * discovery. Absent = specs/04 §4.1 discovery.
     */
    benchmarkBaseline?: { taskCount: number; attemptsPerTask: number; batchSize: number }
    /**
     * Champion tournament envelope (ADR-047, specs/03 §11). Optional for
     * stable-demo (which never enters the tournament); required by the
     * terminal-bench-formal profile.
     */
    tournament?: TournamentConfig
  }
  modelRoutes: ModelRouteConfig[]
  proposerRoute: string
  /**
   * Required by the built-in iteration builder. It remains optional in the
   * document shape so deterministic unit fixtures can inject a test builder;
   * production iteration fails closed when this trusted runtime lock is absent.
   */
  nativeDsh?: NativeDshRuntimeConfig
  /**
   * Live model route id for SOLVE trials (ADR-030). Absent = every solve
   * trial runs the recorded-replay capsule (Gate 8 behavior). When set it
   * must reference a zen-compatible networked route and be paired with
   * `budget.solverTokens`.
   */
  solverRoute?: string
  benchmark: {
    provider: 'terminal-bench-2-1'
    maxAgentTimeoutSec: typeof TERMINAL_BENCH_MAX_AGENT_TIMEOUT_SEC
    tasksRoot: string
    baselineSourceDir: string
    /** Required only for tree-v2 to bind the non-inheriting v1 migration receipt. */
    legacyBaselineSourceDir?: string
    harbor: {
      bin: string
      version: string
      jobsRoot: string
      concurrentTrials: number
      prefetchImages?: boolean
    }
    artifactEndpoint: { host: string; port: number }
    /**
     * ADR-028 second amendment: optional HTTP proxy injected into every trial
     * container's environment via the jobconfig `env` lever, so the
     * pre-launch ACP apt bootstrap can use the host's fast egress path. Both
     * values are credential-free and recorded verbatim in every job plan YAML.
     */
    trialContainerProxy?: { httpProxy: string; noProxy: string }
  }
  budget: {
    usd: number
    proposerTokens: number
    proposalCalls: number
    taskTrials: number
    wallClockMinutes: number
    /** Live-solver token budget (ADR-030); required iff `solverRoute` is set. */
    solverTokens?: number
  }
  sealedAccess: false
}

export class RunConfigError extends Error {
  constructor(message: string) {
    super(`run-config: ${message}`)
    this.name = 'RunConfigError'
  }
}

interface ValidateFn {
  (data: unknown): boolean
  errors?: { instancePath: string; message?: string; params?: Record<string, unknown> }[]
}

let compiled: ValidateFn | undefined

function validator(): ValidateFn {
  if (compiled === undefined) {
    const path = resolve(repoRoot, 'schemas', 'run.config.schema.json')
    const schema = JSON.parse(readFileSync(path, 'utf8')) as object
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    compiled = ajv.compile(schema) as ValidateFn
  }
  return compiled
}

/** Config-rejection shape (mirrors ManifestValidationError; own kind union). */
export interface RunConfigErrorReport {
  kind: 'run-config'
  errors: string[]
}

export type RunConfigResult =
  { ok: true; config: RunConfig; configHash: string } | { ok: false; error: RunConfigErrorReport }

/** Validate one parsed config document (schema + semantics). */
export function validateRunConfig(data: unknown): RunConfigResult {
  const validate = validator()
  if (!validate(data)) {
    return {
      ok: false,
      error: {
        kind: 'run-config',
        errors: (validate.errors ?? []).map(
          (error) =>
            `${error.instancePath || '<root>'}: ${error.message ?? 'invalid'}${
              error.params && Object.keys(error.params).length > 0
                ? ` ${JSON.stringify(error.params)}`
                : ''
            }`,
        ),
      },
    }
  }
  const config = data as RunConfig
  const problems = semanticProblems(config)
  if (problems.length > 0) {
    return { ok: false, error: { kind: 'run-config', errors: problems } }
  }
  return { ok: true, config, configHash: `sha256:${canonicalHash(config)}` }
}

/**
 * Route-table completeness for one selecting role (proposer | solver): the
 * selected route must exist, must be networked where the role demands it, and
 * — for zen-compatible routes — must carry baseUrl/model/temperature before
 * preflight. An under-specified endpoint fails closed, never falls back.
 */
function routeCompleteness(
  config: Pick<RunConfig, 'modelRoutes' | 'proposerRoute' | 'solverRoute'>,
  role: 'proposer' | 'solver',
): string[] {
  const routeId = role === 'proposer' ? config.proposerRoute : config.solverRoute
  if (routeId === undefined) return []
  const route = config.modelRoutes.find((candidate) => candidate.id === routeId)
  if (route === undefined) {
    return [`${role}Route ${routeId} is not in modelRoutes`]
  }
  // The recorded proposer route is the offline default; as a SOLVER route it
  // would silently reproduce the zero-capability replay (ADR-030 context).
  if (role === 'solver' && route.provider !== 'zen-compatible') {
    return [
      `solver route ${route.id}: the solver route must be networked (zen-compatible); the recorded route is the behavior solverRoute exists to replace`,
    ]
  }
  if (route.provider !== 'zen-compatible') return []
  const problems: string[] = []
  if (route.baseUrl === undefined || !/^https?:\/\/[^/]+.*$/.test(route.baseUrl)) {
    problems.push(`${role} route ${route.id}: zen-compatible requires an http(s) baseUrl`)
  }
  if (route.model === undefined || route.model.length === 0) {
    problems.push(`${role} route ${route.id}: zen-compatible requires the exact model id`)
  }
  if (route.temperature === undefined) {
    problems.push(`${role} route ${route.id}: zen-compatible requires a temperature`)
  }
  // ADR-033: the retry policy is part of the frozen route lock — a route
  // without one fails closed rather than silently retrying nothing.
  const retry = route.retry
  if (retry === undefined) {
    problems.push(`${role} route ${route.id}: zen-compatible requires a retry policy (ADR-033)`)
  } else if (
    !Number.isInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    retry.maxAttempts > 8 ||
    !Array.isArray(retry.backoffMs) ||
    retry.backoffMs.length !== retry.maxAttempts - 1 ||
    retry.backoffMs.some((ms) => !Number.isInteger(ms) || ms < 0)
  ) {
    problems.push(
      `${role} route ${route.id}: retry policy must be {maxAttempts: 1..8, backoffMs: length maxAttempts-1, non-negative integers}`,
    )
  }
  return problems
}

/** Semantic invariants beyond the schema's reach (fail closed). */
function semanticProblems(config: RunConfig): string[] {
  const problems: string[] = []
  const routeIds = new Set(config.modelRoutes.map((route) => route.id))
  if (routeIds.size !== config.modelRoutes.length) {
    problems.push('modelRoutes: duplicate route ids')
  }
  if (!routeIds.has(config.proposerRoute)) {
    problems.push(`proposerRoute ${config.proposerRoute} is not in modelRoutes`)
  }
  for (const route of config.modelRoutes) {
    if (route.provider === 'zen-compatible' && route.credentialFile === undefined) {
      problems.push(`route ${route.id}: zen-compatible routes require credentialFile`)
    }
  }
  // A networked route must be fully specified before preflight — an
  // under-specified endpoint must fail closed, not fall back silently. The
  // check applies to whichever role (proposer, solver) selects the route.
  problems.push(...routeCompleteness(config, 'proposer'))
  problems.push(...routeCompleteness(config, 'solver'))
  if (config.solverRoute !== undefined) {
    if (config.budget.solverTokens === undefined) {
      problems.push(
        'solverRoute is set but budget.solverTokens is missing (live solves are billable)',
      )
    }
    // The gateway URL (host:port) freezes into every job config and the run
    // manifest; an ephemeral port would break harbor's same-config resume
    // idempotency. The schema pins port ≥ 1024 — this guards the pairing.
    if (config.benchmark.artifactEndpoint.port < 1024) {
      problems.push(
        `solverRoute requires a fixed artifactEndpoint.port ≥ 1024 (got ${String(
          config.benchmark.artifactEndpoint.port,
        )})`,
      )
    }
    if (config.benchmark.harbor.prefetchImages === false) {
      problems.push('live solver runs cannot disable benchmark.harbor.prefetchImages')
    }
  } else if (config.budget.solverTokens !== undefined) {
    problems.push('budget.solverTokens is set but solverRoute is missing (nothing would spend it)')
  }
  if (config.search.maxDiscoveryTrials > config.search.maxSolverTrials) {
    problems.push('search.maxDiscoveryTrials exceeds search.maxSolverTrials')
  }
  if (config.search.discoveryBatchSize > config.search.maxDiscoveryTrials) {
    problems.push('search.discoveryBatchSize exceeds search.maxDiscoveryTrials')
  }
  // The stable-demo profile must be able to fund its own protocol: discovery
  // plus every admitted node's cold start inside the trial cap.
  const coldStartFloor =
    config.search.maxDiscoveryTrials + config.search.kTarget * config.search.coldStartTrials
  if (coldStartFloor > config.search.maxSolverTrials) {
    problems.push(
      `search: discovery (${String(config.search.maxDiscoveryTrials)}) + K*q0 (${String(
        config.search.kTarget * config.search.coldStartTrials,
      )}) exceeds maxSolverTrials (${String(config.search.maxSolverTrials)})`,
    )
  }
  // ADR-042: a benchmark baseline replaces stable-demo discovery with its
  // full matrix — the cap must fund the matrix plus every admitted node's
  // cold start (the calibration preflight re-checks the stricter gate).
  if (config.search.benchmarkBaseline !== undefined) {
    const matrixTrials =
      config.search.benchmarkBaseline.taskCount * config.search.benchmarkBaseline.attemptsPerTask
    if (
      matrixTrials + config.search.kTarget * config.search.coldStartTrials >
      config.search.maxSolverTrials
    ) {
      problems.push(
        `search: benchmark baseline matrix (${String(matrixTrials)}) + K*q0 (${String(
          config.search.kTarget * config.search.coldStartTrials,
        )}) exceeds maxSolverTrials (${String(config.search.maxSolverTrials)})`,
      )
    }
  }
  if (config.budget.taskTrials < config.search.maxSolverTrials) {
    problems.push('budget.taskTrials is below search.maxSolverTrials')
  }
  if (config.sealedAccess !== false) {
    problems.push('sealedAccess must be false for stable-demo')
  }
  // ADR-047/049: the formal profile must carry the tournament envelope and
  // the benchmark baseline — without a frozen matrix there is no pool, and
  // without the tournament envelope there is no champion path.
  if (config.profile === 'terminal-bench-formal') {
    if (config.search.tournament === undefined) {
      problems.push('profile terminal-bench-formal requires search.tournament')
    }
    if (config.search.benchmarkBaseline === undefined) {
      problems.push('profile terminal-bench-formal requires search.benchmarkBaseline')
    }
  }
  if (
    config.candidateProtocol === 'tree-v2' &&
    config.benchmark.legacyBaselineSourceDir === undefined
  ) {
    problems.push('tree-v2 candidateProtocol requires benchmark.legacyBaselineSourceDir')
  }
  if (
    config.candidateProtocol === 'legacy-v1' &&
    config.benchmark.legacyBaselineSourceDir !== undefined
  ) {
    problems.push('legacy-v1 candidateProtocol forbids benchmark.legacyBaselineSourceDir')
  }
  return problems
}

/** Read + validate a config file from disk. */
export function loadRunConfig(path: string): RunConfigResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'run-config',
        errors: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`],
      },
    }
  }
  return validateRunConfig(parsed)
}

/** The default stable-demo config document for `init` (callers add paths). */
export function defaultRunConfig(input: {
  runId: string
  masterSeed: string
  tasksRoot: string
  baselineSourceDir: string
  candidateProtocol?: RunConfig['candidateProtocol']
  profile?: RunConfig['profile']
  legacyBaselineSourceDir?: string
  jobsRoot: string
  harborBin?: string
  harborVersion?: string
  artifactHost?: string
  artifactPort?: number
  /** ADR-028 second amendment: credential-free proxy for trial containers. */
  trialContainerProxy?: { httpProxy: string; noProxy: string }
  /** Select the proposer route by id (default: the recorded route). */
  proposerRoute?: string
  /** Optional live solver route id (ADR-030); paired with solverTokens. */
  solverRoute?: string
  /** Live-solver token budget (ADR-030); paired with solverRoute. */
  solverTokens?: number
  /** Concurrent real-solver Harbor waves; live runs default to four. */
  concurrentTrials?: number
  /** Warm task images before the first live-solver launch. */
  prefetchImages?: boolean
  /** Endpoint facts for a zen-compatible proposer route (Gate 8). */
  modelBaseUrl?: string
  modelName?: string
  modelTemperature?: number
  /** Absolute path to the prebuilt, vetted DSH source catalog. */
  nativeDshCatalogRoot?: string
  /** SHA-256 of the effective native DSH dependency closure from preflight. */
  nativeDshDependencyClosureSha256?: string
  overrides?: Partial<RunConfig['search']> &
    Partial<RunConfig['budget']> & {
      kTarget?: number
      /** ADR-042: flat --set carriers composed into search.benchmarkBaseline. */
      baselineTaskCount?: number
      baselineAttemptsPerTask?: number
      baselineBatchSize?: number
      /** ADR-049: flat --set carriers composed into search.tournament. */
      tournamentMinEligibilityTrials?: number
      tournamentCoverageAttemptsPerTask?: number
      tournamentMaxTrials?: number
      tournamentBootstrapResamples?: number
    }
}): RunConfig {
  if (
    (input.nativeDshCatalogRoot === undefined) !==
    (input.nativeDshDependencyClosureSha256 === undefined)
  ) {
    throw new RunConfigError(
      'nativeDshCatalogRoot and nativeDshDependencyClosureSha256 must be supplied together',
    )
  }
  const candidateProtocol = input.candidateProtocol ?? 'legacy-v1'
  // Only genuine search keys may enter search — the overrides object may mix
  // search and budget keys (the CLI `--set` path), and budget keys must not
  // leak into the search document (nor the reverse, handled below).
  const searchOverrides: Partial<RunConfig['search']> = {}
  for (const key of Object.keys(STABLE_DEMO_DEFAULTS.search) as Array<keyof RunConfig['search']>) {
    const value = input.overrides?.[key]
    // The union key collapses the indexed-write type to the intersection of
    // every search property type (number & benchmarkBaseline), which no value
    // can satisfy. The key set genuinely came from the defaults object, and
    // every defaults key is number-typed, so the narrow write cast is safe.
    if (value !== undefined) {
      ;(searchOverrides as Record<string, unknown>)[key] = value
    }
  }
  const search = { ...STABLE_DEMO_DEFAULTS.search, ...searchOverrides }
  // ADR-042: the CLI --set surface is flat integers only, so the benchmark
  // baseline object arrives as three flat keys and is composed here. All
  // three must be present together — a partial matrix is a config error, not
  // a silent default. Non-CLI callers may pass the complete object directly;
  // flat carriers win if both are present.
  if (input.overrides?.benchmarkBaseline !== undefined) {
    search.benchmarkBaseline = input.overrides.benchmarkBaseline
  }
  // The tournament envelope object is not part of the flat default key set,
  // so it passes through explicitly like benchmarkBaseline.
  if (input.overrides?.tournament !== undefined) {
    search.tournament = input.overrides.tournament
  }
  const baselineFlat = [
    'baselineTaskCount',
    'baselineAttemptsPerTask',
    'baselineBatchSize',
  ] as const
  const baselineValues = baselineFlat.map((key) => input.overrides?.[key])
  if (baselineValues.some((value) => value !== undefined)) {
    if (baselineValues.some((value) => value === undefined)) {
      throw new RunConfigError(
        'benchmarkBaseline requires baselineTaskCount, baselineAttemptsPerTask and baselineBatchSize together',
      )
    }
    search.benchmarkBaseline = {
      taskCount: baselineValues[0]!,
      attemptsPerTask: baselineValues[1]!,
      batchSize: baselineValues[2]!,
    }
  }
  // ADR-049: the tournament envelope rides the same flat --set surface as the
  // benchmark baseline — all four carriers together or none.
  const tournamentFlat = [
    'tournamentMinEligibilityTrials',
    'tournamentCoverageAttemptsPerTask',
    'tournamentMaxTrials',
    'tournamentBootstrapResamples',
  ] as const
  const tournamentValues = tournamentFlat.map((key) => input.overrides?.[key])
  if (tournamentValues.some((value) => value !== undefined)) {
    if (tournamentValues.some((value) => value === undefined)) {
      throw new RunConfigError(
        'search.tournament requires tournamentMinEligibilityTrials, tournamentCoverageAttemptsPerTask, tournamentMaxTrials and tournamentBootstrapResamples together',
      )
    }
    search.tournament = {
      minEligibilityTrials: tournamentValues[0]!,
      coverageAttemptsPerTask: tournamentValues[1]!,
      maxTrials: tournamentValues[2]!,
      bootstrapResamples: tournamentValues[3]!,
    }
  }
  // Only genuine budget keys may enter budget — the overrides object is shared
  // with `search`, so spreading it wholesale would leak search keys here.
  const budgetDefaults = {
    usd: 500_000_000, // $500 acceptance ceiling in µUSD
    proposerTokens: 20_000_000,
    proposalCalls: 20,
    taskTrials: Math.max(search.maxSolverTrials, 15),
    wallClockMinutes: 960,
  } satisfies RunConfig['budget']
  const budgetOverrides: Partial<RunConfig['budget']> = {}
  // solverTokens is optional in the document, so it is not in budgetDefaults'
  // key set — include it explicitly or `--set solverTokens=` would be dropped.
  const budgetKeys = Object.keys(budgetDefaults).concat('solverTokens') as Array<
    keyof RunConfig['budget']
  >
  for (const key of budgetKeys) {
    const value = input.overrides?.[key]
    if (value !== undefined) budgetOverrides[key] = value
  }
  if (budgetOverrides.solverTokens === undefined && input.solverTokens !== undefined) {
    budgetOverrides.solverTokens = input.solverTokens
  }
  const budget: RunConfig['budget'] = { ...budgetDefaults, ...budgetOverrides }
  // Optional zen-compatible endpoint facts land on the zen route document;
  // the proposer route selection is applied after the route table is built.
  const modelRoutes: ModelRouteConfig[] = [
    { ...STABLE_DEMO_DEFAULTS.recordedRoute },
    {
      ...STABLE_DEMO_DEFAULTS.zenCompatibleRoute,
      credentialFile: '/etc/dsh-evolve-le/zen-compatible.key',
      ...(input.modelBaseUrl !== undefined ? { baseUrl: input.modelBaseUrl } : {}),
      ...(input.modelName !== undefined ? { model: input.modelName } : {}),
      ...(input.modelTemperature !== undefined ? { temperature: input.modelTemperature } : {}),
    },
  ]
  return {
    $schema: RUN_CONFIG_SCHEMA_ID,
    schemaVersion: 1,
    runId: input.runId,
    profile: input.profile ?? 'stable-demo',
    candidateProtocol,
    masterSeed: input.masterSeed,
    search,
    modelRoutes,
    proposerRoute: input.proposerRoute ?? STABLE_DEMO_DEFAULTS.recordedRoute.id,
    ...(input.solverRoute !== undefined ? { solverRoute: input.solverRoute } : {}),
    ...(input.nativeDshCatalogRoot !== undefined
      ? {
          nativeDsh: {
            catalogRoot: input.nativeDshCatalogRoot,
            dependencyClosureSha256: input.nativeDshDependencyClosureSha256!,
          },
        }
      : {}),
    benchmark: {
      provider: 'terminal-bench-2-1',
      maxAgentTimeoutSec: TERMINAL_BENCH_MAX_AGENT_TIMEOUT_SEC,
      tasksRoot: input.tasksRoot,
      baselineSourceDir: input.baselineSourceDir,
      ...(input.legacyBaselineSourceDir === undefined
        ? {}
        : { legacyBaselineSourceDir: input.legacyBaselineSourceDir }),
      harbor: {
        bin: input.harborBin ?? 'harbor',
        version: input.harborVersion ?? '0.21.0',
        jobsRoot: input.jobsRoot,
        concurrentTrials: input.concurrentTrials ?? (input.solverRoute !== undefined ? 4 : 1),
        ...((input.prefetchImages ?? input.solverRoute !== undefined)
          ? { prefetchImages: input.prefetchImages ?? true }
          : {}),
      },
      artifactEndpoint: {
        host: input.artifactHost ?? '172.17.0.1',
        port: input.artifactPort ?? 8443,
      },
      ...(input.trialContainerProxy !== undefined
        ? { trialContainerProxy: input.trialContainerProxy }
        : {}),
    },
    budget,
    sealedAccess: false,
  }
}

/**
 * One-shot proposal sandbox limits for networked proposer routes (Gate 8):
 * real-model turns are slow — reasoning models spend minutes per turn and the
 * writeChild directives are large — so the sandbox default 300s kill would
 * turn every real proposal into a timeout. The recorded policy stays on the
 * fast default (it finishes in seconds and must keep failing fast).
 */
export const REMOTE_PROPOSAL_SANDBOX_LIMITS = {
  maxTurns: 24,
  timeoutMs: 3_600_000,
} as const

/** Sandbox limits for the run's proposer route (empty = recorded defaults). */
export function proposalSandboxLimits(config: Pick<RunConfig, 'modelRoutes' | 'proposerRoute'>): {
  maxTurns?: number
  timeoutMs?: number
} {
  const route = config.modelRoutes.find((candidate) => candidate.id === config.proposerRoute)
  return route !== undefined && route.provider === 'zen-compatible'
    ? { ...REMOTE_PROPOSAL_SANDBOX_LIMITS }
    : {}
}

/**
 * The run's evolution track (specs/00 §4): `self` when the solver and the
 * proposer share one route — the system under test is the whole self-loop —
 * `assisted` when a stronger solver proposes for a weaker evolvee. Null when
 * no live solver is configured (replay solves, Gate 8 behavior).
 */
export function solverTrackOf(
  config: Pick<RunConfig, 'proposerRoute' | 'solverRoute'>,
): 'self' | 'assisted' | null {
  if (config.solverRoute === undefined) return null
  return config.solverRoute === config.proposerRoute ? 'self' : 'assisted'
}
