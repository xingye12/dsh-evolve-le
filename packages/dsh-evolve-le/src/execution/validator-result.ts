/** Verify a terminal external result before adoption; never launches work. */
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson, sha256Hex } from '../state/canonical.js'
import { openObjectStore, validateRef } from '../state/object-store.js'
import { buildCanonicalTar } from '../candidate/canonical.js'
import { readCanonicalFile, verifyExecutionBundle } from './evidence.js'
import { executionName, assertExact, ExecutionError } from './types.js'
import { readSourceSnapshot } from './snapshot.js'
import { readValidatorExport } from './validator-export.js'
import type {
  ValidatorSupervisorConfig,
  ValidatorSupervisorResult,
} from './validator-supervisor.js'
export async function readValidatorResult(
  config: ValidatorSupervisorConfig,
): Promise<ValidatorSupervisorResult | null> {
  const root = join(config.hostRoot, executionName(config.spec))
  let value: unknown
  try {
    value = await readCanonicalFile(join(root, 'validator-supervisor-result.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  assertExact(value, [
    'protocol',
    'specDigest',
    'configuration',
    'outcome',
    'execution',
    'validation',
    'failure',
  ])
  if (
    value.protocol !== 'dsh-evolve-le/validator-supervisor-result/v1' ||
    value.specDigest !== canonicalHash(config.spec) ||
    !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INCOMPLETE'].includes(String(value.outcome))
  )
    throw new ExecutionError('invalid validator supervisor result')
  const store = await openObjectStore(config.storeRoot)
  validateRef(value.configuration)
  const frozen = parseCanonicalJson((await store.read(value.configuration)).toString('utf8'))
  if (canonicalJson(frozen) !== canonicalJson(config))
    throw new ExecutionError('supervisor frozen config mismatch')
  if (value.execution === null && value.failure === null)
    throw new ExecutionError('supervisor result lacks failure evidence')
  if (value.failure !== null) {
    validateRef(value.failure)
    await store.verify(value.failure)
  }
  if (value.execution !== null) {
    validateRef(value.execution)
    const bundle = await verifyExecutionBundle(store, value.execution)
    const spec = parseCanonicalJson((await store.read(bundle.spec)).toString('utf8'))
    if (canonicalHash(spec) !== canonicalHash(config.spec))
      throw new ExecutionError('supervisor execution spec mismatch')
    if (value.outcome !== 'INCOMPLETE' && value.outcome !== bundle.outcome)
      throw new ExecutionError('supervisor outcome mismatch')
    if (value.validation !== null) {
      validateRef(value.validation)
      if (
        value.outcome !== 'SUCCEEDED' ||
        !bundle.artifacts.some((r) => canonicalJson(r) === canonicalJson(value.validation))
      )
        throw new ExecutionError('unbound supervisor validation receipt')
      const source = await readSourceSnapshot(store, config.validator.sourceSnapshot)
      const files = []
      for (const file of source.files)
        files.push({ path: file.path, mode: file.mode, content: await store.read(file.content) })
      await readValidatorExport(store, value.validation, {
        executionId: config.spec.executionId,
        sourceDigest: `sha256:${sha256Hex(buildCanonicalTar(files))}`,
      })
    }
  } else if (value.outcome === 'SUCCEEDED' || value.validation !== null)
    throw new ExecutionError('success without execution bundle')
  if (value.outcome === 'SUCCEEDED' && (value.validation === null || value.failure !== null))
    throw new ExecutionError('incomplete successful validator result')
  return value as unknown as ValidatorSupervisorResult
}
