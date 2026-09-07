/**
 * Gate 1 fixture: trusted stub of the DSH `systemPrompt` service. The real
 * service belongs to the upstream DSH stack (staged in the capsule runner,
 * task 13); for controller-side Loader E2E this stub provides the same
 * `section()` contract with a `snapshot()` readout the tests can assert on.
 *
 * Loaded through the real Cordis Loader from `cordis.*.yml`. Erasable
 * TypeScript only (native type stripping, no TS-aware transform).
 */

import type { Context } from '@deepseek-ai/cordis'
interface CandidateToolDefinition {
  name: string
}

interface CandidateSkillRegistration {
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: StubSystemPromptService
  }
}

export const name = 'dsh-evolve-le:stub-system-prompt'

export function apply(ctx: Context): void {
  const sections: PromptSectionRecord[] = []
  const tools: CandidateToolDefinition[] = []
  const skills: CandidateSkillRegistration[] = []
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
    snapshot: () => [...tools],
  } satisfies StubToolsService)
  ctx.provide('skills', {
    register(input: CandidateSkillRegistration): () => void {
      skills.push(input)
      return () => {
        const at = skills.indexOf(input)
        if (at >= 0) skills.splice(at, 1)
      }
    },
    snapshot: () => [...skills],
  } satisfies StubSkillsService)
}
