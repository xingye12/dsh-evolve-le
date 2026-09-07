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
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertPreflight,
  baselineSourceCheck,
  configCheck,
  credentialChecks,
  dockerCheck,
  harborVersionCheck,
  nativeDshCatalogCheck,
  proposalWorkerIdentityCheck,
  PreflightError,
  runPreflight,
  runRootCheck,
  searchCalibrationCheck,
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

  it('reports whether the host can actually drop a proposal worker to a non-root uid', async () => {
    const [finding] = await runPreflight([proposalWorkerIdentityCheck()])
    expect(finding?.name).toBe('proposal-worker-identity')
    expect(typeof finding?.ok).toBe('boolean')
    expect(finding?.detail).toMatch(/setpriv|uid/i)
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

  it('nativeDshCatalogCheck fails closed before launch when no native runtime lock exists', async () => {
    const config = defaultRunConfig({
      runId: 'preflight-native-lock',
      masterSeed: 'preflight-native-lock-seed',
      tasksRoot: '/tmp/tasks',
      baselineSourceDir: '/tmp/baseline',
      jobsRoot: '/tmp/jobs',
    })
    const finding = await nativeDshCatalogCheck(config)()
    expect(finding).toEqual({
      name: 'native-dsh-catalog',
      ok: false,
      detail: 'nativeDsh catalogRoot and dependencyClosureSha256 are required',
    })
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
    // Avoid synchronous child creation: this host's seccomp profile rejects
    // spawnSync even though the async preflight check remains available.
    const version = `v${process.versions.node}`
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

// ---------------------------------------------------------------------------
// Search calibration (specs/03 §2, ADR-042)
// ---------------------------------------------------------------------------

describe('search calibration preflight (specs/03 §2, ADR-042)', () => {
  const HANDLES = Array.from(
    { length: 89 },
    (_unused, index) => `task-${String(index + 1).padStart(3, '0')}`,
  )

  function calibrationConfig(
    overrides: Record<string, number> = {},
  ): ReturnType<typeof defaultRunConfig> {
    return defaultRunConfig({
      runId: 'calibration-unit',
      masterSeed: 'calibration-unit-seed-0',
      tasksRoot: '/tmp/dsh-tasks',
      baselineSourceDir: '/repo/packages/candidate-baseline',
      jobsRoot: '/tmp/dsh-jobs',
      overrides,
    })
  }

  it('accepts the stable-demo envelope (minimum 9 inside 15)', async () => {
    const finding = await searchCalibrationCheck(calibrationConfig(), HANDLES)()
    expect(finding.ok).toBe(true)
    expect(finding.detail).toContain('minimumTrials=9')
  })

  it('accepts K=10 with the pre-registered 24×1 benchmark baseline', async () => {
    const config = calibrationConfig({
      kTarget: 10,
      maxSolverTrials: 60,
      baselineTaskCount: 24,
      baselineAttemptsPerTask: 1,
      baselineBatchSize: 6,
    })
    const finding = await searchCalibrationCheck(config, HANDLES)()
    expect(finding.ok).toBe(true)
    expect(finding.detail).toContain('minimumTrials=49')
    expect(finding.detail).toContain('matrix=24')
  })

  it('returns a finding (never throws) for the 89→72 live population (attempt-2 regression)', async () => {
    // The live tasks root carries the frozen ≤1800s exclusion: 72 handles.
    // The default 89-slot split would throw "cannot fill 89 slots" inside the
    // check and surface as a preflight-internal failure — attempt 2 died on
    // exactly this before any paid trial. The check must scale its ceremony
    // to the actual population and report normally.
    const liveHandles = Array.from(
      { length: 72 },
      (_unused, index) => `live-${String(index + 1).padStart(3, '0')}`,
    )
    const config = calibrationConfig({
      kTarget: 10,
      maxSolverTrials: 60,
      baselineTaskCount: 24,
      baselineAttemptsPerTask: 1,
      baselineBatchSize: 6,
    })
    const finding = await searchCalibrationCheck(config, liveHandles)()
    expect(finding.ok).toBe(true)
    expect(finding.detail).toContain('minimumTrials=49')
    expect(finding.detail).toContain('matrix=24')
  })

  it('bounds the matrix by the development split (observed+guard, ADR-046): 49 for 72 handles', async () => {
    const liveHandles = Array.from(
      { length: 72 },
      (_unused, index) => `live-${String(index + 1).padStart(3, '0')}`,
    )
    const base = {
      kTarget: 10,
      maxSolverTrials: 60,
      baselineAttemptsPerTask: 1,
      baselineBatchSize: 6,
    }
    // 49 = 39 observed + 10 guard: the full development split is legal.
    const legal = await searchCalibrationCheck(
      calibrationConfig({ ...base, baselineTaskCount: 49 }),
      liveHandles,
    )()
    expect(legal.ok).toBe(true)
    expect(legal.detail).toContain('matrix=49')
    // 50 = 39 observed + 11 guard: one task beyond the development split.
    const overflow = await searchCalibrationCheck(
      calibrationConfig({ ...base, baselineTaskCount: 50 }),
      liveHandles,
    )()
    expect(overflow.ok).toBe(false)
    expect(overflow.detail).toContain('exceeds the development split (49 handles)')
  })

  it('accepts the ADR-045 k80 envelope against the 72-handle live population', async () => {
    // ADR-045: alpha=0.8 → finalGate 240 → minimumTrials 255 inside the
    // amended 400-trial envelope; the 39×2 matrix sits at the observed split
    // (39 observed, inside the ADR-046 development bound of 49).
    const liveHandles = Array.from(
      { length: 72 },
      (_unused, index) => `live-${String(index + 1).padStart(3, '0')}`,
    )
    const config = calibrationConfig({
      kTarget: 80,
      coldStartTrials: 3,
      shortlistSize: 5,
      ucbAirAlphaPerMille: 800,
      maxSolverTrials: 400,
      taskTrials: 400,
      baselineTaskCount: 39,
      baselineAttemptsPerTask: 2,
      baselineBatchSize: 8,
    })
    const finding = await searchCalibrationCheck(config, liveHandles)()
    expect(finding.ok).toBe(true)
    expect(finding.detail).toContain('minimumTrials=255')
    expect(finding.detail).toContain('matrix=78')
  })

  it('still REJECTS the k80 envelope at the frozen 0.6 alpha even inside 400 trials', async () => {
    // The specs/03 §2 mandate shape stays contract-tested: at alpha=0.6 the
    // final gate alone needs N ≥ ceil(80^(5/3))=1486, which no amended solver
    // cap can afford — the reason ADR-045 pre-registers 0.8 for the formal
    // profile instead of silently resizing around the gate.
    const config = calibrationConfig({
      kTarget: 80,
      coldStartTrials: 3,
      shortlistSize: 5,
      maxSolverTrials: 400,
      taskTrials: 400,
    })
    const finding = await searchCalibrationCheck(config, HANDLES)()
    expect(finding.ok).toBe(false)
    expect(finding.detail).toContain('minimumTrials=1501')
    expect(finding.detail).toContain('exceeds maxSolverTrials=400')
  })

  it('rejects a benchmark baseline larger than the development split', async () => {
    const config = calibrationConfig({
      kTarget: 10,
      maxSolverTrials: 60,
      baselineTaskCount: 61, // development split is 60 = 48 observed + 12 guard for the pinned population
      baselineAttemptsPerTask: 1,
      baselineBatchSize: 6,
    })
    const finding = await searchCalibrationCheck(config, HANDLES)()
    expect(finding.ok).toBe(false)
    expect(finding.detail).toContain('exceeds the development split (60 handles)')
  })
})
