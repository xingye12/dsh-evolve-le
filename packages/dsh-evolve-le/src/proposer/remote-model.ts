/**
 * Remote model adapter for the proposal sandbox worker (Gate 8, specs/05
 * §7/§9): the worker stays inside its network namespace — no HTTP client, no
 * credential, no DNS. Its only channel to the model is this Unix-socket
 * client speaking the proxy's newline-JSON protocol. One connection per
 * request keeps failure handling trivial: connect, send one line, read one
 * line, destroy.
 *
 * The TCB proxy on the other end of the socket enforces the route lock,
 * budget and receipt chain; this side simply refuses (throws) on any error,
 * which the agent loop records and the controller later counts as the
 * expansion failure it is.
 * @module @dsh-evolve-le/core/proposer/remote-model
 */

import { createConnection } from 'node:net'
import type { GatewayRequest, RecordedModel } from './gateway.js'
import type {
  NativeLlmCompletionRequest,
  NativeLlmCompletionResult,
} from '../dsh/native-llm-adapter.js'

/** Default client timeout: the proxy's 120s request budget + margin. */
export const DEFAULT_REMOTE_MODEL_TIMEOUT_MS = 150_000

export function openRemoteModel(options: {
  socketPath: string
  timeoutMs?: number
}): RecordedModel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_MODEL_TIMEOUT_MS
  const socketRequest = async (payload: Record<string, unknown>): Promise<RemoteReply> =>
    new Promise<RemoteReply>((resolve, reject) => {
      const socket = createConnection(options.socketPath)
      let buffer = ''
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        socket.destroy()
        fn()
      }
      socket.setTimeout(timeoutMs)
      socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        finish(() => {
          try {
            resolve(JSON.parse(line) as RemoteReply)
          } catch (error) {
            reject(new Error(`unparseable proxy reply: ${(error as Error).message}`))
          }
        })
      })
      socket.on('timeout', () =>
        finish(() =>
          reject(new Error(`model gateway socket timed out after ${String(timeoutMs)}ms`)),
        ),
      )
      socket.on('error', (error) => finish(() => reject(error)))
      socket.on('close', () =>
        finish(() => reject(new Error('model gateway socket closed before a reply'))),
      )
    })
  return {
    async complete(request: GatewayRequest): Promise<string> {
      const reply = await socketRequest({
        v: 1,
        type: 'complete',
        sections: request.sections,
        userText: request.userText,
        ...(request.messages === undefined ? {} : { messages: request.messages }),
        ...(request.tools === undefined ? {} : { tools: request.tools }),
      })
      if (reply.type === 'ok' && typeof reply.responseText === 'string') return reply.responseText
      throw new Error(reply.message ?? 'proxy returned an error')
    },
    async completeNative(request: NativeLlmCompletionRequest): Promise<NativeLlmCompletionResult> {
      const reply = await requestRemoteNative(socketRequest, request)
      if (reply.type !== 'ok' || typeof reply.responseText !== 'string') {
        throw new Error(reply.message ?? 'proxy returned an error')
      }
      return {
        responseText: reply.responseText,
        ...(reply.toolCalls === undefined ? {} : { toolCalls: reply.toolCalls }),
        ...(typeof reply.promptTokens === 'number' ? { promptTokens: reply.promptTokens } : {}),
        ...(typeof reply.completionTokens === 'number'
          ? { completionTokens: reply.completionTokens }
          : {}),
        ...(reply.requestId !== undefined &&
        reply.promptSha256 !== undefined &&
        reply.responseSha256 !== undefined
          ? {
              audit: {
                requestId: reply.requestId,
                promptSha256: reply.promptSha256,
                responseSha256: reply.responseSha256,
              },
            }
          : {}),
      }
    },
  }
}

interface RemoteReply {
  type?: string
  responseText?: string
  toolCalls?: { id: string; name: string; arguments: string }[]
  promptTokens?: number
  completionTokens?: number
  requestId?: string
  promptSha256?: string
  responseSha256?: string
  message?: string
}

function requestRemoteNative(
  complete: (payload: Record<string, unknown>) => Promise<RemoteReply>,
  request: NativeLlmCompletionRequest,
): Promise<RemoteReply> {
  return complete({
    v: 1,
    type: 'complete',
    sections:
      request.system === undefined
        ? []
        : [{ name: 'native:system', order: 0, text: request.system }],
    userText: request.userText ?? '',
    messages: request.messages,
    tools: request.tools,
  })
}
