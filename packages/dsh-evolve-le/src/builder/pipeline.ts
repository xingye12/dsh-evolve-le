/**
 * Trusted admission pipeline (specs/02 §11, Gate 1): ten ordered stages over
 * a once-frozen staging tree, fail-fast, with honest receipts — a stage that
 * never ran is `skipped`, never invented. Only a build whose ten receipts are
 * all `pass` yields outcome `admitted` (ADMITTED_UNEVALUATED: safety-
 * runnability, never performance acceptance).
 * @module @dsh-evolve-le/core/builder/pipeline
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  candidateIdFromDigest,
  captureCanonicalSource,
  type CanonicalSource,
} from '../candidate/canonical.js'
import { diffCanonicalSources } from '../candidate/diff.js'
import { scanCanonicalSource, defaultScanPolicy } from '../candidate/scan.js'
import { runAcpSession } from '../acp/driver.js'
import { computeTreeDigest, TREE_DIGEST_ALGO } from '../digest.js'
import { nativeDshClosurePresent } from '../dsh/native-composition.js'
import { repoRoot, validateManifest } from '../schema.js'
import {
  assertTreeV2CandidateTree,
  assertTreeV2Child,
  assertTreeV2RuntimeModeContract,
  finalizeTreeV2Receipt,
  treeV2Digest,
  treeV2RuntimeFingerprint,
  treeV2SolvePolicyFingerprint,
  type TreeV2CandidateIntent,
  type TreeV2ModeFingerprints,
  type TreeV2RequiredParentEvidence,
} from '../tree-v2/contract.js'
import {
  assertTreeV2ReceiptDocument,
  type TreeV2AdmissionReceipt,
  type TreeV2CapabilityCatalogReceipt,
  type TreeV2MaterializationReceipt,
  type TreeV2MechanismOutcomeReceipt,
} from '../tree-v2/receipts.js'
import {
  assembleCapsule,
  bootConfig,
  buildBundle,
  buildInstallManifest,
  installCandidateIntoClosure,
  archiveCapsule,
} from './capsule.js'
import { doubleCompile } from './compile.js'
import { toolchainFingerprints } from './pins.js'
import {
  describeSandbox,
  runSandboxed,
  sandboxedInteractiveCommand,
  sandboxEnvironment,
} from './sandbox.js'
import { assembleOfflineNodeModules, captureStagedSource, stageDeclaredSource } from './staging.js'
import { materializeNodeRuntime } from './pinned-runtime.js'
import { runCandidateTests, runOxlint } from './type-lint-unit.js'

/** The canonical stage order; receipts always list exactly these ten. */
export const STAGE_ORDER = [
  'containment',
  'schema',
  'diffBoundary',
  'policyScan',
  'reproducibleBuild',
  'typeLintUnit',
  'loaderBoot',
  'unloadInvariant',
  'mockReplay',
  'capsuleDoubleBuild',
] as const

export type StageName = (typeof STAGE_ORDER)[number]
export type ReceiptStatus = 'pass' | 'fail' | 'skipped'

export interface Receipt {
  status: ReceiptStatus
  detail: string
  artifact?: string
}

export type Receipts = Record<StageName, Receipt>

export interface BuildInput {
  /** Proposer working directory (declared entries only are staged). */
  sourceDir: string
  /** Builder-owned scratch directory; created fresh, caller cleans up. */
  workRoot: string
  /**
   * Canonical parent source tree (Gate 4): required whenever candidate.json
   * declares a non-null canonicalParent. Identity-bound — the capture must
   * hash to the declared parent digest or admission fails closed.
   */
  parentTreeDir?: string
  /**
   * Builder-owned, prebuilt DSH workspace used to compose a native capsule.
   * Omit it to build the explicitly non-native compatibility closure.
   */
  nativeDshCatalogRoot?: string
  /**
   * Run-manifest lock for the native closure. A mismatch means the upstream
   * catalog changed after preflight, so admission fails before compilation.
   */
  expectedDependencyClosureSha256?: string
  /**
   * Trusted parent evidence for a tree-v2 child. It comes only from the
   * parent admission record, never from the child source tree or proposer.
   */
  treeV2ParentEvidence?: {
    requiredParentEvidence: TreeV2RequiredParentEvidence
    modeFingerprints: TreeV2ModeFingerprints
  }
}

export interface TreeV2BuildReceipts {
  mechanismOutcome: TreeV2MechanismOutcomeReceipt
  capabilityCatalog: TreeV2CapabilityCatalogReceipt
  materialization: TreeV2MaterializationReceipt
  admission: TreeV2AdmissionReceipt
}

export interface BuildResult {
  candidateId: string
  sourceDigest: string
  outcome: 'admitted' | 'rejected'
  rejection?: { stage: StageName; reason: string }
  receipts: Receipts
  bundle?: { tarSha256: string; entrySha256: string; fileCount: number; bytes: number }
  capsule?: {
    tarSha256: string
    archiveSha256: string
    sbomSha256: string
    provenanceSha256: string
  }
  artifacts: {
    workRoot: string
    treeDir: string
    capsuleDir: string
    capsuleTar: string
    capsuleArchive: string
    buildManifestPath: string
    treeV2ReceiptsDir?: string
  }
  manifest: Record<string, unknown>
  treeV2?: {
    protocol: 'dsh-self-evolving-candidate-tree-v2'
    modeFingerprints: TreeV2ModeFingerprints
    receipts: TreeV2BuildReceipts
  }
}

/**
 * Compiled core lib directory: the runner/probe/stub files staged into every
 * capsule. Always the compiled `lib/` tree — capsules never embed `.ts` — so
 * when the pipeline itself runs from source (vitest), resolve across to `lib`.
 */
const moduleDir = dirname(fileURLToPath(import.meta.url))
const coreLibDir = existsSync(join(moduleDir, '..', 'bin/candidate-probe.js'))
  ? join(moduleDir, '..')
  : join(moduleDir, '..', '..', 'lib')

function emptyReceipts(): Receipts {
  const receipts = {} as Record<StageName, Receipt>
  for (const stage of STAGE_ORDER) {
    receipts[stage] = { status: 'skipped', detail: 'not reached' }
  }
  return receipts
}

/** True when two name sequences are equal as multisets (order-insensitive). */
function sameSequence(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false
  const sorted = [...actual].sort()
  const target = [...expected].sort()
  return sorted.every((name, index) => name === target[index])
}

interface ProbeReport {
  sections: { afterBoot: string[]; afterUnload: string[] }
  strategy?: {
    toolsAfterBoot?: string[]
    toolsAfterUnload?: string[]
    skillsAfterBoot?: string[]
    skillsAfterUnload?: string[]
    agentEventsAfterBoot?: string[]
    agentEventsAfterUnload?: string[]
    sessionEventsAfterBoot?: string[]
    sessionEventsAfterUnload?: string[]
    workflowsAfterBoot?: string[]
    workflowsAfterUnload?: string[]
  }
  quiescent: boolean
  error?: string
  timings: { bootMs: number; unloadMs: number }
}

/** Report produced by the native AgentLoop admission turn inside a capsule. */
interface NativeTurnProbeReport {
  nativeComposition: boolean
  turn?: {
    assistantText: string
    eventCount: number
    toolTraceEventCount: number
    toolCallEventCount: number
    toolResultEventCount: number
  }
  quiescent: boolean
  error?: string
  timings: { bootMs: number; turnMs?: number; unloadMs: number }
}

/** Report produced by the native proposal tool loop inside a capsule. */
interface NativeProposalProbeReport {
  nativeComposition: boolean
  proposal?: {
    childCount: number
    eventCount: number
    toolTraceEventCount: number
    toolCallEventCount: number
    toolResultEventCount: number
    backendWrites: string[]
  }
  quiescent: boolean
  error?: string
  timings: { bootMs: number; proposalMs?: number; unloadMs: number }
}

/** Report produced by the native ACP solve bridge inside a capsule. */
interface NativeSolveProbeReport {
  nativeComposition: boolean
  solve?: {
    completionCount: number
    eventCount: number
    toolCallEventCount: number
    toolResultEventCount: number
    terminalCalls: string[]
    readPaths: string[]
    writes: string[]
    assistantChunks: string[]
    candidateCheckpointCount: number
    candidateCheckpointSha256: string
    strategyUsage: {
      workflowInvocations: number
      strategyToolInvocations: number
      agentEventInvocations: number
      sessionEventInvocations: number
    }
  }
  quiescent: boolean
  error?: string
  timings: { bootMs: number; solveMs?: number; unloadMs: number }
}

/** One declared prompt section (candidate.json runtime.promptSections). */
interface DeclaredSection {
  name: string
  order: number
}

/** Section names a candidate declares for one mode, in (order, name) order. */
function declaredSections(
  manifest: Record<string, unknown> | undefined,
  mode: 'solve' | 'propose',
): DeclaredSection[] {
  const runtime = manifest?.['runtime'] as
    | {
        promptSections?: Record<string, DeclaredSection[]>
        modeSurfaces?: Record<string, { promptSections?: DeclaredSection[] }>
      }
    | undefined
  const list =
    manifest?.['schemaVersion'] === 2
      ? runtime?.modeSurfaces?.[mode]?.promptSections
      : runtime?.promptSections?.[mode]
  if (!Array.isArray(list)) return []
  return [...list]
    .filter((section) => section !== null && typeof section === 'object')
    .map((section) => ({ name: String(section.name), order: Number(section.order) }))
    .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
}

/** The exact section-name sequence boot must expose for a mode. */
function expectedSectionNames(
  manifest: Record<string, unknown> | undefined,
  mode: 'solve' | 'propose',
): string[] {
  return declaredSections(manifest, mode).map((section) => section.name)
}

function expectedStrategyNames(
  manifest: Record<string, unknown> | undefined,
  key: 'newToolNames' | 'newSkillNames' | 'agentEventNames' | 'sessionEventNames' | 'workflowNames',
  mode: 'solve' | 'propose',
): string[] {
  const runtime = manifest?.['runtime'] as Record<string, unknown> | undefined
  const modeSurfaces = runtime?.['modeSurfaces'] as
    Record<string, Record<string, unknown>> | undefined
  const names = manifest?.['schemaVersion'] === 2 ? modeSurfaces?.[mode]?.[key] : runtime?.[key]
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === 'string')
    : []
}

/**
 * Parent preservation (specs/02 §10, specs/03 §9): a child must retain every
 * prompt section name its canonical parent declared, in both modes. Sections
 * may be re-ordered or their text changed as the mechanism itself — names are
 * the preserved surface the controller can attribute and revoke.
 */
function checkSectionPreservation(
  parentSource: CanonicalSource,
  childManifest: Record<string, unknown> | undefined,
): string | undefined {
  const parentManifestFile = parentSource.files.find((file) => file.path === 'candidate.json')
  if (parentManifestFile === undefined) {
    return 'parent source has no candidate.json to check preservation against'
  }
  let parentManifest: Record<string, unknown>
  try {
    parentManifest = JSON.parse(parentManifestFile.content.toString('utf8')) as Record<
      string,
      unknown
    >
  } catch (error) {
    return `parent candidate.json is not JSON: ${String(error)}`
  }
  for (const mode of ['solve', 'propose'] as const) {
    const parentNames = new Set(expectedSectionNames(parentManifest, mode))
    const childNames = new Set(expectedSectionNames(childManifest, mode))
    for (const name of parentNames) {
      if (!childNames.has(name)) {
        return `child drops parent ${mode} section "${name}" (preservation violation)`
      }
    }
  }
  return undefined
}

/**
 * Run the full admission pipeline over one candidate source directory.
 * Every stage records a receipt; the first failure stops the chain and the
 * build is rejected at that stage. The returned manifest always validates
 * against the versioned build schema — a builder-side schema violation is a
 * bug and throws instead of producing a bogus manifest.
 */
export async function buildCandidate(input: BuildInput): Promise<BuildResult> {
  const workRoot = resolve(input.workRoot)
  const sourceDir = resolve(input.sourceDir)
  await rm(workRoot, { recursive: true, force: true })
  await mkdir(workRoot, { recursive: true })
  const receipts = emptyReceipts()
  const treeDir = join(workRoot, 'tree')
  const capsuleDir = join(workRoot, 'capsule')

  let failed: { stage: StageName; reason: string } | undefined
  const failStage = (stage: StageName, reason: string): void => {
    receipts[stage] = { status: 'fail', detail: reason }
    failed = { stage, reason }
  }

  // ---- stage 1: containment -------------------------------------------
  let source: CanonicalSource | undefined
  let treeDigestValue = ''
  try {
    await stageDeclaredSource(sourceDir, join(workRoot, 'staged-src'))
    source = await captureStagedSource(join(workRoot, 'staged-src'), treeDir)
    const treeStats = await computeTreeDigest(treeDir)
    treeDigestValue = treeStats.digest
    receipts.containment = {
      status: 'pass',
      detail: `captured ${source.files.length} files, ${source.bytes} bytes; staged read-only; tree digest ${TREE_DIGEST_ALGO}:${treeDigestValue.slice(0, 16)}…`,
    }
  } catch (error) {
    failStage('containment', error instanceof Error ? error.message : String(error))
  }

  // Placeholder for containment-time failures only: valid base32 shape, never
  // a real identity (no source tar was captured).
  const candidateId =
    source !== undefined ? candidateIdFromDigest(source.sha256) : `c_${'a'.repeat(26)}`
  const sourceDigest = source !== undefined ? `sha256:${source.sha256}` : 'sha256:' + '0'.repeat(64)

  // ---- stage 2: schema -------------------------------------------------
  let candidateManifest: Record<string, unknown> | undefined
  let canonicalParent: string | null = null
  let candidatePackage = ''
  let treeV2Intent: TreeV2CandidateIntent | undefined
  if (failed === undefined && source !== undefined) {
    const manifestFile = source.files.find((file) => file.path === 'candidate.json')
    const packageFile = source.files.find((file) => file.path === 'package.json')
    if (manifestFile === undefined || packageFile === undefined) {
      failStage('schema', 'candidate source is missing candidate.json or package.json')
    } else {
      try {
        candidateManifest = JSON.parse(manifestFile.content.toString('utf8')) as Record<
          string,
          unknown
        >
        const pkg = JSON.parse(packageFile.content.toString('utf8')) as { name?: string }
        candidatePackage = pkg.name ?? ''
        const result = validateManifest('candidate', candidateManifest)
        if (!result.ok) {
          failStage(
            'schema',
            `candidate.json invalid: ${result.error.errors
              .map((e) => String(e))
              .join('; ')
              .slice(0, 1000)}`,
          )
        } else {
          if (candidateManifest.schemaVersion === 2) {
            treeV2Intent = candidateManifest as unknown as TreeV2CandidateIntent
            assertTreeV2CandidateTree(source, treeV2Intent)
            canonicalParent = treeV2Intent.parent?.sourceDigest ?? null
          } else {
            canonicalParent = (candidateManifest.canonicalParent as string | null) ?? null
          }
          receipts.schema = {
            status: 'pass',
            detail: `candidate.json and package.json validate${treeV2Intent === undefined ? '' : ' as tree-v2'}; package ${candidatePackage}`,
          }
        }
      } catch (error) {
        failStage('schema', error instanceof Error ? error.message : String(error))
      }
    }
  }

  // ---- stage 3: diff boundary ------------------------------------------
  let parentDiff: Record<string, unknown> | undefined
  if (failed === undefined && source === undefined) {
    failStage('diffBoundary', 'internal: diff boundary reached without a captured source')
  } else if (failed === undefined && source !== undefined) {
    const childSource = source
    if (canonicalParent === null) {
      parentDiff = {
        parent: null,
        diffHash: createHash('sha256').update('').digest('hex'),
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
      }
      receipts.diffBoundary = {
        status: 'pass',
        detail: 'lineage root (canonicalParent null): no parent diff required',
      }
    } else if (input.parentTreeDir === undefined) {
      failStage(
        'diffBoundary',
        'candidate declares canonicalParent but no parent source tree was supplied',
      )
    } else {
      try {
        const parentSource = await captureCanonicalSource(input.parentTreeDir)
        if (`sha256:${parentSource.sha256}` !== canonicalParent) {
          failStage(
            'diffBoundary',
            `supplied parent tree hashes to sha256:${parentSource.sha256}, candidate.json declares ${canonicalParent}`,
          )
        } else {
          if (treeV2Intent !== undefined) {
            const parentEvidence = input.treeV2ParentEvidence
            if (parentEvidence === undefined) {
              failStage(
                'diffBoundary',
                'tree-v2 child requires trusted parent evidence and mode fingerprints',
              )
            } else if (
              treeV2Digest(parentEvidence.requiredParentEvidence) !==
              treeV2Digest(treeV2Intent.requiredParentEvidence)
            ) {
              failStage(
                'diffBoundary',
                'tree-v2 requiredParentEvidence does not match the trusted parent admission record',
              )
            } else {
              const diff = assertTreeV2Child(parentSource, childSource, treeV2Intent)
              parentDiff = {
                parent: canonicalParent,
                diffHash: diff.diffHash,
                filesChanged: diff.filesChanged,
                linesAdded: diff.linesAdded,
                linesRemoved: diff.linesRemoved,
                differingFiles: diff.differingFiles,
              }
              receipts.diffBoundary = {
                status: 'pass',
                detail: `tree-v2 parent ${canonicalParent.slice(0, 16)}… verified; multi-file component, candidate tests, named evidence, and byte-preserved modes pass; ${diff.filesChanged} files +${diff.linesAdded}/-${diff.linesRemoved}`,
              }
            }
          } else {
            const preservation = checkSectionPreservation(parentSource, candidateManifest)
            if (preservation !== undefined) {
              failStage('diffBoundary', preservation)
            } else {
              const diff = diffCanonicalSources(parentSource, childSource)
              parentDiff = {
                parent: canonicalParent,
                diffHash: diff.diffHash,
                filesChanged: diff.filesChanged,
                linesAdded: diff.linesAdded,
                linesRemoved: diff.linesRemoved,
                differingFiles: diff.differingFiles,
              }
              receipts.diffBoundary = {
                status: 'pass',
                detail: `parent ${canonicalParent.slice(0, 16)}… verified by re-capture; ${diff.filesChanged} files +${diff.linesAdded}/-${diff.linesRemoved} within the pre-registered boundary; parent sections preserved`,
              }
            }
          }
        }
      } catch (error) {
        failStage('diffBoundary', error instanceof Error ? error.message : String(error))
      }
    }
  }

  // ---- stage 4: policy scan ---------------------------------------------
  if (failed === undefined && source !== undefined) {
    const report = scanCanonicalSource(source, defaultScanPolicy())
    if (report.clean) {
      receipts.policyScan = {
        status: 'pass',
        detail: 'no findings across import/dependency/leak/task/secret rules',
      }
    } else {
      failStage(
        'policyScan',
        report.findings
          .map((f) => `${f.rule} at ${f.path}:${f.line} (${f.detail})`)
          .join('; ')
          .slice(0, 2000),
      )
    }
  }

  // ---- stage 5: reproducible build ---------------------------------------
  let closure:
    { digest: string; fileCount: number; packages: { name: string; version: string }[] } | undefined
  let compileTsconfigSha256 = ''
  let compiledDir = ''
  if (failed === undefined && source !== undefined) {
    try {
      closure = await assembleOfflineNodeModules(
        treeDir,
        input.nativeDshCatalogRoot === undefined
          ? undefined
          : { nativeDshCatalogRoot: input.nativeDshCatalogRoot },
      )
      if (
        input.expectedDependencyClosureSha256 !== undefined &&
        closure.digest !== input.expectedDependencyClosureSha256
      ) {
        failStage(
          'reproducibleBuild',
          `native DSH closure drift: assembled ${closure.digest}, expected ${input.expectedDependencyClosureSha256}`,
        )
      }
      const toolchain = await toolchainFingerprints()
      if (failed === undefined) {
        const compile = await doubleCompile({
          workRoot,
          tscBin: toolchain.typescriptBin,
          timeoutMs: 180_000,
        })
        compileTsconfigSha256 = compile.tsconfigSha256
        if (!compile.ok) {
          failStage('reproducibleBuild', compile.detail)
        } else {
          compiledDir = join(workRoot, 'compile-1')
          receipts.reproducibleBuild = {
            status: 'pass',
            detail: `${compile.detail}; closure ${closure.packages.length} packages (${closure.fileCount} files), tsc ${toolchain.typescript}`,
          }
        }
      }
    } catch (error) {
      failStage('reproducibleBuild', error instanceof Error ? error.message : String(error))
    }
  }

  // ---- stage 6: type/lint/unit -------------------------------------------
  if (failed === undefined && source !== undefined) {
    const hasTests = source.files.some((file) => file.path.startsWith('tests/'))
    const declaresAssertions =
      candidateManifest !== undefined &&
      Array.isArray(
        (candidateManifest.tests as { mechanismAssertions?: unknown[] })?.mechanismAssertions,
      ) &&
      (candidateManifest.tests as { mechanismAssertions: unknown[] }).mechanismAssertions.length > 0
    if ((treeV2Intent !== undefined || declaresAssertions === true) && !hasTests) {
      failStage(
        'typeLintUnit',
        'candidate.json declares mechanism assertions but the source ships no tests/',
      )
    } else {
      // oxlint ships a Node CLI; it runs by absolute interpreter path so the
      // sandbox's stripped PATH cannot break resolution. Lint only the
      // candidate's own code — never the TCB-assembled dependency closure.
      // (ADR-038: the stage-6 toolchain lives in type-lint-unit.ts so the
      // proposal-gateway `candidate-tests` handler runs the same checks.)
      const lint = await runOxlint(treeDir, hasTests)
      if (lint.code !== 0) {
        failStage(
          'typeLintUnit',
          `oxlint failed (exit ${lint.code}): ${lint.stdout.trim().slice(0, 1000)}`,
        )
      } else {
        let detail = 'oxlint clean over staged tree'
        if (hasTests) {
          const vitest = await runCandidateTests(workRoot, treeDir)
          if (vitest === undefined) {
            detail += '; candidate tests passed'
          } else {
            failStage('typeLintUnit', `candidate tests failed: ${vitest.slice(0, 1000)}`)
          }
        } else {
          detail += '; candidate ships no tests (and declares none)'
        }
        if (failed === undefined) receipts.typeLintUnit = { status: 'pass', detail }
      }
    }
  }

  // ---- stages 7–9: packed boot, unload invariant, mock replay -------------
  let bundleStats:
    { tarSha256: string; entrySha256: string; fileCount: number; bytes: number } | undefined
  let capsuleStats:
    | { tarSha256: string; archiveSha256: string; sbomSha256: string; provenanceSha256: string }
    | undefined
  let bootSolve: ProbeReport | undefined
  const expectedSolveTools = expectedStrategyNames(candidateManifest, 'newToolNames', 'solve')
  const expectedSolveSkills = expectedStrategyNames(candidateManifest, 'newSkillNames', 'solve')
  const expectedSolveAgentEvents = expectedStrategyNames(
    candidateManifest,
    'agentEventNames',
    'solve',
  )
  const expectedSolveSessionEvents = expectedStrategyNames(
    candidateManifest,
    'sessionEventNames',
    'solve',
  )
  const expectedSolveWorkflows = expectedStrategyNames(candidateManifest, 'workflowNames', 'solve')
  const expectedProposeTools = expectedStrategyNames(candidateManifest, 'newToolNames', 'propose')
  const expectedProposeSkills = expectedStrategyNames(candidateManifest, 'newSkillNames', 'propose')
  const expectedProposeAgentEvents = expectedStrategyNames(
    candidateManifest,
    'agentEventNames',
    'propose',
  )
  const expectedProposeSessionEvents = expectedStrategyNames(
    candidateManifest,
    'sessionEventNames',
    'propose',
  )
  const expectedProposeWorkflows = expectedStrategyNames(
    candidateManifest,
    'workflowNames',
    'propose',
  )
  let treeV2ModeFingerprints: TreeV2ModeFingerprints | undefined
  if (failed === undefined && source !== undefined && closure !== undefined) {
    // The capsule embeds its own pinned node interpreter (specs/02 §12): the
    // TB task images ship no node, so a missing or drifted reference is
    // builder-environment infrastructure failure — it throws (fail closed)
    // rather than poisoning the lineage with a fake candidate rejection.
    const nodeRuntime = await materializeNodeRuntime({ workDir: join(workRoot, 'node-runtime') })
    const toolchain = await toolchainFingerprints()
    const { bundle, files: bundleFiles } = await buildBundle(source, compiledDir)
    // The Loader resolves entries via bare import(packageName): install the
    // compiled bundle into the flat closure, then verify it like any other
    // package in runtime/install-manifest.json.
    const candidateVersion = JSON.parse(
      bundleFiles.find((file) => file.path === 'package.json')!.content.toString('utf8'),
    ) as { version?: string }
    await installCandidateIntoClosure(join(treeDir, 'node_modules'), bundleFiles, candidatePackage)
    const installManifest = await buildInstallManifest(join(treeDir, 'node_modules'), [
      ...closure.packages,
      { name: candidatePackage, version: candidateVersion.version ?? '?' },
    ])
    const docs = await assembleCapsule({
      capsuleDir,
      sourceTreeDir: treeDir,
      bundle,
      bundleFiles,
      installManifest,
      candidatePackage,
      candidateId,
      sourceDigest,
      toolchain: { node: toolchain.node, pnpm: toolchain.pnpm, typescript: toolchain.typescript },
      runnerSourceDir: coreLibDir,
      nodeRuntime,
    })

    // stage 7: real Loader boot of the packed capsule (solve mode). The
    // exposed sections must be exactly what candidate.json declares — the
    // declaration is the admission contract, not the baseline's shape.
    const solveRun = await runProbe(capsuleDir, 'cordis.yml', 60_000)
    if (solveRun.report === undefined) {
      failStage('loaderBoot', `capsule probe failed: ${solveRun.stderrOrError}`)
    } else {
      bootSolve = solveRun.report
      await writeFile(
        join(workRoot, 'boot-solve.json'),
        `${JSON.stringify(solveRun.raw, null, 2)}\n`,
        'utf8',
      )
      const expectedSolve = expectedSectionNames(candidateManifest, 'solve')
      const expectedPropose = expectedSectionNames(candidateManifest, 'propose')
      if (treeV2Intent === undefined && expectedSolve.length === 0) {
        failStage('loaderBoot', 'candidate.json declares no solve promptSections to verify')
      } else if (solveRun.report.error !== undefined) {
        failStage(
          'loaderBoot',
          `boot failed inside capsule: ${solveRun.report.error.slice(0, 1000)}`,
        )
      } else if (!sameSequence(solveRun.report.sections.afterBoot, expectedSolve)) {
        failStage(
          'loaderBoot',
          `solve-mode sections ${JSON.stringify(solveRun.report.sections.afterBoot)} != declared ${JSON.stringify(expectedSolve)}`,
        )
      } else if (
        !sameSequence(solveRun.report.strategy?.toolsAfterBoot ?? [], expectedSolveTools) ||
        !sameSequence(solveRun.report.strategy?.skillsAfterBoot ?? [], expectedSolveSkills) ||
        !sameSequence(
          solveRun.report.strategy?.agentEventsAfterBoot ?? [],
          expectedSolveAgentEvents,
        ) ||
        !sameSequence(
          solveRun.report.strategy?.sessionEventsAfterBoot ?? [],
          expectedSolveSessionEvents,
        ) ||
        !sameSequence(solveRun.report.strategy?.workflowsAfterBoot ?? [], expectedSolveWorkflows)
      ) {
        failStage(
          'loaderBoot',
          `solve-mode strategy ${JSON.stringify(solveRun.report.strategy)} != declared tools=${JSON.stringify(expectedSolveTools)} skills=${JSON.stringify(expectedSolveSkills)}`,
        )
      } else if (treeV2Intent === undefined && expectedPropose.length === 0) {
        failStage('loaderBoot', 'candidate.json declares no propose promptSections to verify')
      } else {
        if (treeV2Intent !== undefined) {
          treeV2ModeFingerprints = {
            // ADR-039: mask this candidate's own id out of section text —
            // identity is fixed content, not an evolvable mechanism.
            solve: treeV2RuntimeFingerprint(solveRun.report, 'solve', { candidateId }),
            propose: '',
          }
        }
        receipts.loaderBoot = {
          status: 'pass',
          detail: `packed capsule booted through the real Loader in an isolated one-shot process; sections ${JSON.stringify(solveRun.report.sections.afterBoot)}; boot ${Math.round(solveRun.report.timings.bootMs)}ms`,
        }
      }
    }

    // stage 8: unload invariant.
    if (failed === undefined && bootSolve !== undefined) {
      if (bootSolve.quiescent !== true) {
        failStage(
          'unloadInvariant',
          'post-unload inventory or process handles differ from the pre-boot baseline',
        )
      } else if (bootSolve.sections.afterUnload.length !== 0) {
        failStage(
          'unloadInvariant',
          `sections survived unload: ${bootSolve.sections.afterUnload.join(',')}`,
        )
      } else if (
        (bootSolve.strategy?.toolsAfterUnload?.length ?? 0) !== 0 ||
        (bootSolve.strategy?.skillsAfterUnload?.length ?? 0) !== 0 ||
        (bootSolve.strategy?.agentEventsAfterUnload?.length ?? 0) !== 0 ||
        (bootSolve.strategy?.sessionEventsAfterUnload?.length ?? 0) !== 0 ||
        (bootSolve.strategy?.workflowsAfterUnload?.length ?? 0) !== 0
      ) {
        failStage(
          'unloadInvariant',
          `strategy registrations survived unload: ${JSON.stringify(bootSolve.strategy)}`,
        )
      } else {
        receipts.unloadInvariant = {
          status: 'pass',
          detail:
            'Cordis inventory and process handles returned to baseline; candidate prompt, tool and skill registrations removed',
        }
      }
    }

    // stage 9: replay and native AgentLoop proof. The propose overlay checks
    // mode dispatch + lifecycle. Native capsules additionally execute one
    // deterministic offline turn through ctx.agents.create(), then ACP checks
    // the locked wire surface. This is a composition proof, not an evaluation.
    if (failed === undefined) {
      await writeFile(
        join(capsuleDir, 'cordis.propose.yml'),
        bootConfig(
          candidatePackage,
          candidateId,
          'propose',
          nativeDshClosurePresent(installManifest.entries) ? {} : undefined,
        ),
        'utf8',
      )
      const proposeRun = await runProbe(capsuleDir, 'cordis.propose.yml', 60_000)
      if (proposeRun.report === undefined) {
        failStage('mockReplay', `propose-mode probe failed: ${proposeRun.stderrOrError}`)
      } else {
        await writeFile(
          join(workRoot, 'boot-propose.json'),
          `${JSON.stringify(proposeRun.raw, null, 2)}\n`,
          'utf8',
        )
        const sections = proposeRun.report.sections
        if (proposeRun.report.error !== undefined) {
          failStage(
            'mockReplay',
            `propose-mode boot failed: ${proposeRun.report.error.slice(0, 1000)}`,
          )
        } else if (
          !sameSequence(sections.afterBoot, expectedSectionNames(candidateManifest, 'propose'))
        ) {
          failStage(
            'mockReplay',
            `propose-mode sections ${JSON.stringify(sections.afterBoot)} != declared ${JSON.stringify(expectedSectionNames(candidateManifest, 'propose'))}`,
          )
        } else if (
          !sameSequence(proposeRun.report.strategy?.toolsAfterBoot ?? [], expectedProposeTools) ||
          !sameSequence(proposeRun.report.strategy?.skillsAfterBoot ?? [], expectedProposeSkills) ||
          !sameSequence(
            proposeRun.report.strategy?.agentEventsAfterBoot ?? [],
            expectedProposeAgentEvents,
          ) ||
          !sameSequence(
            proposeRun.report.strategy?.sessionEventsAfterBoot ?? [],
            expectedProposeSessionEvents,
          ) ||
          !sameSequence(
            proposeRun.report.strategy?.workflowsAfterBoot ?? [],
            expectedProposeWorkflows,
          )
        ) {
          failStage(
            'mockReplay',
            `propose-mode strategy ${JSON.stringify(proposeRun.report.strategy)} != declared tools=${JSON.stringify(expectedProposeTools)} skills=${JSON.stringify(expectedProposeSkills)}`,
          )
        } else if (
          !proposeRun.report.quiescent ||
          sections.afterUnload.length !== 0 ||
          (proposeRun.report.strategy?.toolsAfterUnload?.length ?? 0) !== 0 ||
          (proposeRun.report.strategy?.skillsAfterUnload?.length ?? 0) !== 0 ||
          (proposeRun.report.strategy?.agentEventsAfterUnload?.length ?? 0) !== 0 ||
          (proposeRun.report.strategy?.sessionEventsAfterUnload?.length ?? 0) !== 0 ||
          (proposeRun.report.strategy?.workflowsAfterUnload?.length ?? 0) !== 0
        ) {
          failStage('mockReplay', 'propose-mode unload did not return to baseline')
        } else if (treeV2Intent !== undefined && treeV2ModeFingerprints !== undefined) {
          // Every tree-v2 build — root or child — records the propose-mode
          // Loader fingerprint: the build manifest schema requires both mode
          // fingerprints, and the migration root's fingerprints are what a
          // later child's runtime mode contract is checked against.
          treeV2ModeFingerprints.propose = treeV2RuntimeFingerprint(proposeRun.report, 'propose', { candidateId })
        }
      }
      let nativeTurnDetail = ''
      if (failed === undefined && nativeDshClosurePresent(installManifest.entries)) {
        const nativeTurn = await runNativeTurnProbe(capsuleDir, 'cordis.yml', 60_000)
        if (nativeTurn.report === undefined) {
          failStage('mockReplay', `native AgentLoop probe failed: ${nativeTurn.stderrOrError}`)
        } else {
          await writeFile(
            join(workRoot, 'native-turn-solve.json'),
            `${JSON.stringify(nativeTurn.raw, null, 2)}\n`,
            'utf8',
          )
          if (nativeTurn.report.error !== undefined) {
            failStage(
              'mockReplay',
              `native AgentLoop turn failed: ${nativeTurn.report.error.slice(0, 1000)}`,
            )
          } else if (!nativeTurn.report.nativeComposition) {
            failStage('mockReplay', 'native capsule boot did not mount ctx.agents.create()')
          } else if (!nativeTurn.report.quiescent) {
            failStage('mockReplay', 'native AgentLoop turn did not return to the pre-boot baseline')
          } else if (
            nativeTurn.report.turn === undefined ||
            nativeTurn.report.turn.eventCount === 0
          ) {
            failStage('mockReplay', 'native AgentLoop turn emitted no attributable session events')
          } else if (
            nativeTurn.report.turn.toolCallEventCount !== 1 ||
            nativeTurn.report.turn.toolResultEventCount !== 1
          ) {
            failStage(
              'mockReplay',
              'native AgentLoop did not complete the candidate strategy tool dispatch',
            )
          } else {
            nativeTurnDetail =
              `; native ctx.agents.create() turn emitted ${nativeTurn.report.turn.eventCount} session events` +
              ` and one candidate strategy tool call/result in ${Math.round(nativeTurn.report.timings.turnMs ?? 0)}ms with clean unload`
          }
        }
      }
      let nativeProposalDetail = ''
      if (failed === undefined && nativeDshClosurePresent(installManifest.entries)) {
        const nativeProposal = await runNativeProposalProbe(
          capsuleDir,
          'cordis.propose.yml',
          60_000,
        )
        if (nativeProposal.report === undefined) {
          failStage(
            'mockReplay',
            `native proposal AgentLoop probe failed: ${nativeProposal.stderrOrError}`,
          )
        } else {
          await writeFile(
            join(workRoot, 'native-proposal.json'),
            `${JSON.stringify(nativeProposal.raw, null, 2)}\n`,
            'utf8',
          )
          if (nativeProposal.report.error !== undefined) {
            failStage(
              'mockReplay',
              `native proposal AgentLoop turn failed: ${nativeProposal.report.error.slice(0, 1000)}`,
            )
          } else if (!nativeProposal.report.nativeComposition) {
            failStage(
              'mockReplay',
              'native proposal capsule boot did not mount ctx.agents.create()',
            )
          } else if (!nativeProposal.report.quiescent) {
            failStage(
              'mockReplay',
              'native proposal AgentLoop did not return to the pre-boot baseline',
            )
          } else if (
            nativeProposal.report.proposal === undefined ||
            nativeProposal.report.proposal.eventCount === 0
          ) {
            failStage(
              'mockReplay',
              'native proposal AgentLoop emitted no attributable session events',
            )
          } else if (
            nativeProposal.report.proposal.toolCallEventCount !== 3 ||
            nativeProposal.report.proposal.toolResultEventCount !== 3 ||
            nativeProposal.report.proposal.backendWrites.length !== 1
          ) {
            failStage(
              'mockReplay',
              'native proposal AgentLoop did not complete bounded list/write/finish tool dispatch',
            )
          } else {
            nativeProposalDetail =
              `; native proposal ctx.agents.create() emitted ${nativeProposal.report.proposal.eventCount} session events` +
              ` and bounded list/write/finish tool calls in ${Math.round(nativeProposal.report.timings.proposalMs ?? 0)}ms with clean unload`
          }
        }
      }
      let nativeSolveDetail = ''
      if (failed === undefined && nativeDshClosurePresent(installManifest.entries)) {
        const nativeSolve = await runNativeSolveProbe(capsuleDir, 'cordis.yml', 60_000)
        if (nativeSolve.report === undefined) {
          failStage('mockReplay', `native ACP solve probe failed: ${nativeSolve.stderrOrError}`)
        } else {
          await writeFile(
            join(workRoot, 'native-solve.json'),
            `${JSON.stringify(nativeSolve.raw, null, 2)}\n`,
            'utf8',
          )
          const solve = nativeSolve.report.solve
          if (nativeSolve.report.error !== undefined) {
            failStage(
              'mockReplay',
              `native ACP solve turn failed: ${nativeSolve.report.error.slice(0, 1000)}`,
            )
          } else if (!nativeSolve.report.nativeComposition) {
            failStage(
              'mockReplay',
              'native ACP solve capsule boot did not mount ctx.agents.create()',
            )
          } else if (!nativeSolve.report.quiescent) {
            failStage('mockReplay', 'native ACP solve did not return to the pre-boot baseline')
          } else if (solve === undefined || solve.eventCount === 0) {
            failStage('mockReplay', 'native ACP solve emitted no attributable session events')
          } else if (
            solve.completionCount !== 4 ||
            solve.toolCallEventCount !== 3 ||
            solve.toolResultEventCount !== 3 ||
            solve.terminalCalls.length !== 1 ||
            solve.readPaths.length !== 1 ||
            solve.writes.length !== 1 ||
            solve.assistantChunks.length === 0
          ) {
            failStage(
              'mockReplay',
              'native ACP solve did not complete bounded exec/read/write tool dispatch',
            )
          } else {
            if (treeV2ModeFingerprints !== undefined && bootSolve !== undefined) {
              treeV2ModeFingerprints.solve = treeV2RuntimeFingerprint(bootSolve, 'solve', {
                candidateId,
                solvePolicyProbe: {
                  candidateCheckpointCount: solve.candidateCheckpointCount,
                  candidateCheckpointSha256: solve.candidateCheckpointSha256,
                  strategyUsage: solve.strategyUsage,
                },
              })
              treeV2ModeFingerprints.solvePolicy = treeV2SolvePolicyFingerprint({
                candidateCheckpointCount: solve.candidateCheckpointCount,
                candidateCheckpointSha256: solve.candidateCheckpointSha256,
                strategyUsage: solve.strategyUsage,
              })
            }
            nativeSolveDetail =
              `; native ACP ctx.agents.create() solve emitted ${solve.eventCount} session events` +
              ` and bounded exec/read/write tool calls in ${Math.round(nativeSolve.report.timings.solveMs ?? 0)}ms with clean unload`
          }
        }
      }
      if (
        failed === undefined &&
        treeV2Intent !== undefined &&
        treeV2Intent.parent !== null &&
        treeV2ModeFingerprints !== undefined
      ) {
        try {
          assertTreeV2RuntimeModeContract(
            treeV2Intent.modeContract,
            input.treeV2ParentEvidence!.modeFingerprints,
            treeV2ModeFingerprints,
          )
        } catch (error) {
          failStage('mockReplay', error instanceof Error ? error.message : String(error))
        }
      }
      if (failed === undefined) {
        // Same rule as runProbe: the ACP round must run on the embedded
        // runtime the task containers will exec, not on the host interpreter.
        const argv = sandboxedInteractiveCommand(join(capsuleDir, 'runtime/node'), [
          join(capsuleDir, 'runner/bin/acp-boot.js'),
          'cordis.yml',
        ])
        const acp = await runAcpSession(argv.command, argv.args, {
          cwd: capsuleDir,
          env: sandboxEnvironment(),
          timeoutMs: 60_000,
        })
        await writeFile(
          join(workRoot, 'acp-solve.json'),
          `${JSON.stringify(acp, null, 2)}\n`,
          'utf8',
        )
        const chunks = acp.updates
          .filter((update) => update.sessionUpdate === 'agent_message_chunk')
          .map((update) => update.content?.text ?? '')
        if (acp.timedOut || acp.exitCode !== 0) {
          failStage(
            'mockReplay',
            `ACP round failed (exit ${acp.exitCode}${acp.timedOut ? ', timed out' : ''}): ${acp.stopReason.slice(0, 500)}`,
          )
        } else if (acp.initialize.protocolVersion !== 1) {
          failStage(
            'mockReplay',
            `ACP initialize returned protocolVersion ${acp.initialize.protocolVersion}`,
          )
        } else if (acp.stopReason !== 'end_turn') {
          failStage('mockReplay', `ACP prompt stopReason ${acp.stopReason} != end_turn`)
        } else if (
          acp.report === undefined ||
          !acp.report.quiescent ||
          acp.report.sections.afterUnload.length !== 0
        ) {
          failStage('mockReplay', 'ACP runner did not return to baseline after client disconnect')
        } else {
          // Every declared solve section must stream back in the turn.
          const missing = expectedSectionNames(candidateManifest, 'solve').filter(
            (name) => !chunks.some((text) => text.includes(`[${name}]`)),
          )
          if (missing.length > 0) {
            failStage(
              'mockReplay',
              `declared solve sections absent from the ACP turn stream: ${missing.join(',')}`,
            )
          }
        }
        if (failed === undefined) {
          receipts.mockReplay = {
            status: 'pass',
            detail:
              'ACP initialize/session/prompt round over @agentclientprotocol/sdk 0.25.1 (the locked dsh-acp wire surface) through the real Loader: all declared solve sections streamed in the turn, end_turn, unload invariant held; propose overlay dispatched the declared propose sections with clean unload; recorded-LLM replay lands with the staged DSH production closure (Gate 2)' +
              nativeTurnDetail +
              nativeProposalDetail +
              nativeSolveDetail,
          }
        }
      }
    }

    // stage 10: capsule double build. Both trees are assembled fresh so the
    // shipped capsule is exactly the double-built artifact — untainted by the
    // stage 7–9 probe runs and their scratch propose overlay.
    if (failed === undefined) {
      const assembleOptions = {
        sourceTreeDir: treeDir,
        bundle,
        bundleFiles,
        installManifest,
        candidatePackage,
        candidateId,
        sourceDigest,
        toolchain: { node: toolchain.node, pnpm: toolchain.pnpm, typescript: toolchain.typescript },
        runnerSourceDir: coreLibDir,
        nodeRuntime,
      } as const
      await rm(capsuleDir, { recursive: true, force: true })
      await assembleCapsule({ ...assembleOptions, capsuleDir })
      const first = await archiveCapsule(capsuleDir)
      const secondDir = join(workRoot, 'capsule-2')
      await assembleCapsule({ ...assembleOptions, capsuleDir: secondDir })
      const second = await archiveCapsule(secondDir)
      if (first.tarSha256 !== second.tarSha256) {
        failStage(
          'capsuleDoubleBuild',
          `capsule tars differ: ${first.tarSha256.slice(0, 16)}… vs ${second.tarSha256.slice(0, 16)}…`,
        )
      } else if (first.archiveSha256 !== second.archiveSha256) {
        failStage(
          'capsuleDoubleBuild',
          `capsule tar.gz archives differ: ${first.archiveSha256.slice(0, 16)}… vs ${second.archiveSha256.slice(0, 16)}…`,
        )
      } else {
        await writeFile(join(workRoot, 'capsule.tar'), first.tar)
        await writeFile(join(workRoot, 'capsule.tar.gz'), first.archive)
        bundleStats = {
          tarSha256: bundle.tarSha256,
          entrySha256: bundle.entrySha256,
          fileCount: bundle.fileCount,
          bytes: bundle.bytes,
        }
        capsuleStats = {
          tarSha256: first.tarSha256,
          archiveSha256: first.archiveSha256,
          sbomSha256: docs.sbomSha256,
          provenanceSha256: docs.provenanceSha256,
        }
        receipts.capsuleDoubleBuild = {
          status: 'pass',
          detail: `two capsule assemblies byte-identical (tar and tar.gz; ${first.fileCount} files, ${first.bytes} bytes); tar ${first.tarSha256.slice(0, 16)}…, archive ${first.archiveSha256.slice(0, 16)}…`,
        }
      }
    }
  } else if (failed === undefined) {
    failStage('loaderBoot', 'internal: stages reached boot without compiled artifacts')
  }

  // ---- manifest ----------------------------------------------------------
  const outcome: 'admitted' | 'rejected' = failed === undefined ? 'admitted' : 'rejected'
  const toolchainOnce = await toolchainFingerprints()
  const manifest: Record<string, unknown> = {
    $schema: 'https://dsh-evolve-le.local/schemas/build.manifest.schema.json',
    schemaVersion: 1,
    candidateId,
    outcome,
    ...(outcome === 'rejected' && failed !== undefined ? { rejection: failed } : {}),
    identity: { sourceDigest, canonicalParent },
    ...(source !== undefined && failed === undefined
      ? {
          source: {
            fileCount: source.files.length,
            bytes: source.bytes,
            treeDigest: { algo: TREE_DIGEST_ALGO, value: treeDigestValue },
          },
        }
      : {}),
    ...(bundleStats !== undefined ? { bundle: bundleStats } : {}),
    ...(capsuleStats !== undefined ? { capsule: capsuleStats } : {}),
    ...(parentDiff !== undefined ? { parentDiff } : {}),
    ...(failed === undefined && closure !== undefined
      ? {
          fingerprints: {
            node: toolchainOnce.node,
            pnpm: toolchainOnce.pnpm,
            typescript: toolchainOnce.typescript,
            dependencyClosureSha256: closure.digest,
            tsconfigSha256: compileTsconfigSha256,
          },
        }
      : {}),
    ...(treeV2Intent !== undefined && treeV2ModeFingerprints !== undefined
      ? {
          treeV2: {
            protocol: treeV2Intent.protocol,
            modeContract: treeV2Intent.modeContract,
            ...(treeV2Intent.requiredParentEvidence === undefined
              ? {}
              : { requiredParentEvidence: treeV2Intent.requiredParentEvidence }),
            modeFingerprints: treeV2ModeFingerprints,
          },
        }
      : {}),
    receipts,
    builder: {
      builtAt: new Date().toISOString(),
      sandbox: describeSandbox(),
      networkAccess: false,
      executedCandidateLifecycleScript: false,
    },
  }

  const manifestCheck = validateManifest('build', manifest)
  if (!manifestCheck.ok) {
    throw new Error(
      `builder produced an invalid build manifest (builder bug): ${manifestCheck.error.errors.map((e) => String(e)).join('; ')}`,
    )
  }
  const buildManifestPath = join(workRoot, 'build-manifest.json')
  await writeFile(buildManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  let treeV2BuildReceipts: TreeV2BuildReceipts | undefined
  if (
    outcome === 'admitted' &&
    treeV2Intent !== undefined &&
    treeV2ModeFingerprints !== undefined
  ) {
    const capabilityCatalog = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: treeV2Intent.protocol,
      kind: 'capability-catalog' as const,
      candidateDigest: sourceDigest,
      capabilities: [...treeV2Intent.runtime.capabilities].sort(),
    })
    const materialization = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: treeV2Intent.protocol,
      kind: 'materialization-receipt' as const,
      parentCandidateDigest: treeV2Intent.parent?.candidateDigest ?? null,
      candidateDigest: sourceDigest,
      candidateIntentDigest: treeV2Intent.receiptDigest,
      sourceDigest,
      capabilityCatalogDigest: capabilityCatalog.receiptDigest,
    })
    const mechanismOutcome = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: treeV2Intent.protocol,
      kind: 'mechanism-outcome' as const,
      candidateIntentDigest: treeV2Intent.receiptDigest,
      mechanismTestDigest: treeV2Digest({
        command: treeV2Intent.tests.command,
        tests: [...treeV2Intent.tests.mechanism].sort(),
        receipt: receipts.typeLintUnit,
      }),
      outcome: 'passed' as const,
    })
    const admission = finalizeTreeV2Receipt({
      schemaVersion: 2,
      protocol: treeV2Intent.protocol,
      kind: 'admission-receipt' as const,
      candidateDigest: sourceDigest,
      buildDigest: treeV2Digest(manifest),
      materializationDigest: materialization.receiptDigest,
      capabilityCatalogDigest: capabilityCatalog.receiptDigest,
      modeFingerprints: treeV2ModeFingerprints,
      admitted: true as const,
    })
    assertTreeV2ReceiptDocument('mechanism-outcome', mechanismOutcome)
    assertTreeV2ReceiptDocument('capability-catalog', capabilityCatalog)
    assertTreeV2ReceiptDocument('materialization-receipt', materialization)
    assertTreeV2ReceiptDocument('admission-receipt', admission)
    treeV2BuildReceipts = {
      mechanismOutcome,
      capabilityCatalog,
      materialization,
      admission,
    }
    const receiptDir = join(workRoot, 'tree-v2-receipts')
    await mkdir(receiptDir, { recursive: true })
    const receiptFiles = {
      'mechanism-outcome': mechanismOutcome,
      'capability-catalog': capabilityCatalog,
      'materialization-receipt': materialization,
      'admission-receipt': admission,
    }
    for (const [name, receipt] of Object.entries(receiptFiles)) {
      await writeFile(
        join(receiptDir, `${name}.json`),
        `${JSON.stringify(receipt, null, 2)}\n`,
        'utf8',
      )
    }
  }

  return {
    candidateId: manifest.candidateId as string,
    sourceDigest,
    outcome,
    ...(failed !== undefined ? { rejection: failed } : {}),
    receipts,
    ...(bundleStats !== undefined ? { bundle: bundleStats } : {}),
    ...(capsuleStats !== undefined ? { capsule: capsuleStats } : {}),
    ...(treeV2Intent !== undefined &&
    treeV2ModeFingerprints !== undefined &&
    treeV2BuildReceipts !== undefined
      ? {
          treeV2: {
            protocol: treeV2Intent.protocol,
            modeFingerprints: treeV2ModeFingerprints,
            receipts: treeV2BuildReceipts,
          },
        }
      : {}),
    artifacts: {
      workRoot,
      treeDir,
      capsuleDir,
      capsuleTar: join(workRoot, 'capsule.tar'),
      capsuleArchive: join(workRoot, 'capsule.tar.gz'),
      buildManifestPath,
      ...(treeV2BuildReceipts === undefined
        ? {}
        : { treeV2ReceiptsDir: join(workRoot, 'tree-v2-receipts') }),
    },
    manifest,
  }
}

// ---------------------------------------------------------------------------

interface ProbeRun {
  report: ProbeReport | undefined
  raw: unknown
  stderrOrError: string
}

interface NativeTurnProbeRun {
  report: NativeTurnProbeReport | undefined
  raw: unknown
  stderrOrError: string
}

interface NativeProposalProbeRun {
  report: NativeProposalProbeReport | undefined
  raw: unknown
  stderrOrError: string
}

interface NativeSolveProbeRun {
  report: NativeSolveProbeReport | undefined
  raw: unknown
  stderrOrError: string
}

async function runProbe(
  capsuleDir: string,
  configName: string,
  timeoutMs: number,
): Promise<ProbeRun> {
  // Boot through the capsule's own embedded runtime, not the host node: the
  // probe must exercise exactly the interpreter the task containers exec.
  const run = await runSandboxed(
    join(capsuleDir, 'runtime/node'),
    [join(capsuleDir, 'runner/bin/probe.js'), configName],
    { cwd: capsuleDir, timeoutMs },
  )
  let report: ProbeReport | undefined
  try {
    report = JSON.parse(run.stdout) as ProbeReport
  } catch {
    // fall through: report stays undefined
  }
  return {
    report,
    raw: report ?? {
      unparsed: run.stdout.slice(0, 4000),
      stderr: run.stderr.slice(0, 4000),
      code: run.code,
      timedOut: run.timedOut,
    },
    stderrOrError: run.timedOut
      ? `probe timed out after ${timeoutMs}ms`
      : run.stderr.slice(0, 2000) || `exit ${run.code}`,
  }
}

/** Execute the native AgentLoop proof through the capsule's own Node binary. */
async function runNativeTurnProbe(
  capsuleDir: string,
  configName: string,
  timeoutMs: number,
): Promise<NativeTurnProbeRun> {
  const run = await runSandboxed(
    join(capsuleDir, 'runtime/node'),
    [join(capsuleDir, 'runner/bin/native-turn-probe.js'), configName],
    { cwd: capsuleDir, timeoutMs },
  )
  let report: NativeTurnProbeReport | undefined
  try {
    report = JSON.parse(run.stdout) as NativeTurnProbeReport
  } catch {
    // fall through: report stays undefined
  }
  return {
    report,
    raw: report ?? {
      unparsed: run.stdout.slice(0, 4000),
      stderr: run.stderr.slice(0, 4000),
      code: run.code,
      timedOut: run.timedOut,
    },
    stderrOrError: run.timedOut
      ? `native AgentLoop probe timed out after ${timeoutMs}ms`
      : run.stderr.slice(0, 2000) || `exit ${run.code}`,
  }
}

/** Execute the native proposal tool-loop proof through the capsule runtime. */
async function runNativeProposalProbe(
  capsuleDir: string,
  configName: string,
  timeoutMs: number,
): Promise<NativeProposalProbeRun> {
  const run = await runSandboxed(
    join(capsuleDir, 'runtime/node'),
    [join(capsuleDir, 'runner/bin/native-proposal-probe.js'), configName],
    { cwd: capsuleDir, timeoutMs },
  )
  let report: NativeProposalProbeReport | undefined
  try {
    report = JSON.parse(run.stdout) as NativeProposalProbeReport
  } catch {
    // fall through: report stays undefined
  }
  return {
    report,
    raw: report ?? {
      unparsed: run.stdout.slice(0, 4000),
      stderr: run.stderr.slice(0, 4000),
      code: run.code,
      timedOut: run.timedOut,
    },
    stderrOrError: run.timedOut
      ? `native proposal AgentLoop probe timed out after ${timeoutMs}ms`
      : run.stderr.slice(0, 2000) || `exit ${run.code}`,
  }
}

/** Execute the native ACP solve proof through the capsule's own Node runtime. */
async function runNativeSolveProbe(
  capsuleDir: string,
  configName: string,
  timeoutMs: number,
): Promise<NativeSolveProbeRun> {
  const run = await runSandboxed(
    join(capsuleDir, 'runtime/node'),
    [join(capsuleDir, 'runner/bin/native-solve-probe.js'), configName],
    { cwd: capsuleDir, timeoutMs },
  )
  let report: NativeSolveProbeReport | undefined
  try {
    report = JSON.parse(run.stdout) as NativeSolveProbeReport
  } catch {
    // fall through: report stays undefined
  }
  return {
    report,
    raw: report ?? {
      unparsed: run.stdout.slice(0, 4000),
      stderr: run.stderr.slice(0, 4000),
      code: run.code,
      timedOut: run.timedOut,
    },
    stderrOrError: run.timedOut
      ? `native ACP solve probe timed out after ${timeoutMs}ms`
      : run.stderr.slice(0, 2000) || `exit ${run.code}`,
  }
}

// (stage 6's oxlint + candidate-test toolchain was extracted to
// type-lint-unit.ts by ADR-038 so the proposal gateway runs the same checks)
