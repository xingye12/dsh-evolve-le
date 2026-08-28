/**
 * Gate 1 builder CLI: run the trusted admission pipeline over one candidate
 * source directory and print the resulting build manifest.
 *
 * Usage: `node lib/bin/build-candidate.js --source <dir> --work-root <dir>`
 * Exit 0 when admitted, 1 when rejected, 2 on usage error.
 * @module @dsh-evolve-le/core/bin/build-candidate
 */

import { buildCandidate } from '../builder/pipeline.js'

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const sourceDir = argument('source')
const workRoot = argument('work-root')
if (sourceDir === undefined || workRoot === undefined) {
  process.stderr.write('usage: build-candidate --source <dir> --work-root <dir>\n')
  process.exitCode = 2
} else {
  const result = await buildCandidate({ sourceDir, workRoot })
  process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
  process.exitCode = result.outcome === 'admitted' ? 0 : 1
}
