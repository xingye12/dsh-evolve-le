/**
 * Reproducible compile stage (specs/02 §11 step 5): the trusted builder —
 * never the candidate — generates the effective TypeScript config, compiles
 * the staged source twice inside the offline sandbox, and requires both
 * outputs to be byte-identical. The candidate's own tsconfig.json is identity
 * material only and is never handed to the compiler.
 * @module @dsh-evolve-le/core/builder/compile
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runSandboxed } from './sandbox.js'

/** The builder-generated compile config; deterministic and TCB-owned. */
export function generatedTsConfig(): Record<string, unknown> {
  return {
    compilerOptions: {
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2023',
      lib: ['es2023'],
      types: [],
      strict: true,
      verbatimModuleSyntax: true,
      declaration: true,
      sourceMap: false,
      incremental: false,
      skipLibCheck: true,
      rootDir: 'tree/src',
      outDir: 'compile-1',
    },
    include: ['tree/src'],
  }
}

export interface CompileOutputs {
  /** sha256 over sorted `path\0fileSha256\n` records of the emitted tree. */
  fingerprint: string
  files: { path: string; sha256: string }[]
}

async function hashTree(root: string, prefix = ''): Promise<{ path: string; sha256: string }[]> {
  const out: { path: string; sha256: string }[] = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...(await hashTree(root, rel)))
    } else if (entry.isFile()) {
      const content = await readFile(join(root, rel))
      out.push({ path: rel, sha256: createHash('sha256').update(content).digest('hex') })
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export interface DoubleCompileResult {
  ok: boolean
  detail: string
  outputs?: CompileOutputs
  tsconfigSha256: string
}

/**
 * Compile `tree/src` twice into `compile-1` and `compile-2` under `workRoot`.
 * Both runs use the same generated config; divergence in any emitted byte
 * fails the stage with the differing paths listed.
 */
export async function doubleCompile(options: {
  workRoot: string
  tscBin: string
  timeoutMs: number
}): Promise<DoubleCompileResult> {
  const config = generatedTsConfig()
  const configText = `${JSON.stringify(config, null, 2)}\n`
  const tsconfigPath = join(options.workRoot, 'tsconfig.build.json')
  await writeFile(tsconfigPath, configText, 'utf8')
  const tsconfigSha256 = createHash('sha256').update(configText).digest('hex')

  const results: CompileOutputs[] = []
  for (const outDir of ['compile-1', 'compile-2']) {
    const run = await runSandboxed(
      process.execPath,
      [options.tscBin, '-p', 'tsconfig.build.json', '--outDir', outDir],
      { cwd: options.workRoot, timeoutMs: options.timeoutMs },
    )
    if (run.timedOut) {
      return {
        ok: false,
        detail: `tsc timed out after ${options.timeoutMs}ms writing ${outDir}`,
        tsconfigSha256,
      }
    }
    if (run.code !== 0) {
      return {
        ok: false,
        detail: `tsc failed for ${outDir} (exit ${run.code}): ${run.stderr.trim().slice(0, 2000)}`,
        tsconfigSha256,
      }
    }
    const files = await hashTree(join(options.workRoot, outDir))
    const fingerprint = createHash('sha256')
    for (const file of files) fingerprint.update(`${file.path}\0${file.sha256}\n`)
    results.push({ fingerprint: fingerprint.digest('hex'), files })
  }

  if (results[0]!.fingerprint !== results[1]!.fingerprint) {
    const first = new Map(results[0]!.files.map((file) => [file.path, file.sha256]))
    const differing = results[1]!.files
      .filter((file) => first.get(file.path) !== file.sha256)
      .map((file) => file.path)
    return {
      ok: false,
      detail: `compile outputs diverge between the two runs: ${differing.slice(0, 10).join(', ')}`,
      tsconfigSha256,
    }
  }
  return {
    ok: true,
    detail: `two sandboxed tsc runs produced identical output (${results[0]!.files.length} files)`,
    outputs: results[0]!,
    tsconfigSha256,
  }
}
