/**
 * TCB bundle finalization contract tests (ADR-034). The fixtures replay the
 * attempt-7 failure classes: fabricated receipt digests, an intent authored
 * by a model that cannot compute canonical sha256, and donor/evidence fields
 * the controller must reject. Finalization derives every digest from the
 * model's semantic fields against the trusted export manifest and archive
 * catalog; the controller-side verifiers (verifyTreeV2Receipt,
 * validateTreeV2, parseProposalOutput) must accept the result.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  finalizeTreeV2Bundle,
  TreeV2FinalizationError,
  type FinalizeTreeV2BundleOptions,
} from '../../src/tree-v2/finalize-bundle.js'
import {
  TREE_V2_PROTOCOL,
  verifyTreeV2Receipt,
  type TreeV2CandidateIntent,
  type TreeV2Receipt,
} from '../../src/tree-v2/contract.js'
import type {
  TreeV2AnalysisReceipt,
  TreeV2ProposalReceipt,
} from '../../src/tree-v2/receipts.js'
import { parseProposalOutput, type ProposalOutput } from '../../src/proposer/protocol.js'
import { validateTreeV2 } from '../../src/schema.js'
import type { ArchiveCatalog } from '../../src/proposer/catalog.js'
import type { ExportManifest } from '../../src/proposer/export.js'

const roots: string[] = []
async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

const PARENT_CANDIDATE_DIGEST = `sha256:${'1'.repeat(64)}`
const MECHANISM_OUTCOME_DIGEST = `sha256:${'2'.repeat(64)}`
const NORMALIZED_TRIAL_DIGEST = `sha256:${'3'.repeat(64)}`
const TRAJECTORY_DIGEST = `sha256:${'4'.repeat(64)}`
const DONOR_ID = 'cand-tree-v2-baseline'
const FABRICATED_DIGEST = `sha256:${'f'.repeat(64)}`

function exportManifestFixture(): ExportManifest {
  return {
    schemaVersion: 1,
    exportVersion: 'dsh-evolve-le/evidence-export/v1',
    exportId: 'exp_finalize_fixture',
    principal: 'proposer:test',
    purpose: 'candidate-expansion',
    allowedLabels: ['DEV_OBSERVED', 'PUBLIC_SPEC'],
    objects: [
      {
        digest: NORMALIZED_TRIAL_DIGEST.slice('sha256:'.length),
        size: 10,
        mediaType: 'application/vnd.dsh-evolve-le.normalized-trial+json',
        label: 'DEV_OBSERVED',
        path: `objects/${NORMALIZED_TRIAL_DIGEST.slice('sha256:'.length)}`,
      },
      {
        digest: TRAJECTORY_DIGEST.slice('sha256:'.length),
        size: 10,
        mediaType: 'application/vnd.dsh-evolve-le.trajectory+json',
        label: 'DEV_OBSERVED',
        path: `objects/${TRAJECTORY_DIGEST.slice('sha256:'.length)}`,
      },
    ],
    createdFromStateHash: `sha256:${'5'.repeat(64)}`,
    merkleRoot: `sha256:${'6'.repeat(64)}`,
    canaryAbsence: { checkedObjects: 2, tokenFingerprints: [], result: 'absent' },
  }
}

function catalogFixture(): ArchiveCatalog {
  return {
    schemaVersion: 1,
    catalogVersion: 'dsh-evolve-le/archive-catalog/v1',
    runId: 'tree-v2-finalize-test',
    entries: [
      {
        candidateId: DONOR_ID,
        sourceHash: `sha256:${'7'.repeat(64)}`,
        parentCandidateId: null,
        proposalActionId: null,
        status: 'admitted',
        tasks: [],
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        guardObservationsExcluded: 0,
      },
    ],
  }
}

/**
 * ADR-037 fixture files: the parent tree owns src/index.ts and src/strategy.ts
 * (matching the live attempt-10 parent, parent-files.json evidence); the child
 * modifies src/index.ts and adds src/hint.ts. modeComponents lists ONLY the
 * parent-owned path — attempt 10 listed the added module and every child died
 * at the controller diffBoundary.
 */
const PARENT_INDEX = `export const parentRoot = true\n`
const CHILD_INDEX = `${PARENT_INDEX}\nexport const childRoot = true\n`
const PARENT_STRATEGY = `export const strategy = 'parent'\n`
const CHILD_STRATEGY = `export const strategy = 'child'\n`
const ADDED_MODULE = `export const addedModule = true\n`
/** ADR-039: the two fixed parent files every child must carry verbatim. */
const PARENT_PACKAGE_JSON = `{ "name": "candidate-tree-v2-test", "private": true }\n`
const PARENT_PATCH_YML = `name: candidate-tree-v2-test\nservices: {}\n`
const FIXED_PARENT_FILES: Record<string, string> = {
  'package.json': PARENT_PACKAGE_JSON,
  'cordis.patch.yml': PARENT_PATCH_YML,
}

/** A model-authored v2 candidate-intent: `$schema` habit, fabricated digest. */
function intentFixture(
  options: {
    modeComponents?: Record<string, string[]>
    modeContract?: { targetModes: string[]; preservedModes: string[] }
  } = {},
): Record<string, unknown> {
  return {
    $schema: 'https://dsh-evolve-le.local/schema/tree-v2/candidate-intent/v2',
    schemaVersion: 2,
    protocol: TREE_V2_PROTOCOL,
    kind: 'candidate-intent',
    candidate: { name: '@dsh-evolve-le/candidate-tree-v2-test-child', version: '1.0.0', entry: 'src/index.ts' },
    parent: { candidateDigest: FABRICATED_DIGEST, sourceDigest: FABRICATED_DIGEST },
    modeContract: options.modeContract ?? { targetModes: ['solve', 'propose'], preservedModes: [] },
    runtime: {
      modeComponents: options.modeComponents ?? {
        solve: ['src/index.ts'],
        propose: ['src/index.ts'],
      },
      modeSurfaces: {
        solve: {
          promptSections: [{ name: 'candidate:hint', order: 120 }],
          newToolNames: [],
          newSkillNames: [],
          agentEventNames: [],
          sessionEventNames: [],
          workflowNames: [],
        },
        propose: {
          promptSections: [{ name: 'candidate:hint', order: 120 }],
          newToolNames: [],
          newSkillNames: [],
          agentEventNames: [],
          sessionEventNames: [],
          workflowNames: [],
        },
      },
      capabilities: ['system-prompt'],
    },
    tests: { command: 'pnpm vitest run tests/', mechanism: ['tests/child.spec.ts'], preservation: ['tests/preserved.spec.ts'] },
    receiptDigest: FABRICATED_DIGEST,
  }
}

/** The raw model bundle: attempt-7-style fabricated digests everywhere. */
function rawBundleFixture(childName: string, donors: string[] = [DONOR_ID]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    protocol: 'dsh-evolve-le/proposal/v2',
    parentSourceHash: PARENT_CANDIDATE_DIGEST,
    children: [
      {
        childName,
        hypothesis: 'emit a hint section from the solve runtime',
        donorCandidates: donors,
        targetFailureModes: ['no-strategy-hint'],
        strategySurfaces: ['system-prompt'],
        analysisReceipt: {
          schemaVersion: 2,
          protocol: TREE_V2_PROTOCOL,
          kind: 'analysis',
          parentCandidateDigest: PARENT_CANDIDATE_DIGEST, // attempt-7: copied parent digest
          findings: ['missing hint strategy'],
          evidenceDigests: [NORMALIZED_TRIAL_DIGEST, TRAJECTORY_DIGEST],
          receiptDigest: PARENT_CANDIDATE_DIGEST, // fabricated: copy of the parent digest
        },
        proposalReceipt: {
          schemaVersion: 2,
          protocol: TREE_V2_PROTOCOL,
          kind: 'proposal',
          proposalId: childName,
          parentCandidateDigest: PARENT_CANDIDATE_DIGEST,
          analysisDigest: PARENT_CANDIDATE_DIGEST, // fabricated
          candidateIntentDigest: PARENT_CANDIDATE_DIGEST, // fabricated
          modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
          requiredParentEvidence: {
            analysisDigest: PARENT_CANDIDATE_DIGEST, // fabricated
            mechanismOutcomeDigest: MECHANISM_OUTCOME_DIGEST,
            // The one thing a model CAN do (and the prompt now requires):
            // cite exact sha256 refs of objects listed in export/manifest.json.
            normalizedTrialDigest: NORMALIZED_TRIAL_DIGEST,
            trajectoryDigest: TRAJECTORY_DIGEST,
          },
          receiptDigest: `${NORMALIZED_TRIAL_DIGEST}${TRAJECTORY_DIGEST}`, // attempt-7: concatenation
        },
      },
    ],
  }
}

async function stageFixture(
  root: string,
  childName: string,
  rawBundle: Record<string, unknown>,
  extra: {
    intent?: Record<string, unknown>
    childFiles?: Record<string, string>
    parentSourceFiles?: Record<string, string>
    /** Fixed files the child tree deliberately does NOT write (ADR-039). */
    omitFixedFiles?: string[]
  } = {},
) {
  const childrenRoot = join(root, 'work', 'children')
  await mkdir(join(childrenRoot, childName), { recursive: true })
  await writeFile(
    join(childrenRoot, childName, 'candidate.json'),
    `${JSON.stringify(extra.intent ?? intentFixture(), null, 2)}\n`,
    'utf8',
  )
  const childFiles = extra.childFiles ?? {
    'src/index.ts': CHILD_INDEX,
    'src/hint.ts': ADDED_MODULE,
    'tests/child.spec.ts': `it('mechanism', () => {})\n`,
    'tests/preserved.spec.ts': `it('preserved', () => {})\n`,
  }
  // ADR-039: the parent view always carries the two fixed files, and the
  // child tree is merged with them unless the test writes its own (to replay
  // the attempt-12 omission/change failure classes explicitly).
  const parentSourceFiles = {
    ...FIXED_PARENT_FILES,
    ...(extra.parentSourceFiles ?? { 'src/index.ts': PARENT_INDEX, 'src/strategy.ts': PARENT_STRATEGY }),
  }
  const mergedChildFiles = { ...childFiles }
  for (const [path, content] of Object.entries(FIXED_PARENT_FILES)) {
    if (!(path in childFiles) && !(extra.omitFixedFiles ?? []).includes(path)) {
      mergedChildFiles[path] = parentSourceFiles[path] ?? content
    }
  }
  for (const [path, content] of Object.entries(mergedChildFiles)) {
    await mkdir(join(childrenRoot, childName, dirname(path)), { recursive: true })
    await writeFile(join(childrenRoot, childName, path), content, 'utf8')
  }
  const options: FinalizeTreeV2BundleOptions = {
    proposal: rawBundle as unknown as ProposalOutput,
    childrenRoot,
    exportManifest: exportManifestFixture(),
    treeV2Parent: {
      candidateDigest: PARENT_CANDIDATE_DIGEST,
      mechanismOutcomeDigest: MECHANISM_OUTCOME_DIGEST,
    },
    parentSourceHash: PARENT_CANDIDATE_DIGEST,
    catalog: catalogFixture(),
    parentSourceFiles,
  }
  return { options, childrenRoot }
}

describe('finalizeTreeV2Bundle (ADR-034)', () => {
  it('keeps the local protocol constant in sync with the contract', () => {
    // The worker runtime cannot import contract.ts; the literal must match.
    expect(rawBundleFixture('child-1').protocol).toBe('dsh-evolve-le/proposal/v2')
    expect(intentFixture()['protocol']).toBe(TREE_V2_PROTOCOL)
  })

  it('derives every digest from model semantic fields and binds the chain', async () => {
    const root = await freshRoot('dsh-finalize-ok-')
    const { options, childrenRoot } = await stageFixture(root, 'child-1', rawBundleFixture('child-1'))
    const finalized = await finalizeTreeV2Bundle(options)

    // The controller-side verifiers accept the receipts.
    for (const child of finalized.children) {
      verifyTreeV2Receipt(child.analysisReceipt as TreeV2Receipt)
      verifyTreeV2Receipt(child.proposalReceipt as TreeV2Receipt)
      expect(validateTreeV2('analysis', child.analysisReceipt).ok).toBe(true)
      expect(validateTreeV2('proposal', child.proposalReceipt).ok).toBe(true)
    }
    const child = finalized.children[0]!
    const analysis = child.analysisReceipt as TreeV2AnalysisReceipt
    const proposalReceipt = child.proposalReceipt as TreeV2ProposalReceipt

    // The fabricated digests are gone; every binding is derived.
    expect(analysis.receiptDigest).not.toBe(PARENT_CANDIDATE_DIGEST)
    expect(proposalReceipt.receiptDigest).not.toBe(`${NORMALIZED_TRIAL_DIGEST}${TRAJECTORY_DIGEST}`)
    expect(analysis.parentCandidateDigest).toBe(PARENT_CANDIDATE_DIGEST)
    expect(analysis.findings).toEqual(['missing hint strategy'])
    expect(analysis.evidenceDigests).toEqual([NORMALIZED_TRIAL_DIGEST, TRAJECTORY_DIGEST])
    expect(proposalReceipt.analysisDigest).toBe(analysis.receiptDigest)
    expect(proposalReceipt.parentCandidateDigest).toBe(PARENT_CANDIDATE_DIGEST)
    expect(proposalReceipt.requiredParentEvidence).toEqual({
      analysisDigest: analysis.receiptDigest,
      mechanismOutcomeDigest: MECHANISM_OUTCOME_DIGEST,
      normalizedTrialDigest: NORMALIZED_TRIAL_DIGEST,
      trajectoryDigest: TRAJECTORY_DIGEST,
    })
    expect(child.donorCandidates).toEqual([DONOR_ID])

    // The rewritten candidate.json on disk binds parent and evidence.
    const intent = JSON.parse(
      await readFile(join(childrenRoot, 'child-1', 'candidate.json'), 'utf8'),
    ) as TreeV2CandidateIntent
    verifyTreeV2Receipt(intent as unknown as TreeV2Receipt)
    expect(intent.parent).toEqual({
      candidateDigest: PARENT_CANDIDATE_DIGEST,
      sourceDigest: PARENT_CANDIDATE_DIGEST,
    })
    expect(intent.requiredParentEvidence?.analysisDigest).toBe(analysis.receiptDigest)
    expect(proposalReceipt.candidateIntentDigest).toBe(intent.receiptDigest)
    expect(validateTreeV2('candidate-intent', intent).ok).toBe(true)

    // The finalized bundle passes the wire-protocol shape check.
    expect(() => parseProposalOutput(finalized)).not.toThrow()
  })

  it('passes v1 bundles through untouched', async () => {
    const root = await freshRoot('dsh-finalize-v1-')
    const { options } = await stageFixture(root, 'child-1', rawBundleFixture('child-1'))
    const v1 = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/proposal/v1',
      parentSourceHash: `sha256:${'8'.repeat(64)}`,
      children: [
        {
          childName: 'legacy-child',
          hypothesis: 'legacy mechanism hypothesis',
          donorCandidates: [],
          evidenceRefs: ['9'.repeat(64)],
          targetFailureModes: ['legacy-failure'],
        },
      ],
    }
    const result = await finalizeTreeV2Bundle({ ...options, proposal: v1 as unknown as ProposalOutput })
    expect(result).toBe(v1)
  })

  it('rejects a donor that is not in the staged archive catalog', async () => {
    const root = await freshRoot('dsh-finalize-donor-')
    const { options } = await stageFixture(root, 'child-1', rawBundleFixture('child-1', ['@dsh-evolve-le/invented']))
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('not in the archive catalog')
  })

  it('rejects hollow evidence: a named digest the analysis never cited', async () => {
    const root = await freshRoot('dsh-finalize-hollow-')
    const raw = rawBundleFixture('child-1')
    const childRecord = (raw.children as Record<string, unknown>[])[0]!
    const proposalRecord = childRecord['proposalReceipt'] as Record<string, unknown>
    proposalRecord['requiredParentEvidence'] = {
      analysisDigest: PARENT_CANDIDATE_DIGEST,
      mechanismOutcomeDigest: MECHANISM_OUTCOME_DIGEST,
      normalizedTrialDigest: FABRICATED_DIGEST,
      trajectoryDigest: FABRICATED_DIGEST,
    }
    const { options } = await stageFixture(root, 'child-1', raw)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('does not resolve to a normalized-trial')
  })

  it('rejects evidence refs that are not objects of the export', async () => {
    const root = await freshRoot('dsh-finalize-unresolvable-')
    const raw = rawBundleFixture('child-1')
    const childRecord = (raw.children as Record<string, unknown>[])[0]!
    const analysisRecord = childRecord['analysisReceipt'] as Record<string, unknown>
    analysisRecord['evidenceDigests'] = [NORMALIZED_TRIAL_DIGEST, FABRICATED_DIGEST]
    const { options } = await stageFixture(root, 'child-1', raw)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('not an object of the export')
  })

  it('rejects an unsafe child name before it touches the filesystem', async () => {
    const root = await freshRoot('dsh-finalize-name-')
    const raw = rawBundleFixture('../../escape')
    const { options } = await stageFixture(root, 'child-1', raw)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('not a safe directory name')
  })

  it('rejects a v2 bundle without a staged catalog-capable parent (missing child file)', async () => {
    const root = await freshRoot('dsh-finalize-missing-')
    const { options } = await stageFixture(root, 'child-1', rawBundleFixture('child-2'))
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('candidate.json unreadable')
  })

  it('rejects a modeComponent path missing from the parent (attempt-10 replay, ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-parent-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: intentFixture({
          modeComponents: { solve: ['src/index.ts', 'src/added-module.ts'], propose: ['src/index.ts'] },
        }),
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/added-module.ts': ADDED_MODULE,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'references parent-missing file src/added-module.ts',
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('parent-files.json')
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('tests.mechanism')
  })

  it('rejects a modeComponent path the child never wrote (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-child-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: intentFixture({
          modeComponents: { solve: ['src/index.ts', 'src/strategy.ts'], propose: ['src/index.ts'] },
        }),
        childFiles: { 'src/index.ts': CHILD_INDEX },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'references file src/strategy.ts missing from the child tree',
    )
  })

  it('rejects a non-production modeComponent path before any join (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-pattern-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: intentFixture({
          modeComponents: { solve: ['src/../escape.ts'], propose: ['src/index.ts'] },
        }),
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'is not a src/ production module',
    )
  })

  it('rejects a target mode with no production-byte change (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-flat-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: intentFixture({
          modeComponents: { solve: ['src/index.ts'], propose: ['src/strategy.ts'] },
          modeContract: { targetModes: ['solve', 'propose'], preservedModes: [] },
        }),
        // solve lists src/index.ts byte-identical to the parent; propose lists
        // src/strategy.ts which the child DID change — so propose passes and
        // solve is the rejecting mode.
        childFiles: {
          'src/index.ts': PARENT_INDEX,
          'src/strategy.ts': CHILD_STRATEGY,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'target mode solve has no production-byte change',
    )
  })

  it('rejects a preserved mode with changed production bytes (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-preserved-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: intentFixture({
          modeComponents: { solve: ['src/index.ts'], propose: ['src/strategy.ts'] },
          modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
        }),
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/strategy.ts': CHILD_STRATEGY,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'preserved mode propose changed production bytes in src/strategy.ts',
    )
  })

  it('rejects a child that did not modify the component root (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-root-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: intentFixture({
          modeComponents: { solve: ['src/strategy.ts'], propose: ['src/strategy.ts'] },
          modeContract: { targetModes: ['solve', 'propose'], preservedModes: [] },
        }),
        childFiles: {
          'src/index.ts': PARENT_INDEX,
          'src/strategy.ts': CHILD_STRATEGY,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'must modify the component root src/index.ts',
    )
  })

  it('rejects a malformed modeContract instead of crashing (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-mc-contract-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: {
          ...intentFixture(),
          modeContract: { targetModes: 'solve' },
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'modeContract must declare targetModes and preservedModes arrays',
    )
  })

  it('rejects a tests.mechanism path the child never wrote (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-test-missing-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/hint.ts': ADDED_MODULE,
          'tests/preserved.spec.ts': `it('preserved', () => {})\n`,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'tests.mechanism references missing test file tests/child.spec.ts',
    )
  })

  it('rejects a mechanism test that only modifies a parent test (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-test-modified-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        intent: {
          ...intentFixture(),
          tests: {
            command: 'pnpm vitest run tests/',
            mechanism: ['tests/candidate.spec.ts'],
            preservation: ['tests/preserved.spec.ts'],
          },
        },
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/hint.ts': ADDED_MODULE,
          'tests/candidate.spec.ts': `it('parent test, modified', () => {})\n`,
          'tests/preserved.spec.ts': `it('preserved', () => {})\n`,
        },
        parentSourceFiles: {
          'src/index.ts': PARENT_INDEX,
          'src/strategy.ts': PARENT_STRATEGY,
          'tests/candidate.spec.ts': `it('parent test', () => {})\n`,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'tests.mechanism path tests/candidate.spec.ts already exists in the parent',
    )
  })

  it('rejects a tests.preservation path the child never wrote (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-preservation-missing-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/hint.ts': ADDED_MODULE,
          'tests/child.spec.ts': `it('mechanism', () => {})\n`,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'tests.preservation references missing test file tests/preserved.spec.ts',
    )
  })

  it('rejects a v2 bundle finalized without the parent source view (ADR-037)', async () => {
    const root = await freshRoot('dsh-finalize-no-parent-view-')
    const { options } = await stageFixture(root, 'child-1', rawBundleFixture('child-1'))
    const withoutView = { ...options } as Record<string, unknown>
    delete withoutView['parentSourceFiles']
    await expect(
      finalizeTreeV2Bundle(withoutView as unknown as FinalizeTreeV2BundleOptions),
    ).rejects.toThrow('requires the parent source view')
  })

  it('rejects a child tree missing a fixed parent file (attempt-12 replay, ADR-039)', async () => {
    const root = await freshRoot('dsh-finalize-fixed-missing-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/hint.ts': ADDED_MODULE,
          'tests/child.spec.ts': `it('mechanism', () => {})\n`,
          'tests/preserved.spec.ts': `it('preserved', () => {})\n`,
        },
        // package.json deliberately omitted — the merged parent side used
        // to mask this gap until admission scan rejected the tree.
        omitFixedFiles: ['package.json'],
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'is missing the fixed parent file package.json',
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow('proposal_write_child')
  })

  it('rejects a child that changed a fixed parent file (attempt-12 replay, ADR-039)', async () => {
    const root = await freshRoot('dsh-finalize-fixed-changed-')
    const { options } = await stageFixture(
      root,
      'child-1',
      rawBundleFixture('child-1'),
      {
        childFiles: {
          'src/index.ts': CHILD_INDEX,
          'src/hint.ts': ADDED_MODULE,
          'tests/child.spec.ts': `it('mechanism', () => {})\n`,
          'tests/preserved.spec.ts': `it('preserved', () => {})\n`,
          'package.json': `{ "name": "candidate-tree-v2-test", "version": "0.0.1" }\n`,
        },
      },
    )
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(TreeV2FinalizationError)
    await expect(finalizeTreeV2Bundle(options)).rejects.toThrow(
      'changed the fixed parent file package.json',
    )
  })
})
