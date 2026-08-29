/**
 * Proposal bundle validation (Gate 4, specs/03 §9, specs/05 §10–§11,
 * specs/07 §6): the controller-side gate between a sandbox's submitted bundle
 * and anything entering the candidate store. Nothing here trusts the sandbox:
 * children are re-captured from the writable root (which fails closed on
 * symlinks and forbidden components), re-diffed against the declared parent,
 * scanned for canary tokens, deduplicated by diff hash inside the batch and
 * against the archive, and every evidence reference must resolve to an object
 * of the export the sandbox actually saw.
 * @module @dsh-evolve-le/core/proposer/validate
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureCanonicalSource, type CanonicalSource } from '../candidate/canonical.js'
import { diffCanonicalSources, type CanonicalDiff } from '../candidate/diff.js'
import type { ArchiveCatalog } from './catalog.js'
import { scanFieldsForCanary, scanForCanary } from './canary.js'
import type { ExportManifest } from './export.js'
import type { ProposalOutput } from './protocol.js'

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(`proposal-validation: ${message}`)
    this.name = 'ProposalValidationError'
  }
}

export interface ChildVerdict {
  childName: string
  /** Canonical source digest of the child tree (`sha256:<hex>`). */
  sourceHash: string
  diffHash: string
  filesChanged: number
  linesAdded: number
  linesRemoved: number
  admitted: boolean
  /** Rejection reason when not admitted. */
  reason?: string
}

export interface ProposalValidation {
  /** Admitted children in proposal order, ready for the candidate store. */
  admitted: ChildVerdict[]
  /** Rejected children with reasons — evidence is kept, never dropped. */
  rejected: ChildVerdict[]
  /** Errors that invalidate the whole bundle. */
  batchErrors: string[]
  /** The child source captures, keyed by childName, for the import step. */
  sources: Map<string, CanonicalSource>
  /** The parent diff per child, keyed by childName. */
  diffs: Map<string, CanonicalDiff>
}

export interface ValidateProposalBundleOptions {
  proposal: ProposalOutput
  /** The sandbox's writable children root (`work/children`). */
  childrenRoot: string
  /** Controller-side canonical capture of the declared parent tree. */
  parentSource: CanonicalSource
  /** The label-filtered export the sandbox read (manifest.json parsed). */
  exportManifest: ExportManifest
  /** Archive catalog for cross-batch dedup and donor existence. */
  catalog: ArchiveCatalog
  /** Canary tokens no child or hypothesis may carry. */
  canaryTokens: readonly string[]
}

export const PROPOSAL_MAX_CHANGED_LINES = 5_000

/**
 * Validate one submitted bundle. Batch errors (parent mismatch, canary in a
 * hypothesis, unknown donor, unresolvable evidence ref) reject the whole
 * bundle; per-child verdicts carry the diff identity either way so rejected
 * children keep auditable evidence.
 */
export async function validateProposalBundle(
  options: ValidateProposalBundleOptions,
): Promise<ProposalValidation> {
  const { proposal, parentSource, exportManifest, catalog, canaryTokens } = options
  const tokens = [...canaryTokens]
  const batchErrors: string[] = []
  if (proposal.parentSourceHash !== `sha256:${parentSource.sha256}`) {
    batchErrors.push(
      `bundle parent ${proposal.parentSourceHash} != declared parent sha256:${parentSource.sha256}`,
    )
  }
  const exportDigests = new Set(exportManifest.objects.map((object) => object.digest))
  const archiveSourceHashes = new Set(catalog.entries.map((entry) => entry.sourceHash))
  const archiveCandidateIds = new Set(catalog.entries.map((entry) => entry.candidateId))
  for (const child of proposal.children) {
    const canaryHits = scanFieldsForCanary(child as unknown as Record<string, unknown>, tokens)
    if (canaryHits.length > 0) {
      batchErrors.push(
        `child ${child.childName}: canary fingerprint hit at ${canaryHits[0]?.field}`,
      )
    }
    for (const donor of child.donorCandidates) {
      if (!archiveCandidateIds.has(donor)) {
        batchErrors.push(`child ${child.childName}: donor ${donor} is not in the archive catalog`)
      }
    }
    for (const ref of child.evidenceRefs) {
      if (!exportDigests.has(ref)) {
        batchErrors.push(
          `child ${child.childName}: evidence ref ${ref} is not an object of export ${exportManifest.exportId}`,
        )
      }
    }
  }

  const admitted: ChildVerdict[] = []
  const rejected: ChildVerdict[] = []
  const sources = new Map<string, CanonicalSource>()
  const diffs = new Map<string, CanonicalDiff>()
  const diffHashesSeen = new Set<string>()

  for (const child of proposal.children) {
    let source: CanonicalSource
    let diff: CanonicalDiff
    try {
      source = await captureCanonicalSource(join(options.childrenRoot, child.childName))
      diff = diffCanonicalSources(parentSource, source)
    } catch (error) {
      rejected.push({
        childName: child.childName,
        sourceHash: '',
        diffHash: '',
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        admitted: false,
        reason: `capture failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      continue
    }
    sources.set(child.childName, source)
    diffs.set(child.childName, diff)
    const base = {
      childName: child.childName,
      sourceHash: `sha256:${source.sha256}`,
      diffHash: diff.diffHash,
      filesChanged: diff.filesChanged,
      linesAdded: diff.linesAdded,
      linesRemoved: diff.linesRemoved,
    } satisfies Omit<ChildVerdict, 'admitted' | 'reason'>
    const reject = (reason: string): void => {
      rejected.push({ ...base, admitted: false, reason })
    }
    let reason: string | undefined
    if (diff.filesChanged === 0) {
      reason = 'no-change child: identical to the parent source'
    } else if (diff.linesAdded + diff.linesRemoved > PROPOSAL_MAX_CHANGED_LINES) {
      reason = `diff exceeds the pre-registered ${PROPOSAL_MAX_CHANGED_LINES}-line cap`
    } else if (diffHashesSeen.has(diff.diffHash)) {
      reason = 'duplicate mechanism: identical diff hash inside the batch'
    } else if (archiveSourceHashes.has(base.sourceHash)) {
      reason = 'duplicate mechanism: source already present in the archive'
    } else {
      for (const file of source.files) {
        const hits = scanForCanary(file.content.toString('utf8'), tokens)
        if (hits.length > 0) {
          reason = `canary fingerprint hit in ${file.path}`
          break
        }
      }
    }
    if (reason !== undefined) {
      reject(reason)
      continue
    }
    diffHashesSeen.add(diff.diffHash)
    admitted.push({ ...base, admitted: true })
  }

  if (batchErrors.length > 0) {
    // Batch errors poison the whole bundle: nothing is admitted, but every
    // captured verdict stays in the record as rejected evidence.
    return {
      admitted: [],
      rejected: [
        ...admitted.map((verdict) => ({
          ...verdict,
          admitted: false,
          reason: 'rejected: bundle-level error',
        })),
        ...rejected,
      ],
      batchErrors,
      sources,
      diffs,
    }
  }
  return { admitted, rejected, batchErrors, sources, diffs }
}

/** Parse an export directory's manifest.json (the view the sandbox read). */
export async function readExportManifest(exportDir: string): Promise<ExportManifest> {
  const raw = JSON.parse(await readFile(join(exportDir, 'manifest.json'), 'utf8')) as ExportManifest
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.objects)) {
    throw new ProposalValidationError(`export ${exportDir} has no well-formed manifest`)
  }
  return raw
}
