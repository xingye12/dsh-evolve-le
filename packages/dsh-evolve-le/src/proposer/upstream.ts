/**
 * Upstream chat-completion call core (Gate 8, extracted for ADR-030): the
 * single place the controller process speaks to an OpenAI-compatible model
 * endpoint. Both TCB proxies — the proposer's AF_UNIX `openRemoteModelProxy`
 * and the solve gateway's HTTPS handler — delegate here, so the route lock
 * (exact model/temperature/max_tokens), the credential's single point of
 * appearance (`Authorization` on this one request), empty-content handling
 * and usage/cost accounting cannot drift between the two surfaces.
 *
 * This module never writes receipts and never decides policy: the caller
 * owns the receipt chain, the budget stops and the reply shape. Receipts and
 * logs carry CONTENT HASHES ONLY — prompt text, response text and the
 * credential never leave this module's stack frame (specs/05 §7).
 * @module @dsh-evolve-le/core/proposer/upstream
 */

import type { RemoteRoutePlan } from './remote-gateway.js'
import { tokenCount } from './gateway.js'
import type { NativeLlmToolCall, NativeLlmToolSchema } from '../dsh/native-llm-adapter.js'
import { createHash } from 'node:crypto'

export interface UpstreamMessage {
  role: string
  content: unknown
}

export interface UpstreamChatInput {
  plan: RemoteRoutePlan
  /** Exists ONLY for this request's Authorization header (rule 8). */
  credential: string
  sections: readonly { name: string; order: number; text: string }[]
  userText: string
  messages?: readonly UpstreamMessage[]
  tools?: readonly NativeLlmToolSchema[]
  requestTimeoutMs: number
  /**
   * Wall-clock budget for the WHOLE retry loop (ADR-033), chosen by the
   * caller so the loop can never outlive its consumer: the proposer proxy
   * derives it from the sandbox's socket-client timeout, the solve gateway
   * from the ACP client's fixed per-request budget.
   */
  retryTotalBudgetMs: number
}

/** One upstream attempt inside a request's retry loop (receipts carry all). */
export interface UpstreamAttempt {
  ok: boolean
  error?: string
  httpStatus?: number
  timedOut?: true
}

export interface UpstreamChatOk {
  ok: true
  content: string
  toolCalls: NativeLlmToolCall[]
  promptTokens: number
  completionTokens: number
  costUsdMicros: number
  /** True when the endpoint reported usage; false = deterministic estimate. */
  modelReportedUsage: boolean
  attempts: UpstreamAttempt[]
}

export interface UpstreamChatError {
  ok: false
  error: string
  httpStatus?: number
  timedOut?: true
  /** Present only when a response arrived and its charge is knowable. */
  responseSha256?: string
  promptTokens?: number
  completionTokens?: number
  costUsdMicros?: number
  modelReportedUsage?: boolean
  attempts: UpstreamAttempt[]
}

export type UpstreamChatResult = UpstreamChatOk | UpstreamChatError

/** One attempt's outcome before the attempts trace is attached. */
type SingleAttemptResult = Omit<UpstreamChatOk, 'attempts'> | Omit<UpstreamChatError, 'attempts'>

/**
 * One chat completion against the frozen route plan, retrying transient
 * infrastructure failures under the plan's frozen retry policy (ADR-033):
 * upstream 5xx and network failures retry within the caller's total budget;
 * 4xx, per-attempt timeouts, empty content and malformed tool calls never
 * retry — ambiguity resolves to FAIL. Never throws for an upstream
 * condition; every attempt lands in `attempts` for the caller to receipt.
 */
export async function upstreamChatCompletion(
  input: UpstreamChatInput,
): Promise<UpstreamChatResult> {
  const retry = input.plan.retry
  const attempts: UpstreamAttempt[] = []
  let remaining = input.retryTotalBudgetMs
  let lastFailure: Omit<UpstreamChatError, 'attempts'> | undefined
  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    const startedAt = Date.now()
    const attemptBudgetMs = Math.min(input.requestTimeoutMs, remaining)
    const result = await singleAttempt(input, attemptBudgetMs)
    remaining -= Date.now() - startedAt
    if (result.ok) return { ...result, attempts: [...attempts, { ok: true }] }
    attempts.push({
      ok: false,
      error: result.error,
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
      ...(result.timedOut === undefined ? {} : { timedOut: result.timedOut }),
    })
    lastFailure = result
    if (!retryable(result) || attempt === retry.maxAttempts) break
    const backoff = retry.backoffMs[attempt - 1] ?? 0
    remaining -= backoff
    if (remaining <= 0) break
    await delay(backoff)
  }
  const failure = lastFailure ?? {
    ok: false as const,
    error: 'retry budget exhausted before the first attempt',
  }
  return { ...failure, attempts }
}

/** One bounded attempt; the request shape never varies between attempts. */
async function singleAttempt(
  input: UpstreamChatInput,
  requestTimeoutMs: number,
): Promise<SingleAttemptResult> {
  const messages =
    input.messages === undefined ? compatibilityMessages(input) : nativeMessages(input.messages)
  const tools = input.tools?.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    const response = await fetch(`${input.plan.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The credential exists ONLY here: never in a receipt, log or file.
        authorization: `Bearer ${input.credential}`,
      },
      body: JSON.stringify({
        model: input.plan.model,
        messages,
        temperature: input.plan.temperature,
        max_tokens: input.plan.maxOutputTokens,
        ...(tools === undefined || tools.length === 0 ? {} : { tools }),
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        ok: false,
        error: `upstream ${String(response.status)}`,
        httpStatus: response.status,
      }
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown; tool_calls?: unknown } }[]
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    const message = payload.choices?.[0]?.message
    const content = textOf(message?.content)
    let toolCalls: NativeLlmToolCall[]
    try {
      toolCalls = toolCallsOf(message?.tool_calls)
    } catch (error) {
      return {
        ok: false,
        error: (error as Error).message,
        responseSha256: sha256(JSON.stringify(message ?? null)),
        ...usageFor(input, payload.usage, content),
      }
    }
    if (content.trim() === '' && toolCalls.length === 0) {
      // Reasoning models can spend the entire max_tokens budget on
      // reasoning_content and return an empty answer — that request is a
      // failed turn, but its returned usage is still a billable, durable
      // fact. Callers must settle it instead of mistaking it for a free retry.
      return {
        ok: false,
        error: 'upstream returned empty content (finish_reason length?)',
        responseSha256: sha256(JSON.stringify(message ?? null)),
        ...usageFor(input, payload.usage, content),
      }
    }
    return {
      ok: true,
      content,
      toolCalls,
      ...usageFor(input, payload.usage, content, toolCalls),
    }
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError'
    return aborted
      ? {
          ok: false,
          error: `request timed out after ${String(requestTimeoutMs)}ms`,
          timedOut: true,
        }
      : { ok: false, error: `network failure: ${(error as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}

function usageFor(
  input: UpstreamChatInput,
  reportedUsage: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined,
  content: string,
  toolCalls: readonly NativeLlmToolCall[] = [],
): Pick<UpstreamChatOk, 'promptTokens' | 'completionTokens' | 'costUsdMicros' | 'modelReportedUsage'> {
  const modelReported =
    typeof reportedUsage?.prompt_tokens === 'number' &&
    typeof reportedUsage?.completion_tokens === 'number'
  const promptTokens = modelReported
    ? (reportedUsage!.prompt_tokens as number)
    : tokenCount(
        JSON.stringify({
          system: [...input.sections]
            .sort((a, b) => a.order - b.order)
            .map((section) => ({ name: section.name, text: section.text })),
          user: input.userText,
        }),
      )
  const completionTokens = modelReported
    ? (reportedUsage!.completion_tokens as number)
    : input.messages === undefined
      ? tokenCount(content)
      : tokenCount(JSON.stringify({ content, toolCalls }))
  return {
    promptTokens,
    completionTokens,
    costUsdMicros: Math.round(
      promptTokens * input.plan.inputUsdPerMTok + completionTokens * input.plan.outputUsdPerMTok,
    ),
    modelReportedUsage: modelReported,
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** ADR-033: only transient infrastructure failures retry, nothing else. */
function retryable(result: SingleAttemptResult): boolean {
  if (result.ok) return false
  if (result.timedOut === true) return false
  if (result.httpStatus !== undefined) return result.httpStatus >= 500
  return result.error.startsWith('network failure')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function compatibilityMessages(input: UpstreamChatInput): UpstreamMessage[] {
  return [
    ...[...input.sections]
      .sort((a, b) => a.order - b.order)
      .map((section) => ({ role: 'system', content: section.text })),
    { role: 'user', content: input.userText },
  ]
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
      if (record['type'] === 'tool-result') return JSON.stringify(record['content'] ?? record)
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function toolCallsOf(value: unknown): NativeLlmToolCall[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new Error('upstream returned malformed tool call')
    }
    const record = entry as Record<string, unknown>
    const fn = record['function']
    if (
      typeof record['id'] !== 'string' ||
      fn === null ||
      typeof fn !== 'object' ||
      typeof (fn as Record<string, unknown>)['name'] !== 'string' ||
      typeof (fn as Record<string, unknown>)['arguments'] !== 'string'
    ) {
      throw new Error('upstream returned malformed tool call')
    }
    return {
      id: record['id'] as string,
      name: (fn as Record<string, unknown>)['name'] as string,
      arguments: (fn as Record<string, unknown>)['arguments'] as string,
    }
  })
}

function nativeMessages(messages: readonly UpstreamMessage[]): Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  for (const message of messages) {
    const content = textOf(message.content)
    const blocks = Array.isArray(message.content) ? message.content : []
    const objectBlocks = blocks.filter(
      (block): block is Record<string, unknown> => block !== null && typeof block === 'object',
    )
    const toolCalls = objectBlocks
      .filter((block) => block['type'] === 'tool-call')
      .map((block) => ({
        id: String(block['id']),
        type: 'function',
        function: { name: String(block['name']), arguments: String(block['arguments']) },
      }))
    const toolResults = objectBlocks.filter((block) => block['type'] === 'tool-result')
    if (message.role === 'assistant') {
      output.push({
        role: 'assistant',
        content,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      })
    } else if (toolResults.length > 0) {
      // A native tool-result block is already a complete OpenAI `tool`
      // message. Do not also emit its JSON rendering as a second ordinary
      // message; that duplicates history and changes the locked prompt hash.
      const ordinaryBlocks = objectBlocks.filter((block) => block['type'] !== 'tool-result')
      const ordinaryContent = textOf(ordinaryBlocks)
      if (ordinaryContent.length > 0) output.push({ role: message.role, content: ordinaryContent })
      for (const result of toolResults) {
        output.push({
          role: 'tool',
          tool_call_id: String(result['toolCallId']),
          content: textOf(result['content']) || '(no output)',
        })
      }
    } else {
      output.push({ role: message.role, content })
    }
  }
  return output
}
