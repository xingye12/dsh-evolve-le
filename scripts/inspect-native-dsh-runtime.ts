/**
 * Inspect a prebuilt DeepSeek Harness checkout as the native DSH runtime
 * catalog used by candidate capsules.
 *
 * Usage:
 *   pnpm native-dsh:inspect --catalog-root /absolute/path/to/deepseek-harness
 *
 * The output is the exact lock fragment accepted by `dsh-evolve init`. The
 * catalog itself remains outside this repository's editable package surface.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectNativeDshRuntime } from '../packages/dsh-evolve-le/src/builder/staging.ts'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const catalogRoot = argument('--catalog-root')
const outputPath = argument('--output')

if (catalogRoot === undefined) {
  process.stderr.write('usage: pnpm native-dsh:inspect --catalog-root DIR [--output FILE]\n')
  process.exitCode = 2
} else {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-runtime-inspect-'))
  try {
    const runtime = await inspectNativeDshRuntime(resolve(catalogRoot), scratch)
    const lock = {
      catalogRoot: runtime.catalogRoot,
      dependencyClosureSha256: runtime.dependencyClosureSha256,
      packages: runtime.packages,
      fileCount: runtime.fileCount,
    }
    const text = `${JSON.stringify(lock, null, 2)}\n`
    if (outputPath !== undefined) {
      await writeFile(resolve(outputPath), text, 'utf8')
    }
    process.stdout.write(text)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
