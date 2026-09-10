/**
 * Solve gateway (ADR-030): the TCB side of a live SOLVER route. Harbor trial
 * containers reach the controller's model credential through an authenticated
 * `POST /gateway/complete` mounted on the same HTTPS listener that already
 * serves capsule tarballs on the docker bridge — one host service, one
 * throwaway CA, one firewall story, zero harbor changes (the handler hook on
 * `startArtifactServer`).
 *
 * Firewall contract (each rule machine-asserted by tests/solve-gateway.test.ts):
 *
 *  - the gateway runs in the controller process and is the ONLY holder of the
 *    credential on the solve side; the upstream request shape is locked by
 *    `upstreamChatCompletion` (route/model/temperature/max_tokens);
 *  - per-trial bearer tokens: 32 random bytes, mode 0600, root-only, under
 *    `<stateDir>/tokens/<jobName>.token`, bind-mounted read-only into exactly
 *    that trial's container. A trial can therefore only spend its own budget;
 *    a candidate cannot shift cost onto a rival trial (specs/02 §13);
 *  - requestIds are PER TRIAL, so concurrent trials each keep an independent,
 *    gapless chain; receipts carry hashes/usage only and live under
 *    `<stateDir>/receipts/<jobName>.jsonl` (evidence);
 *  - budget stops refuse atomically BEFORE the request leaves the process and
 *    still append an error receipt;
 *  - unauthenticated requests get 401 with no receipt, no upstream call, and
 *    an error body containing neither the token nor any prompt content;
 *  - all state is on disk: `openSolveGateway` replays tokens/ + receipts/ at
 *    open so a restarted controller continues each trial's sequence and usage
 *    instead of re-minting a fresh budget (fail closed on a corrupt chain).
 * @module @dsh-evolve-le/core/solver/gateway
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { promptSha256 } from '../acp/recorded-replay.js'
import { GATEWAY_VERSION, type GatewayBudget, type GatewayUsage } from '../proposer/gateway.js'
import {
  remoteRoutePlanHash,
  retryWorstCaseMs,
  type RemoteRoutePlan,
} from '../proposer/remote-gateway.js'
import { upstreamChatCompletion, type UpstreamAttempt } from '../proposer/upstream.js'
import type { NativeLlmToolSchema } from '../dsh/native-llm-adapter.js'
import {
  appendSolveReceipt,
  readSolveReceipts,
  verifySolveReceipts,
  type SolveReceipt,
  type SolveReceiptError,
  type SolveReceiptVerification,
} from './receipts.js'

export { verifySolveReceipts }
export type { SolveReceipt, SolveReceiptVerification }

export const SOLVE_GATEWAY_PATH = '/gateway/complete'

/**
 * Hard per-trial ceiling for live solves: the agent-side caps in
 * SOLVE_AGENT_LIMITS bound wall-clock behavior, but this is the authoritative
 * stop that fires before a request leaves the controller process.
 */
export const DEFAULT_SOLVE_TRIAL_BUDGET: GatewayBudget = {
  // ADR-066: successor runs may spend up to 150 model requests.  This is
  // deliberately independent of the token/cost caps below: a long but cheap
  // tool-solving trajectory must still stop before either spend boundary.
  maxRequests: 150,
  maxTotalTokens: 2_000_000,
  maxCostUsdMicros: 300_000, // $0.30 per trial at frozen prices
}

/** Requests are JSON documents; solve prompts with tool output can be large. */
const MAX_BODY_BYTES = 64 * 1024 * 1024

const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

interface TrialState {
  jobName: string
  token: string
  tokenFilePath: string
  receiptsPath: string
  usage: GatewayUsage
  sequence: number
  receiptsChain: Promise<void>
}

export interface SolveGateway {
  readonly routeHash: string
  /**
   * Resolves once tokens/receipts replay finished; rejects when an existing
   * chain fails verification (fail closed before any new spend). Callers that
   * want open-time semantics await this immediately.
   */
  ready(): Promise<void>
  /** Idempotent by jobName; reuses the on-disk token across resumes. */
  enrollTrial(jobName: string): Promise<{ tokenFilePath: string }>
  /** Mounted on the artifact listener for non-artifact paths. */
  handler(req: IncomingMessage, res: ServerResponse): void
  /** Receipt-verified usage fact for one finished trial. */
  terminalFact(jobName: string): Promise<SolveReceiptVerification>
  /** Refuse further requests; flush every receipt chain. */
  close(): Promise<void>
}

function freshUsage(): GatewayUsage {
  return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsdMicros: 0 }
}

/**
 * Open (or reopen) the solve gateway. On reopen, every token under
 * `tokens/` is replayed against its receipts file to restore usage and the
 * per-trial sequence; a corrupted, duplicated or orphaned chain throws here —
 * the run fails closed rather than letting a trial double-spend.
 */
export function openSolveGateway(options: {
  stateDir: string
  plan: RemoteRoutePlan
  credential: string
  requestTimeoutMs?: number
  /**
   * Wall-clock budget for one request's whole retry loop (ADR-033). Defaults
   * to the plan's worst case — maxAttempts × requestTimeoutMs + Σ backoff.
   * The CLI passes the ACP client's fixed per-request budget minus margin so
   * the in-container client never races the gateway's retries.
   */
  retryTotalBudgetMs?: number
  budget?: GatewayBudget
}): SolveGateway {
  const routeHash = remoteRoutePlanHash(options.plan)
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000
  const retryTotalBudgetMs =
    options.retryTotalBudgetMs ?? retryWorstCaseMs(options.plan.retry, requestTimeoutMs)
  const budget = options.budget ?? DEFAULT_SOLVE_TRIAL_BUDGET
  const tokensDir = join(options.stateDir, 'tokens')
  const receiptsDir = join(options.stateDir, 'receipts')
  const trials = new Map<string, TrialState>()
  const byToken = new Map<string, TrialState>()
  let closed = false
  // Restart replay: async, but openSolveGateway is sync by contract — the
  // promise is created eagerly and every entry point awaits it.
  const replay = (async () => {
    await mkdir(tokensDir, { recursive: true, mode: 0o700 })
    await mkdir(receiptsDir, { recursive: true, mode: 0o755 })
    const names = await readdir(tokensDir).catch(() => [] as string[])
    for (const name of names) {
      if (!name.endsWith('.token')) continue
      const jobName = name.slice(0, -'.token'.length)
      const tokenFilePath = join(tokensDir, name)
      const token = (await readFile(tokenFilePath, 'utf8')).trim()
      if (!/^[0-9a-f]{64}$/.test(token)) {
        throw new Error(`solve-gateway: malformed token file ${tokenFilePath}`)
      }
      const receiptsPath = join(receiptsDir, `${jobName}.jsonl`)
      const receipts = await readSolveReceipts(receiptsPath)
      if (receipts.length === 0) continue
      // A pre-existing chain must verify before it is extended again; the
      // restart path must not resurrect a tampered ledger.
      const check = await verifySolveReceipts({ receiptsPath, routeHash, jobName })
      if (!check.ok) {
        throw new Error(
          `solve-gateway: existing receipts for ${jobName} fail verification: ${check.problems.join('; ')}`,
        )
      }
      const usage = freshUsage()
      for (const receipt of receipts) {
        if (!receipt.ok) continue
        usage.requests += 1
        usage.promptTokens += receipt.promptTokens
        usage.completionTokens += receipt.completionTokens
        usage.totalTokens += receipt.promptTokens + receipt.completionTokens
        usage.costUsdMicros += receipt.costUsdMicros
      }
      const state: TrialState = {
        jobName,
        token,
        tokenFilePath,
        receiptsPath,
        usage,
        sequence: receipts.length,
        receiptsChain: Promise.resolve(),
      }
      trials.set(jobName, state)
      byToken.set(token, state)
    }
    // A receipts file without its token file cannot be attributed to a live
    // trial anymore — corruption, not a state the gateway may paper over.
    const receiptNames = await readdir(receiptsDir).catch(() => [] as string[])
    for (const name of receiptNames) {
      if (!name.endsWith('.jsonl')) continue
      const jobName = name.slice(0, -'.jsonl'.length)
      if (!trials.has(jobName)) {
        throw new Error(`solve-gateway: receipts for ${jobName} have no token file`)
      }
    }
  })()
  // Attach a no-op handler so an early rejection cannot become an unhandled
  // rejection before the first entry point awaits `replay`.
  void replay.catch(() => undefined)

  async function enrollTrial(jobName: string): Promise<{ tokenFilePath: string }> {
    await replay
    if (!JOB_NAME_PATTERN.test(jobName)) {
      throw new Error(`solve-gateway: jobName ${jobName} is not a safe trial id`)
    }
    const existing = trials.get(jobName)
    if (existing !== undefined) return { tokenFilePath: existing.tokenFilePath }
    const tokenFilePath = join(tokensDir, `${jobName}.token`)
    let token = await readFile(tokenFilePath, 'utf8').catch(() => null)
    if (token === null) {
      token = randomBytes(32).toString('hex')
      // 0600 at creation; the dir is already 0700 root-only.
      await writeFile(tokenFilePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    } else {
      token = token.trim()
      if (!/^[0-9a-f]{64}$/.test(token)) {
        throw new Error(`solve-gateway: malformed token file ${tokenFilePath}`)
      }
    }
    const state: TrialState = {
      jobName,
      token,
      tokenFilePath,
      receiptsPath: join(receiptsDir, `${jobName}.jsonl`),
      usage: freshUsage(),
      sequence: 0,
      receiptsChain: Promise.resolve(),
    }
    trials.set(jobName, state)
    byToken.set(token, state)
    return { tokenFilePath }
  }

  function appendReceipt(state: TrialState, receipt: SolveReceipt): void {
    state.receiptsChain = appendSolveReceipt(state.receiptsChain, state.receiptsPath, receipt)
  }

  function errorReceipt(
    state: TrialState,
    requestId: string,
    promptHash: string | null,
    error: string,
    attempts: UpstreamAttempt[],
  ): SolveReceiptError {
    return {
      schemaVersion: 4,
      gatewayVersion: GATEWAY_VERSION,
      jobName: state.jobName,
      requestId,
      route: options.plan.routeId,
      routeHash,
      promptSha256: promptHash,
      ok: false,
      error,
      attempts,
    }
  }

  /** Same JSON request shape as the AF_UNIX line protocol (shared capsule-side parser). */
  interface CompleteRequest {
    v?: number
    type?: string
    sections: { name: string; order: number; text: string }[]
    userText: string
    messages?: { role: string; content: unknown }[]
    tools?: NativeLlmToolSchema[]
  }

  async function complete(state: TrialState, request: CompleteRequest): Promise<unknown> {
    // Per-trial sequence: consumed only after the request parsed, mirroring
    // the proposer proxy, so malformed requests never open a gap.
    state.sequence += 1
    const requestId = `req-${String(state.sequence)}`
    const promptHash = promptSha256({
      sections: request.sections,
      userText: request.userText,
      ...(request.messages === undefined ? {} : { messages: request.messages }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
    })
    const fail = (receipt: SolveReceiptError, message: string): unknown => {
      appendReceipt(state, receipt)
      return { v: 1, type: 'error', requestId, routeHash, message }
    }
    if (closed) {
      return fail(
        errorReceipt(state, requestId, promptHash, 'gateway is closed', []),
        'gateway is closed',
      )
    }
    if (state.usage.requests >= budget.maxRequests) {
      const message = `budget stop: ${String(state.usage.requests)}/${String(budget.maxRequests)} requests used`
      return fail(errorReceipt(state, requestId, promptHash, message, []), message)
    }
    const result = await upstreamChatCompletion({
      plan: options.plan,
      credential: options.credential,
      sections: request.sections,
      userText: request.userText,
      ...(request.messages === undefined ? {} : { messages: request.messages }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
      requestTimeoutMs,
      retryTotalBudgetMs,
    })
    if (!result.ok) {
      return fail(
        {
          ...errorReceipt(state, requestId, promptHash, result.error, result.attempts),
          ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        },
        result.error,
      )
    }
    const totalAfter = state.usage.totalTokens + result.promptTokens + result.completionTokens
    const costAfter = state.usage.costUsdMicros + result.costUsdMicros
    if (totalAfter > budget.maxTotalTokens || costAfter > budget.maxCostUsdMicros) {
      return fail(
        errorReceipt(
          state,
          requestId,
          promptHash,
          `budget stop: ${String(totalAfter)} tokens / ${String(costAfter)} µUSD would exceed the cap`,
          result.attempts,
        ),
        'budget stop: tokens or cost would exceed the cap',
      )
    }
    state.usage.requests += 1
    state.usage.promptTokens += result.promptTokens
    state.usage.completionTokens += result.completionTokens
    state.usage.totalTokens = totalAfter
    state.usage.costUsdMicros = costAfter
    appendReceipt(state, {
      schemaVersion: 4,
      gatewayVersion: GATEWAY_VERSION,
      jobName: state.jobName,
      requestId,
      route: options.plan.routeId,
      routeHash,
      promptSha256: promptHash,
      responseSha256: responseSha256For(request, result.content, result.toolCalls),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsdMicros: result.costUsdMicros,
      ok: true,
      modelReportedUsage: result.modelReportedUsage,
      attempts: result.attempts,
    })
    return {
      v: 1,
      type: 'ok',
      requestId,
      routeHash,
      promptSha256: promptHash,
      responseText: result.content,
      ...(result.toolCalls.length === 0 ? {} : { toolCalls: result.toolCalls }),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsdMicros: result.costUsdMicros,
      responseSha256: responseSha256For(request, result.content, result.toolCalls),
    }
  }

  function handler(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      await replay
      if (req.method !== 'POST' || req.url !== SOLVE_GATEWAY_PATH) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(`${JSON.stringify({ v: 1, type: 'error', message: 'not found' })}\n`)
        return
      }
      const authorization = req.headers.authorization ?? ''
      const bearer = authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : ''
      const state = byToken.get(bearer)
      if (bearer === '' || state === undefined) {
        // No receipt, no upstream call, and nothing about the request echoed.
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(`${JSON.stringify({ v: 1, type: 'error', message: 'unauthorized' })}\n`)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        if (aborted) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          aborted = true
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(`${JSON.stringify({ v: 1, type: 'error', message: 'request body too large' })}\n`)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('error', () => {
        aborted = true
      })
      await new Promise<void>((resolveBody) => {
        req.on('end', () => resolveBody())
        req.on('close', () => resolveBody())
      })
      if (aborted || res.writableEnded) return
      let request: CompleteRequest
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CompleteRequest
        if (parsed['type'] !== 'complete') throw new Error('unknown request type')
        if (
          !Array.isArray(parsed.sections) ||
          typeof parsed.userText !== 'string' ||
          (parsed.messages !== undefined && !Array.isArray(parsed.messages)) ||
          (parsed.tools !== undefined && !Array.isArray(parsed.tools))
        ) {
          throw new Error('malformed request')
        }
        request = parsed
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          `${JSON.stringify({
            v: 1,
            type: 'error',
            message: `bad request: ${(error as Error).message}`,
          })}\n`,
        )
        return
      }
      const replyValue = await complete(state, request)
      if (res.writableEnded || res.destroyed) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(`${JSON.stringify(replyValue)}\n`)
    })().catch(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(`${JSON.stringify({ v: 1, type: 'error', message: 'internal error' })}\n`)
      }
    })
  }

  async function terminalFact(jobName: string): Promise<SolveReceiptVerification> {
    await replay
    const state = trials.get(jobName)
    if (state === undefined) {
      return {
        ok: false,
        problems: [`trial ${jobName} was never enrolled`],
        requests: 0,
        errorReceipts: 0,
        usage: freshUsage(),
      }
    }
    await state.receiptsChain
    return verifySolveReceipts({ receiptsPath: state.receiptsPath, routeHash, jobName })
  }

  return {
    routeHash,
    ready: () => replay,
    enrollTrial,
    handler,
    terminalFact,
    async close() {
      await replay
      closed = true
      await Promise.all([...trials.values()].map((state) => state.receiptsChain))
    },
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function responseSha256For(
  request: { messages?: unknown },
  content: string,
  toolCalls: readonly unknown[],
): string {
  return request.messages === undefined
    ? sha256Hex(content)
    : sha256Hex(JSON.stringify({ content, toolCalls }))
}
