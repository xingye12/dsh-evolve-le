/**
 * Candidate testkit (specs/02 §7): a dependency-free fake of the exact Cordis
 * surface {@link defineCandidate} touches, so candidate-owned tests can assert
 * their prompt, tool and skill wiring without a live harness, network, or model.
 *
 * It is deliberately minimal — it records strategy registrations and
 * `ctx.effect` ownership. If a candidate needs more than this to test itself,
 * that is a signal its behavior exceeds the candidate surface.
 *
 * @module @dsh-evolve-le/candidate-sdk/testkit
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  CandidateMode,
  CandidateEventRegistration,
  CandidateSkillRegistration,
  CandidateToolDefinition,
  CandidateWorkflowRegistration,
  PromptSection,
} from './index.js'

/** One live section: present while its owning effect is undisposed. */
export interface RecordedSection extends PromptSection {}

/** One registered effect and whether its teardown has run. */
export interface RecordedEffect {
  index: number
  disposed: boolean
}

export interface RecordedTool extends CandidateToolDefinition {}
export interface RecordedSkill extends CandidateSkillRegistration {}
export interface RecordedEvent extends CandidateEventRegistration {}
export interface RecordedWorkflow extends CandidateWorkflowRegistration {}

/** A mock plugin context plus readouts; `ctx` is cast, the rest is real. */
export interface CandidateHarness {
  /** Mock context satisfying exactly the surface the SDK touches. */
  readonly ctx: Context
  /** Sections currently registered (disposers remove them). */
  sections(): readonly RecordedSection[]
  /** Effects registered through `ctx.effect`, with disposal state. */
  effects(): readonly RecordedEffect[]
  /** Candidate tools currently registered through the DSH-shaped registry. */
  tools(): readonly RecordedTool[]
  /** Candidate skills currently registered through the DSH-shaped registry. */
  skills(): readonly RecordedSkill[]
  /** Candidate agent/session event listeners still mounted. */
  events(): readonly RecordedEvent[]
  /** Candidate workflows still registered through the trusted registry. */
  workflows(): readonly RecordedWorkflow[]
  /** Run all effect teardowns in reverse order (simulates Fiber disposal). */
  dispose(): void
}

/**
 * Build a recording harness. Sections registered by
 * `candidate.register(harness.ctx, config)` appear in `sections()` and vanish
 * after `dispose()`, mirroring how a real Fiber unwind drops effect-owned
 * prompt contributions.
 */
export function createHarness(): CandidateHarness {
  const liveSections: RecordedSection[] = []
  const effects: RecordedEffect[] = []
  const liveTools: RecordedTool[] = []
  const liveSkills: RecordedSkill[] = []
  const liveEvents: RecordedEvent[] = []
  const liveWorkflows: RecordedWorkflow[] = []
  const teardownFor = new Map<RecordedEffect, () => void>()

  const systemPrompt = {
    section(input: PromptSection): () => void {
      const record: RecordedSection = { name: input.name, order: input.order, text: input.text }
      liveSections.push(record)
      return () => {
        const at = liveSections.indexOf(record)
        if (at >= 0) liveSections.splice(at, 1)
      }
    },
  }

  const runTeardown = (record: RecordedEffect): void => {
    if (record.disposed) return
    record.disposed = true
    const teardown = teardownFor.get(record)
    teardown?.()
  }

  const effect = (factory: () => (() => void) | void): (() => void) => {
    const record: RecordedEffect = { index: effects.length, disposed: false }
    effects.push(record)
    teardownFor.set(record, factory() ?? (() => {}))
    return () => runTeardown(record)
  }

  const tools = {
    register(definition: CandidateToolDefinition): () => void {
      liveTools.push(definition)
      return () => {
        const at = liveTools.indexOf(definition)
        if (at >= 0) liveTools.splice(at, 1)
      }
    },
  }
  const skills = {
    register(skill: CandidateSkillRegistration): () => void {
      liveSkills.push(skill)
      return () => {
        const at = liveSkills.indexOf(skill)
        if (at >= 0) liveSkills.splice(at, 1)
      }
    },
  }

  const candidateWorkflows = {
    register(workflow: CandidateWorkflowRegistration): () => void {
      liveWorkflows.push(workflow)
      return () => {
        const at = liveWorkflows.indexOf(workflow)
        if (at >= 0) liveWorkflows.splice(at, 1)
      }
    },
  }
  const on = (name: string, handler: (...args: unknown[]) => unknown): (() => void) => {
    const event: RecordedEvent = { name: name as RecordedEvent['name'], handler }
    liveEvents.push(event)
    return () => {
      const at = liveEvents.indexOf(event)
      if (at >= 0) liveEvents.splice(at, 1)
    }
  }

  const ctx = { systemPrompt, tools, skills, candidateWorkflows, effect, on } as unknown as Context

  return {
    ctx,
    sections: () => [...liveSections],
    effects: () => effects.map((effect) => ({ ...effect })),
    tools: () => [...liveTools],
    skills: () => [...liveSkills],
    events: () => [...liveEvents],
    workflows: () => [...liveWorkflows],
    dispose(): void {
      for (const record of [...effects].reverse()) runTeardown(record)
    },
  }
}

/** Convenience config for tests: any mode, plus whatever fields the candidate needs. */
export function modeConfig<C extends { mode: CandidateMode }>(
  mode: CandidateMode,
  extra: Omit<C, 'mode'> = {} as Omit<C, 'mode'>,
): C {
  return { mode, ...extra } as C
}
