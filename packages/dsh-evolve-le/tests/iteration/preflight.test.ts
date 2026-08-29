/**
 * Preflight contract tests (Gate 5, specs/07 §7; CLAUDE.md rules 8–9): every
 * condition that must hold BEFORE the first paid launch is checked fail-closed
 * in one place, and a failure surfaces the complete finding list rather than
 * the first.
 *
 * Pins:
 * - invalid config stops the run before any effect;
 * - credential files are stat'ed (existence + owner-only mode) and never read;
 * - docker/harbor/task-tree checks report their real cause;
 * - `assertPreflight` throws `PreflightError` carrying every failed finding;
 * - a throwing check degrades to a failed finding, never to a pass.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertPreflight,
  baselineSourceCheck,
  configCheck,
  credentialChecks,
  dockerCheck,
  harborVersionCheck,
  PreflightError,
  runPreflight,
  runRootCheck,
  tasksRootCheck,
  type PreflightFinding,
} from '../../src/iteration/preflight.js'
import { defaultRunConfig } from '../../src/config/run-config.js'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function findingsOf(map: Record<string, PreflightFinding>): PreflightFinding[] {
  return Object.values(map)
}

describe('preflight runner', () => {
  it('collects all findings, including from checks that throw', async () => {
    const findings = await runPreflight([
      () => ({ name: 'a', ok: true }),
      () => ({ name: 'b', ok: false, detail: 'nope' }),
      () => {
        throw new Error('exploded')
      },
      async () => ({ name: 'd', ok: true, detail: 'async' }),
    ])
    expect(findings.map((finding) => finding.name)).toEqual(['a', 'b', 'preflight-internal', 'd'])
    expect(findings[2]?.ok).toBe(false)
    expect(findings[2]?.detail).toContain('exploded')
  })

  it('assertPreflight throws with every failed finding listed', () => {
    const findings = findingsOf({
      ok1: { name: 'ok1', ok: true },
      bad1: { name: 'bad1', ok: false, detail: 'reason-1' },
      bad2: { name: 'bad2', ok: false, detail: 'reason-2' },
    })
    expect(() => assertPreflight(findings)).toThrow(PreflightError)
    try {
      assertPreflight(findings)
      expect.unreachable('assertPreflight must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PreflightError)
      const message = (error as PreflightError).message
      expect(message).toContain('bad1: reason-1')
      expect(message).toContain('bad2: reason-2')
      expect(message).not.toContain('ok1')
    }
    // All-pass findings do not throw.
    expect(() =>
      assertPreflight([
        { name: 'ok1', ok: true },
        { name: 'ok2', ok: true },
      ]),
    ).not.toThrow()
  })
})

describe('preflight checks', () => {
  it('configCheck reports the canonical hash or every validation error', async () => {
    const good = defaultRunConfig({
      runId: 'preflight-test',
      masterSeed: 'preflight-seed-1',
      tasksRoot: '/tmp/tasks',
      baselineSourceDir: '/tmp/baseline',
      jobsRoot: '/tmp/jobs',
    })
    const ok = await configCheck(good)()
    expect(ok.ok).toBe(true)
    expect(ok.detail).toMatch(/^sha256:[0-9a-f]{64}$/)

    const bad = { ...good, sealedAccess: true }
    const finding = await configCheck(bad)()
    expect(finding.ok).toBe(false)
    expect(finding.detail).toContain('sealedAccess')
  })

  it('credentialChecks stats the file and owner-only mode; content is never read', async () => {
    const root = await scratch('dsh-preflight-cred-')
    const secret = join(root, 'zen.key')
    await writeFile(secret, 'SECRET-CONTENT-NOT-TO-BE-READ\n', { mode: 0o600 })
    const config = defaultRunConfig({
      runId: 'preflight-test',
      masterSeed: 'preflight-seed-1',
      tasksRoot: '/tmp/tasks',
      baselineSourceDir: '/tmp/baseline',
      jobsRoot: '/tmp/jobs',
      overrides: {},
    })
    config.modelRoutes = [
      {
        id: 'zen',
        provider: 'zen-compatible',
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 32_768,
        inputUsdMicrosPerMTok: 140_000,
        outputUsdMicrosPerMTok: 280_000,
        credentialFile: secret,
      },
    ]

    const [finding] = credentialChecks(config).map((check) => check())
    const present = await finding
    expect(present?.ok).toBe(true)
    expect(present?.detail).toBeUndefined() // no content, no digest — nothing read

    // Missing file and loose mode both fail closed.
    const missing = structuredClone(config)
    missing.modelRoutes[0]!.credentialFile = join(root, 'absent.key')
    const [missingFinding] = await Promise.all(credentialChecks(missing).map((c) => c()))
    expect(missingFinding?.ok).toBe(false)
    expect(missingFinding?.detail).toContain('missing')

    await chmod(secret, 0o644)
    const loose = await Promise.all(credentialChecks(config).map((c) => c()))
    expect(loose[0]?.ok).toBe(false)
    expect(loose[0]?.detail).toContain('owner-only')
  })

  it('dockerCheck and harborVersionCheck surface the real cause', async () => {
    const docker = await dockerCheck('/nonexistent/docker-bin')()
    expect(docker.ok).toBe(false)

    const nodeBin = process.execPath
    // `node --version` prints "vX.Y.Z" — expect an exact-match mismatch.
    const version = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim()
    const wrong = await harborVersionCheck(nodeBin, '0.21.0')()
    expect(wrong.ok).toBe(false)
    expect(wrong.detail).toContain(version)
    const right = await harborVersionCheck(nodeBin, version)()
    expect(right.ok).toBe(true)
  })

  it('tasksRootCheck verifies a task.toml per planned handle', async () => {
    const root = await scratch('dsh-preflight-tasks-')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'task-a'), { recursive: true })
    await writeFile(join(root, 'task-a', 'task.toml'), '[task]\n')

    const ok = await tasksRootCheck(root, ['task-a'])()
    expect(ok.ok).toBe(true)
    const missing = await tasksRootCheck(root, ['task-a', 'task-b', 'task-c'])()
    expect(missing.ok).toBe(false)
    expect(missing.detail).toContain('task-b')
  })

  it('baselineSourceCheck and runRootCheck require existing directories', async () => {
    const root = await scratch('dsh-preflight-dirs-')
    expect((await baselineSourceCheck(root)()).ok).toBe(true)
    expect((await baselineSourceCheck(join(root, 'nope'))()).ok).toBe(false)
    expect((await runRootCheck(root)()).ok).toBe(true)
    expect((await runRootCheck(join(root, 'nope'))()).ok).toBe(false)
  })
})
