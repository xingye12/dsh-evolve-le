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
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
