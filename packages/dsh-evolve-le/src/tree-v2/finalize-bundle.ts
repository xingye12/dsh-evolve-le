/**
 * TCB finalization of a live-model tree-v2 proposal bundle (ADR-034).
 *
 * A real model cannot compute canonical-JSON sha256 digests — attempt 7 proved
 * it fabricates digest-looking strings (copied parent digests, concatenated
 * evidence digests, random hex) and trips the strict receipt schemas (extra
 * `$schema` keys, missing required fields). Digests are content-addressed
 * bindings between documents and must be DERIVED, never authored: this module
 * rebuilds each child's analysis receipt, candidate-intent parent evidence and
 * proposal receipt from the model's semantic fields at the proposal tool
 * boundary, before the bundle shape check and before anything is written.
 *
 * Everything here is re-verified independently by the controller
 * (`assertTreeV2ReceiptDocument`, `validateProposalBundle`); the raw model
 * bundle stays in the transcript's tool-call events, so the derivation is
 * auditable. Structural impossibilities throw — the same proposal-failure
 * outcome a controller rejection would have produced, never a silent repair.
 * @module @dsh-evolve-le/core/tree-v2/finalize-bundle
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../state/canonical.js'
import type { ArchiveCatalog } from '../proposer/catalog.js'
import type { ExportManifest } from '../proposer/export.js'
import type { ProposalOutput } from '../proposer/protocol.js'
import type { TreeV2CandidateIntent, TreeV2RequiredParentEvidence } from './contract.js'
import type { TreeV2AnalysisReceipt, TreeV2ProposalReceipt } from './receipts.js'

/**
 * Keep this literal in sync with `TREE_V2_PROTOCOL` in `tree-v2/contract.ts`
 * (tests/tree-v2/finalize-bundle.test.ts asserts equality). The proposal
 * sandbox's worker runtime tree ships only dependency-light modules, so this
 * module must not import contract.ts at runtime — the same pattern
 * proposer/policy.ts already uses for its recorded receipts.
 */
const TREE_V2_PROTOCOL = 'dsh-self-evolving-candidate-tree-v2'

export class TreeV2FinalizationError extends Error {
  constructor(message: string) {
    super(`tree-v2 finalization: ${message}`)
    this.name = 'TreeV2FinalizationError'
  }
}

const DIGEST = /^sha256:[a-f0-9]{64}$/
/** Same safe-directory pattern parseProposalOutput enforces for child names. */
const CHILD_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
/**
 * Mirror of the private PRODUCTION_FILE pattern in tree-v2/contract.ts
 * (this module must not import contract.ts — the worker runtime tree ships
 * only dependency-light modules). The boundary check below only runs this
 * pattern against model-authored strings before any join(), never as a
 * substitute for the controller's SOURCE_FILE/production checks.
 */
const PRODUCTION_FILE = /^src\/[A-Za-z0-9][A-Za-z0-9._/-]*\.ts$/
/** Mirror of the private TEST_FILE pattern in tree-v2/contract.ts. */
const TEST_FILE = /^tests\/[A-Za-z0-9][A-Za-z0-9._/-]*\.spec\.ts$/
/** Successor root capability introduced by ADR-055. */
const SOLVE_POLICY_WORKFLOW = 'candidate-workflow:solve-policy'

function fail(message: string): never {
  throw new TreeV2FinalizationError(message)
}

/**
 * Canonical-serialized receipt digest — byte-identical to
 * `finalizeTreeV2Receipt`/`treeV2Digest` in `tree-v2/contract.ts` (canonical
 * JSON over the unsigned document, prefixed `sha256:`).
 */
function finalizeReceipt<T extends Record<string, unknown>>(
  receipt: T,
): T & { receiptDigest: string } {
  return {
    ...receipt,
    receiptDigest: `sha256:${sha256Hex(canonicalJson(receipt))}`,
  }
}

export interface FinalizeTreeV2BundleOptions {
  /** Raw model-authored bundle (proposal/v2). */
  proposal: ProposalOutput
  /** The model-written child trees (`work/children`). */
  childrenRoot: string
  /** The label-filtered export manifest the model actually read. */
  exportManifest: ExportManifest
  /** Trusted parent facts from the supervisor config. */
  treeV2Parent: { candidateDigest: string; mechanismOutcomeDigest: string }
  /** Trusted parent source hash from the supervisor config. */
  parentSourceHash: string
  /** The staged archive catalog (dev-observed only); donor source of truth. */
  catalog: ArchiveCatalog
  /**
   * TCB-staged parent source view (path → utf8 content), the same files
   * parent-files.json names. ADR-037: the finalizer enforces the projection
   * contract at the submit boundary against this view — modeComponents may
   * only name parent-existing production modules. A v2 bundle finalized
   * without it fails closed.
   */
  parentSourceFiles: Readonly<Record<string, string>>
}

/** String array with at least one non-empty entry, no duplicates. */
function assertStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    fail(`${label} must be a non-empty string array`)
  }
  const list = value as string[]
  if (new Set(list).size !== list.length) fail(`${label} must not contain duplicates`)
  return list
}

/**
 * Resolve one `sha256:<hex>` evidence ref to an object of the export with the
 * given media suffix. Export manifest digests are BARE hex (validate.ts strips
 * the receipt prefix the same way).
 */
function exportObjectOf(manifest: ExportManifest, digest: string, mediaSuffix: string): boolean {
  return manifest.objects.some(
    (object) =>
      object.digest === digest.slice('sha256:'.length) && object.mediaType.endsWith(mediaSuffix),
  )
}

/**
 * Repair one child's documents and rewrite its candidate.json. Mutates the
 * given child entry in place and returns the finalized receipts.
 */
async function finalizeChild(
  options: FinalizeTreeV2BundleOptions,
  child: NonNullable<ProposalOutput['children'][number]>,
): Promise<void> {
  const { childrenRoot, exportManifest, treeV2Parent, parentSourceHash, catalog } = options
  const childRecord = child as unknown as Record<string, unknown>
  // childName is model-authored and becomes a filesystem path below: it must
  // pass the same safe-directory pattern the controller enforces, before any
  // join() touches it.
  if (typeof child.childName !== 'string' || !CHILD_NAME_PATTERN.test(child.childName)) {
    fail(`child name ${String(child.childName)} is not a safe directory name`)
  }

  // --- candidate-intent (the model's candidate.json) ----------------------
  const intentPath = join(childrenRoot, child.childName, 'candidate.json')
  let intentRaw: Record<string, unknown>
  try {
    intentRaw = JSON.parse(await readFile(intentPath, 'utf8')) as Record<string, unknown>
  } catch (error) {
    fail(
      `child ${child.childName} candidate.json unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (
    intentRaw['schemaVersion'] !== 2 ||
    intentRaw['protocol'] !== TREE_V2_PROTOCOL ||
    intentRaw['kind'] !== 'candidate-intent'
  ) {
    fail(`child ${child.childName} candidate.json is not a tree-v2 candidate-intent`)
  }

  // --- analysis receipt ----------------------------------------------------
  const rawAnalysis = childRecord['analysisReceipt']
  if (rawAnalysis === null || typeof rawAnalysis !== 'object' || Array.isArray(rawAnalysis)) {
    fail(`child ${child.childName} has no analysis receipt`)
  }
  const analysisRecord = rawAnalysis as Record<string, unknown>
  const findings = assertStringList(analysisRecord['findings'], `child ${child.childName} findings`)
  const evidenceDigests = assertStringList(
    analysisRecord['evidenceDigests'],
    `child ${child.childName} evidenceDigests`,
  )
  for (const digest of evidenceDigests) {
    if (!DIGEST.test(digest)) {
      fail(`child ${child.childName} evidence digest ${digest} is not sha256:<64-hex>`)
    }
    if (
      !exportManifest.objects.some((object) => object.digest === digest.slice('sha256:'.length))
    ) {
      fail(
        `child ${child.childName} evidence ref ${digest} is not an object of the export the model read`,
      )
    }
  }
  const analysis = finalizeReceipt({
    schemaVersion: 2,
    protocol: TREE_V2_PROTOCOL,
    kind: 'analysis',
    parentCandidateDigest: treeV2Parent.candidateDigest,
    findings,
    evidenceDigests,
  }) as TreeV2AnalysisReceipt

  // --- named parent evidence (the model's two evidence choices) ------------
  const rawProposal = childRecord['proposalReceipt']
  if (rawProposal === null || typeof rawProposal !== 'object' || Array.isArray(rawProposal)) {
    fail(`child ${child.childName} has no proposal receipt`)
  }
  const rawEvidence = (rawProposal as Record<string, unknown>)['requiredParentEvidence']
  const evidenceRecord =
    rawEvidence !== null && typeof rawEvidence === 'object' && !Array.isArray(rawEvidence)
      ? (rawEvidence as Record<string, unknown>)
      : undefined
  const evidenceChoice = (name: 'normalizedTrialDigest' | 'trajectoryDigest'): string => {
    const value = evidenceRecord?.[name]
    if (typeof value !== 'string' || !DIGEST.test(value)) {
      fail(`child ${child.childName} ${name} is not sha256:<64-hex>`)
    }
    return value
  }
  const normalizedTrialDigest = evidenceChoice('normalizedTrialDigest')
  const trajectoryDigest = evidenceChoice('trajectoryDigest')
  if (!exportObjectOf(exportManifest, normalizedTrialDigest, 'normalized-trial+json')) {
    fail(
      `child ${child.childName} normalizedTrialDigest does not resolve to a normalized-trial object of the export`,
    )
  }
  if (!exportObjectOf(exportManifest, trajectoryDigest, 'trajectory+json')) {
    fail(
      `child ${child.childName} trajectoryDigest does not resolve to a trajectory object of the export`,
    )
  }
  // Both named evidence digests must be cited by the analysis (closes the
  // hollow-evidence hole: a fabricated but pattern-valid digest would verify).
  for (const [name, digest] of [
    ['normalizedTrialDigest', normalizedTrialDigest],
    ['trajectoryDigest', trajectoryDigest],
  ] as const) {
    if (!evidenceDigests.includes(digest)) {
      fail(`child ${child.childName} ${name} is absent from the analysis evidenceDigests`)
    }
  }
  const requiredParentEvidence: TreeV2RequiredParentEvidence = {
    analysisDigest: analysis.receiptDigest,
    mechanismOutcomeDigest: treeV2Parent.mechanismOutcomeDigest,
    normalizedTrialDigest,
    trajectoryDigest,
  }

  // --- intent repair: TCB-forced bindings, model-authored rest -------------
  // The model's candidate.json must carry the full static contract; the
  // controller re-validates it against the strict schema, so missing sections
  // here fail with a finalization error instead of a controller rejection —
  // same outcome, earlier and with a local message.
  for (const section of ['candidate', 'modeContract', 'runtime', 'tests'] as const) {
    const value = intentRaw[section]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(`child ${child.childName} candidate.json is missing the ${section} section`)
    }
  }
  const { receiptDigest: _drop, ...intentUnsigned } = intentRaw
  const intentBase = intentUnsigned as unknown as Omit<
    TreeV2CandidateIntent,
    'parent' | 'requiredParentEvidence' | 'receiptDigest'
  >

  // --- modeComponents projection contract (ADR-037) ------------------------
  // modeComponents names ONLY parent-existing production modules whose bytes
  // the child changes. Attempt 10: all nine children listed the modules they
  // ADDED and died at the controller diffBoundary with zero in-loop feedback
  // ("parent target solve references missing file"). The controller
  // re-verifies this independently (assertTreeV2Child); this boundary check
  // surfaces the same class while the model can still fix the intent and
  // retry proposal_finish. Byte rules mirror the projection semantics:
  // target modes must show a production-byte change at the listed paths,
  // preserved modes must show none, and every child modifies src/index.ts.
  const readChildSource = async (path: string): Promise<string | undefined> => {
    try {
      return await readFile(join(childrenRoot, child.childName, path), 'utf8')
    } catch {
      return undefined
    }
  }
  const modeContract = intentBase.modeContract as {
    targetModes: string[]
    preservedModes: string[]
  }
  if (!Array.isArray(modeContract.targetModes) || !Array.isArray(modeContract.preservedModes)) {
    fail(
      `child ${child.childName} candidate.json modeContract must declare targetModes and preservedModes arrays`,
    )
  }
  const rawRuntime = intentRaw['runtime'] as Record<string, unknown>
  const rawModeComponents = rawRuntime['modeComponents']
  if (
    rawModeComponents === null ||
    typeof rawModeComponents !== 'object' ||
    Array.isArray(rawModeComponents)
  ) {
    fail(`child ${child.childName} candidate.json runtime.modeComponents must be an object`)
  }
  const modeComponents = rawModeComponents as Record<string, unknown>
  for (const mode of ['solve', 'propose'] as const) {
    const entries = modeComponents[mode]
    if (!Array.isArray(entries)) {
      fail(`child ${child.childName} runtime.modeComponents.${mode} must be an array`)
    }
    const components = entries as unknown[]
    const byteChecks: Array<{ path: string; parent: string; child: string }> = []
    for (const path of components) {
      if (typeof path !== 'string' || !PRODUCTION_FILE.test(path)) {
        fail(
          `child ${child.childName} runtime.modeComponents.${mode} path ${String(
            path,
          )} is not a src/ production module`,
        )
      }
      const parentContent = options.parentSourceFiles[path]
      if (parentContent === undefined) {
        fail(
          `child ${child.childName} runtime.modeComponents.${mode} references parent-missing file ${path} — modeComponents may only list files that exist in the parent tree (parent-files.json); a module your child adds must not be listed here (it is established by the added-file diff and tests.mechanism)`,
        )
      }
      const childContent = await readChildSource(path)
      if (childContent === undefined) {
        fail(
          `child ${child.childName} runtime.modeComponents.${mode} references file ${path} missing from the child tree — write every listed file via proposal_write_child or remove it from modeComponents`,
        )
      }
      byteChecks.push({ path, parent: parentContent, child: childContent })
    }
    if (modeContract.preservedModes.includes(mode)) {
      for (const entry of byteChecks) {
        if (entry.parent !== entry.child) {
          fail(
            `child ${child.childName} preserved mode ${mode} changed production bytes in ${entry.path}`,
          )
        }
      }
    }
    if (modeContract.targetModes.includes(mode)) {
      if (!byteChecks.some((entry) => entry.parent !== entry.child)) {
        fail(
          `child ${child.childName} target mode ${mode} has no production-byte change — modify at least one listed component file`,
        )
      }
    }
  }
  const parentRoot = options.parentSourceFiles['src/index.ts']
  const childRoot = await readChildSource('src/index.ts')
  if (parentRoot === undefined) {
    fail('the parent source view is missing src/index.ts (staging is incomplete)')
  }
  if (childRoot === undefined || childRoot === parentRoot) {
    fail(`child ${child.childName} must modify the component root src/index.ts`)
  }

  // --- fixed-file presence contract (ADR-039) ------------------------------
  // The controller's candidate scan requires package.json and cordis.patch.yml
  // in the CHILD tree — attempt 12 prop-2 wrote trees without them; the
  // boundary test run masked the gap because the merged view's parent side
  // supplied the bytes, and both children died at admission with
  // "package/missing; patch/missing". Both files are "keep fixed" per the
  // proposal prompt, so the child must carry the parent's bytes verbatim.
  for (const fixedPath of ['package.json', 'cordis.patch.yml'] as const) {
    const parentContent = options.parentSourceFiles[fixedPath]
    if (parentContent === undefined) {
      fail(`the parent source view is missing ${fixedPath} (staging is incomplete)`)
    }
    const childContent = await readChildSource(fixedPath)
    if (childContent === undefined) {
      fail(
        `child ${child.childName} is missing the fixed parent file ${fixedPath} — write the parent's bytes into the child tree via proposal_write_child (read parent/${fixedPath})`,
      )
    }
    if (childContent !== parentContent) {
      fail(
        `child ${child.childName} changed the fixed parent file ${fixedPath} — its bytes must equal the parent's (read parent/${fixedPath} and write them verbatim)`,
      )
    }
  }

  // --- tests naming contract (ADR-037) -------------------------------------
  // Every path named in tests.mechanism/preservation must be a tests/*.spec.ts
  // file the child actually wrote; mechanism tests must be ADDED files (the
  // controller rejects a mechanism test that merely modifies a parent test).
  // Attempt-10 evidence: prop-1/prop-2 named .preservation.spec.ts files with
  // no corresponding writes — the next rejection class behind modeComponents.
  const rawTests = intentRaw['tests'] as Record<string, unknown>
  const mechanism = rawTests['mechanism']
  const preservation = rawTests['preservation']
  if (!Array.isArray(mechanism) || !Array.isArray(preservation)) {
    fail(
      `child ${child.childName} candidate.json tests must declare mechanism and preservation arrays`,
    )
  }
  for (const path of mechanism) {
    if (typeof path !== 'string' || !TEST_FILE.test(path)) {
      fail(
        `child ${child.childName} tests.mechanism path ${String(
          path,
        )} is not a tests/*.spec.ts path`,
      )
    }
    if ((await readChildSource(path)) === undefined) {
      fail(
        `child ${child.childName} tests.mechanism references missing test file ${path} — write every named test via proposal_write_child or remove it from tests.mechanism`,
      )
    }
    if (options.parentSourceFiles[path] !== undefined) {
      fail(
        `child ${child.childName} tests.mechanism path ${path} already exists in the parent — a mechanism test must be an ADDED file; name the new test file your child adds`,
      )
    }
  }
  for (const path of preservation) {
    if (typeof path !== 'string' || !TEST_FILE.test(path)) {
      fail(
        `child ${child.childName} tests.preservation path ${String(
          path,
        )} is not a tests/*.spec.ts path`,
      )
    }
    if ((await readChildSource(path)) === undefined) {
      fail(
        `child ${child.childName} tests.preservation references missing test file ${path} — write every named test via proposal_write_child or remove it from tests.preservation`,
      )
    }
  }

  const intent = finalizeReceipt({
    ...intentBase,
    parent: { candidateDigest: treeV2Parent.candidateDigest, sourceDigest: parentSourceHash },
    requiredParentEvidence,
  }) as unknown as TreeV2CandidateIntent
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`, 'utf8')

  // --- proposal receipt ----------------------------------------------------
  const proposal = finalizeReceipt({
    schemaVersion: 2,
    protocol: TREE_V2_PROTOCOL,
    kind: 'proposal',
    proposalId: child.childName,
    parentCandidateDigest: treeV2Parent.candidateDigest,
    analysisDigest: analysis.receiptDigest,
    candidateIntentDigest: intent.receiptDigest,
    modeContract: intent.modeContract,
    requiredParentEvidence,
  }) as TreeV2ProposalReceipt

  // --- donors --------------------------------------------------------------
  // Donors may legitimately be empty (a child can build on parent evidence
  // alone); membership against the staged catalog is the only rule here.
  const donorCandidates = childRecord['donorCandidates']
  if (
    !Array.isArray(donorCandidates) ||
    donorCandidates.some((donor) => typeof donor !== 'string')
  ) {
    fail(`child ${child.childName} donorCandidates must be a string array`)
  }
  const catalogIds = new Set(catalog.entries.map((entry) => entry.candidateId))
  for (const donor of donorCandidates as string[]) {
    if (!catalogIds.has(donor)) {
      fail(`child ${child.childName} donor ${donor} is not in the archive catalog`)
    }
  }

  childRecord['analysisReceipt'] = analysis
  childRecord['proposalReceipt'] = proposal
}

/**
 * ADR-055 diversity gate.  The migration root exposes a bounded solve-policy
 * workflow specifically so the search does not spend every multi-child batch
 * on static prompt text.  Enforce the declaration at the trusted proposal
 * boundary, but only for successor roots which advertise the capability: old
 * recorded runs and their historic parent source remain replayable exactly as
 * they were.
 */
async function assertSuccessorWorkflowDiversity(
  options: FinalizeTreeV2BundleOptions,
  children: readonly NonNullable<ProposalOutput['children'][number]>[],
): Promise<void> {
  if (children.length < 2) return
  let parentWorkflowNames: unknown
  try {
    const parentIntent = JSON.parse(options.parentSourceFiles['candidate.json'] ?? '{}') as {
      runtime?: { modeSurfaces?: { solve?: { workflowNames?: unknown } } }
    }
    parentWorkflowNames = parentIntent.runtime?.modeSurfaces?.solve?.workflowNames
  } catch {
    // The parent manifest is a trusted staged source file. A missing or
    // malformed historic manifest means it does not advertise this successor
    // capability; the normal parent/child receipt checks still apply.
  }
  if (!Array.isArray(parentWorkflowNames) || !parentWorkflowNames.includes(SOLVE_POLICY_WORKFLOW)) {
    return
  }
  for (const child of children) {
    const childRecord = child as unknown as Record<string, unknown>
    const surfaces = childRecord['strategySurfaces']
    if (!Array.isArray(surfaces) || !surfaces.includes('workflow')) continue
    const intentPath = join(options.childrenRoot, child.childName, 'candidate.json')
    try {
      const intent = JSON.parse(await readFile(intentPath, 'utf8')) as {
        runtime?: { modeSurfaces?: { solve?: { workflowNames?: unknown } } }
      }
      const names = intent.runtime?.modeSurfaces?.solve?.workflowNames
      if (Array.isArray(names) && names.includes(SOLVE_POLICY_WORKFLOW)) return
    } catch {
      // The child finalizer has already checked readability; keep the trusted
      // boundary fail-closed rather than treating an unreadable declaration as
      // a non-workflow child.
    }
  }
  fail(
    `successor multi-child proposal must include one child with strategySurfaces "workflow" and solve.workflowNames ${SOLVE_POLICY_WORKFLOW}`,
  )
}

/**
 * Finalize a v2 proposal bundle: rebuild and digest every child's receipts,
 * repair its candidate-intent parent evidence, and validate donors against
 * the staged catalog. v1 envelopes pass through untouched.
 */
export async function finalizeTreeV2Bundle(
  options: FinalizeTreeV2BundleOptions,
): Promise<ProposalOutput> {
  const proposal = options.proposal as unknown as Record<string, unknown>
  if (proposal['schemaVersion'] !== 2) return options.proposal
  if (options.parentSourceFiles === undefined) {
    fail('a v2 bundle requires the parent source view (parent-files.json + parent files)')
  }
  const children = options.proposal.children
  if (!Array.isArray(children) || children.length === 0) fail('bundle has no children')
  for (const child of children) {
    await finalizeChild(options, child)
  }
  await assertSuccessorWorkflowDiversity(options, children)
  return options.proposal
}
