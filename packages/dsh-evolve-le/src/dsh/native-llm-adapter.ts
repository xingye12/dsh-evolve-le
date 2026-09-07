/**
 * Structural bridge from the trusted gateway to the upstream DSH LLM
 * registry. The runtime package is resolved inside a native capsule, while
 * this controller stays buildable without vendoring the upstream checkout.
 */

import type { Context } from '@deepseek-ai/cordis'

export interface NativeLlmToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface NativeLlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface NativeLlmAudit {
  requestId: string
  promptSha256: string
  responseSha256: string
}

export interface NativeLlmCompletionRequest {
  provider: string
  model: string
  system?: string
  messages: readonly { role: string; content: unknown }[]
  /** Compatibility rendering for older gateway adapters. */
  userText?: string
  tools: readonly NativeLlmToolSchema[]
  signal?: AbortSignal
}

export interface NativeLlmCompletionResult {
  responseText: string
  toolCalls?: readonly NativeLlmToolCall[]
  promptTokens?: number
  completionTokens?: number
  audit?: NativeLlmAudit
}

export interface NativeLlmAdapterOptions {
  provider: string
  model: string
  maxTokens?: number
  complete(
    request: NativeLlmCompletionRequest,
  ): Promise<NativeLlmCompletionResult> | NativeLlmCompletionResult
}

interface NativeLlmRuntime {
  registerAdapter(
    providers: string[],
    adapter: {
      providerInfo(provider: string): { id: string; name: string }
      providerRetryPolicy(provider: string): undefined
      listModels(provider: string): Promise<readonly unknown[]>
      resolveModel?(provider: string, model: string): Promise<unknown>
      stream(options: NativeGenerateOptions): AsyncIterable<NativeStreamChunk>
    },
  ): (() => void) | (() => unknown)
}

interface NativeGenerateOptions {
  provider: string
  model: string
  system?: string
  messages: readonly { role: string; content: unknown }[]
  tools?: readonly NativeLlmToolSchema[]
  maxTokens?: number
  signal?: AbortSignal
}

type NativeStreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } }
  | { type: 'block-start'; index: number; blockType: 'tool-call' }
  | {
      type: 'tool-call-delta'
      index: number
      id: string
      name: string
      argumentsDelta: string
    }
  | {
      type: 'block-end'
      index: number
      block: { type: 'tool-call'; id: string; name: string; arguments: string }
    }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' } }

function runtimeOf(ctx: Context): NativeLlmRuntime {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const provided =
    typeof get === 'function' ? (get.call(ctx, 'llm') as NativeLlmRuntime) : undefined
  if (provided !== undefined && typeof provided.registerAdapter === 'function') return provided
  const direct = (ctx as unknown as { llm?: NativeLlmRuntime }).llm
  if (direct !== undefined && typeof direct.registerAdapter === 'function') return direct
  throw new Error('native DSH LLM adapter: ctx.llm is unavailable')
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as { type?: unknown; text?: unknown; content?: unknown }
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      if (record.type === 'tool-result') return JSON.stringify(record.content ?? record)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function conversationOf(messages: readonly { role: string; content: unknown }[]): string {
  return messages
    .map((message) => {
      const text = textOf(message.content)
      return text === '' ? '' : `${message.role.toUpperCase()}\n${text}`
    })
    .filter(Boolean)
    .join('\n\n')
}

function countTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

/** Register one gateway-backed provider in the native DSH LLM runtime. */
export function installNativeLlmAdapter(
  ctx: Context,
  options: NativeLlmAdapterOptions,
): () => void {
  if (options.provider.length === 0 || options.model.length === 0) {
    throw new TypeError('native DSH LLM adapter provider and model must be non-empty')
  }
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
  ) {
    throw new TypeError('native DSH LLM adapter maxTokens must be a positive safe integer')
  }
  const runtime = runtimeOf(ctx)
  const adapter = {
    providerInfo(provider: string): { id: string; name: string } {
      return { id: provider, name: provider }
    },
    providerRetryPolicy(_provider: string): undefined {
      return undefined
    },
    listModels(_provider: string): Promise<readonly unknown[]> {
      // The route is TCB-frozen but the remote gateway has no discovery API.
      // Exact model resolution below remains authoritative for the locked id.
      return Promise.resolve([])
    },
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<unknown> {
      if (signal?.aborted)
        return Promise.reject(new Error('native DSH LLM adapter: resolve aborted'))
      if (provider !== options.provider || model !== options.model) {
        return Promise.reject(new Error('native DSH LLM adapter: route mismatch'))
      }
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        ...(options.maxTokens === undefined ? {} : { defaultMaxTokens: options.maxTokens }),
      })
    },
    async *stream(request: NativeGenerateOptions): AsyncIterable<NativeStreamChunk> {
      if (
        request.provider !== options.provider ||
        request.model !== options.model ||
        (request.maxTokens !== undefined &&
          options.maxTokens !== undefined &&
          request.maxTokens > options.maxTokens)
      ) {
        throw new Error('native DSH LLM adapter: request does not match locked route')
      }
      const completionRequest: NativeLlmCompletionRequest = {
        provider: request.provider,
        model: request.model,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages,
        userText: conversationOf(request.messages),
        tools: request.tools ?? [],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
      const result = await options.complete(completionRequest)
      const toolCalls = result.toolCalls ?? []
      if (result.responseText.length === 0 && toolCalls.length === 0) {
        throw new Error('native DSH LLM adapter: gateway returned empty content and no tool calls')
      }
      const promptTokens =
        result.promptTokens ??
        countTokens(request.system ?? '') + countTokens(conversationOf(request.messages))
      const completionTokens = result.completionTokens ?? countTokens(result.responseText)
      let index = 0
      if (result.responseText.length > 0) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: result.responseText }
        yield { type: 'block-end', index, block: { type: 'text', text: result.responseText } }
        index += 1
      }
      for (const call of toolCalls) {
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: call.arguments,
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
        }
        index += 1
      }
      yield { type: 'usage', usage: { inputTokens: promptTokens, outputTokens: completionTokens } }
      yield { type: 'finish', reason: { kind: toolCalls.length > 0 ? 'tool-calls' : 'stop' } }
    },
  }
  const dispose = runtime.registerAdapter([options.provider], adapter)
  return () => void dispose()
}
