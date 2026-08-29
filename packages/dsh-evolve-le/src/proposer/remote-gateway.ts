/**
 * Remote model gateway proxy (Gate 8, specs/05 §7): the TCB side of a
 * networked proposer route. The proposal sandbox stays networkless — its model
 * adapter is a Unix-socket client (see `remote-model.ts`) — and this proxy,
 * running in the controller process, is the ONLY holder of the credential and
 * the only speaker to the upstream endpoint.
 *
 * Firewall contract (each rule is machine-asserted by the contract tests):
 *
 *  - one frozen route plan (endpoint, exact model, temperature, max tokens,
 *    prices) hashed into every receipt;
 *  - sequential requestIds, newline-JSON socket protocol, one request per
 *    line, hard per-request timeout;
 *  - receipts carry metadata and CONTENT HASHES ONLY — prompt text, response
 *    text and the credential never appear in any receipt or log;
 *  - usage comes from the upstream when reported, deterministic byte/4
 *    accounting otherwise, cost only from the frozen prices;
 *  - budget stops refuse atomically BEFORE the request leaves the process and
 *    still append an error receipt (no silent continue, no gap in the chain);
 *  - upstream HTTP errors and timeouts become error receipts, never crashes.
 *
 * Controller-side verification (`verifyRemoteReceipts`) anchors the worker
 * transcript to this receipt chain — the networked analogue of the recorded
 * policy's byte-replay verification.
 * @module @dsh-evolve-le/core/proposer/remote-gateway
 */

import { createHash } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { promptSha256 } from '../acp/recorded-replay.js'
import { GATEWAY_VERSION, tokenCount, type GatewayBudget, type GatewayUsage } from './gateway.js'

export { GATEWAY_VERSION }

/** The frozen networked route (specs/05 §7: locked endpoint/model/params). */
export interface RemoteRoutePlan {
  routeId: string
  baseUrl: string
  model: string
  temperature: number
  maxOutputTokens: number
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

/** sha256 over the canonical plan; every receipt binds the run to it. */
export function remoteRoutePlanHash(plan: RemoteRoutePlan): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        routeId: plan.routeId,
        baseUrl: plan.baseUrl,
        model: plan.model,
        temperature: plan.temperature,
        maxOutputTokens: plan.maxOutputTokens,
        inputUsdPerMTok: plan.inputUsdPerMTok,
        outputUsdPerMTok: plan.outputUsdPerMTok,
      }),
      'utf8',
    )
    .digest('hex')
}

export interface RemoteReceiptOk {
  schemaVersion: 2
  gatewayVersion: string
  requestId: string
  route: string
  routeHash: string
  promptSha256: string
  responseSha256: string
  promptTokens: number
  completionTokens: number
  costUsdMicros: number
  ok: true
  modelReportedUsage: boolean
}

export interface RemoteReceiptError {
  schemaVersion: 2
  gatewayVersion: string
  requestId: string
  route: string
  routeHash: string
  promptSha256: string | null
  ok: false
  error: string
  httpStatus?: number
  timedOut?: true
}

export type RemoteReceipt = RemoteReceiptOk | RemoteReceiptError

export interface RemoteProxy {
  readonly socketPath: string
  readonly receiptsPath: string
  readonly routeHash: string
  /** Resolves once the socket is listening (rejects on a listen failure). */
  ready(): Promise<void>
  usage(): GatewayUsage
  close(): Promise<void>
}

export const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 120_000

interface CompleteRequest {
  sections: { name: string; order: number; text: string }[]
  userText: string
}

/**
 * Open the TCB proxy on a Unix socket. One line in, one line out; requests
 * are serialized per connection and numbered globally across connections so
 * the receipt chain has no gaps.
 */
export function openRemoteModelProxy(options: {
  socketPath: string
  receiptsPath: string
  plan: RemoteRoutePlan
  credential: string
  budget?: GatewayBudget
  requestTimeoutMs?: number
  /** Socket file mode — the sandbox worker (a different uid) must connect. */
  socketMode?: number
}): RemoteProxy {
  const routeHash = remoteRoutePlanHash(options.plan)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS
  const usage: GatewayUsage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsdMicros: 0,
  }
  let sequence = 0
  let closed = false
  let receiptsChain: Promise<void> = Promise.resolve()

  const appendReceipt = (receipt: RemoteReceipt): void => {
    receiptsChain = receiptsChain.then(async () => {
      await mkdir(dirname(options.receiptsPath), { recursive: true })
      await appendFile(options.receiptsPath, `${JSON.stringify(receipt)}\n`, 'utf8')
    })
  }

  const errorReceipt = (
    requestId: string,
    promptHash: string | null,
    error: string,
  ): RemoteReceiptError => ({
    schemaVersion: 2,
    gatewayVersion: GATEWAY_VERSION,
    requestId,
    route: options.plan.routeId,
    routeHash,
    promptSha256: promptHash,
    ok: false,
    error,
  })

  const sockets = new Set<Socket>()
  const server = createServer((socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.trim() === '') continue
        void handle(line, socket)
      }
    })
    socket.on('error', () => socket.destroy())
  })

  const handle = async (line: string, socket: Socket): Promise<void> => {
    let request: CompleteRequest
    try {
      const parsed = JSON.parse(line) as { type?: string } & CompleteRequest
      if (parsed['type'] !== 'complete') throw new Error(`unknown request type`)
      request = parsed
    } catch (error) {
      reply(socket, { v: 1, type: 'error', message: `bad request: ${(error as Error).message}` })
      return
    }
    sequence += 1
    const requestId = `req-${sequence}`
    const promptHash = promptSha256({ sections: request.sections, userText: request.userText })
    const fail = (receipt: RemoteReceiptError, message: string): void => {
      appendReceipt(receipt)
      reply(socket, { v: 1, type: 'error', requestId, message })
    }
    if (closed) {
      fail(errorReceipt(requestId, promptHash, 'gateway is closed'), 'gateway is closed')
      return
    }
    if (usage.requests >= (options.budget?.maxRequests ?? Number.POSITIVE_INFINITY)) {
      fail(
        errorReceipt(
          requestId,
          promptHash,
          `budget stop: ${usage.requests}/${String(options.budget?.maxRequests)} requests used`,
        ),
        `budget stop: ${usage.requests}/${String(options.budget?.maxRequests)} requests used`,
      )
      return
    }

    const messages = [
      ...[...request.sections]
        .sort((a, b) => a.order - b.order)
        .map((section) => ({ role: 'system', content: section.text })),
      { role: 'user', content: request.userText },
    ]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const response = await fetch(`${options.plan.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The credential exists ONLY here: never in a receipt, log or file.
          authorization: `Bearer ${options.credential}`,
        },
        body: JSON.stringify({
          model: options.plan.model,
          messages,
          temperature: options.plan.temperature,
          max_tokens: options.plan.maxOutputTokens,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        fail(
          {
            ...errorReceipt(requestId, promptHash, `upstream ${String(response.status)}`),
            httpStatus: response.status,
          },
          `upstream ${String(response.status)}`,
        )
        return
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[]
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
      }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        fail(
          errorReceipt(requestId, promptHash, 'upstream returned no message content'),
          'upstream returned no message content',
        )
        return
      }
      if (content.trim() === '') {
        // Reasoning models can spend the entire max_tokens budget on
        // reasoning_content and return an empty answer — that request is a
        // failed turn, never a receipt-worthy response.
        fail(
          errorReceipt(
            requestId,
            promptHash,
            'upstream returned empty content (finish_reason length?)',
          ),
          'upstream returned empty content (finish_reason length?)',
        )
        return
      }
      const reportedUsage = payload.usage
      const modelReported =
        typeof reportedUsage?.prompt_tokens === 'number' &&
        typeof reportedUsage?.completion_tokens === 'number'
      const promptTokens = modelReported
        ? (reportedUsage!.prompt_tokens as number)
        : tokenCount(
            JSON.stringify({
              system: [...request.sections]
                .sort((a, b) => a.order - b.order)
                .map((section) => ({ name: section.name, text: section.text })),
              user: request.userText,
            }),
          )
      const completionTokens = modelReported
        ? (reportedUsage!.completion_tokens as number)
        : tokenCount(content)
      const costUsdMicros = Math.round(
        promptTokens * options.plan.inputUsdPerMTok +
          completionTokens * options.plan.outputUsdPerMTok,
      )
      const totalAfter = usage.totalTokens + promptTokens + completionTokens
      const costAfter = usage.costUsdMicros + costUsdMicros
      if (
        totalAfter > (options.budget?.maxTotalTokens ?? Number.POSITIVE_INFINITY) ||
        costAfter > (options.budget?.maxCostUsdMicros ?? Number.POSITIVE_INFINITY)
      ) {
        fail(
          errorReceipt(
            requestId,
            promptHash,
            `budget stop: ${String(totalAfter)} tokens / ${String(costAfter)} µUSD would exceed the cap`,
          ),
          'budget stop: tokens or cost would exceed the cap',
        )
        return
      }
      usage.requests += 1
      usage.promptTokens += promptTokens
      usage.completionTokens += completionTokens
      usage.totalTokens = totalAfter
      usage.costUsdMicros = costAfter
      appendReceipt({
        schemaVersion: 2,
        gatewayVersion: GATEWAY_VERSION,
        requestId,
        route: options.plan.routeId,
        routeHash,
        promptSha256: promptHash,
        responseSha256: sha256Hex(content),
        promptTokens,
        completionTokens,
        costUsdMicros,
        ok: true,
        modelReportedUsage: modelReported,
      })
      reply(socket, {
        v: 1,
        type: 'ok',
        requestId,
        responseText: content,
        promptTokens,
        completionTokens,
      })
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError'
      const message = aborted
        ? `request timed out after ${String(requestTimeoutMs)}ms`
        : `network failure: ${(error as Error).message}`
      const receipt = errorReceipt(requestId, promptHash, message)
      fail(aborted ? { ...receipt, timedOut: true } : receipt, message)
    } finally {
      clearTimeout(timer)
    }
  }

  const listenPromise = new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.socketPath, () => resolveListen())
  })
  // The listening socket is created with the umask default (root-only connect
  // in practice); the sandbox worker is a different uid, so widen it on request.
  const readyPromise = listenPromise.then(async () => {
    if (options.socketMode !== undefined) {
      await chmod(options.socketPath, options.socketMode)
    }
  })

  return {
    socketPath: options.socketPath,
    receiptsPath: options.receiptsPath,
    routeHash,
    ready: () => readyPromise,
    usage: () => ({ ...usage }),
    async close() {
      closed = true
      await listenPromise.catch(() => undefined)
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await receiptsChain
      await rm(options.socketPath, { force: true })
    },
  }
}

function reply(socket: Socket, value: unknown): void {
  if (socket.destroyed) return
  socket.write(`${JSON.stringify(value)}\n`)
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface RemoteReceiptVerification {
  ok: boolean
  requests: number
  problems: string[]
  /**
   * Authoritative usage summed from the successful receipts: API-reported
   * tokens (or the deterministic estimate) at the frozen route prices. The
   * controller settles the proposal budget from this, not from the worker's
   * in-sandbox character accounting.
   */
  usage: GatewayUsage
}

/**
 * Anchor a finished sandbox's transcript to the proxy receipt chain: every
 * model turn in the transcript must correspond, in order, to a successful
 * receipt with the same prompt hash and a response whose sha256 matches the
 * recorded response hash. Any error receipt, gap, mismatch or wrong route
 * fails closed — this replaces byte-replay for networked routes, where the
 * controller cannot re-derive the model's responses.
 */
export async function verifyRemoteReceipts(options: {
  receiptsPath: string
  transcriptPath: string
  routeHash: string
}): Promise<RemoteReceiptVerification> {
  const problems: string[] = []
  const receiptLines = (await readFileLines(options.receiptsPath)).filter((line) => line !== '')
  const receipts = receiptLines.map((line) => JSON.parse(line) as RemoteReceipt)
  if (receipts.length === 0) problems.push('no receipts recorded')
  const okReceipts: RemoteReceiptOk[] = []
  for (const receipt of receipts) {
    if (!receipt.ok) {
      problems.push(`receipt ${receipt.requestId} failed: ${receipt.error}`)
      continue
    }
    if (receipt.routeHash !== options.routeHash) {
      problems.push(`receipt ${receipt.requestId} routeHash does not match the frozen plan`)
    }
    okReceipts.push(receipt)
  }
  receipts.forEach((receipt, index) => {
    const expected = `req-${String(index + 1)}`
    if (receipt.requestId !== expected) {
      problems.push(
        `receipt sequence break at ${String(index + 1)}: ${receipt.requestId} ≠ ${expected}`,
      )
    }
  })
  const turns = (await readFileLines(options.transcriptPath))
    .filter((line) => line !== '')
    .map(
      (line) =>
        JSON.parse(line) as {
          kind?: string
          requestId?: string
          promptSha256?: string
          responseText?: string
        },
    )
    .filter((record) => record.kind === 'turn')
  if (turns.length !== okReceipts.length) {
    problems.push(
      `transcript has ${String(turns.length)} model turns but ${String(okReceipts.length)} successful receipts`,
    )
  }
  for (const [index, turn] of turns.entries()) {
    const receipt = okReceipts[index]
    if (receipt === undefined) break
    if (turn.requestId !== receipt.requestId) {
      problems.push(
        `turn ${String(index + 1)} requestId ${String(turn.requestId)} ≠ ${receipt.requestId}`,
      )
    }
    if (turn.promptSha256 !== receipt.promptSha256) {
      problems.push(`turn ${String(index + 1)} promptSha256 does not match the receipt`)
    }
    if (
      typeof turn.responseText === 'string' &&
      sha256Hex(turn.responseText) !== receipt.responseSha256
    ) {
      problems.push(`turn ${String(index + 1)} responseSha256 does not match the receipt`)
    }
  }
  const usage: GatewayUsage = {
    requests: okReceipts.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsdMicros: 0,
  }
  for (const receipt of okReceipts) {
    usage.promptTokens += receipt.promptTokens
    usage.completionTokens += receipt.completionTokens
    usage.totalTokens += receipt.promptTokens + receipt.completionTokens
    usage.costUsdMicros += receipt.costUsdMicros
  }
  return { ok: problems.length === 0, requests: okReceipts.length, problems, usage }
}

async function readFileLines(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  if (text.trim() === '') return []
  return text.trimEnd().split('\n')
}
