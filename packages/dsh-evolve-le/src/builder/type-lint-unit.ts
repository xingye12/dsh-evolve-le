/**
 * The stage-6 typeLintUnit toolchain, extracted (ADR-038) so the builder
 * pipeline and the proposal-gateway `candidate-tests` handler run the SAME
 * checks — the boundary check at `proposal_finish` must predict the
 * controller gate it mirrors. Everything here executes candidate-authored
 * code only through `runSandboxed` subprocesses, never in-process.
 * @module @dsh-evolve-le/core/builder/type-lint-unit
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from '../schema.js'
import { runSandboxed, type SandboxedRun } from './sandbox.js'

/**
 * Write the builder-generated vitest.config.mjs and tsconfig.json into the
 * staged tree. The candidate's own tsconfig.json is identity material only
 * (specs/02 §11): the working copy is replaced with a self-contained
 * builder-generated config so no tool ever executes proposer-authored
 * compiler options. The canonical bytes are unaffected — they were captured
 * in stage 1.
 */
export async function writeTypeLintUnitConfigs(treeDir: string): Promise<void> {
  await writeFile(
    join(treeDir, 'vitest.config.mjs'),
    `export default ${JSON.stringify({
      cache: false,
      test: {
        environment: 'node',
        include: ['tests/**/*.spec.ts'],
        testTimeout: 30000,
        fileParallelism: false,
      },
    })}\n`,
    'utf8',
  )
  await writeFile(
    join(treeDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'es2023',
          lib: ['es2023'],
          types: [],
          strict: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['src', 'tests'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

export function oxlintCli(): string {
  return join(repoRoot, 'node_modules/oxlint/bin/oxlint')
}

/**
 * Lint targets for the staged tree: only the candidate's own code — never
 * the TCB-assembled dependency closure.
 */
export function typeLintUnitLintTargets(treeDir: string, hasTests: boolean): string[] {
  return [join(treeDir, 'src'), ...(hasTests ? [join(treeDir, 'tests')] : [])]
}

/**
 * oxlint over the staged tree. The CLI ships a Node script; it runs by
 * absolute interpreter path so the sandbox's stripped PATH cannot break
 * resolution.
 */
export function runOxlint(treeDir: string, hasTests: boolean): Promise<SandboxedRun> {
  return runSandboxed(process.execPath, [oxlintCli(), ...typeLintUnitLintTargets(treeDir, hasTests)], {
    cwd: repoRoot,
    timeoutMs: 60_000,
  })
}

/**
 * Run the candidate-owned tests from the frozen staging tree via the repo's
 * vitest. Returns the failure output on a non-zero exit, undefined on pass.
 */
export async function runCandidateTests(
  workRoot: string,
  treeDir: string,
): Promise<string | undefined> {
  await writeTypeLintUnitConfigs(treeDir)
  const vitestBin = join(repoRoot, 'node_modules/vitest/vitest.mjs')
  const run = await runSandboxed(process.execPath, [vitestBin, 'run', '--root', treeDir], {
    cwd: workRoot,
    timeoutMs: 180_000,
  })
  if (run.code === 0) return undefined
  return `${run.stdout.trim()}\n${run.stderr.trim()}`.slice(0, 2000)
}
