/**
 * Restricted-name sanitation for public formal-run evidence (ADR-052).
 *
 * The run root is the authoritative, access-controlled raw record.  The
 * public evidence copy is derived from it and must never contain a guard or
 * sealed task identity.  Keeping this logic in one small, pure module avoids
 * relying on individual callers to remember which JSON field Harbor happens
 * to use for a task name.
 * @module scripts/lib/evidence-sanitization
 */

import { createHash } from 'node:crypto'

export interface RestrictedNameRedaction {
  name: string
  replacement: string
}

/** Build exact-string redactions for both bare and registry-qualified names. */
export function restrictedTaskNameRedactions(
  guardNameToOpaque: ReadonlyMap<string, string>,
  sealedHandles: readonly string[],
): RestrictedNameRedaction[] {
  const redactions = new Map<string, string>()
  const add = (name: string, replacement: string) => {
    if (name !== '') redactions.set(name, replacement)
  }

  for (const [name, opaqueId] of guardNameToOpaque) {
    add(name, `guard:${opaqueId}`)
    add(`terminal-bench/${name}`, `guard:${opaqueId}`)
  }
  for (const [index, name] of sealedHandles.entries()) {
    const replacement = `sealed:${String(index + 1).padStart(2, '0')}`
    add(name, replacement)
    add(`terminal-bench/${name}`, replacement)
  }

  // A qualified name must win before its bare suffix is considered.
  return [...redactions.entries()]
    .map(([name, replacement]) => ({ name, replacement }))
    .sort((left, right) => right.name.length - left.name.length || left.name.localeCompare(right.name))
}

export function sanitizeRestrictedTaskNames(
  text: string,
  redactions: readonly RestrictedNameRedaction[],
): string {
  let sanitized = text
  for (const { name, replacement } of redactions) {
    sanitized = sanitized.split(name).join(replacement)
  }
  return sanitized
}

export function restrictedTaskNameHits(
  text: string,
  redactions: readonly RestrictedNameRedaction[],
): string[] {
  return [...new Set(redactions.map(({ name }) => name).filter((name) => text.includes(name)))].sort()
}

/**
 * Preserve the binding to the raw image-prefetch receipt without exporting its
 * task-named image list.  The raw receipt remains in the protected run root;
 * this derived attestation is the only public-copy representation.
 */
export function imagePrefetchAttestation(raw: Buffer): {
  protocol: 'dsh-evolve-le/evidence-image-prefetch-attestation/v1'
  sourceSha256: string
  sourceBytes: number
  imageCount: number | null
} {
  let imageCount: number | null = null
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as { images?: unknown }
    if (Array.isArray(parsed.images)) imageCount = parsed.images.length
  } catch {
    // The source hash still binds a malformed raw receipt; record validation
    // elsewhere is responsible for rejecting malformed live inputs.
  }
  return {
    protocol: 'dsh-evolve-le/evidence-image-prefetch-attestation/v1',
    sourceSha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    sourceBytes: raw.length,
    imageCount,
  }
}
