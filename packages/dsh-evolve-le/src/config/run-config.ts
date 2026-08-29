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

export const RUN_CONFIG_SCHEMA_ID = 'https://dsh-evolve-le.local/schemas/run.config.schema.json'

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
  /** The compatible Zen/high/1M/32k route, preserved as an optional route. */
  zenCompatibleRoute: {
    id: 'deepseek/zen-compatible',
    provider: 'zen-compatible' as const,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    inputUsdMicrosPerMTok: 140_000,
    outputUsdMicrosPerMTok: 280_000,
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
}

export interface RunConfig {
  $schema: typeof RUN_CONFIG_SCHEMA_ID
  schemaVersion: 1
  runId: string
  profile: 'stable-demo'
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
  }
  modelRoutes: ModelRouteConfig[]
  proposerRoute: string
  benchmark: {
    provider: 'terminal-bench-2-1'
    tasksRoot: string
    baselineSourceDir: string
    harbor: { bin: string; version: string; jobsRoot: string; concurrentTrials: number }
    artifactEndpoint: { host: string; port: number }
  }
  budget: {
    usd: number
    proposerTokens: number
    proposalCalls: number
    taskTrials: number
    wallClockMinutes: number
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
  // A networked proposer route must be fully specified before preflight — an
  // under-specified endpoint must fail closed, not fall back silently.
  const proposerRoute = config.modelRoutes.find((route) => route.id === config.proposerRoute)
  if (proposerRoute?.provider === 'zen-compatible') {
    if (
      proposerRoute.baseUrl === undefined ||
      !/^https?:\/\/[^/]+.*$/.test(proposerRoute.baseUrl)
    ) {
      problems.push(
        `proposer route ${proposerRoute.id}: zen-compatible requires an http(s) baseUrl`,
      )
    }
    if (proposerRoute.model === undefined || proposerRoute.model.length === 0) {
      problems.push(
        `proposer route ${proposerRoute.id}: zen-compatible requires the exact model id`,
      )
    }
    if (proposerRoute.temperature === undefined) {
      problems.push(`proposer route ${proposerRoute.id}: zen-compatible requires a temperature`)
    }
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
  if (config.budget.taskTrials < config.search.maxSolverTrials) {
    problems.push('budget.taskTrials is below search.maxSolverTrials')
  }
  if (config.sealedAccess !== false) {
    problems.push('sealedAccess must be false for stable-demo')
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
  jobsRoot: string
  harborBin?: string
  harborVersion?: string
  artifactHost?: string
  artifactPort?: number
  /** Select the proposer route by id (default: the recorded route). */
  proposerRoute?: string
  /** Endpoint facts for a zen-compatible proposer route (Gate 8). */
  modelBaseUrl?: string
  modelName?: string
  modelTemperature?: number
  overrides?: Partial<RunConfig['search']> & Partial<RunConfig['budget']> & { kTarget?: number }
}): RunConfig {
  // Only genuine search keys may enter search — the overrides object may mix
  // search and budget keys (the CLI `--set` path), and budget keys must not
  // leak into the search document (nor the reverse, handled below).
  const searchOverrides: Partial<RunConfig['search']> = {}
  for (const key of Object.keys(STABLE_DEMO_DEFAULTS.search) as Array<keyof RunConfig['search']>) {
    const value = input.overrides?.[key]
    if (value !== undefined) searchOverrides[key] = value
  }
  const search = { ...STABLE_DEMO_DEFAULTS.search, ...searchOverrides }
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
  for (const key of Object.keys(budgetDefaults) as Array<keyof RunConfig['budget']>) {
    const value = input.overrides?.[key]
    if (value !== undefined) budgetOverrides[key] = value
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
    profile: 'stable-demo',
    masterSeed: input.masterSeed,
    search,
    modelRoutes,
    proposerRoute: input.proposerRoute ?? STABLE_DEMO_DEFAULTS.recordedRoute.id,
    benchmark: {
      provider: 'terminal-bench-2-1',
      tasksRoot: input.tasksRoot,
      baselineSourceDir: input.baselineSourceDir,
      harbor: {
        bin: input.harborBin ?? 'harbor',
        version: input.harborVersion ?? '0.21.0',
        jobsRoot: input.jobsRoot,
        concurrentTrials: 1,
      },
      artifactEndpoint: {
        host: input.artifactHost ?? '172.17.0.1',
        port: input.artifactPort ?? 8443,
      },
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
