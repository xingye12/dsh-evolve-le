/**
 * Candidate SDK contract tests (Gate 1): boundaries are enforced at
 * registration time — out-of-namespace section names, bad orders, empty or
 * oversized text, unknown modes and missing systemPrompt all fail closed.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createHarness } from '../src/testkit.js'
import { defineCandidate, type CandidateRuntime } from '../src/index.js'

interface TestConfig extends CandidateRuntime {
  candidateId: string
}

const builder = (name: string) => (config: TestConfig) => ({
  name: name as `candidate:${string}`,
  order: 100,
  text: `section for ${config.candidateId}`,
})

describe('defineCandidate boundaries', () => {
  it('registers an in-namespace section in both modes', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: { promptSection: builder('candidate:identity') },
      propose: { promptSection: builder('candidate:proposal-policy') },
    })
    for (const mode of ['solve', 'propose'] as const) {
      const harness = createHarness()
      candidate.register(harness.ctx, { mode, candidateId: 'c_test' })
      expect(harness.sections()).toHaveLength(1)
      harness.dispose()
      expect(harness.sections()).toEqual([])
    }
  })

  it('rejects section names outside the candidate: namespace', () => {
    const candidate = defineCandidate<TestConfig>({
      // Deliberately out-of-boundary name; the runtime check must reject it.
      solve: { promptSection: builder('system-prompt') },
      propose: { promptSection: builder('candidate:proposal-policy') },
    })
    const harness = createHarness()
    expect(() => candidate.register(harness.ctx, { mode: 'solve', candidateId: 'c_test' })).toThrow(
      /candidate-sdk: section name must match/,
    )
  })

  it('rejects non-integer and out-of-range orders', () => {
    const withOrder = (order: number) =>
      defineCandidate<TestConfig>({
        solve: {
          promptSection: (config) => ({
            name: 'candidate:identity',
            order,
            text: config.candidateId,
          }),
        },
        propose: {},
      })
    const harness = createHarness()
    expect(() => withOrder(1.5).register(harness.ctx, { mode: 'solve', candidateId: 'x' })).toThrow(
      /order/,
    )
    expect(() => withOrder(-1).register(harness.ctx, { mode: 'solve', candidateId: 'x' })).toThrow(
      /order/,
    )
    expect(() =>
      withOrder(10_001).register(harness.ctx, { mode: 'solve', candidateId: 'x' }),
    ).toThrow(/order/)
  })

  it('rejects empty and oversized text', () => {
    const withText = (text: string) =>
      defineCandidate<TestConfig>({
        solve: { promptSection: () => ({ name: 'candidate:identity', order: 1, text }) },
        propose: {},
      })
    const harness = createHarness()
    expect(() => withText('').register(harness.ctx, { mode: 'solve', candidateId: 'x' })).toThrow(
      /text/,
    )
    expect(() =>
      withText('x'.repeat(32 * 1024 + 1)).register(harness.ctx, {
        mode: 'solve',
        candidateId: 'x',
      }),
    ).toThrow(/text/)
  })

  it('rejects unknown modes and non-object configs', () => {
    const candidate = defineCandidate({
      solve: {},
      propose: {},
    })
    const harness = createHarness()
    expect(() => candidate.register(harness.ctx, { mode: 'audit' } as never)).toThrow(
      /mode must be/,
    )
    expect(() => candidate.register(harness.ctx, null as never)).toThrow(/config must be/)
  })

  it('rejects a definition missing a mode behavior', () => {
    expect(() => defineCandidate({ solve: {} } as never)).toThrow(/"propose"/)
  })

  it('fails closed when systemPrompt is not injectable', () => {
    const candidate = defineCandidate({
      solve: { promptSection: () => ({ name: 'candidate:identity', order: 1, text: 't' }) },
      propose: {},
    })
    const bare = {} as Context
    expect(() => candidate.register(bare, { mode: 'solve' })).toThrow(
      /systemPrompt service unavailable/,
    )
  })

  it('describe() resolves the plan without touching a context', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: { promptSection: builder('candidate:identity') },
      propose: {},
    })
    expect(candidate.describe({ mode: 'solve', candidateId: 'c_test' }).section?.name).toBe(
      'candidate:identity',
    )
    expect(candidate.describe({ mode: 'propose', candidateId: 'c_test' }).section).toBeUndefined()
  })

  it('registers candidate-owned DSH tools and skills with effect ownership', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: {
        tools: () => [
          {
            name: 'candidate_probe',
            description: 'Probe the current strategy.',
            parameters: { type: 'object' },
            output: {
              schema: { type: 'string' },
              render: () => [],
            },
            execute: async () => 'ok',
          },
        ],
        skills: () => [
          {
            name: 'candidate-review',
            description: 'Review the strategy.',
            content: 'Review the strategy before acting.',
            invocation: { modelInvocable: true, userInvocable: false },
          },
        ],
      },
      propose: {},
    })
    const harness = createHarness()
    candidate.register(harness.ctx, { mode: 'solve', candidateId: 'c_test' })
    expect(harness.tools().map((tool) => tool.name)).toEqual(['candidate_probe'])
    expect(harness.skills().map((skill) => skill.name)).toEqual(['candidate-review'])
    expect(harness.effects()).toHaveLength(2)
    harness.dispose()
    expect(harness.tools()).toEqual([])
    expect(harness.skills()).toEqual([])
  })

  it('registers agent/session events and workflows with effect ownership', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: {
        agentEvents: () => [{ name: 'candidate:agent/before-step', handler: () => undefined }],
        sessionEvents: () => [{ name: 'candidate:session/observed', handler: () => undefined }],
        workflows: () => [
          {
            name: 'candidate-workflow:recover',
            description: 'Recover a bounded session.',
            run: async () => 'ok',
          },
        ],
      },
      propose: {},
    })
    const harness = createHarness()
    candidate.register(harness.ctx, { mode: 'solve', candidateId: 'c_test' })
    expect(harness.events().map((event) => event.name)).toEqual([
      'candidate:agent/before-step',
      'candidate:session/observed',
    ])
    expect(harness.workflows().map((workflow) => workflow.name)).toEqual([
      'candidate-workflow:recover',
    ])
    harness.dispose()
    expect(harness.events()).toEqual([])
    expect(harness.workflows()).toEqual([])
  })

  it('registers an automatic tool facet with only the typed strategy context', async () => {
    const candidate = defineCandidate<TestConfig>({
      solve: {
        tools: () => [
          {
            name: 'candidate_next_step',
            description: 'Give bounded next-step advice.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            output: { schema: { type: 'string' }, render: () => [] },
            execute: async () => 'model-callable',
            strategy: {
              autoInvoke: true,
              run: async (context) => ({ checkpoint: `turn-${String(context.turn)}` }),
            },
          },
        ],
      },
      propose: {},
    })
    const harness = createHarness()
    candidate.register(harness.ctx, { mode: 'solve', candidateId: 'c_test' })
    expect(harness.strategyTools().map((tool) => tool.name)).toEqual(['candidate_next_step'])
    await expect(
      harness.strategyTools()[0]!.run({
        protocol: 'dsh-evolve-le/candidate-strategy-context/v1',
        turn: 2,
        step: 1,
        phase: 'pre-step',
        observation: {
          toolCalls: { exec: 0, read: 0, write: 0 },
          previousAction: 'none',
          lastExec: { outcome: 'none', consecutiveRepeated: 0 },
          writesSinceLastExec: 0,
        },
      }),
    ).resolves.toEqual({ checkpoint: 'turn-2' })
  })

  it('fails closed when event or workflow registrations are malformed', () => {
    const badEvent = defineCandidate({
      solve: { agentEvents: () => [{ name: 'agent/update', handler: () => undefined }] },
      propose: {},
    })
    expect(() => badEvent.describe({ mode: 'solve' })).toThrow(/event name/)
    const badWorkflow = defineCandidate({
      solve: {
        workflows: () => [{ name: 'workflow', description: 'x', run: async () => undefined }],
      },
      propose: {},
    })
    expect(() => badWorkflow.describe({ mode: 'solve' })).toThrow(/workflow name/)
  })

  it('resolves injected services through Cordis get() in a native agent scope', () => {
    const sections: string[] = []
    const tools: string[] = []
    const skills: string[] = []
    const ctx = {
      get(name: string) {
        if (name === 'systemPrompt') {
          return {
            section: (input: { name: string }) => {
              sections.push(input.name)
              return () => undefined
            },
          }
        }
        if (name === 'tools') {
          return {
            register: (definition: { name: string }) => {
              tools.push(definition.name)
              return () => undefined
            },
          }
        }
        if (name === 'skills') {
          return {
            register: (skill: { name: string }) => {
              skills.push(skill.name)
              return () => undefined
            },
          }
        }
        return undefined
      },
      effect(factory: () => (() => void) | void) {
        return factory() ?? (() => undefined)
      },
    } as unknown as Context
    const candidate = defineCandidate<TestConfig>({
      solve: {
        promptSection: builder('candidate:identity'),
        tools: () => [
          {
            name: 'candidate_probe',
            description: 'Probe the strategy.',
            parameters: { type: 'object' },
            output: { schema: { type: 'string' }, render: () => [] },
            execute: async () => 'ok',
          },
        ],
        skills: () => [
          {
            name: 'candidate-review',
            description: 'Review the strategy.',
            content: 'Review before acting.',
          },
        ],
      },
      propose: {},
    })
    candidate.register(ctx, { mode: 'solve', candidateId: 'c_test' })
    expect(sections).toEqual(['candidate:identity'])
    expect(tools).toEqual(['candidate_probe'])
    expect(skills).toEqual(['candidate-review'])
  })

  it('does not read guarded Cordis service properties before ctx.get()', () => {
    const registrations: string[] = []
    const ctx = {
      get(name: string) {
        if (name !== 'systemPrompt') return undefined
        return {
          section: (input: { name: string }) => {
            registrations.push(input.name)
            return () => undefined
          },
        }
      },
      get systemPrompt(): never {
        throw new Error('cannot get property "systemPrompt" without inject')
      },
      effect(factory: () => (() => void) | void) {
        return factory() ?? (() => undefined)
      },
    } as unknown as Context
    const candidate = defineCandidate<TestConfig>({
      solve: { promptSection: builder('candidate:identity') },
      propose: {},
    })

    candidate.register(ctx, { mode: 'solve', candidateId: 'c_test' })
    expect(registrations).toEqual(['candidate:identity'])
  })

  it('rejects strategy registrations outside candidate namespaces', () => {
    const candidate = defineCandidate<TestConfig>({
      solve: {
        tools: () => [
          {
            name: 'read_file',
            description: 'Not candidate-owned.',
            parameters: { type: 'object' },
            output: { schema: { type: 'string' }, render: () => [] },
            execute: async () => 'nope',
          },
        ],
      },
      propose: {},
    })
    expect(() => candidate.describe({ mode: 'solve', candidateId: 'c_test' })).toThrow(
      /tool name must match/,
    )
  })

  it('candidates without a promptSection register no effects', () => {
    const candidate = defineCandidate({ solve: {}, propose: {} })
    const harness = createHarness()
    candidate.register(harness.ctx, { mode: 'solve' })
    expect(harness.sections()).toEqual([])
    expect(harness.effects()).toEqual([])
  })
})
