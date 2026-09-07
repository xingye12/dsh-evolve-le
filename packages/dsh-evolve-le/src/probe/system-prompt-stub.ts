/**
 * TCB strategy-service stub for capsule runner compositions (Gate 1). The
 * real DSH prompt, tool and skill services belong to the upstream DSH stack
 * and are staged with the full ACP closure; admission boots use these
 * byte-stable contracts plus snapshot readouts so the loader probe can assert
 * registration and unload invariants. Compiled to a single dependency-free
 * file and shipped inside every capsule at `runtime/system-prompt-stub.mjs`.
 * @module @dsh-evolve-le/core/probe/system-prompt-stub
 */

import type { Context } from '@deepseek-ai/cordis'

interface CandidateToolDefinition {
  name: string
}

interface CandidateSkillRegistration {
  name: string
}

interface CandidateWorkflowRegistration {
  name: string
}

/** One registered prompt section. */
export interface PromptSectionRecord {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** Stub service contract: the real surface plus a test readout. */
export interface StubSystemPromptService {
  section(input: PromptSectionRecord): () => void
  snapshot(): readonly PromptSectionRecord[]
}

export interface StubToolsService {
  register(input: CandidateToolDefinition): () => void
  snapshot(): readonly CandidateToolDefinition[]
}

export interface StubSkillsService {
  register(input: CandidateSkillRegistration): () => void
  snapshot(): readonly CandidateSkillRegistration[]
}

export interface StubCandidateWorkflowsService {
  register(input: CandidateWorkflowRegistration): () => void
  snapshot(): readonly CandidateWorkflowRegistration[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: StubSystemPromptService
  }
}

export const name = 'dsh-evolve-le:system-prompt-stub'

export function apply(ctx: Context): void {
  const sections: PromptSectionRecord[] = []
  const tools: CandidateToolDefinition[] = []
  const skills: CandidateSkillRegistration[] = []
  const workflows: CandidateWorkflowRegistration[] = []
  ctx.provide('systemPrompt', {
    section(input: PromptSectionRecord): () => void {
      const record: PromptSectionRecord = { name: input.name, order: input.order, text: input.text }
      sections.push(record)
      return () => {
        const at = sections.indexOf(record)
        if (at >= 0) sections.splice(at, 1)
      }
    },
    snapshot(): readonly PromptSectionRecord[] {
      return [...sections]
    },
  })
  ctx.provide('tools', {
    register(input: CandidateToolDefinition): () => void {
      tools.push(input)
      return () => {
        const at = tools.indexOf(input)
        if (at >= 0) tools.splice(at, 1)
      }
    },
    snapshot(): readonly CandidateToolDefinition[] {
      return [...tools]
    },
  } satisfies StubToolsService)
  ctx.provide('skills', {
    register(input: CandidateSkillRegistration): () => void {
      skills.push(input)
      return () => {
        const at = skills.indexOf(input)
        if (at >= 0) skills.splice(at, 1)
      }
    },
    snapshot(): readonly CandidateSkillRegistration[] {
      return [...skills]
    },
  } satisfies StubSkillsService)
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
