/**
 * Gate 1 builder CLI: run the trusted admission pipeline over one candidate
 * source directory and print the resulting build manifest.
 *
 * Usage: `node lib/bin/build-candidate.js --source <dir> --work-root <dir> --native-dsh-catalog-root <dir> --native-dsh-closure-sha256 <sha256>`
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
const nativeDshCatalogRoot = argument('native-dsh-catalog-root')
const expectedDependencyClosureSha256 = argument('native-dsh-closure-sha256')
if (
  sourceDir === undefined ||
  workRoot === undefined ||
  nativeDshCatalogRoot === undefined ||
  expectedDependencyClosureSha256 === undefined
) {
  process.stderr.write(
    'usage: build-candidate --source <dir> --work-root <dir> --native-dsh-catalog-root <dir> --native-dsh-closure-sha256 <sha256>\n',
  )
  process.exitCode = 2
} else {
  const result = await buildCandidate({
    sourceDir,
    workRoot,
    nativeDshCatalogRoot,
    expectedDependencyClosureSha256,
  })
  process.stdout.write(`${JSON.stringify(result.manifest, null, 2)}\n`)
  process.exitCode = result.outcome === 'admitted' ? 0 : 1
}
