/** Read the external completion fact and all immutable source bindings. */
import { parseGenerationDraft } from '../proposer/generation-draft.js'
import { join } from 'node:path'
import { canonicalHash, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectStore, type ObjectRef } from '../state/object-store.js'
import { parseProposalOutput, type ProposalOutput } from '../proposer/protocol.js'
import { readCanonicalFile } from './evidence.js'
import { readSourceSnapshot } from './snapshot.js'
import { assertExact, ExecutionError, type ExecutionSpec } from './types.js'
export interface VerifiedSubmission {
  ref: ObjectRef
  proposal: ProposalOutput
  sources: { child: string; source: ObjectRef }[]
  artifacts: ObjectRef[]
}
export async function readSubmission(options: {
  root: string
  spec: ExecutionSpec
  store: ObjectStore
  generationOnly?: true
  children?: readonly string[]
  parentSourceHash?: string
}): Promise<VerifiedSubmission | null> {
  let ref: unknown
  try {
    ref = await readCanonicalFile(join(options.root, 'submitted.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  validateRef(ref)
  return verifySubmission({ ...options, ref })
}
/** Verify a CAS completion fact without requiring the old container/work directory. */
export async function verifySubmission(options: {
  ref: ObjectRef
  spec: ExecutionSpec
  store: ObjectStore
  generationOnly?: true
  children?: readonly string[]
  parentSourceHash?: string
}): Promise<VerifiedSubmission> {
  const ref = options.ref
  validateRef(ref)
  const value = parseCanonicalJson((await options.store.read(ref)).toString('utf8'))
  assertExact(value, ['protocol', 'specDigest', 'executionId', 'proposal', 'sources'])
  if (
    value.protocol !==
      (options.generationOnly
        ? 'dsh-evolve-le/generation-submission/v1'
        : 'dsh-evolve-le/proposal-submission/v1') ||
    value.specDigest !== canonicalHash(options.spec) ||
    value.executionId !== options.spec.executionId ||
    !Array.isArray(value.sources)
  )
    throw new ExecutionError('invalid submission execution binding')
  if (options.generationOnly) parseGenerationDraft(value.proposal)
  else parseProposalOutput(value.proposal)
  const proposal = value.proposal
  if (options.parentSourceHash && proposal.parentSourceHash !== options.parentSourceHash)
    throw new ExecutionError('submission parent binding mismatch')
  const expected = new Set(proposal.children.map((c) => c.childName))
  const sources: VerifiedSubmission['sources'] = [],
    artifacts: ObjectRef[] = [ref]
  for (const source of value.sources) {
    assertExact(source, ['child', 'source'])
    if (
      typeof source.child !== 'string' ||
      !expected.delete(source.child) ||
      (options.children && !options.children.includes(source.child))
    )
      throw new ExecutionError('submission child allocation mismatch')
    validateRef(source.source)
    const snapshot = await readSourceSnapshot(options.store, source.source)
    if (
      snapshot.executionId !== options.spec.executionId ||
      snapshot.specDigest !== canonicalHash(options.spec) ||
      snapshot.child !== source.child
    )
      throw new ExecutionError('submission source binding mismatch')
    sources.push({ child: source.child, source: source.source })
    artifacts.push(source.source, ...snapshot.files.map((f) => f.content))
  }
  if (expected.size) throw new ExecutionError('submission missing child source')
  return { ref, proposal, sources, artifacts }
}
