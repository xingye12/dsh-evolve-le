import { describe, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureCanonicalSource } from '../src/candidate/canonical.js'
import { validateTreeV2 } from '../src/schema.js'
import {
  assertModeContract,
  assertTreeV2CandidateTree,
  assertTreeV2Child,
  finalizeTreeV2Receipt,
  treeV2Digest,
  treeV2RuntimeFingerprint,
  verifyTreeV2Receipt,
  TREE_V2_PROTOCOL,
  TREE_V2_RECEIPT_KINDS,
} from '../src/tree-v2/contract.js'
import { assertTreeV2ReceiptChain, persistTreeV2ReceiptDocument } from '../src/tree-v2/receipts.js'
import {
  assertTreeV2MigrationReceipt,
  createTreeV2MigrationReceipt,
  persistTreeV2MigrationReceipt,
} from '../src/tree-v2/migration.js'
import { openObjectStore } from '../src/state/object-store.js'
import { canonicalJson } from '../src/state/canonical.js'

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`

function intent(parent: string) {
  return finalizeTreeV2Receipt({
    schemaVersion: 2 as const,
    protocol: TREE_V2_PROTOCOL,
    kind: 'candidate-intent' as const,
    candidate: { name: 'candidate-v2', version: '1.0.0', entry: 'src/index.ts' as const },
    parent: { candidateDigest: digest('a'), sourceDigest: parent },
    modeContract: { targetModes: ['solve' as const], preservedModes: ['propose' as const] },
    requiredParentEvidence: {
      analysisDigest: digest('a'),
      mechanismOutcomeDigest: digest('b'),
      normalizedTrialDigest: digest('c'),
      trajectoryDigest: digest('d'),
    },
    runtime: {
      modeComponents: { solve: ['src/index.ts'], propose: ['src/propose.ts'] },
      modeSurfaces: {
        solve: {
          promptSections: [{ name: 'candidate:solve', order: 100 }],
          newToolNames: [],
          newSkillNames: [],
          agentEventNames: [],
          sessionEventNames: [],
          workflowNames: [],
        },
        propose: {
          promptSections: [{ name: 'candidate:propose', order: 100 }],
          newToolNames: [],
          newSkillNames: [],
          agentEventNames: [],
          sessionEventNames: [],
          workflowNames: [],
        },
      },
      capabilities: ['system-prompt'],
    },
    tests: {
      command: 'pnpm test',
      mechanism: ['tests/new.spec.ts'],
      preservation: ['tests/child.spec.ts'],
    },
  })
}

function rootIntent() {
  return finalizeTreeV2Receipt({
    schemaVersion: 2 as const,
    protocol: TREE_V2_PROTOCOL,
    kind: 'candidate-intent' as const,
    candidate: { name: 'candidate-v2-root', version: '1.0.0', entry: 'src/index.ts' as const },
    parent: null,
    modeContract: {
      targetModes: ['solve' as const, 'propose' as const],
      preservedModes: [],
    },
    runtime: {
      modeComponents: {
        solve: ['src/index.ts', 'src/component.ts'],
        propose: ['src/index.ts', 'src/component.ts'],
      },
      modeSurfaces: {
        solve: {
          promptSections: [{ name: 'candidate:solve', order: 100 }],
          newToolNames: [],
          newSkillNames: [],
          agentEventNames: [],
          sessionEventNames: [],
          workflowNames: [],
        },
        propose: {
          promptSections: [{ name: 'candidate:propose', order: 100 }],
          newToolNames: [],
          newSkillNames: [],
          agentEventNames: [],
          sessionEventNames: [],
          workflowNames: [],
        },
      },
      capabilities: ['system-prompt' as const],
    },
    tests: {
      command: 'pnpm test',
      mechanism: ['tests/root.spec.ts'],
      preservation: [],
    },
  })
}

async function rootSource(root: string) {
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(
    join(root, 'src/index.ts'),
    "import { component } from './component.js'\nexport function apply(ctx: any) { ctx.plugin(component) }\n",
  )
  await writeFile(join(root, 'src/component.ts'), 'export const component = () => {}\n')
  await writeFile(join(root, 'tests/root.spec.ts'), 'export {}\n')
  await writeFile(join(root, 'candidate.json'), '{}\n')
  await writeFile(join(root, 'package.json'), '{}\n')
  return captureCanonicalSource(root)
}

async function source(root: string, solveText = 'export const solve = 1\n', extra = false) {
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await writeFile(
    join(root, 'src/index.ts'),
    `export function apply(ctx: any) { ctx.plugin(() => {}) }\n${solveText}`,
  )
  await writeFile(join(root, 'src/propose.ts'), 'export const propose = 1\n')
  if (extra) {
    await writeFile(join(root, 'src/new.ts'), 'export const newMechanism = true\n')
    await writeFile(join(root, 'tests/new.spec.ts'), 'export {}\n')
  }
  await writeFile(join(root, 'tests/child.spec.ts'), 'export {}\n')
  await writeFile(join(root, 'candidate.json'), '{}\n')
  await writeFile(join(root, 'package.json'), '{}\n')
  return captureCanonicalSource(root)
}

describe('tree-v2 contract', () => {
  it('makes the runtime fingerprint content-sensitive over section surfaces (ADR-039)', () => {
    // Attempt 12 prop-3: a child folded a directive into an existing section's
    // TEXT only — the name-only fingerprint saw no change and the target-mode
    // contract was unsatisfiable. The fingerprint must see mounted text.
    const base = {
      sections: { afterBoot: ['candidate:identity'] },
      strategy: { toolsAfterBoot: [], skillsAfterBoot: [] },
    }
    const parent = treeV2RuntimeFingerprint(base, 'solve')
    const textChanged = treeV2RuntimeFingerprint(
      {
        ...base,
        sectionSurfaces: {
          afterBoot: [{ name: 'candidate:identity', order: 100, text: 'solve mode' }],
        },
      },
      'solve',
    )
    const textChangedAgain = treeV2RuntimeFingerprint(
      {
        ...base,
        sectionSurfaces: {
          afterBoot: [
            { name: 'candidate:identity', order: 100, text: 'solve mode — CHILD DIRECTIVE' },
          ],
        },
      },
      'solve',
    )
    expect(parent).not.toBe(textChanged)
    expect(textChanged).not.toBe(textChangedAgain)
    // Same content, same mode → same fingerprint (stable, content-addressed).
    expect(
      treeV2RuntimeFingerprint(
        {
          ...base,
          sectionSurfaces: {
            afterBoot: [{ name: 'candidate:identity', order: 100, text: 'solve mode' }],
          },
        },
        'solve',
      ),
    ).toBe(textChanged)
    // The legacy name-only fallback stays deterministic for old reports.
    expect(treeV2RuntimeFingerprint(base, 'solve')).toBe(parent)
  })

  it('masks the mounting candidate id out of section text (ADR-039)', () => {
    // The SDK's documented pattern embeds config.candidateId in the section
    // text; a byte-identical child mounts under a DIFFERENT id, so raw text
    // hashing would break every preserved-mode contract on identity alone.
    const reportFor = (id: string): unknown => ({
      sections: { afterBoot: ['candidate:identity'] },
      sectionSurfaces: {
        afterBoot: [{ name: 'candidate:identity', order: 100, text: `candidate ${id} in solve mode` }],
      },
      strategy: { toolsAfterBoot: [] },
    })
    const parent = treeV2RuntimeFingerprint(reportFor('c_parent0000000000000000000000'), 'solve', {
      candidateId: 'c_parent0000000000000000000000',
    })
    const child = treeV2RuntimeFingerprint(reportFor('c_child00000000000000000000000'), 'solve', {
      candidateId: 'c_child00000000000000000000000',
    })
    expect(parent).toBe(child)
    // Content beyond identity still moves the fingerprint.
    const evolved = treeV2RuntimeFingerprint(
      {
        ...reportFor('c_child00000000000000000000000'),
        sectionSurfaces: {
          afterBoot: [
            {
              name: 'candidate:identity',
              order: 100,
              text: 'candidate c_child00000000000000000000000 in solve mode — CHILD DIRECTIVE',
            },
          ],
        },
      },
      'solve',
      { candidateId: 'c_child00000000000000000000000' },
    )
    expect(evolved).not.toBe(child)
  })

  it('accepts an explicit parentless migration root without fabricated parent evidence', async () => {
    const root = await rootSource(
      join('/tmp', `tree-v2-root-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    )
    const candidateIntent = rootIntent()
    expect(validateTreeV2('candidate-intent', candidateIntent)).toMatchObject({ ok: true })
    expect(() => assertTreeV2CandidateTree(root, candidateIntent)).not.toThrow()
  })

  it('does not allow the migration-root exception on a child', async () => {
    const root = await rootSource(
      join('/tmp', `tree-v2-root-child-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    )
    expect(() => assertTreeV2Child(root, root, rootIntent())).toThrow(/migration root.*child/i)
  })

  it('validates and independently persists all eight receipt kinds', async () => {
    const documents = {
      proposal: finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'proposal' as const,
        proposalId: 'proposal-1',
        parentCandidateDigest: digest('a'),
        analysisDigest: digest('b'),
        candidateIntentDigest: digest('c'),
        modeContract: { targetModes: ['solve'], preservedModes: ['propose'] },
        requiredParentEvidence: {
          analysisDigest: digest('b'),
          mechanismOutcomeDigest: digest('d'),
          normalizedTrialDigest: digest('e'),
          trajectoryDigest: digest('f'),
        },
      }),
      analysis: finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'analysis' as const,
        parentCandidateDigest: digest('a'),
        findings: ['The parent fails before verifying the tool result.'],
        evidenceDigests: [digest('e'), digest('f')],
      }),
      'candidate-intent': intent(digest('a')),
      'mechanism-outcome': finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'mechanism-outcome' as const,
        candidateIntentDigest: digest('a'),
        mechanismTestDigest: digest('b'),
        outcome: 'passed' as const,
      }),
      'capability-catalog': finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'capability-catalog' as const,
        candidateDigest: digest('a'),
        capabilities: ['system-prompt'],
      }),
      'materialization-receipt': finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'materialization-receipt' as const,
        parentCandidateDigest: digest('a'),
        candidateDigest: digest('b'),
        candidateIntentDigest: digest('c'),
        sourceDigest: digest('d'),
        capabilityCatalogDigest: digest('e'),
      }),
      'admission-receipt': finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'admission-receipt' as const,
        candidateDigest: digest('a'),
        buildDigest: digest('b'),
        materializationDigest: digest('c'),
        capabilityCatalogDigest: digest('d'),
        modeFingerprints: { solve: digest('e'), propose: digest('f') },
        admitted: true as const,
      }),
      'migration-receipt': createTreeV2MigrationReceipt({
        legacyCandidateDigest: digest('a'),
        treeV2CandidateDigest: digest('b'),
        sourceDigest: digest('c'),
      }),
    }
    expect(Object.keys(documents).sort()).toEqual([...TREE_V2_RECEIPT_KINDS].sort())
    const store = await openObjectStore(
      join('/tmp', `tree-v2-receipts-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    )
    for (const kind of TREE_V2_RECEIPT_KINDS) {
      const receipt = documents[kind]
      expect(validateTreeV2(kind, receipt)).toMatchObject({ ok: true })
      expect(() => verifyTreeV2Receipt(receipt)).not.toThrow()
      const { receiptDigest, ...unsigned } = receipt
      expect(receiptDigest).toBe(treeV2Digest(unsigned))
      const ref = await persistTreeV2ReceiptDocument(store, kind, receipt)
      expect(ref.mediaType).toContain(`tree-v2.${kind}`)
      await expect(store.read(ref)).resolves.toEqual(Buffer.from(`${canonicalJson(receipt)}\n`))
    }
  })

  it('validates cross-receipt bindings and rejects a substituted digest', () => {
    const analysis = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: TREE_V2_PROTOCOL,
      kind: 'analysis' as const,
      parentCandidateDigest: digest('a'),
      findings: ['The parent fails before verifying the tool result.'],
      evidenceDigests: [digest('c'), digest('d')],
    })
    const candidateIntent = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: TREE_V2_PROTOCOL,
      kind: 'candidate-intent' as const,
      candidate: { name: 'child', version: '1.0.0', entry: 'src/index.ts' as const },
      parent: { candidateDigest: digest('a'), sourceDigest: digest('b') },
      modeContract: { targetModes: ['solve' as const], preservedModes: ['propose' as const] },
      requiredParentEvidence: {
        analysisDigest: analysis.receiptDigest,
        mechanismOutcomeDigest: digest('b'),
        normalizedTrialDigest: digest('c'),
        trajectoryDigest: digest('d'),
      },
      runtime: {
        modeComponents: { solve: ['src/index.ts'], propose: ['src/propose.ts'] },
        modeSurfaces: {
          solve: {
            promptSections: [{ name: 'candidate:solve', order: 100 }],
            newToolNames: [],
            newSkillNames: [],
            agentEventNames: [],
            sessionEventNames: [],
            workflowNames: [],
          },
          propose: {
            promptSections: [{ name: 'candidate:propose', order: 100 }],
            newToolNames: [],
            newSkillNames: [],
            agentEventNames: [],
            sessionEventNames: [],
            workflowNames: [],
          },
        },
        capabilities: ['system-prompt'],
      },
      tests: {
        command: 'pnpm test',
        mechanism: ['tests/mechanism.spec.ts'],
        preservation: ['tests/preservation.spec.ts'],
      },
    })
    const catalog = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: TREE_V2_PROTOCOL,
      kind: 'capability-catalog' as const,
      candidateDigest: digest('e'),
      capabilities: ['system-prompt'],
    })
    const materialization = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: TREE_V2_PROTOCOL,
      kind: 'materialization-receipt' as const,
      parentCandidateDigest: digest('a'),
      candidateDigest: digest('e'),
      candidateIntentDigest: candidateIntent.receiptDigest,
      sourceDigest: digest('f'),
      capabilityCatalogDigest: catalog.receiptDigest,
    })
    const chain = {
      analysis,
      candidateIntent,
      proposal: finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'proposal' as const,
        proposalId: 'proposal-1',
        parentCandidateDigest: digest('a'),
        analysisDigest: analysis.receiptDigest,
        candidateIntentDigest: candidateIntent.receiptDigest,
        modeContract: candidateIntent.modeContract,
        requiredParentEvidence: candidateIntent.requiredParentEvidence,
      }),
      mechanismOutcome: finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'mechanism-outcome' as const,
        candidateIntentDigest: candidateIntent.receiptDigest,
        mechanismTestDigest: digest('1'),
        outcome: 'passed' as const,
      }),
      capabilityCatalog: catalog,
      materialization,
      admission: finalizeTreeV2Receipt({
        schemaVersion: 2,
        protocol: TREE_V2_PROTOCOL,
        kind: 'admission-receipt' as const,
        candidateDigest: digest('e'),
        buildDigest: digest('2'),
        materializationDigest: materialization.receiptDigest,
        capabilityCatalogDigest: catalog.receiptDigest,
        modeFingerprints: { solve: digest('3'), propose: digest('4') },
        admitted: true as const,
      }),
    }
    expect(() => assertTreeV2ReceiptChain(chain)).not.toThrow()
    const { receiptDigest: _oldDigest, ...unsignedAdmission } = chain.admission
    const substitutedAdmission = finalizeTreeV2Receipt({
      ...unsignedAdmission,
      materializationDigest: digest('9'),
    })
    expect(() =>
      assertTreeV2ReceiptChain({
        ...chain,
        admission: substitutedAdmission,
      }),
    ).toThrow(/materialization/)
  })

  it('requires a complete, disjoint mode partition', () => {
    expect(() =>
      assertModeContract({ targetModes: ['solve'], preservedModes: ['solve'] }),
    ).toThrow()
    expect(() =>
      assertModeContract({ targetModes: ['solve'], preservedModes: ['propose'] }),
    ).not.toThrow()
  })

  it('requires the capability catalog to equal the declared per-mode surface union', async () => {
    const root = join(
      '/tmp',
      `tree-v2-catalog-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    const candidate = await source(root, 'export const solve = 2\n', true)
    const { receiptDigest: _receiptDigest, ...unsignedIntent } = intent(digest('a'))
    const candidateIntent = finalizeTreeV2Receipt({
      ...unsignedIntent,
      runtime: { ...unsignedIntent.runtime, capabilities: ['system-prompt', 'tools'] },
    })
    expect(() => assertTreeV2Child(candidate, candidate, candidateIntent)).toThrow(
      /capabilities does not match/,
    )
  })

  it('enforces multi-file root, test, target and preserved byte boundaries', async () => {
    const root = join('/tmp', `tree-v2-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const parentDir = join(root, 'parent')
    const childDir = join(root, 'child')
    const parent = await source(parentDir, 'export const solve = 1\n')
    const child = await source(childDir, 'export const solve = 2\n', true)
    const childIntent = intent(`sha256:${parent.sha256}`)
    expect(() => assertTreeV2Child(parent, child, childIntent)).not.toThrow()
  })

  it('makes migration results non-inheritable', () => {
    const receipt = createTreeV2MigrationReceipt({
      legacyCandidateDigest: digest('a'),
      treeV2CandidateDigest: digest('b'),
      sourceDigest: digest('c'),
    })
    expect(validateTreeV2('migration-receipt', receipt)).toMatchObject({ ok: true })
    expect(() => assertTreeV2MigrationReceipt(receipt)).not.toThrow()
    expect(receipt.resultsInherited).toBe(false)
  })

  it('persists a migration receipt as a content-addressed object', async () => {
    const root = join(
      '/tmp',
      `tree-v2-migration-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    const store = await openObjectStore(root)
    const persisted = await persistTreeV2MigrationReceipt(store, {
      legacyCandidateDigest: digest('a'),
      treeV2CandidateDigest: digest('b'),
      sourceDigest: digest('c'),
    })
    await expect(store.read(persisted.ref)).resolves.toEqual(
      Buffer.from(`${canonicalJson(persisted.receipt)}\n`),
    )
    expect(persisted.ref.mediaType).toBe(
      'application/vnd.dsh-evolve-le.tree-v2.migration-receipt+json',
    )
  })
})
