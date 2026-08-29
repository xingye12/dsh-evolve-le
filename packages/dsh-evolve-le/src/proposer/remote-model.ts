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

/** Default client timeout: the proxy's 120s request budget + margin. */
export const DEFAULT_REMOTE_MODEL_TIMEOUT_MS = 150_000

export function openRemoteModel(options: {
  socketPath: string
  timeoutMs?: number
}): RecordedModel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_MODEL_TIMEOUT_MS
  return {
    async complete(request: GatewayRequest): Promise<string> {
      return new Promise<string>((resolve, reject) => {
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
        socket.on('connect', () => {
          socket.write(
            `${JSON.stringify({
              v: 1,
              type: 'complete',
              sections: request.sections,
              userText: request.userText,
            })}\n`,
          )
        })
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          const newline = buffer.indexOf('\n')
          if (newline === -1) return
          const line = buffer.slice(0, newline)
          finish(() => {
            try {
              const reply = JSON.parse(line) as {
                type?: string
                responseText?: string
                message?: string
              }
              if (reply['type'] === 'ok' && typeof reply['responseText'] === 'string') {
                resolve(reply['responseText'])
                return
              }
              reject(new Error(reply['message'] ?? 'proxy returned an error'))
            } catch (error) {
              reject(new Error(`unparseable proxy reply: ${(error as Error).message}`))
            }
          })
        })
        socket.on('timeout', () =>
          finish(() => reject(new Error(`model gateway socket timed out after ${String(timeoutMs)}ms`))),
        )
        socket.on('error', (error) => finish(() => reject(error)))
        socket.on('close', () => finish(() => reject(new Error('model gateway socket closed before a reply'))))
      })
    },
  }
}
