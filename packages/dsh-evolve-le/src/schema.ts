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

const compilers = new Map<ManifestKind, ReturnType<typeof makeValidator>>()

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

/**
 * Validate one manifest document against its versioned schema.
 * @param kind - which manifest schema to apply.
 * @param data - parsed JSON document.
 * @returns ok with the same value, or the full error list.
 */
export function validateManifest(kind: ManifestKind, data: unknown): ManifestValidationResult {
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
