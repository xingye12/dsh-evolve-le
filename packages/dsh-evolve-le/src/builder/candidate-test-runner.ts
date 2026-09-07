/**
 * ADR-038/ADR-039: the real `candidate-tests` runner behind the proposal
 * gateway. Stages a merged parent+child view in a throwaway directory and
 * runs the SAME checks the controller's admission + stage 6 (typeLintUnit)
 * apply — the boundary check at `proposal_finish` must predict the controller
 * gates it mirrors. Everything here executes candidate-authored code only
 * through `runSandboxed` subprocesses, never in-process.
 *
 * ADR-039 extensions over the ADR-038 suite:
 *  - the child's candidate.json is validated with the SAME manifest schema
 *    the controller's `validate.ts` applies (attempt 12 prop-1: empty
 *    modeComponents array passed the boundary and died at admission);
 *  - the mounted surface is compared parent-vs-child through the SDK testkit
 *    (the exact harness pattern the parent baseline spec uses), because the
 *    builder's runtime fingerprint is content-sensitive (attempt 12 prop-3:
 *    text-only mechanism edits left the name-only fingerprint untouched).
 *
 * The gateway (`remote-gateway.ts`) verifies the merged view's parent bytes
 * against its staged parent view BEFORE calling this runner; here the files
 * are trusted inputs (relative-safe paths already validated) and the run is
 * purely mechanical.
 * @module @dsh-evolve-le/core/builder/candidate-test-runner
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runCandidateTests, runOxlint, writeTypeLintUnitConfigs } from './type-lint-unit.js'
import { runSandboxed } from './sandbox.js'
import { repoRoot, validateManifest } from '../schema.js'

/** Reply output cap, mirrored by the gateway's truncation. */
export const CANDIDATE_TEST_OUTPUT_CAP = 2000

/** One mounted mode record produced by the surface probe. */
interface SurfaceRecord {
  ok: boolean
  error?: string
  sections?: { name: string; order: number; text: string }[]
  tools?: string[]
  skills?: string[]
}

const ANSI_ESCAPE = /\[[0-9;]*m/g

export interface CandidateTestRun {
  ok: boolean
  output: string
}

/**
 * The generated surface-probe spec: mounts the staged tree's `src/index.ts`
 * through the SDK testkit (the same inline `ctx.plugin` pattern the parent
 * baseline spec uses) and writes the per-mode mounted record — section
 * name/order/text plus tool/skill names — to `__surface_out.json` beside the
 * tree. Both the child and the parent staged view run the SAME spec, so the
 * records are comparable apples-to-apples (fixed probe config, same
 * node_modules closure).
 */
const SURFACE_PROBE_SPEC = `import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'vitest'
import { createHarness } from '@dsh-evolve-le/candidate-sdk/testkit'
import { apply } from '../src/index.js'

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', '__surface_out.json')

test('surface probe', () => {
  const record: Record<string, unknown> = {}
  for (const mode of ['solve', 'propose'] as const) {
    const harness = createHarness()
    const ctx = harness.ctx as unknown as {
      plugin: (plugin: (c: unknown, cfg: unknown) => void, config: unknown) => void
    }
    ctx.plugin = (plugin, config) => {
      plugin(harness.ctx, config)
    }
    try {
      apply(harness.ctx as never, { candidateId: 'c_probe000000000000000000000000000', mode })
      record[mode] = {
        ok: true,
        sections: harness.sections(),
        tools: harness.tools().map((tool) => tool.name).sort(),
        skills: harness.skills().map((skill) => skill.name).sort(),
      }
    } catch (error) {
      record[mode] = {
        ok: false,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      }
    }
  }
  writeFileSync(outPath, JSON.stringify(record, null, 2))
})
`

const SURFACE_PROBE_REL = 'tests/__surface_probe.spec.ts'
const SURFACE_PROBE_OUT = '__surface_out.json'

/** Run the candidate-owned tests from a staged tree via the repo's vitest. */
export async function runCandidateTestSuite(options: {
  childName: string
  files: Record<string, string>
  /**
   * A capsule directory whose `node_modules/` is symlinked into the staged
   * tree: the merged view carries only source files, and the child's
   * dependency closure is by contract the parent's (package.json is fixed),
   * so the parent capsule's closure is the test run's closure — the same
   * TCB-assembled node_modules the builder's stage 5 uses.
   */
  dependencyRoot?: string
  /**
   * ADR-039: the staged parent source view (parentSourceFiles). Present on
   * live routes; when given, the runner also mounts the parent the same way
   * and compares mounted surfaces per the child's declared modeContract.
   */
  parentFiles?: Record<string, string>
}): Promise<CandidateTestRun> {
  const stageRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-tests-'))
  try {
    const treeDir = join(stageRoot, 'tree')
    for (const [rel, content] of Object.entries(options.files)) {
      const target = join(treeDir, rel)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    if (options.dependencyRoot !== undefined) {
      await symlink(join(options.dependencyRoot, 'node_modules'), join(treeDir, 'node_modules'))
    }

    // --- manifest schema (ADR-039, attempt-12 prop-1) ----------------------
    // The controller's validate.ts runs the full candidate schema; an empty
    // modeComponents array passed the ADR-037 projection vacuously and died
    // at admission. Same check, same wording, at the boundary.
    const manifest = options.files['candidate.json']
    let parsedManifest: Record<string, unknown> | undefined
    if (manifest !== undefined) {
      try {
        parsedManifest = JSON.parse(manifest) as Record<string, unknown>
      } catch (error) {
        return {
          ok: false,
          output: `candidate.json unparseable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
      const result = validateManifest('candidate', parsedManifest)
      if (!result.ok) {
        return {
          ok: false,
          output: `candidate manifest rejected the child: ${result.error.errors
            .slice(0, 3)
            .join('; ')}`,
        }
      }
    }

    const hasTests = Object.keys(options.files).some((path) => path.startsWith('tests/'))
    const lint = await runOxlint(treeDir, hasTests)
    if (lint.code !== 0) {
      return {
        ok: false,
        output: stripAnsi(`oxlint failed (exit ${String(lint.code)}): ${lint.stdout.trim()}`).slice(
          0,
          CANDIDATE_TEST_OUTPUT_CAP,
        ),
      }
    }

    // --- mounted-surface compare (ADR-039, attempt-12 prop-3) --------------
    if (options.parentFiles !== undefined && parsedManifest?.schemaVersion === 2) {
      const surfaceFailure = await compareMountedSurfaces({
        childIntent: parsedManifest,
        parentFiles: options.parentFiles,
        dependencyRoot: options.dependencyRoot,
        treeDir,
      })
      if (surfaceFailure !== undefined) {
        return { ok: false, output: surfaceFailure.slice(0, CANDIDATE_TEST_OUTPUT_CAP) }
      }
    }

    const vitest = await runCandidateTests(stageRoot, treeDir)
    if (vitest !== undefined) {
      return { ok: false, output: stripAnsi(vitest).slice(0, CANDIDATE_TEST_OUTPUT_CAP) }
    }
    return { ok: true, output: 'oxlint clean; candidate tests passed' }
  } finally {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The surface probe result keyed by side ('child' | 'parent'). */
type Side = 'child' | 'parent'

/**
 * Mount both views through the SDK testkit and compare per the child's
 * declared modeContract. Returns the failure text, undefined when the
 * contract holds. The real Loader probe at mockReplay stays authoritative;
 * this predictor exercises the same `candidate.register` path via the SDK
 * testkit the parent baseline spec uses.
 */
async function compareMountedSurfaces(options: {
  childIntent: Record<string, unknown>
  parentFiles: Record<string, string>
  dependencyRoot: string | undefined
  treeDir: string
}): Promise<string | undefined> {
  const modeContract = (
    options.childIntent as { modeContract?: { targetModes?: string[]; preservedModes?: string[] } }
  ).modeContract
  if (modeContract === undefined) return undefined
  const targetModes = modeContract.targetModes ?? []
  const preservedModes = modeContract.preservedModes ?? []
  const childRecord = await surfaceProbe(options.treeDir, 'child')
  const parentRecord = await surfaceProbeForParent(options)
  if (childRecord === undefined || parentRecord === undefined) {
    return `tree-v2 surface probe failed: the mounted surface of ${
      childRecord === undefined ? 'the child' : 'the parent'
    } could not be measured`
  }
  const modeLabel = (mode: string): string =>
    mode === 'solve' ? 'solve' : mode === 'propose' ? 'propose' : String(mode)
  for (const mode of targetModes) {
    const child = childRecord[mode]
    const parent = parentRecord[mode]
    if (child === undefined || parent === undefined) {
      return `tree-v2 target mode ${modeLabel(mode)} surface probe produced no record`
    }
    if (!child.ok || !parent.ok) {
      return `tree-v2 surface probe could not mount ${
        !child.ok ? 'the child' : 'the parent'
      } in ${modeLabel(mode)} mode: ${String((!child.ok ? child : parent).error ?? 'unknown error')}`
    }
    if (JSON.stringify(child) === JSON.stringify(parent)) {
      return `tree-v2 target mode ${modeLabel(mode)} mounted surface did not change (sections/tools/skills identical to the parent) — make the ${modeLabel(
        mode,
      )} surface observably different, e.g. fold a ${modeLabel(
        mode,
      )}-specific directive into the ${modeLabel(mode)} prompt section's text`
    }
  }
  for (const mode of preservedModes) {
    const child = childRecord[mode]
    const parent = parentRecord[mode]
    if (child === undefined || parent === undefined) {
      return `tree-v2 preserved mode ${modeLabel(mode)} surface probe produced no record`
    }
    if (!child.ok || !parent.ok) {
      return `tree-v2 surface probe could not mount ${
        !child.ok ? 'the child' : 'the parent'
      } in ${modeLabel(mode)} mode: ${String((!child.ok ? child : parent).error ?? 'unknown error')}`
    }
    if (JSON.stringify(child) !== JSON.stringify(parent)) {
      return `tree-v2 preserved mode ${modeLabel(
        mode,
      )} mounted surface changed — keep it identical to the parent's or declare it a target mode`
    }
  }
  return undefined
}

/** Run the probe spec over a staged tree; returns the per-mode records. */
async function surfaceProbe(treeDir: string, side: Side): Promise<Record<string, SurfaceRecord> | undefined> {
  await writeTypeLintUnitConfigs(treeDir)
  await writeFile(join(treeDir, SURFACE_PROBE_REL), SURFACE_PROBE_SPEC, 'utf8')
  const vitestBin = join(repoRoot, 'node_modules/vitest/vitest.mjs')
  const run = await runSandboxed(process.execPath, [vitestBin, 'run', '--root', treeDir, SURFACE_PROBE_REL], {
    cwd: treeDir,
    timeoutMs: 60_000,
  })
  if (run.code !== 0) {
    // The probe spec itself must always pass; a non-zero exit means the
    // mount threw or the spec is broken — report it as an unmountable side.
    return undefined
  }
  try {
    return JSON.parse(await readFile(join(treeDir, SURFACE_PROBE_OUT), 'utf8')) as Record<
      string,
      SurfaceRecord
    >
  } catch {
    return undefined
  }
}

/** Stage the parent view in its own throwaway tree and run the same probe. */
async function surfaceProbeForParent(options: {
  parentFiles: Record<string, string>
  dependencyRoot: string | undefined
}): Promise<Record<string, SurfaceRecord> | undefined> {
  const parentRoot = await mkdtemp(join(tmpdir(), 'dsh-candidate-tests-parent-'))
  try {
    const treeDir = join(parentRoot, 'tree')
    for (const [rel, content] of Object.entries(options.parentFiles)) {
      const target = join(treeDir, rel)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, content, 'utf8')
    }
    if (options.dependencyRoot !== undefined) {
      await symlink(join(options.dependencyRoot, 'node_modules'), join(treeDir, 'node_modules'))
    }
    return await surfaceProbe(treeDir, 'parent')
  } finally {
    await rm(parentRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '')
}
