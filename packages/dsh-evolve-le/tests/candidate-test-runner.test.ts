/**
 * Candidate-test runner contract tests (ADR-038/ADR-039). The runner stages
 * the merged parent+child view, validates the child manifest with the SAME
 * schema the controller's admission gate applies, and — for tree-v2 children
 * with a staged parent view — mounts BOTH trees through the SDK testkit and
 * compares the mounted surfaces per the declared modeContract, all before the
 * real vitest suite runs. Every candidate-authored file is executed only in
 * `runSandboxed` subprocesses.
 *
 * The fixtures replay the attempt-12 failure classes:
 *  - prop-1: an empty modeComponents array passed the ADR-037 projection
 *    vacuously and died at admission (now a verbatim schema rejection);
 *  - prop-3: content-only evolution left the name-only runtime fingerprint
 *    untouched (now a mounted-surface compare with section TEXT).
 *
 * The parent fixture is the shared bootable two-mode tree-v2 migration root
 * (tests/helpers/tree-v2-runner-fixture.ts). The dependency root is a temp
 * merge: the repo root's node_modules (vitest for spec resolution) plus the
 * baseline package's @-scopes (the workspace packages are not hoisted).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runCandidateTestSuite } from '../src/builder/candidate-test-runner.js'
import {
  CHILD_STRATEGY,
  TARGET_BOTH,
  buildDependencyRoot,
  candidateJson,
  childFiles,
  parentFiles,
} from './helpers/tree-v2-runner-fixture.js'

const roots: string[] = []
async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

/**
 * The staged trees import 'vitest' and the workspace SDK packages; the dep
 * root merges the repo root's node_modules with the baseline package's
 * @-scopes (see buildDependencyRoot). Built once per suite.
 */
let dependencyRootPromise: Promise<string> | undefined
async function dependencyRoot(): Promise<string> {
  dependencyRootPromise ??= (async () => {
    const root = await freshRoot('dsh-runner-deps-')
    await buildDependencyRoot(root)
    return root
  })()
  return dependencyRootPromise
}

describe('candidate-test runner (ADR-038/ADR-039)', () => {
  it('rejects an empty modeComponents array with the verbatim schema error (attempt-12 prop-1)', async () => {
    const invalid = candidateJson(TARGET_BOTH, {
      solve: ['src/index.ts', 'src/strategy.ts'],
      propose: [],
    })
    const run = await runCandidateTestSuite({
      childName: 'child-1',
      files: childFiles({ candidateJson: invalid }),
      dependencyRoot: await dependencyRoot(),
      parentFiles: parentFiles(),
    })
    expect(run.ok).toBe(false)
    expect(run.output).toMatch(/candidate manifest rejected the child:/)
    expect(run.output).toMatch(/\/modeComponents\/propose: must NOT have fewer than 1 items/)
  })

  it('rejects an unparseable candidate.json', async () => {
    const run = await runCandidateTestSuite({
      childName: 'child-1',
      files: childFiles({ candidateJson: '{ not json' }),
      dependencyRoot: await dependencyRoot(),
      parentFiles: parentFiles(),
    })
    expect(run.ok).toBe(false)
    expect(run.output).toMatch(/candidate\.json unparseable/)
  })

  it('rejects a target mode whose mounted surface is identical to the parent (attempt-12 prop-3)', async () => {
    // Child files byte-identical to the parent: both modes are target, and
    // neither mounted surface changed.
    const run = await runCandidateTestSuite({
      childName: 'child-1',
      files: childFiles({}),
      dependencyRoot: await dependencyRoot(),
      parentFiles: parentFiles(),
    })
    expect(run.ok).toBe(false)
    expect(run.output).toMatch(/tree-v2 target mode solve mounted surface did not change/)
    expect(run.output).toMatch(/prompt section's text/)
  })

  it('rejects a preserved mode whose mounted surface changed', async () => {
    const preservedContract = { targetModes: ['solve'], preservedModes: ['propose'] }
    const run = await runCandidateTestSuite({
      childName: 'child-1',
      files: childFiles({
        candidateJson: candidateJson(preservedContract),
        strategy: CHILD_STRATEGY,
      }),
      dependencyRoot: await dependencyRoot(),
      parentFiles: parentFiles({ candidateJson: candidateJson(preservedContract) }),
    })
    expect(run.ok).toBe(false)
    expect(run.output).toMatch(/tree-v2 preserved mode propose mounted surface changed/)
  })

  it('passes a compliant child that folds directives into both target-mode sections, then runs the real suite', async () => {
    const run = await runCandidateTestSuite({
      childName: 'child-1',
      files: childFiles({ strategy: CHILD_STRATEGY }),
      dependencyRoot: await dependencyRoot(),
      parentFiles: parentFiles(),
    })
    expect(run.ok, run.output).toBe(true)
    expect(run.output).toMatch(/oxlint clean; candidate tests passed/)
  })
})
