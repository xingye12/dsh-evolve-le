/**
 * TCB-owned outer-scope registry for candidate workflow declarations.
 *
 * Native DSH owns prompt, tool and skill services, but candidate plugins are
 * first loaded in the capsule's outer Cordis scope so they can publish their
 * agent-scope setup hook.  This registry makes that declaration loadable
 * without pretending to execute candidate workflows there.  The native solve
 * runner installs a fresh registry in each unpublished agent Fiber and is the
 * only component that invokes the fixed solve-policy workflow.
 * @module @dsh-evolve-le/core/probe/candidate-workflow-stub
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * ADR-060: registrations retain the full candidate workflow object — name,
 * description and the bounded run hook — not just the name. The native solve
 * runner reuses this outer-scope registry when it is present (Cordis forbids
 * re-providing an ancestor service on the agent Fiber), so the fixed
 * solve-policy workflow must remain executable through the stub.
 */
interface CandidateWorkflowRegistration {
  name: string
  description?: string
  run?: (input: unknown) => Promise<unknown>
}

export interface StubCandidateWorkflowsService {
  register(input: CandidateWorkflowRegistration): () => void
  snapshot(): readonly CandidateWorkflowRegistration[]
}

export const name = 'dsh-evolve-le:candidate-workflow-stub'

export function apply(ctx: Context): void {
  const workflows: CandidateWorkflowRegistration[] = []
  ctx.provide('candidateWorkflows', {
    register(input: CandidateWorkflowRegistration): () => void {
      workflows.push(input)
      return () => {
        const at = workflows.indexOf(input)
        if (at >= 0) workflows.splice(at, 1)
      }
    },
    snapshot(): readonly CandidateWorkflowRegistration[] {
      return [...workflows]
    },
  } satisfies StubCandidateWorkflowsService)
}
