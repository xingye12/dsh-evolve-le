import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { repoRoot } from '../schema.js'
const cache = new Map<string, ReturnType<Ajv2020['compile']>>()
export function validateDiagnosticArtifact(
  kind: 'failure-report' | 'candidate-error-overview' | 'failure-index' | 'agent-debugger',
  value: unknown,
): void {
  let validator = cache.get(kind)
  if (!validator) {
    validator = new Ajv2020({ strict: true, allErrors: true }).compile(
      JSON.parse(readFileSync(resolve(repoRoot, 'schemas', `${kind}.schema.json`), 'utf8')),
    )
    cache.set(kind, validator)
  }
  if (kind === 'failure-index' && value && typeof value === 'object') {
    const index = value as { subjectCandidateId: unknown; entries?: { candidateId: unknown }[] }
    if (
      Array.isArray(index.entries) &&
      index.entries.some((e) => e.candidateId !== index.subjectCandidateId)
    )
      throw Error('failure-index candidate ownership mismatch')
  }
  if (!validator(value)) throw Error(`invalid ${kind}: ${JSON.stringify(validator.errors)}`)
}

// A JSON schema cannot express equality with the enclosing subject candidate.
// Cross-object provenance remains the publisher/exporter's responsibility.
