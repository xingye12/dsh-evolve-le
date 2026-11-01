/** Source generation is not admission. All successful handoffs require CAS cleanup proof. */
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { assertExact, ExecutionError, type ExecutionSpec, type ExecutionOutcome } from './types.js'
import { verifySubmission } from './submission.js'
import { publishCanonical, verifyExecutionBundle } from './evidence.js'
import { verifyExecutionCompletion } from './completion.js'
export interface ProposalGenerationResult {
  protocol: 'dsh-evolve-le/proposal-generation-result/v1'
  admission: 'NONE'
  outcome: ExecutionOutcome
  specDigest: string
  execution: ObjectRef | null
  completion: ObjectRef | null
  submission: ObjectRef | null
  diagnostic: ObjectRef | null
}
export interface ExpectedGeneration {
  store: ObjectStore
  spec: ExecutionSpec
  children: readonly string[]
  parentSourceHash: string
}
export async function verifyGenerationResult(
  raw: unknown,
  expected: ExpectedGeneration,
): Promise<ProposalGenerationResult> {
  raw = structuredClone(raw)
  expected = { ...expected, spec: structuredClone(expected.spec), children: [...expected.children] }
  assertExact(raw, [
    'protocol',
    'admission',
    'outcome',
    'specDigest',
    'execution',
    'completion',
    'submission',
    'diagnostic',
  ])
  if (
    raw.protocol !== 'dsh-evolve-le/proposal-generation-result/v1' ||
    raw.admission !== 'NONE' ||
    !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INCOMPLETE'].includes(String(raw.outcome)) ||
    raw.specDigest !== canonicalHash(expected.spec) ||
    expected.spec.kind !== 'proposal'
  )
    throw new ExecutionError('invalid generation result identity/outcome')
  for (const key of ['execution', 'completion', 'submission', 'diagnostic']) {
    if (raw[key] !== null) {
      validateRef(raw[key])
      await expected.store.verify(raw[key])
    }
  }
  if (raw.outcome === 'SUCCEEDED') {
    validateRef(raw.execution)
    validateRef(raw.completion)
    validateRef(raw.submission)
    const bundle = await verifyExecutionBundle(expected.store, raw.execution)
    if (
      bundle.outcome !== 'SUCCEEDED' ||
      canonicalJson(
        parseCanonicalJson((await expected.store.read(bundle.spec)).toString('utf8')),
      ) !== canonicalJson(expected.spec)
    )
      throw new ExecutionError('generation execution outcome/spec mismatch')
    const completion = await verifyExecutionCompletion(
      expected.store,
      raw.completion,
      expected.spec,
    )
    if (canonicalJson(completion.execution) !== canonicalJson(raw.execution))
      throw new ExecutionError('generation completion mismatch')
    const submission = await verifySubmission({
      ...expected,
      ref: raw.submission,
      generationOnly: true,
    })
    for (const ref of submission.artifacts)
      if (!bundle.artifacts.some((artifact) => canonicalJson(artifact) === canonicalJson(ref)))
        throw new ExecutionError('generation submission missing from execution')
  } else {
    if (raw.submission !== null || raw.diagnostic === null)
      throw new ExecutionError('failed generation requires diagnostic and no handoff')
    if (raw.execution !== null) {
      const bundle = await verifyExecutionBundle(expected.store, raw.execution as ObjectRef)
      if (raw.outcome !== 'INCOMPLETE' && bundle.outcome !== raw.outcome)
        throw new ExecutionError('failure outcome mismatch')
      if (
        canonicalJson(
          parseCanonicalJson((await expected.store.read(bundle.spec)).toString('utf8')),
        ) !== canonicalJson(expected.spec)
      )
        throw new ExecutionError('failure execution spec mismatch')
    }
    if (raw.completion !== null) {
      const completion = await verifyExecutionCompletion(
        expected.store,
        raw.completion as ObjectRef,
        expected.spec,
      )
      if (canonicalJson(completion.execution) !== canonicalJson(raw.execution))
        throw new ExecutionError('failure completion mismatch')
    }
    if (raw.outcome !== 'INCOMPLETE' && raw.execution !== null && raw.completion === null)
      throw new ExecutionError('unclean execution must remain INCOMPLETE')
  }
  return raw as unknown as ProposalGenerationResult
}
export async function publishGenerationResult(
  root: string,
  result: ProposalGenerationResult,
  expected: ExpectedGeneration,
): Promise<ObjectRef> {
  await verifyGenerationResult(result, expected)
  const ref = await expected.store.put(Buffer.from(canonicalJson(result)), {
    mediaType: 'application/vnd.dsh-evolve-le.proposal-generation-result+json',
    label: 'CONTROLLER_INTERNAL',
  })
  await publishCanonical(join(root, 'generation-result.json'), ref)
  return ref
}
export async function readGenerationResult(
  ref: ObjectRef,
  expected: ExpectedGeneration,
): Promise<ProposalGenerationResult> {
  validateRef(ref)
  if (ref.size > 1024 * 1024 || ref.label !== 'CONTROLLER_INTERNAL')
    throw new ExecutionError('invalid generation result envelope')
  return verifyGenerationResult(
    parseCanonicalJson((await expected.store.read(ref)).toString('utf8')),
    expected,
  )
}
