/**
 * Label-filtered evidence export (specs/06 §11, specs/05 §10).
 *
 * The proposer sandbox never queries the artifact store directly: it sees one
 * immutable, action-scoped export directory whose contents were policy-checked
 * per object. Every object's label must be allowed for the principal, every
 * byte is re-verified after materialization, and a canary-absence receipt
 * proves no guarded token leaked into the exported view. The manifest carries
 * a Merkle root over the exported digests so the sandbox-side copy can be
 * integrity-checked without trusting the directory listing.
 * @module @dsh-evolve-le/core/proposer/export
 */

import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { base32Lower } from '../candidate/canonical.js'
import { canaryFingerprint, scanForCanary, type CanaryHit } from './canary.js'
import {
  validateRef,
  type ObjectLabel,
  type ObjectRef,
  type ObjectStore,
} from '../state/object-store.js'

export const EXPORT_VERSION = 'dsh-evolve-le/evidence-export/v1'

/** The only labels a proposer principal may ever read (specs/05 §10). */
export const PROPOSER_READ_LABELS: readonly ObjectLabel[] = ['PUBLIC_SPEC', 'DEV_OBSERVED']

export class EvidenceExportError extends Error {
  constructor(message: string) {
    super(`evidence-export: ${message}`)
    this.name = 'EvidenceExportError'
  }
}

/**
 * Canary refusal (specs/05 §10, ADR-046): a guarded token appeared in the
 * selected bytes. A typed subclass so the driver can distinguish the
 * safety-abort surface from ordinary export failures, carrying the structured
 * hits (fingerprints only) for the information-flow monitor receipt.
 */
export class EvidenceExportCanaryError extends EvidenceExportError {
  constructor(
    message: string,
    readonly hits: CanaryHit[],
  ) {
    super(message)
    this.name = 'EvidenceExportCanaryError'
  }
}

export interface ExportedObject {
  digest: string
  size: number
  mediaType: string
  label: ObjectLabel
  /** Path of the materialized copy inside the export directory. */
  path: string
}

export interface ExportManifest {
  schemaVersion: 1
  exportVersion: typeof EXPORT_VERSION
  exportId: string
  principal: string
  purpose: string
  allowedLabels: ObjectLabel[]
  objects: ExportedObject[]
  createdFromStateHash: string
  merkleRoot: string
  canaryAbsence: {
    checkedObjects: number
    tokenFingerprints: string[]
    result: 'absent'
  }
}

export interface CreateExportOptions {
  /** Root holding one directory per export (`exports/`). */
  exportsRoot: string
  store: ObjectStore
  /** e.g. `proposer:<actionId>` — who the view is for. */
  principal: string
  /** e.g. `candidate-expansion` — why, recorded for audit. */
  purpose: string
  /** Labels this export may contain; enforced per object, fail closed. */
  allowedLabels: readonly ObjectLabel[]
  /** Objects selected for the principal by the controller, never by the sandbox. */
  refs: readonly ObjectRef[]
  /** State hash the selection was derived from. */
  createdFromStateHash: string
  /** Canary tokens guarded content carries; none may appear in the export. */
  canaryTokens: readonly string[]
}

/** Merkle root over sorted unique digests (leaf = sha256(digest), empty = sha256("")). */
export function merkleRootOf(digests: readonly string[]): string {
  if (digests.length === 0) return createHash('sha256').update('', 'utf8').digest('hex')
  let level = [...new Set(digests)].sort().map((digest) => hashHex(digest))
  while (level.length > 1) {
    const next: string[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!
      const right = i + 1 < level.length ? level[i + 1]! : left
      next.push(hashHex(`${left}${right}`))
    }
    level = next
  }
  return level[0]!
}

function hashHex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The manifest minus the fields derived from the core itself. */
type ExportCore = Omit<ExportManifest, 'exportId' | 'merkleRoot' | 'canaryAbsence'>

/** Deterministic export id from the manifest core (idempotent re-exports). */
function exportIdFor(core: ExportCore): string {
  const digest = createHash('sha256').update(JSON.stringify(core), 'utf8').digest('hex')
  return `exp_${base32Lower(Buffer.from(digest, 'hex'), 13)}`
}

/** Enforce the label policy for one export request (fail closed). */
function assertLabelsAllowed(refs: readonly ObjectRef[], allowed: readonly ObjectLabel[]): void {
  if (allowed.length === 0) throw new EvidenceExportError('allowedLabels is empty')
  const allowSet = new Set(allowed)
  for (const ref of refs) {
    if (!allowSet.has(ref.label)) {
      throw new EvidenceExportError(
        `object ${ref.digest.slice(0, 12)} has label ${ref.label}, not allowed for this principal`,
      )
    }
  }
}

/**
 * Create one immutable export view. The export directory is materialized in a
 * staging area, verified byte-for-byte against the store, made read-only, and
 * then published under its deterministic id — an existing identical export is
 * returned as-is; anything else is a collision and fails closed.
 */
export async function createEvidenceExport(
  options: CreateExportOptions,
): Promise<{ exportId: string; dir: string; manifest: ExportManifest }> {
  const { store, refs, canaryTokens } = options
  for (const ref of refs) validateRef(ref)
  assertLabelsAllowed(refs, options.allowedLabels)

  // Verify every ref against the store before anything is copied.
  await store.scrub(refs)

  // Canary-absence scan happens over the source bytes in the store, and the
  // materialized copies are scanned again after the copy below.
  const fingerprints = canaryTokens.map((token) => canaryFingerprint(token))
  for (const ref of refs) {
    const bytes = await store.read(ref)
    const hits = scanForCanary(bytes.toString('utf8'), canaryTokens)
    if (hits.length > 0) {
      throw new EvidenceExportCanaryError(
        `canary fingerprint ${hits[0]!.tokenFingerprint.slice(0, 12)} present in object ${ref.digest.slice(0, 12)} — refusing to export`,
        hits,
      )
    }
  }

  const objects: ExportedObject[] = refs.map((ref) => ({
    digest: ref.digest,
    size: ref.size,
    mediaType: ref.mediaType,
    label: ref.label,
    path: `objects/${ref.digest}`,
  }))
  const core: ExportCore = {
    schemaVersion: 1 as const,
    exportVersion: EXPORT_VERSION,
    principal: options.principal,
    purpose: options.purpose,
    allowedLabels: [...options.allowedLabels],
    objects,
    createdFromStateHash: options.createdFromStateHash,
  }
  const exportId = exportIdFor(core)
  const manifest: ExportManifest = {
    ...core,
    exportId,
    merkleRoot: merkleRootOf(objects.map((object) => object.digest)),
    canaryAbsence: {
      checkedObjects: refs.length,
      tokenFingerprints: fingerprints,
      result: 'absent',
    },
  }
  const dir = join(options.exportsRoot, exportId)
  const existing = await readExistingManifest(join(dir, 'manifest.json'))
  if (existing !== undefined) {
    if (existing.exportId !== manifest.exportId) {
      throw new EvidenceExportError(`export ${exportId} exists with a different manifest`)
    }
    return { exportId, dir, manifest: existing }
  }

  // Stage → verify → chmod read-only → publish.
  const staging = await mkdtemp(join(options.exportsRoot, '.staging-'))
  try {
    await mkdir(join(staging, 'objects'), { recursive: true })
    for (const ref of refs) {
      const target = join(staging, 'objects', ref.digest)
      await copyFile(objectPathOf(store.root, ref.digest), target)
      const copied = await readFile(target)
      if (copied.length !== ref.size || hashHexOf(copied) !== ref.digest) {
        throw new EvidenceExportError(`materialized copy of ${ref.digest.slice(0, 12)} drifted`)
      }
      const postCopy = scanForCanary(copied.toString('utf8'), canaryTokens)
      if (postCopy.length > 0) {
        throw new EvidenceExportCanaryError(
          `canary appeared in the materialized copy of ${ref.digest.slice(0, 12)}`,
          postCopy,
        )
      }
      await chmod(target, 0o444)
    }
    await writeFile(
      join(staging, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    await chmod(join(staging, 'objects'), 0o555)

    await mkdir(options.exportsRoot, { recursive: true })
    try {
      await rename(staging, dir)
    } catch (error) {
      // Lost a race with an identical publish: tolerate only a complete export.
      const alreadyThere = await readExistingManifest(join(dir, 'manifest.json'))
      if (alreadyThere === undefined || alreadyThere.exportId !== exportId) throw error
    }
    await rm(staging, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { exportId, dir, manifest }
}

function objectPathOf(root: string, digest: string): string {
  return join(root, 'sha256', digest.slice(0, 2), digest)
}

function hashHexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readExistingManifest(path: string): Promise<ExportManifest | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw) as ExportManifest
  } catch {
    throw new EvidenceExportError(`existing export manifest at ${path} is not JSON`)
  }
}
