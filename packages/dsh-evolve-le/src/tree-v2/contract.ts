/**
 * Candidate tree-v2 contract.
 *
 * This is deliberately separate from the legacy single-file candidate
 * contract.  A tree-v2 candidate is a real Cordis component tree, and its
 * identity, parent evidence, mode contract, and receipts are all verified by
 * trusted code before it can enter a build or admission path.
 * @module @dsh-evolve-le/core/tree-v2/contract
 */

import { canonicalJson, sha256Hex } from '../state/canonical.js'
import type { CanonicalSource } from '../candidate/canonical.js'
import { diffCanonicalSources, type CanonicalDiff } from '../candidate/diff.js'

export const TREE_V2_PROTOCOL = 'dsh-self-evolving-candidate-tree-v2'

export const TREE_V2_RECEIPT_KINDS = [
  'proposal',
  'analysis',
  'candidate-intent',
  'mechanism-outcome',
  'capability-catalog',
  'materialization-receipt',
  'admission-receipt',
  'migration-receipt',
] as const

export type TreeV2ReceiptKind = (typeof TREE_V2_RECEIPT_KINDS)[number]
export type TreeV2Mode = 'solve' | 'propose'
export type TreeV2Capability =
  'system-prompt' | 'tools' | 'skills' | 'agent-events' | 'session-events' | 'workflow'

export interface TreeV2ModeSurfaces {
  promptSections: Array<{ name: string; order: number }>
  newToolNames: string[]
  newSkillNames: string[]
  agentEventNames: string[]
  sessionEventNames: string[]
  workflowNames: string[]
}

export interface TreeV2ModeContract {
  targetModes: TreeV2Mode[]
  preservedModes: TreeV2Mode[]
}

/** Loader fingerprints plus optional native proof of solve-policy behavior. */
export interface TreeV2ModeFingerprints {
  solve: string
  propose: string
  /** Present for successor builds that execute the native ACP solve probe. */
  solvePolicy?: string
}

export interface TreeV2RequiredParentEvidence {
  analysisDigest: string
  mechanismOutcomeDigest: string
  normalizedTrialDigest: string
  trajectoryDigest: string
}

export interface TreeV2CandidateIntent {
  schemaVersion: 2
  protocol: typeof TREE_V2_PROTOCOL
  kind: 'candidate-intent'
  candidate: {
    name: string
    version: string
    entry: 'src/index.ts'
  }
  /** Null only for the freshly rebuilt v1 -> tree-v2 migration root. */
  parent: {
    candidateDigest: string
    sourceDigest: string
  } | null
  modeContract: TreeV2ModeContract
  /** Required for every child; forbidden on the parentless migration root. */
  requiredParentEvidence?: TreeV2RequiredParentEvidence
  runtime: {
    /** Exact production files which implement each execution mode. */
    modeComponents: Record<TreeV2Mode, string[]>
    /** Loader-visible declarations are mode-specific for every surface. */
    modeSurfaces: Record<TreeV2Mode, TreeV2ModeSurfaces>
    capabilities: TreeV2Capability[]
  }
  tests: {
    command: string
    mechanism: string[]
    preservation: string[]
  }
  receiptDigest: string
}

export interface TreeV2Receipt extends Record<string, unknown> {
  schemaVersion: 2
  protocol: typeof TREE_V2_PROTOCOL
  kind: TreeV2ReceiptKind
  receiptDigest: string
}

const DIGEST = /^sha256:[a-f0-9]{64}$/
const SOURCE_FILE =
  /^(?:src\/[A-Za-z0-9][A-Za-z0-9._/-]*\.ts|tests\/[A-Za-z0-9][A-Za-z0-9._/-]*\.spec\.ts|fixtures\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json|README\.md|candidate\.json|package\.json|cordis\.patch\.yml|tsconfig\.json)$/
const PRODUCTION_FILE = /^src\/[A-Za-z0-9][A-Za-z0-9._/-]*\.ts$/
const TEST_FILE = /^tests\/[A-Za-z0-9][A-Za-z0-9._/-]*\.spec\.ts$/

function fail(message: string): never {
  throw new Error(`tree-v2 contract rejected: ${message}`)
}

function contentAt(source: CanonicalSource, path: string): Buffer | undefined {
  return source.files.find((file) => file.path === path)?.content
}

function uniqueSorted(paths: string[], label: string): string[] {
  if (paths.length === 0) fail(`${label} must not be empty`)
  const unique = [...new Set(paths)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  if (unique.length !== paths.length) fail(`${label} contains duplicate paths`)
  return unique
}

/** Stable content-addressed digest for a JSON document. */
export function treeV2Digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

/** Add the non-self-referential digest to a versioned receipt document. */
export function finalizeTreeV2Receipt<T extends Record<string, unknown>>(
  receipt: T & Omit<TreeV2Receipt, 'receiptDigest'>,
): T & TreeV2Receipt {
  const withDigest = {
    ...receipt,
    receiptDigest: treeV2Digest(receipt),
  }
  return withDigest as T & TreeV2Receipt
}

/** Verify the receipt's digest over all fields except `receiptDigest`. */
export function verifyTreeV2Receipt(receipt: TreeV2Receipt): void {
  const { receiptDigest, ...unsigned } = receipt
  if (!DIGEST.test(receiptDigest)) fail('receiptDigest is not a sha256 digest')
  if (receiptDigest !== treeV2Digest(unsigned))
    fail('receiptDigest does not match canonical receipt')
  if (receipt.schemaVersion !== 2 || receipt.protocol !== TREE_V2_PROTOCOL) {
    fail('receipt does not declare the tree-v2 protocol')
  }
  if (!TREE_V2_RECEIPT_KINDS.includes(receipt.kind)) fail(`unknown receipt kind ${receipt.kind}`)
}

/** Require all four semantically named parent evidence bindings. */
export function assertRequiredParentEvidence(evidence: TreeV2RequiredParentEvidence): void {
  const entries = Object.entries(evidence)
  if (entries.length !== 4) fail('requiredParentEvidence must contain exactly four bindings')
  for (const [name, digest] of entries) {
    if (!DIGEST.test(digest)) fail(`requiredParentEvidence.${name} is not a sha256 digest`)
  }
}

/** Verify that target/preserved modes form a complete, disjoint contract. */
export function assertModeContract(contract: TreeV2ModeContract): void {
  const target = uniqueSorted(contract.targetModes, 'modeContract.targetModes')
  const preserved = [...new Set(contract.preservedModes)].sort()
  if (preserved.length !== contract.preservedModes.length) {
    fail('modeContract.preservedModes contains duplicate modes')
  }
  for (const mode of [...target, ...preserved]) {
    if (mode !== 'solve' && mode !== 'propose') fail(`unknown mode ${mode}`)
  }
  if (preserved.some((mode) => target.includes(mode))) {
    fail('a mode cannot be both target and preserved')
  }
  if (new Set([...target, ...preserved]).size !== 2) {
    fail('targetModes and preservedModes must partition solve and propose')
  }
}

/** Assert the static shape of one candidate tree. */
export function assertTreeV2CandidateTree(
  source: CanonicalSource,
  intent: TreeV2CandidateIntent,
): void {
  if (intent.schemaVersion !== 2 || intent.protocol !== TREE_V2_PROTOCOL) {
    fail('candidate is not tree-v2')
  }
  if (intent.kind !== 'candidate-intent') fail('candidate receipt kind must be candidate-intent')
  verifyTreeV2Receipt(intent as unknown as TreeV2Receipt)
  if (intent.candidate.entry !== 'src/index.ts') fail('candidate entry must be src/index.ts')
  assertModeContract(intent.modeContract)
  if (intent.parent === null) {
    if (intent.requiredParentEvidence !== undefined) {
      fail('migration root must not fabricate requiredParentEvidence')
    }
    if (
      intent.modeContract.preservedModes.length !== 0 ||
      !intent.modeContract.targetModes.includes('solve') ||
      !intent.modeContract.targetModes.includes('propose')
    ) {
      fail('migration root must target solve and propose with no preserved parent mode')
    }
  } else {
    if (intent.requiredParentEvidence === undefined) {
      fail('tree-v2 child requires requiredParentEvidence')
    }
    assertRequiredParentEvidence(intent.requiredParentEvidence)
  }

  const paths = new Set(source.files.map((file) => file.path))
  for (const path of paths) {
    if (!SOURCE_FILE.test(path)) fail(`file is outside the permitted component tree: ${path}`)
  }
  const production = [...paths].filter((path) => PRODUCTION_FILE.test(path))
  if (!paths.has('src/index.ts')) fail('missing component root src/index.ts')
  if (production.length < 2)
    fail('candidate must contain a production module in addition to src/index.ts')
  if (![...paths].some((path) => TEST_FILE.test(path))) {
    fail('candidate must include at least one preservation or mechanism test')
  }
  const root = contentAt(source, 'src/index.ts')?.toString('utf8') ?? ''
  if (!/\bctx\.plugin\s*\(/.test(root)) {
    fail('src/index.ts must mount its component through ctx.plugin()')
  }

  for (const mode of ['solve', 'propose'] as const) {
    const components = uniqueSorted(
      intent.runtime.modeComponents[mode],
      `runtime.modeComponents.${mode}`,
    )
    for (const path of components) {
      if (!PRODUCTION_FILE.test(path) || !paths.has(path)) {
        fail(`runtime.modeComponents.${mode} references missing production file ${path}`)
      }
    }
  }
  const declaredCapabilities = new Set<TreeV2Capability>()
  for (const mode of ['solve', 'propose'] as const) {
    const surfaces = intent.runtime.modeSurfaces[mode]
    if (surfaces.promptSections.length > 0) declaredCapabilities.add('system-prompt')
    if (surfaces.newToolNames.length > 0) declaredCapabilities.add('tools')
    if (surfaces.newSkillNames.length > 0) declaredCapabilities.add('skills')
    if (surfaces.agentEventNames.length > 0) declaredCapabilities.add('agent-events')
    if (surfaces.sessionEventNames.length > 0) declaredCapabilities.add('session-events')
    if (surfaces.workflowNames.length > 0) declaredCapabilities.add('workflow')
  }
  const catalog = [...new Set(intent.runtime.capabilities)].sort()
  if (catalog.length !== intent.runtime.capabilities.length) {
    fail('runtime.capabilities contains duplicate entries')
  }
  if (treeV2Digest(catalog) !== treeV2Digest([...declaredCapabilities].sort())) {
    fail('runtime.capabilities does not match the union of declared mode surfaces')
  }
  if (intent.tests.mechanism.length === 0) {
    fail('tests.mechanism must name at least one mechanism test')
  }
  if (intent.modeContract.preservedModes.length > 0 && intent.tests.preservation.length === 0) {
    fail('a preserved mode requires at least one preservation test')
  }
  const testPaths = new Set([...intent.tests.mechanism, ...intent.tests.preservation])
  for (const path of testPaths) {
    if (!TEST_FILE.test(path) || !paths.has(path)) fail(`tests reference missing test file ${path}`)
  }
}

function projection(source: CanonicalSource, paths: string[], label: string): string {
  const records = uniqueSorted(paths, label).map((path) => {
    const content = contentAt(source, path)
    if (content === undefined) fail(`${label} references missing file ${path}`)
    return { path, sha256: sha256Hex(content) }
  })
  return treeV2Digest(records)
}

/**
 * Compare a child source tree against a parent source tree under the declared
 * mode contract. Preserved modes compare exact module bytes; target modes must
 * have a material production-file change, not merely a manifest edit.
 */
export function assertTreeV2Child(
  parent: CanonicalSource,
  child: CanonicalSource,
  intent: TreeV2CandidateIntent,
): CanonicalDiff {
  assertTreeV2CandidateTree(child, intent)
  if (intent.parent === null) fail('a tree-v2 migration root cannot be validated as a child')
  const diff = diffCanonicalSources(parent, child)
  if (diff.filesChanged === 0) fail('child source is byte-identical to parent')
  // The component root is a stable Loader boundary.  Requiring every child
  // to touch it made an executable strategy change unnecessarily mutate both
  // mode projections, which in turn encouraged prompt-text-only deltas.
  // Children may instead target a mode-specific implementation module.
  if (
    !diff.differingFiles.some(
      (change) =>
        change.status === 'added' &&
        PRODUCTION_FILE.test(change.path) &&
        change.path !== 'src/index.ts',
    )
  ) {
    fail('child must add a non-root production module')
  }
  if (
    !diff.differingFiles.some((change) => change.status === 'added' && TEST_FILE.test(change.path))
  ) {
    fail('child must add a candidate-owned test')
  }
  const addedTests = new Set(
    diff.differingFiles
      .filter((change) => change.status === 'added' && TEST_FILE.test(change.path))
      .map((change) => change.path),
  )
  if (!intent.tests.mechanism.some((path) => addedTests.has(path))) {
    fail('child must add a declared mechanism test')
  }

  for (const mode of intent.modeContract.preservedModes) {
    const files = intent.runtime.modeComponents[mode]
    if (
      projection(parent, files, `parent preserved ${mode}`) !==
      projection(child, files, `child preserved ${mode}`)
    ) {
      fail(`preserved mode ${mode} changed production bytes`)
    }
  }
  for (const mode of intent.modeContract.targetModes) {
    const files = intent.runtime.modeComponents[mode]
    if (
      projection(parent, files, `parent target ${mode}`) ===
      projection(child, files, `child target ${mode}`)
    ) {
      fail(`target mode ${mode} has no production-byte change`)
    }
  }
  return diff
}

/**
 * A stable projection of a Loader probe used for runtime mode evidence.
 * ADR-039: the projection includes the mounted candidate sections' CONTENT
 * (`sectionSurfaces`: name + order + text), not just their names — attempt 12
 * proved that content-only evolution (folding a directive into an existing
 * section, exactly what the surface-preservation prompt teaches) leaves the
 * name-only fingerprint untouched and the target-mode contract unsatisfiable.
 * Reports without `sectionSurfaces` degrade to the legacy name list.
 *
 * Section text routinely embeds the mounting candidate's own id (the SDK's
 * documented pattern is `text: \`…${cfg.candidateId}…\``). A parent and a
 * byte-identical child mount under DIFFERENT ids, so raw text hashing would
 * break every preserved-mode contract. `candidateId` masks the caller's own
 * id out of the text before hashing — identity is fixed content, not an
 * evolvable mechanism.
 */
export function treeV2RuntimeFingerprint(
  report: unknown,
  mode: TreeV2Mode,
  options?: {
    candidateId?: string
    /**
     * Native ACP probe evidence for the bounded solve-policy hook.  It is
     * supplied only after the real AgentLoop probe, so strategy-only changes
     * are observable without inventing a prompt-text change.
     */
    solvePolicyProbe?: {
      candidateCheckpointCount: number
      candidateCheckpointSha256: string
      strategyUsage?: {
        workflowInvocations: number
        strategyToolInvocations: number
        agentEventInvocations: number
        sessionEventInvocations: number
      }
    }
  },
): string {
  const raw = report as Record<string, unknown>
  const strategy = (raw.strategy ?? {}) as Record<string, unknown>
  const sections = (raw.sections ?? {}) as Record<string, unknown>
  const surfaces = (raw.sectionSurfaces ?? {}) as Record<string, unknown>
  const mask = (text: string): string =>
    options?.candidateId === undefined || options.candidateId.length === 0
      ? text
      : text.split(options.candidateId).join('<candidate-id>')
  const maskedSurfaces = Array.isArray(surfaces.afterBoot)
    ? (surfaces.afterBoot as Array<Record<string, unknown>>).map((section) => ({
        ...section,
        ...(typeof section.text === 'string' ? { text: mask(section.text) } : {}),
      }))
    : surfaces.afterBoot
  return treeV2Digest({
    mode,
    sections: maskedSurfaces ?? sections.afterBoot,
    strategy,
    ...(mode === 'solve' && options?.solvePolicyProbe !== undefined
      ? { solvePolicyProbe: options.solvePolicyProbe }
      : {}),
  })
}

/** Stable native-probe projection used to reject a workflow declaration with no behavior change. */
export function treeV2SolvePolicyFingerprint(probe: {
  candidateCheckpointCount: number
  candidateCheckpointSha256: string
  strategyUsage?: {
    workflowInvocations: number
    strategyToolInvocations: number
    agentEventInvocations: number
    sessionEventInvocations: number
  }
}): string {
  return treeV2Digest(probe)
}

/** Runtime half of the mode contract, after isolated Loader probes complete. */
export function assertTreeV2RuntimeModeContract(
  contract: TreeV2ModeContract,
  parent: TreeV2ModeFingerprints,
  child: TreeV2ModeFingerprints,
): void {
  assertModeContract(contract)
  for (const mode of contract.preservedModes) {
    if (parent[mode] !== child[mode]) fail(`preserved mode ${mode} Loader fingerprint changed`)
  }
  for (const mode of contract.targetModes) {
    if (parent[mode] === child[mode]) fail(`target mode ${mode} Loader fingerprint did not change`)
  }
}
