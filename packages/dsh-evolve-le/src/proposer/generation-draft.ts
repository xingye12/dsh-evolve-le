/** Source-authoring envelope only. Semantic receipts remain untrusted until external finalization. */
import { PROPOSAL_MAX_WIDTH, type ProposalOutput, type ChildProposalIntent } from './protocol.js'
export type ProposalDraft = Omit<ProposalOutput, 'children'> & {
  children: Array<Omit<ChildProposalIntent, 'analysisReceipt' | 'proposalReceipt'>>
}
export function parseGenerationDraft(raw: unknown): asserts raw is ProposalDraft {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('invalid generation draft')
  const value = raw as Record<string, unknown>
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.protocol !== `dsh-evolve-le/proposal/v${value.schemaVersion}` ||
    typeof value.parentSourceHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.parentSourceHash) ||
    !Array.isArray(value.children) ||
    !value.children.length ||
    value.children.length > PROPOSAL_MAX_WIDTH
  )
    throw Error('invalid generation draft envelope')
  const names = new Set<string>(),
    hypotheses = new Set<string>()
  for (const rawChild of value.children) {
    if (!rawChild || typeof rawChild !== 'object' || Array.isArray(rawChild))
      throw Error('invalid generation draft child')
    const child = rawChild as Record<string, unknown>
    if (
      typeof child.childName !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(child.childName) ||
      names.has(child.childName) ||
      typeof child.hypothesis !== 'string' ||
      child.hypothesis.length < 10 ||
      hypotheses.has(child.hypothesis)
    )
      throw Error('invalid generation draft child identity/hypothesis')
    names.add(child.childName)
    hypotheses.add(child.hypothesis)
    for (const key of ['donorCandidates', 'targetFailureModes'])
      if (
        !Array.isArray(child[key]) ||
        child[key].some((item: unknown) => typeof item !== 'string')
      )
        throw Error('invalid generation draft metadata')
  }
}
