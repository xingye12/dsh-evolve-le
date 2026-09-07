import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createNativeDshAgent,
  hasNativeDshComposition,
  nativeAssistantText,
  nativeUserMessage,
  mountNativeDshComposition,
  NativeDshUnavailableError,
  NATIVE_DSH_PACKAGE_PINS,
  assertNativeDshClosure,
  nativeDshClosurePresent,
  NATIVE_DSH_PROTOCOL,
  installNativePromptSections,
} from '../src/dsh/native-composition.js'
import { runNativeDshTurn } from '../src/dsh/native-runner.js'

describe('native DSH composition seam', () => {
  it('pins the upstream runtime and keeps native protocol identity stable', () => {
    expect(NATIVE_DSH_PROTOCOL).toBe('dsh-evolve-le/native-dsh/v1')
    expect(NATIVE_DSH_PACKAGE_PINS.map(([name]) => name)).toEqual([
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-agent-default-model',
      '@deepseek-ai/dsh-agent-spine-demo',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-skill',
    ])
    expect(() =>
      assertNativeDshClosure(NATIVE_DSH_PACKAGE_PINS.map(([name, version]) => ({ name, version }))),
    ).not.toThrow()
    expect(() => assertNativeDshClosure([])).toThrow(/missing/)
    expect(nativeDshClosurePresent([])).toBe(false)
  })

  it('fails closed when ctx.agents.create is not mounted', async () => {
    const ctx = new Context()
    expect(hasNativeDshComposition(ctx)).toBe(false)
    await expect(
      createNativeDshAgent(ctx, { sessionId: 'native-test', cwd: '/tmp', mode: 'solve' }),
    ).rejects.toBeInstanceOf(NativeDshUnavailableError)
  })

  it('does not silently claim native composition when upstream closure is absent', async () => {
    const ctx = new Context()
    const mounted = await mountNativeDshComposition(ctx)
    expect(mounted).toBe(false)
    expect(hasNativeDshComposition(ctx)).toBe(false)
  })

  it('preserves DSH message shape and extracts assistant session events', () => {
    const message = nativeUserMessage('hello') as {
      id: unknown
      role: unknown
      content: unknown
      source: unknown
    }
    expect(message.id).toEqual(expect.any(String))
    expect(message.role).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(message.source).toEqual({ kind: 'user' })
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    expect(
      nativeAssistantText([
        {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'a' }] } },
        },
        {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'b' }] } },
        },
      ]),
    ).toBe('a\nb')
  })

  it('drives and disposes a scoped ctx.agents.create handle', async () => {
    let disposed = false
    let setupCalled = false
    let candidateSetupCalled = false
    const calls: unknown[] = []
    const ctx = {
      agents: {
        async create(options: { setup?: (agentCtx: object) => void | Promise<void> }) {
          await options.setup?.({})
          return {
            agent: {
              followup(message: unknown) {
                calls.push(message)
              },
              async whenIdle() {
                calls.push('idle')
              },
              session: {
                events: [
                  {
                    type: 'assistant/message',
                    data: { message: { content: [{ type: 'text', text: 'native reply' }] } },
                  },
                ],
              },
            },
            async dispose() {
              disposed = true
            },
          }
        },
      },
      candidateStrategySetup: async () => {
        await new Promise<void>((resolveSetup) => setImmediate(resolveSetup))
        candidateSetupCalled = true
      },
    } as unknown as Context
    const result = await runNativeDshTurn(ctx, {
      sessionId: 'native-turn',
      cwd: '/tmp',
      mode: 'solve',
      prompt: 'hello',
      setup: async () => {
        await new Promise<void>((resolveSetup) => setImmediate(resolveSetup))
        setupCalled = true
      },
    })
    expect(setupCalled).toBe(true)
    expect(candidateSetupCalled).toBe(true)
    expect(result.assistantText).toBe('native reply')
    expect(disposed).toBe(true)
    expect(calls[0]).toMatchObject({
      id: expect.any(String),
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    })
  })

  it('resolves unpublished agent services through ctx.get before guarded properties', async () => {
    const sectionNames: string[] = []
    const agents = {
      async create(options: { setup?: (agentCtx: Context) => void | Promise<void> }) {
        const agentCtx = {
          get(name: string) {
            return name === 'systemPrompt'
              ? {
                  section(section: { name: string }) {
                    sectionNames.push(section.name)
                    return () => undefined
                  },
                }
              : undefined
          },
          get systemPrompt(): never {
            throw new Error('guarded systemPrompt property was read')
          },
        } as unknown as Context
        await options.setup?.(agentCtx)
        return {
          agent: {
            followup() {},
            async whenIdle() {},
            session: { events: [] },
          },
          async dispose() {},
        }
      },
    }
    const ctx = {
      get(name: string) {
        if (name === 'agents') return agents
        if (name === 'candidateStrategySetup') {
          return (agentCtx: Context) =>
            installNativePromptSections(agentCtx, [
              { name: 'candidate:guarded', order: 1, text: 'guarded' },
            ])
        }
        return undefined
      },
      get agents(): never {
        throw new Error('guarded agents property was read')
      },
      get candidateStrategySetup(): never {
        throw new Error('guarded candidate setup property was read')
      },
    } as unknown as Context
    await expect(
      runNativeDshTurn(ctx, {
        sessionId: 'native-guarded-services',
        cwd: '/tmp',
        mode: 'solve',
        prompt: 'hello',
      }),
    ).resolves.toMatchObject({ eventCount: 0 })
    expect(sectionNames).toEqual(['candidate:guarded'])
  })
})
