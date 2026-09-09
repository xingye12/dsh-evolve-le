/**
 * Shared provenance-lock loading and JSON-Schema validation for the
 * `provenance:*` and `setup:source` scripts.
 * @module scripts/lib/lock
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

/** Repository root (the directory containing `provenance.lock.json`). */
export const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

/** Inferred shape of `provenance.lock.json` (validated by the JSON Schema). */
export interface ProvenanceLock {
  version: number
  generatedAt: string
  generatedBy: string
  upstreams: Record<
    string,
    {
      path: string
      vcs: 'git'
      commit: string
      remote: { owner: string; repo: string }
      snapshot?: {
        mode: 'tarball'
        url: string
        tarballSha256: string
        fileCount: number
        treeDigest: { algo: string; value: string }
      }
    }
  >
  references: Record<string, { path: string; sourceUrl: string; algo: string; value: string }>
  toolchain: Record<string, string>
  dshPackages: Record<string, string>
  verification: { machineReadable: boolean; checker: string; checks: string[] }
}

let validatorPromise: Promise<import('ajv/dist/2020.js').ValidateFunction> | undefined

async function getValidator() {
  validatorPromise ??= (async () => {
    const ajv = new Ajv2020.default({ allErrors: true })
    addFormats.default(ajv)
    const schema = JSON.parse(
      await readFile(resolve(repoRoot, 'schemas/provenance.lock.schema.json'), 'utf8'),
    ) as object
    return ajv.compile(schema)
  })()
  return validatorPromise
}

/**
 * Load and validate `provenance.lock.json`.
 * @returns the parsed lock.
 * @throws when the file is unreadable or violates
 *   `schemas/provenance.lock.schema.json`, with every schema error listed.
 */
export async function loadLock(): Promise<ProvenanceLock> {
  const path = resolve(repoRoot, 'provenance.lock.json')
  const source = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(source)
  const validate = await getValidator()
  if (!validate(parsed)) {
    const errors = (validate.errors ?? []).map(e => `${e.instancePath}: ${e.message ?? 'invalid'}`)
    throw new Error(`provenance.lock.json violates schemas/provenance.lock.schema.json:\n${errors.join('\n')}`)
  }
  return parsed as ProvenanceLock
}
