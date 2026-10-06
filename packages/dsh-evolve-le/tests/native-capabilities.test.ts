import { describe, expect, it } from 'vitest'
import { bootConfig } from '../src/builder/capsule.js'
import { installNativeLlmAdapter } from '../src/dsh/native-llm-adapter.js'
import { DelegationBudget, NATIVE_CAPABILITIES_POLICY } from '../src/dsh/native-capabilities.js'

describe('native compression and delegation contract', () => {
  it('loads upstream compression and subagent services through the production overlay', () => {
    const config = bootConfig('candidate', 'id', 'solve', {})
    expect(config).toContain('@deepseek-ai/dsh-token-meter')
    expect(config).toContain('@deepseek-ai/dsh-compaction-basic')
    expect(config).toContain('@deepseek-ai/dsh-subagent')
    expect(bootConfig('candidate', 'id', 'solve')).not.toContain('dsh-compaction-basic')
  })

  it('reserves count and concurrent slots before asynchronous child creation', () => {
    const budget = new DelegationBudget({ maxChildren: 2, maxConcurrent: 1, maxDepth: 1 })
    const release = budget.reserve(1)
    expect(() => budget.reserve(1)).toThrow(/concurrent/)
    release()
    release()
    budget.reserve(1)()
    expect(() => budget.reserve(1)).toThrow(/count/)
    expect(() => budget.reserve(2)).toThrow(/depth/)
    expect(NATIVE_CAPABILITIES_POLICY.subagents.maxDepth).toBe(1)
  })

  it('exposes frozen context capacity and counts every gateway completion including summaries', async () => {
    let adapter: any
    const usage = { inputTokens: 0, outputTokens: 0 }
    installNativeLlmAdapter(
      {
        llm: {
          registerAdapter(_p: unknown, a: unknown) {
            adapter = a
            return () => {}
          },
        },
      } as never,
      {
        provider: 'p',
        model: 'm',
        maxTokens: 128,
        contextWindowTokens: 10000,
        usageSink: usage,
        complete: () => ({ responseText: 'summary', promptTokens: 17, completionTokens: 3 }),
      },
    )
    expect(await adapter.resolveModel('p', 'm')).toMatchObject({
      context: { contextWindow: 10000 },
    })
    for await (const _ of adapter.stream({
      provider: 'p',
      model: 'm',
      messages: [],
      maxTokens: 8192,
    })) {
      /* exhaust */
    }
    expect(usage).toEqual({ inputTokens: 17, outputTokens: 3 })
    expect(() =>
      installNativeLlmAdapter({} as never, {
        provider: 'p',
        model: 'm',
        contextWindowTokens: 0,
        complete: () => ({ responseText: 'x' }),
      }),
    ).toThrow(/context/)
  })
})
