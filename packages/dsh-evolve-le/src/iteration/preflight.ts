/**
 * Fail-closed preflight (Gate 5, specs/07 §7; CLAUDE.md rules 8–9): every
 * condition that must hold before the first paid launch, checked in one
 * place. A preflight failure throws before any run state is created or any
 * external effect is attempted — invalid config, missing or wrong-mode
 * credential, unavailable Docker/Harbor, unusable task tree, or a budget that
 * cannot fund the frozen protocol all stop the run instead of degrading it.
 *
 * Credential rule: files are stat'ed, never read — the secret stays in its
 * 0600 root-readable file and never enters memory, logs, or evidence.
 * @module @dsh-evolve-le/core/iteration/preflight
 */

import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectNativeDshRuntime } from '../builder/staging.js'
import { proposalWorkerIdentityAvailable } from '../proposer/sandbox.js'
import { promisify } from 'node:util'
import { calibrateSearch } from '../selection/calibration.js'
import { runSplitCeremony, splitCountsForPopulation } from '../split/ceremony.js'
import { validateRunConfig, type RunConfig } from '../config/run-config.js'

const exec = promisify(execFileCb)

export interface PreflightFinding {
  name: string
  ok: boolean
  detail?: string
}

export type PreflightCheck = () => PreflightFinding | Promise<PreflightFinding>

export class PreflightError extends Error {
  constructor(readonly findings: readonly PreflightFinding[]) {
    super(
      `preflight failed:\n${findings
        .filter((finding) => !finding.ok)
        .map((finding) => `  - ${finding.name}: ${finding.detail ?? 'failed'}`)
        .join('\n')}`,
    )
    this.name = 'PreflightError'
  }
}

/** Run every check; collect all findings (never stop at the first). */
export async function runPreflight(checks: readonly PreflightCheck[]): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = []
  for (const check of checks) {
    try {
      findings.push(await check())
    } catch (error) {
      findings.push({
        name: 'preflight-internal',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return findings
}

/** Assert every finding passed (fail closed with the full list). */
export function assertPreflight(findings: readonly PreflightFinding[]): void {
  if (findings.some((finding) => !finding.ok)) {
    throw new PreflightError(findings)
  }
}

/** Config document: schema + semantic validation via the versioned loader. */
export function configCheck(document: unknown): PreflightCheck {
  return async () => {
    const result = validateRunConfig(document)
    return result.ok
      ? { name: 'config', ok: true, detail: result.configHash }
      : { name: 'config', ok: false, detail: result.error.errors.join('; ') }
  }
}

/**
 * Materialize the exact native DSH closure in a builder-owned scratch tree
 * and compare it with the run lock. Admission repeats this calculation, so a
 * catalog mutation after PREFLIGHT cannot silently change candidate runtime.
 */
export function nativeDshCatalogCheck(config: Pick<RunConfig, 'nativeDsh'>): PreflightCheck {
  return async (): Promise<PreflightFinding> => {
    const runtime = config.nativeDsh
    if (runtime === undefined) {
      return {
        name: 'native-dsh-catalog',
        ok: false,
        detail: 'nativeDsh catalogRoot and dependencyClosureSha256 are required',
      }
    }
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-runtime-preflight-'))
    try {
      const actual = await inspectNativeDshRuntime(runtime.catalogRoot, scratch)
      if (actual.dependencyClosureSha256 !== runtime.dependencyClosureSha256) {
        return {
          name: 'native-dsh-catalog',
          ok: false,
          detail: `closure sha256 ${actual.dependencyClosureSha256}, expected ${runtime.dependencyClosureSha256}`,
        }
      }
      return {
        name: 'native-dsh-catalog',
        ok: true,
        detail: `${actual.dependencyClosureSha256} (${actual.packages.length} packages, ${actual.fileCount} files)`,
      }
    } catch (error) {
      return {
        name: 'native-dsh-catalog',
        ok: false,
        detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
}

/** A proposal worker may never fall back to the controller's root uid. */
export function proposalWorkerIdentityCheck(): PreflightCheck {
  return () => {
    const identity = proposalWorkerIdentityAvailable()
    return { name: 'proposal-worker-identity', ...identity }
  }
}

/**
 * Credential files: exist, are regular files, and are readable by owner only
 * (mode 0600). The content is deliberately never read here (rule 8).
 */
export function credentialChecks(config: RunConfig): PreflightCheck[] {
  return config.modelRoutes
    .filter((route) => route.credentialFile !== undefined)
    .map((route) => {
      const path = route.credentialFile as string
      return async (): Promise<PreflightFinding> => {
        const info = await stat(path).catch(() => undefined)
        if (info === undefined) {
          return { name: `credential:${route.id}`, ok: false, detail: `${path} missing` }
        }
        if (!info.isFile()) {
          return { name: `credential:${route.id}`, ok: false, detail: `${path} not a file` }
        }
        if ((info.mode & 0o077) !== 0) {
          return {
            name: `credential:${route.id}`,
            ok: false,
            detail: `${path} mode ${info.mode.toString(8)} is not owner-only (0600)`,
          }
        }
        return { name: `credential:${route.id}`, ok: true }
      }
    })
}

/** Docker daemon reachable (the Harbor environment backend). */
export function dockerCheck(bin = 'docker'): PreflightCheck {
  return async () => {
    const result = await exec(bin, ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 30_000,
    }).catch((error: unknown) => error as Error)
    return result instanceof Error
      ? { name: 'docker', ok: false, detail: result.message.slice(0, 300) }
      : { name: 'docker', ok: true, detail: result.stdout.trim() }
  }
}

/** Harbor binary reports exactly the pinned version. */
export function harborVersionCheck(bin: string, expected: string): PreflightCheck {
  return async () => {
    const result = await exec(bin, ['--version'], { timeout: 30_000 }).catch(
      (error: unknown) => error as Error,
    )
    if (result instanceof Error) {
      return { name: 'harbor-version', ok: false, detail: result.message.slice(0, 300) }
    }
    const version = result.stdout.trim()
    return version === expected
      ? { name: 'harbor-version', ok: true, detail: version }
      : {
          name: 'harbor-version',
          ok: false,
          detail: `harbor --version = ${version}, expected ${expected}`,
        }
  }
}

/** Task tree: the tasks root exists and every planned handle has a task.toml. */
export function tasksRootCheck(tasksRoot: string, handles: readonly string[]): PreflightCheck {
  return async () => {
    const missing: string[] = []
    for (const handle of handles) {
      const info = await stat(join(tasksRoot, handle, 'task.toml')).catch(() => undefined)
      if (info?.isFile() !== true) missing.push(handle)
    }
    return missing.length === 0
      ? { name: 'tasks-root', ok: true, detail: `${handles.length} handles verified` }
      : {
          name: 'tasks-root',
          ok: false,
          detail: `${tasksRoot}: no task.toml for ${missing.slice(0, 5).join(', ')}${
            missing.length > 5 ? ` (+${missing.length - 5} more)` : ''
          }`,
        }
  }
}

/** Baseline source directory exists (the trusted builder validates the rest). */
export function baselineSourceCheck(baselineSourceDir: string): PreflightCheck {
  return async () => {
    const info = await stat(baselineSourceDir).catch(() => undefined)
    return info?.isDirectory() === true
      ? { name: 'baseline-source', ok: true, detail: baselineSourceDir }
      : { name: 'baseline-source', ok: false, detail: `${baselineSourceDir} missing` }
  }
}

/** Run root writable (the evidence tree lands here). */
export function runRootCheck(runRoot: string): PreflightCheck {
  return async () => {
    const info = await stat(runRoot).catch(() => undefined)
    return info?.isDirectory() === true
      ? { name: 'run-root', ok: true, detail: runRoot }
      : { name: 'run-root', ok: false, detail: `${runRoot} does not exist (init first)` }
  }
}

/**
 * UCB-Air calibration preflight (specs/03 §2, ADR-042, ADR-046): before any
 * paid launch, the frozen envelope must structurally reach K. Pure arithmetic
 * over the frozen config (see selection/calibration.ts); with a benchmark
 * baseline the matrix is additionally bounded by the development split
 * (observed + guard, ADR-046) — the ceremony is deterministic from (runId,
 * masterSeed, handles), the same inputs the driver replays, so this is
 * exactly what the run would compute.
 */
export function searchCalibrationCheck(
  config: RunConfig,
  handles: readonly string[],
): PreflightCheck {
  return () => {
    const problems: string[] = []
    const baseline = config.search.benchmarkBaseline
    if (baseline !== undefined) {
      // Scale the split to the actual population: the live tasks root carries
      // the frozen 89→72 ≤1800s exclusion, and the default 89-slot split
      // would throw "cannot fill" instead of producing a finding. This mirrors
      // the ceremony the run itself uses (record script + init path).
      const ceremony = runSplitCeremony({
        runId: config.runId,
        masterSeed: config.masterSeed,
        handles,
        counts: splitCountsForPopulation(handles.length),
      })
      const developmentCount =
        ceremony.ceremony.observedHandles.length + ceremony.ceremony.guardOpaqueIds.length
      if (baseline.taskCount > developmentCount) {
        problems.push(
          `benchmarkBaseline.taskCount=${baseline.taskCount} exceeds the development split (${developmentCount} handles)`,
        )
      }
    }
    const verdict = calibrateSearch({
      kTarget: config.search.kTarget,
      coldStartTrials: config.search.coldStartTrials,
      shortlistSize: config.search.shortlistSize,
      ucbAirAlphaPerMille: config.search.ucbAirAlphaPerMille,
      maxSolverTrials: config.search.maxSolverTrials,
      taskTrials: config.budget.taskTrials,
      ...(baseline !== undefined ? { benchmarkBaseline: baseline } : {}),
    })
    problems.push(...verdict.problems)
    return problems.length === 0
      ? { name: 'search-calibration', ok: true, detail: verdict.detail }
      : { name: 'search-calibration', ok: false, detail: problems.join('; ') }
  }
}
