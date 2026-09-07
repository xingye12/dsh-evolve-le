/**
 * Capsule-side solve gateway client (ADR-030): the ONLY network speaker in a
 * live-solve trial. Speaks newline-delimited JSON replies over HTTPS to the
 * controller's authenticated `/gateway/complete`, authenticated by the
 * per-trial bearer token bind-mounted at a path (never an env value).
 *
 * Client discipline is load-bearing for the capsule's unload invariant
 * (`acp-boot` fails the boot on any new process handle after the serving
 * baseline): every request uses `node:https.request` with `agent:false` —
 * one connection per request, destroyed on completion — because the global
 * `fetch`'s undici pool keeps sockets (handles) alive for minutes and would
 * turn every live trial into a dirty-process capability FAIL.
 *
 * TLS: Node does NOT honor `SSL_CERT_FILE` (curl and Python do), so the
 * augmented CA bundle the job mounts is loaded explicitly from that env var
 * when present. A missing bundle against an https URL is a hard failure,
 * never a disabled verification.
 * @module @dsh-evolve-le/core/acp/solve-client
 */

import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import type { NativeLlmToolCall, NativeLlmToolSchema } from '../dsh/native-llm-adapter.js'

/**
 * The gateway endpoint path. Duplicated from `solver/gateway.ts` on purpose:
 * the capsule ships a minimal file set and must not pull the controller-side
 * gateway (fs/receipts/upstream graph) into `runner/`; the unit and container
 * tests assert the two literals cannot drift.
 */
export const SOLVE_GATEWAY_PATH = '/gateway/complete'

/**
 * The in-container client's fixed per-request wall clock (ADR-032's per-request
 * cap for live solves). The controller's solve gateway keeps its whole ADR-033
 * retry loop inside this budget minus a small margin, so the client always
 * outlasts the gateway's retries.
 */
export const SOLVE_CLIENT_REQUEST_TIMEOUT_MS = 660_000

export interface SolveClientOptions {
  /** Base URL of the artifact listener, e.g. https://172.17.0.1:8443 */
  url: string
  /** The per-trial bearer token read from the mounted token file. */
  token: string
  /** The frozen route plan hash the gateway must echo on every reply. */
  routeHash: string
  /** Per-request wall clock (the gateway holds its own upstream timeout). */
  timeoutMs?: number
}

export interface SolveTurnOk {
  ok: true
  requestId: string
  responseText: string
  promptTokens: number
  completionTokens: number
  costUsdMicros: number
  toolCalls?: NativeLlmToolCall[]
  promptSha256?: string
  responseSha256?: string
}

export interface SolveTurnError {
  ok: false
  requestId?: string
  message: string
}

export type SolveTurnResult = SolveTurnOk | SolveTurnError

export interface SolveClient {
  complete(
    request: {
      sections: readonly { name: string; order: number; text: string }[]
      userText: string
      messages?: readonly { role: string; content: unknown }[]
      tools?: readonly NativeLlmToolSchema[]
    },
    requestedTimeoutMs?: number,
    options?: { signal?: AbortSignal },
  ): Promise<SolveTurnResult>
}

export class SolveClientError extends Error {
  constructor(message: string) {
    super(`solve-client: ${message}`)
    this.name = 'SolveClientError'
  }
}

export function openSolveGatewayClient(options: SolveClientOptions): SolveClient {
  const parsed = new URL(options.url)
  if (parsed.protocol !== 'https:') {
    throw new SolveClientError(`the solve gateway URL must be https (got ${parsed.protocol})`)
  }
  const configuredTimeoutMs = options.timeoutMs ?? SOLVE_CLIENT_REQUEST_TIMEOUT_MS
  // Node ignores SSL_CERT_FILE; load the job's augmented CA bundle explicitly.
  const caFile = process.env['SSL_CERT_FILE']
  const ca = caFile !== undefined && caFile !== '' ? readFileSync(caFile) : undefined

  return {
    complete(request, requestedTimeoutMs, completeOptions) {
      const timeoutMs = requestedTimeoutMs ?? configuredTimeoutMs
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new SolveClientError(
          `request timeout must be a positive integer (got ${String(timeoutMs)})`,
        )
      }
      const signal = completeOptions?.signal
      return new Promise<SolveTurnResult>((resolve, reject) => {
        // ACP session/cancel (and the wall-clock deadline cancel) reach the
        // wire through this signal. An already-aborted signal must reject
        // BEFORE any network attempt — the caller cancelled, so no socket may
        // be opened at all (the unload invariant counts handles).
        if (signal?.aborted === true) {
          reject(new SolveClientError('request aborted before send'))
          return
        }
        const payload = Buffer.from(
          JSON.stringify({
            v: 1,
            type: 'complete',
            sections: request.sections,
            userText: request.userText,
            ...(request.messages === undefined ? {} : { messages: request.messages }),
            ...(request.tools === undefined ? {} : { tools: request.tools }),
          }),
          'utf8',
        )
        const req = httpsRequest(
          {
            hostname: parsed.hostname,
            port: parsed.port === '' ? 443 : Number(parsed.port),
            path: SOLVE_GATEWAY_PATH,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': String(payload.length),
              // The token exists only on this wire, never in a log or receipt.
              authorization: `Bearer ${options.token}`,
            },
            ...(ca !== undefined ? { ca } : {}),
            // One connection per request: no pool may outlive the turn.
            agent: false,
            timeout: timeoutMs,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8')
              let reply: Record<string, unknown>
              try {
                reply = JSON.parse(text === '' ? '{}' : text) as Record<string, unknown>
              } catch {
                reject(
                  new SolveClientError(
                    `unparseable gateway reply (status ${String(res.statusCode)})`,
                  ),
                )
                return
              }
              // Route binding: every reply carries the frozen route hash; a
              // mismatch means the capsule is talking to the wrong route.
              if (reply['routeHash'] !== undefined && reply['routeHash'] !== options.routeHash) {
                reject(
                  new SolveClientError(
                    `gateway routeHash ${String(reply['routeHash'])} does not match the frozen plan`,
                  ),
                )
                return
              }
              if (reply['type'] === 'ok') {
                let toolCalls: NativeLlmToolCall[] | undefined
                try {
                  toolCalls = Array.isArray(reply['toolCalls'])
                    ? parseToolCalls(reply['toolCalls'])
                    : undefined
                } catch (error) {
                  reject(error instanceof Error ? error : new SolveClientError(String(error)))
                  return
                }
                resolve({
                  ok: true,
                  requestId: String(reply['requestId'] ?? ''),
                  responseText: String(reply['responseText'] ?? ''),
                  promptTokens: Number(reply['promptTokens'] ?? 0),
                  completionTokens: Number(reply['completionTokens'] ?? 0),
                  costUsdMicros: Number(reply['costUsdMicros'] ?? 0),
                  ...(toolCalls === undefined ? {} : { toolCalls }),
                  ...(typeof reply['promptSha256'] === 'string'
                    ? { promptSha256: reply['promptSha256'] }
                    : {}),
                  ...(typeof reply['responseSha256'] === 'string'
                    ? { responseSha256: reply['responseSha256'] }
                    : {}),
                })
                return
              }
              if (reply['type'] === 'error') {
                const error: SolveTurnError = {
                  ok: false,
                  message: String(reply['message'] ?? 'gateway error'),
                }
                if (typeof reply['requestId'] === 'string') error.requestId = reply['requestId']
                resolve(error)
                return
              }
              reject(new SolveClientError(`unknown gateway reply type ${String(reply['type'])}`))
            })
          },
        )
        req.on('timeout', () =>
          req.destroy(new SolveClientError(`request timed out after ${String(timeoutMs)}ms`)),
        )
        req.on('error', (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error instanceof Error ? error : new SolveClientError(String(error)))
        })
        // Mid-request abort: destroy the socket so the gateway observes the
        // disconnect instead of producing a reply nobody will read, and so no
        // live socket survives the cancelled turn.
        const onAbort = (): void => {
          req.destroy(new SolveClientError('request aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        req.on('close', () => signal?.removeEventListener('abort', onAbort))
        req.end(payload)
      })
    },
  }
}

function parseToolCalls(value: unknown[]): NativeLlmToolCall[] {
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new SolveClientError('gateway returned malformed tool call')
    }
    const record = entry as Record<string, unknown>
    if (
      typeof record['id'] !== 'string' ||
      typeof record['name'] !== 'string' ||
      typeof record['arguments'] !== 'string'
    ) {
      throw new SolveClientError('gateway returned malformed tool call')
    }
    return {
      id: record['id'],
      name: record['name'],
      arguments: record['arguments'],
    }
  })
}

/** Read the mounted per-trial token file (trimmed). Throws when unreadable. */
export function readSolveTokenFile(path: string): string {
  const token = readFileSync(path, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new SolveClientError(`token file ${path} is not a 64-hex token`)
  }
  return token
}
