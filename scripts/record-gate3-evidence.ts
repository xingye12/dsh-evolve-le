/**
 * Record the Gate 3 fault-matrix evidence: run the full crash-boundary matrix
 * (SIGKILL a real controller child at every durable saga boundary, resume in
 * a fresh process, verify no duplicate external effect / score / cost and a
 * single converged state hash) and write the machine-checkable document to
 * `evidence/gate3/fault-matrix.json`. This is the auditable artifact backing
 * the Gate 3 acceptance claims in `PROJECT_STATUS.md`; it fails closed
 * (exit 1) when any case does not converge.
 * @module scripts/record-gate3-evidence
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

const libDir = resolve(repoRoot, 'packages/dsh-evolve-le/lib')
const binPath = resolve(libDir, 'bin/fault-child.js')
if (!existsSync(binPath)) {
  throw new Error(`fault-child bin missing: run \`pnpm build\` first (${binPath})`)
}
const fromLib = (module: string) => import(pathToFileURL(resolve(libDir, module)).href)
const { runFaultMatrix } = await fromLib('controller/fault-matrix.js')

const matrix = await runFaultMatrix(binPath)

const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
const acceptance = {
  everyBoundaryKilledThenResumed: matrix.cases
    .filter((one) => one.boundary !== null)
    .every((one) => one.killed.length > 0 && one.killed.every(Boolean) && one.passed),
  noDuplicateExternalEffect: matrix.cases.every((one) => !one.duplicateLaunchEffect),
  noDuplicateScore: matrix.cases.every((one) => !one.duplicateScore),
  noDuplicateCost: matrix.cases.every((one) => one.passed),
  singleConvergedStateHash: matrix.convergedStateHash,
  allPassed: matrix.allPassed,
}

const document = {
  gate: 'gate3',
  kind: 'fault-matrix',
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    repositoryHead: head.stdout.trim(),
  },
  protocol: {
    child: 'packages/dsh-evolve-le/lib/bin/fault-child.js (real controller process)',
    kill: 'SIGKILL at the first occurrence of the named boundary',
    world: 'wave w1 with 3 evaluation actions; a2 scripted timeout (unpriced usage)',
    expectation: {
      launchEffects: 'exactly 3, distinct (no duplicate external effect)',
      observations: 'exactly 3 trial identities (no duplicate score)',
      usd: { reserved: 0, spent: 200, unpriced: 1 },
      taskTrials: { reserved: 0, spent: 3, unpriced: 0 },
      stateHash: 'identical across every boundary case and the clean baseline',
    },
  },
  acceptance,
  matrix,
  // Additional fail-closed coverage lives in the vitest suites referenced
  // here (torn writes, corrupt journal/object/snapshot, budget invariants,
  // permutation invariance, seeded crash-chain property).
  coveredBySuites: [
    'packages/dsh-evolve-le/tests/state/journal.test.ts',
    'packages/dsh-evolve-le/tests/state/object-store.test.ts',
    'packages/dsh-evolve-le/tests/state/snapshot.test.ts',
    'packages/dsh-evolve-le/tests/state/budget.test.ts',
    'packages/dsh-evolve-le/tests/state/reducer.test.ts',
    'packages/dsh-evolve-le/tests/controller/controller.test.ts',
    'packages/dsh-evolve-le/tests/controller/property.test.ts',
    'packages/dsh-evolve-le/tests/fault/crash-matrix.subprocess.test.ts',
    'packages/dsh-evolve-le/tests/service/controller-service.subprocess.test.ts',
  ],
}

const outDir = resolve(repoRoot, 'evidence/gate3')
await mkdir(outDir, { recursive: true })
await writeFile(resolve(outDir, 'fault-matrix.json'), `${JSON.stringify(document, null, 2)}\n`)

if (!acceptance.allPassed) {
  const failed = matrix.cases.filter((one) => !one.passed)
  console.error(
    `gate3 fault matrix FAILED: ${failed.length} case(s) — ${JSON.stringify(
      failed.map((one) => ({ boundary: one.boundary, failures: one.failures })),
    )}`,
  )
  process.exit(1)
}
console.log(
  `gate3 fault matrix: ${matrix.cases.length} cases converged to ${matrix.convergedStateHash}`,
)
