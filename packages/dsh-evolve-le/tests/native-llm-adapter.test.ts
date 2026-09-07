import { describe, expect, it } from 'vitest'
import { installNativeLlmAdapter, type NativeLlmToolSchema } from '../src/dsh/native-llm-adapter.js'

describe('native DSH LLM adapter bridge', () => {
  it('maps native generate requests to the locked gateway route', async () => {
    const registrations: Array<{ providers: string[]; adapter: any }> = []
    const requests: any[] = []
    const ctx = {
      llm: {
        registerAdapter(providers: string[], adapter: any) {
          registrations.push({ providers, adapter })
          return () => undefined
        },
      },
    } as never
    const dispose = installNativeLlmAdapter(ctx, {
      provider: 'gateway-provider',
      model: 'gateway-model',
      maxTokens: 128,
      complete(request) {
        requests.push(request)
        return { responseText: 'native answer', promptTokens: 7, completionTokens: 3 }
      },
    })

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.providers).toEqual(['gateway-provider'])
    const tools: NativeLlmToolSchema[] = [
      { name: 'candidate_strategy_snapshot', description: 'inspect', parameters: {} },
    ]
    const chunks: any[] = []
    for await (const chunk of registrations[0]!.adapter.stream({
      provider: 'gateway-provider',
      model: 'gateway-model',
      system: 'system text',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'previous' }] },
      ],
      tools,
      maxTokens: 64,
    })) {
      chunks.push(chunk)
    }
    expect(requests).toEqual([
      {
        provider: 'gateway-provider',
        model: 'gateway-model',
        system: 'system text',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'previous' }] },
        ],
        userText: 'USER\nhello\n\nASSISTANT\nprevious',
        tools,
      },
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'native answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'native answer' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(() => dispose()).not.toThrow()
  })

  it('rejects a route mismatch and empty gateway result', async () => {
    const registrations: any[] = []
    const ctx = {
      llm: {
        registerAdapter(_providers: string[], adapter: any) {
          registrations.push(adapter)
          return () => undefined
        },
      },
    } as never
    installNativeLlmAdapter(ctx, {
      provider: 'p',
      model: 'm',
      complete: () => ({ responseText: '' }),
    })
    await expect(
      (async () => {
        for await (const _chunk of registrations[0].stream({
          provider: 'other',
          model: 'm',
          messages: [],
        })) {
          // exhaust the stream
        }
      })(),
    ).rejects.toThrow(/locked route/)
  })

  it('preserves structured tool calls in the native stream', async () => {
    const registrations: any[] = []
    const ctx = {
      llm: {
        registerAdapter(_providers: string[], adapter: any) {
          registrations.push(adapter)
          return () => undefined
        },
      },
    } as never
    installNativeLlmAdapter(ctx, {
      provider: 'p',
      model: 'm',
      complete: async () => ({
        responseText: '',
        toolCalls: [{ id: 'call-1', name: 'solve_exec', arguments: '{"command":"pwd"}' }],
        promptTokens: 11,
        completionTokens: 4,
      }),
    })
    const chunks: any[] = []
    for await (const chunk of registrations[0].stream({
      provider: 'p',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }] }],
      tools: [{ name: 'solve_exec', description: 'run', parameters: {} }],
    })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'call-1',
        name: 'solve_exec',
        argumentsDelta: '{"command":"pwd"}',
      },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'call-1',
          name: 'solve_exec',
          arguments: '{"command":"pwd"}',
        },
      },
      { type: 'usage', usage: { inputTokens: 11, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it('resolves the unpublished LLM registry through ctx.get()', () => {
    let registered = false
    const llm = {
      registerAdapter() {
        registered = true
        return () => undefined
      },
    }
    const ctx = {
      get(name: string) {
        return name === 'llm' ? llm : undefined
      },
      get llm(): never {
        throw new Error('guarded llm property was read')
      },
    } as never
    const dispose = installNativeLlmAdapter(ctx, {
      provider: 'p',
      model: 'm',
      complete: () => ({ responseText: 'ok' }),
    })
    expect(registered).toBe(true)
    expect(dispose).not.toThrow()
  })
})
