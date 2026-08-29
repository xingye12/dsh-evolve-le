/**
 * Deterministic model gateway (Gate 4, specs/05 §7, specs/07 §6). The
 * proposer's "model" runs behind a TCB gateway inside the sandbox worker: a
 * frozen route table (content-hashed into every receipt), deterministic
 * character-based token accounting, cost derived only from the frozen prices,
 * per-request ids, JSONL receipts, and a hard budget stop — once any budget
 * dimension is exhausted the gateway refuses further requests and the worker
 * fails the proposal. No network, no credentials, no wall clock in the
 * accounting path: the same request stream always produces the same receipts,
 * which is what makes controller-side integrity replay possible.
 * @module @dsh-evolve-le/core/proposer/gateway
 */

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promptSha256 } from '../acp/recorded-replay.js'

export const GATEWAY_VERSION = 'dsh-evolve-le/model-gateway/v1'

/** Frozen route table — prices are USD per million tokens. */
export interface GatewayRoute {
  model: string
  inputUsdPerMTok: number
  outputUsdPerMTok: number
}

export const FROZEN_ROUTES: readonly GatewayRoute[] = [
  { model: 'dsh-evolve-le/recorded-proposer', inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
] as const

/** sha256 over the canonical route table; every receipt binds the run to it. */
export function frozenRouteHash(routes: readonly GatewayRoute[] = FROZEN_ROUTES): string {
  return createHash('sha256')
    .update(JSON.stringify({ routes: [...routes].map((route) => ({ ...route })) }), 'utf8')
    .digest('hex')
}

/** Deterministic token accounting: UTF-8 bytes / 4, rounded up. */
export function tokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}

export interface GatewayBudget {
  maxRequests: number
  maxTotalTokens: number
  maxCostUsdMicros: number
}

export const DEFAULT_PROPOSER_BUDGET: GatewayBudget = {
  maxRequests: 64,
  maxTotalTokens: 2_000_000,
  maxCostUsdMicros: 2_000_000, // $2.00 per proposal action
}

export class ModelGatewayError extends Error {
  constructor(message: string) {
    super(`model-gateway: ${message}`)
    this.name = 'ModelGatewayError'
  }
}

/** One request as the agent loop sees it. */
export interface GatewayRequest {
  sections: readonly { name: string; order: number; text: string }[]
  userText: string
}

/** The deterministic "model" behind the gateway (TCB model adapter slot). */
export interface RecordedModel {
  complete(request: GatewayRequest): string
}

export interface GatewayUsage {
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsdMicros: number
}

export interface GatewayReceipt {
  schemaVersion: 1
  gatewayVersion: typeof GATEWAY_VERSION
  requestId: string
  route: string
  routeHash: string
  promptSha256: string
  promptTokens: number
  completionTokens: number
  costUsdMicros: number
}

export interface ModelGateway {
  readonly routeHash: string
  complete(request: GatewayRequest): Promise<string>
  usage(): GatewayUsage
  /** Flush and fsync the receipts file; safe to call once at worker exit. */
  close(): Promise<void>
}

/**
 * Open the gateway over a deterministic model. Receipts are appended in
 * request order and the file is fsynced on close; every request first checks
 * the budget and fails closed instead of silently continuing past the cap.
 */
export function openModelGateway(options: {
  model: RecordedModel
  receiptsPath: string
  budget?: GatewayBudget
  routes?: readonly GatewayRoute[]
}): ModelGateway {
  const routes = options.routes ?? FROZEN_ROUTES
  const budget = options.budget ?? DEFAULT_PROPOSER_BUDGET
  const route = routes[0]
  if (route === undefined) throw new ModelGatewayError('route table is empty')
  const routeHash = frozenRouteHash(routes)
  const usage: GatewayUsage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsdMicros: 0,
  }
  let closed = false
  // Serializes receipt appends so request order equals file order.
  let receiptsChain: Promise<void> = Promise.resolve()

  const costMicros = (promptTokens: number, completionTokens: number): number => {
    const inputMicros = promptTokens * route.inputUsdPerMTok
    const outputMicros = completionTokens * route.outputUsdPerMTok
    return Math.round(inputMicros + outputMicros)
  }

  return {
    routeHash,
    async complete(request) {
      if (closed) throw new ModelGatewayError('gateway is closed')
      if (usage.requests >= budget.maxRequests) {
        throw new ModelGatewayError(
          `budget stop: ${usage.requests}/${budget.maxRequests} requests used`,
        )
      }
      const promptTokens = tokenCount(renderPrompt(request))
      // Completion size is bounded by the model output itself; account the
      // response after producing it and check the combined budget before
      // accepting the request into the ledger.
      const response = options.model.complete(request)
      const completionTokens = tokenCount(response)
      const totalAfter = usage.totalTokens + promptTokens + completionTokens
      const costAfter = usage.costUsdMicros + costMicros(promptTokens, completionTokens)
      if (totalAfter > budget.maxTotalTokens) {
        throw new ModelGatewayError(
          `budget stop: ${totalAfter} total tokens would exceed ${budget.maxTotalTokens}`,
        )
      }
      if (costAfter > budget.maxCostUsdMicros) {
        throw new ModelGatewayError(
          `budget stop: ${costAfter} µUSD would exceed ${budget.maxCostUsdMicros}`,
        )
      }
      usage.requests += 1
      usage.promptTokens += promptTokens
      usage.completionTokens += completionTokens
      usage.totalTokens = totalAfter
      usage.costUsdMicros = costAfter
      const receipt: GatewayReceipt = {
        schemaVersion: 1,
        gatewayVersion: GATEWAY_VERSION,
        requestId: `req-${usage.requests}`,
        route: route.model,
        routeHash,
        promptSha256: promptSha256(request),
        promptTokens,
        completionTokens,
        costUsdMicros: usage.costUsdMicros,
      }
      receiptsChain = receiptsChain.then(() => appendReceipt(options.receiptsPath, receipt))
      await receiptsChain
      return response
    },
    usage: () => ({ ...usage }),
    async close() {
      closed = true
      await receiptsChain
      const handle = await open(options.receiptsPath, 'r').catch(() => undefined)
      if (handle !== undefined) {
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
    },
  }
}

/** Deterministic prompt rendering used for both accounting and the hash. */
function renderPrompt(request: GatewayRequest): string {
  return JSON.stringify({
    system: [...request.sections]
      .sort((a, b) => a.order - b.order)
      .map((section) => ({ name: section.name, text: section.text })),
    user: request.userText,
  })
}

async function appendReceipt(path: string, receipt: GatewayReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(receipt)}\n`, 'utf8')
}
