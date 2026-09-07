/**
 * Versioned manifest schema loading and validation. The schemas under the repo
 * root `schemas/` directory are the single source of truth for the
 * candidate/proposal/build/capsule manifests (specs/02); this module compiles
 * them with strict Ajv and is the only validation path the trusted builder and
 * its tests may use. Validation fail-closes: callers get either
 * `{ ok: true, value }` or `{ ok: false, errors }` with every violation listed.
 * @module @dsh-evolve-le/core/schema
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'

/** Manifest kinds, one schema file each, all draft 2020-12 and strict. */
export type ManifestKind = 'candidate' | 'proposal' | 'build' | 'capsule'

/** Tree-v2 receipt documents, each independently versioned and validated. */
export type TreeV2SchemaKind =
  | 'proposal'
  | 'analysis'
  | 'candidate-intent'
  | 'mechanism-outcome'
  | 'capability-catalog'
  | 'materialization-receipt'
  | 'admission-receipt'
  | 'migration-receipt'

export interface ManifestValidationError {
  kind: ManifestKind
  errors: string[]
}

export type ManifestValidationResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: ManifestValidationError }

/**
 * Repo root derived from this module's location: it sits at
 * `packages/dsh-evolve-le/{src,lib}/schema.{ts,js}`, three levels below the
 * root in both the vitest (src) and compiled (lib) layouts.
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function schemaPath(kind: ManifestKind): string {
  return resolve(repoRoot, 'schemas', `${kind}.manifest.schema.json`)
}

function treeV2SchemaPath(kind: TreeV2SchemaKind): string {
  return resolve(repoRoot, 'schemas', `tree-v2.${kind}.schema.json`)
}

const compilers = new Map<ManifestKind, ReturnType<typeof makeValidator>>()
const treeV2Compilers = new Map<TreeV2SchemaKind, ReturnType<typeof makeTreeV2Validator>>()

interface ValidateFn {
  (data: unknown): boolean
  errors?: { instancePath: string; message?: string; params?: Record<string, unknown> }[]
}

/** RFC 3339 date-time; the only format our schemas rely on (build.builtAt). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

function makeValidator(kind: ManifestKind): ValidateFn {
  const schema = JSON.parse(readFileSync(schemaPath(kind), 'utf8')) as object
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  ajv.addFormat('date-time', DATE_TIME)
  return ajv.compile(schema) as ValidateFn
}

function makeTreeV2Validator(kind: TreeV2SchemaKind): ValidateFn {
  const schema = JSON.parse(readFileSync(treeV2SchemaPath(kind), 'utf8')) as object
  // strictRequired is disabled for the tree-v2 receipts: the candidate-intent
  // schema conditions `required: ["requiredParentEvidence"]` on the parent
  // shape (a migration root must not carry it, a child must), and draft
  // 2020-12 has no strict-mode-clean way to express that conditional. The
  // semantic invariant itself is enforced by the schema logic and re-checked
  // by the trusted contract layer (tree-v2/contract.ts).
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  ajv.addFormat('date-time', DATE_TIME)
  return ajv.compile(schema) as ValidateFn
}

/** Validate one independently content-addressed tree-v2 receipt or intent. */
export function validateTreeV2(kind: TreeV2SchemaKind, data: unknown): ManifestValidationResult {
  let validate: ValidateFn | undefined = treeV2Compilers.get(kind)
  if (validate === undefined) {
    validate = makeTreeV2Validator(kind)
    treeV2Compilers.set(kind, validate)
  }
  if (validate(data)) return { ok: true, value: data as Record<string, unknown> }
  const errors = (validate.errors ?? []).map(
    (error) =>
      `${error.instancePath || '<root>'}: ${error.message ?? 'invalid'}${
        error.params && Object.keys(error.params).length > 0
          ? ` ${JSON.stringify(error.params)}`
          : ''
      }`,
  )
  return {
    ok: false,
    error: { kind: kind === 'candidate-intent' ? 'candidate' : 'proposal', errors },
  }
}

/**
 * Validate one manifest document against its versioned schema.
 * @param kind - which manifest schema to apply.
 * @param data - parsed JSON document.
 * @returns ok with the same value, or the full error list.
 */
export function validateManifest(kind: ManifestKind, data: unknown): ManifestValidationResult {
  // Candidate schema v2 is deliberately a separate document.  Dispatch here
  // keeps legacy callers on one API while preventing a v1 validator from
  // accidentally accepting a tree-v2 manifest as an extension of v1.
  if (
    kind === 'candidate' &&
    data !== null &&
    typeof data === 'object' &&
    (data as Record<string, unknown>).schemaVersion === 2
  ) {
    return validateTreeV2('candidate-intent', data)
  }
  let validate: ValidateFn | undefined = compilers.get(kind)
  if (validate === undefined) {
    validate = makeValidator(kind)
    compilers.set(kind, validate)
  }
  if (validate(data)) return { ok: true, value: data as Record<string, unknown> }
  const errors = (validate.errors ?? []).map(
    (error) =>
      `${error.instancePath || '<root>'}: ${error.message ?? 'invalid'}${
        error.params && Object.keys(error.params).length > 0
          ? ` ${JSON.stringify(error.params)}`
          : ''
      }`,
  )
  return { ok: false, error: { kind, errors } }
}
