/** Controller handoff reader: verified execution and cleanup, never Archive admission. */
import { join } from 'node:path'
import { canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { assertExact, ExecutionError, type ExecutionSpec, type ExecutionOutcome } from './types.js'
import { readCanonicalFile, verifyExecutionBundle } from './evidence.js'
import { verifyExecutionCompletion } from './completion.js'
import { verifySubmission } from './submission.js'
export interface ProposalSupervisorOutcome {
  protocol: 'dsh-evolve-le/proposal-supervisor-result/v2'
  outcome: ExecutionOutcome
  execution: ObjectRef
  completion: ObjectRef
  submission: ObjectRef | null
}
interface ExpectedProposal {
  store: ObjectStore
  spec: ExecutionSpec
  children: readonly string[]
  parentSourceHash: string
}
export async function verifyProposalSupervisorOutcome(
  raw: unknown,
  expected: ExpectedProposal,
): Promise<ProposalSupervisorOutcome> {
  raw = structuredClone(raw)
  expected = { ...expected, spec: structuredClone(expected.spec), children: [...expected.children] }
  assertExact(raw, ['protocol', 'outcome', 'execution', 'completion', 'submission'])
  if (
    raw.protocol !== 'dsh-evolve-le/proposal-supervisor-result/v2' ||
    expected.spec.kind !== 'proposal'
  )
    throw new ExecutionError('proposal result requires v2 proposal execution')
  validateRef(raw.execution)
  validateRef(raw.completion)
  const bundle = await verifyExecutionBundle(expected.store, raw.execution)
  if (
    raw.outcome !== bundle.outcome ||
    canonicalJson(parseCanonicalJson((await expected.store.read(bundle.spec)).toString('utf8'))) !==
      canonicalJson(expected.spec)
  )
    throw new ExecutionError('proposal outcome/execution spec mismatch')
  const completion = await verifyExecutionCompletion(expected.store, raw.completion, expected.spec)
  if (canonicalJson(completion.execution) !== canonicalJson(raw.execution))
    throw new ExecutionError('proposal cleanup bound to another bundle')
  if (bundle.outcome === 'SUCCEEDED') {
    validateRef(raw.submission)
    const submission = await verifySubmission({ ...expected, ref: raw.submission })
    for (const ref of submission.artifacts)
      if (!bundle.artifacts.some((artifact) => canonicalJson(artifact) === canonicalJson(ref)))
        throw new ExecutionError('submission absent from execution artifacts')
  } else if (raw.submission !== null)
    throw new ExecutionError('failed proposal cannot hand off a submission')
  return raw as unknown as ProposalSupervisorOutcome
}
export async function readProposalSupervisorResult(
  expected: ExpectedProposal & { root: string },
): Promise<ProposalSupervisorOutcome | null> {
  let raw: unknown
  try {
    raw = await readCanonicalFile(join(expected.root, 'result.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return verifyProposalSupervisorOutcome(raw, expected)
}
