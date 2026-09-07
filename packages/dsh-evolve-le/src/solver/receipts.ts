/**
 * Solve-gateway receipts (ADR-030, specs/02 §13 / specs/05 §7): the per-trial
 * chain that attributes every live-solve model call to exactly one harbor
 * job. One JSONL file per trial under `<runRoot>/solve-gateway/receipts/`,
 * append-only, hashes and usage only — prompt text, response text and the
 * bearer token never appear (CLAUDE.md rule 8).
 *
 * Verification semantics here deliberately differ from the proposer's
 * `verifyRemoteReceipts`: a single proposal saga dies on any error turn, but
 * a SOLVE trial is a long agent session in a container — an upstream 429 or
 * timeout mid-trial is an expected event (the turn fails, the trial goes on
 * or ends as a genuine failure). So `ok:false` receipts are tolerated and
 * counted separately, excluded from usage, while everything that breaks
 * attribution — gaps, duplicates, non-monotonic ids, a route-hash mismatch,
 * a wrong trial, a missing or empty chain — fails closed: a trial whose cost
 * cannot be attributed is incomplete, not free.
 * @module @dsh-evolve-le/core/solver/receipts
 */

import { readFile } from 'node:fs/promises'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { GATEWAY_VERSION, type GatewayUsage } from '../proposer/gateway.js'
import type { UpstreamAttempt } from '../proposer/upstream.js'

export interface SolveReceiptOk {
  schemaVersion: 4
  gatewayVersion: string
  jobName: string
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
  /** ADR-033: every upstream attempt of this request, in order. */
  attempts: UpstreamAttempt[]
}

export interface SolveReceiptError {
  schemaVersion: 4
  gatewayVersion: string
  jobName: string
  requestId: string
  route: string
  routeHash: string
  promptSha256: string | null
  ok: false
  error: string
  httpStatus?: number
  timedOut?: true
  /** ADR-033: every upstream attempt of this request, in order. */
  attempts: UpstreamAttempt[]
}

export type SolveReceipt = SolveReceiptOk | SolveReceiptError

export interface SolveReceiptVerification {
  ok: boolean
  problems: string[]
  /** Successful requests (drives usage; error receipts are excluded). */
  requests: number
  /** Tolerated failed turns — 429s, timeouts, empty content. */
  errorReceipts: number
  /** Authoritative usage summed from the successful receipts. */
  usage: GatewayUsage
}

/** Parse one receipts file; a missing file is an attribution failure. */
export async function readSolveReceipts(receiptsPath: string): Promise<SolveReceipt[]> {
  const text = await readFile(receiptsPath, 'utf8').catch(() => null)
  if (text === null || text.trim() === '') return []
  const receipts: SolveReceipt[] = []
  for (const line of text.trimEnd().split('\n')) {
    if (line === '') continue
    receipts.push(JSON.parse(line) as SolveReceipt)
  }
  return receipts
}

/** Append one receipt, serialized per file so request order equals file order. */
export function appendSolveReceipt(
  chain: Promise<void>,
  receiptsPath: string,
  receipt: SolveReceipt,
): Promise<void> {
  return chain.then(async () => {
    await mkdir(dirname(receiptsPath), { recursive: true })
    await appendFile(receiptsPath, `${JSON.stringify(receipt)}\n`, 'utf8')
  })
}

/**
 * Verify one trial's receipt chain under solve semantics (see module docs).
 * A missing file, an empty chain, a broken sequence, a wrong jobName or a
 * route-hash mismatch all fail closed.
 */
export async function verifySolveReceipts(options: {
  receiptsPath: string
  routeHash: string
  jobName: string
}): Promise<SolveReceiptVerification> {
  const problems: string[] = []
  let missing = false
  const text = await readFile(options.receiptsPath, 'utf8').catch(() => {
    missing = true
    return ''
  })
  if (missing) {
    problems.push(`receipts file missing: ${options.receiptsPath}`)
  }
  const receipts =
    text.trim() === '' ? [] : (text.trimEnd().split('\n').map((line) => JSON.parse(line) as SolveReceipt))
  if (!missing && receipts.length === 0) {
    problems.push('no receipts recorded for this trial')
  }
  const usage: GatewayUsage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsdMicros: 0,
  }
  let errorReceipts = 0
  // The sequence check spans ok AND error receipts: every id is consumed in
  // order with no gap and no repeat, whatever the outcome was.
  receipts.forEach((receipt, index) => {
    const expected = `req-${String(index + 1)}`
    if (receipt.requestId !== expected) {
      problems.push(
        `receipt sequence break at ${String(index + 1)}: ${String(receipt.requestId)} ≠ ${expected}`,
      )
    }
    if (receipt.jobName !== options.jobName) {
      problems.push(
        `receipt ${String(receipt.requestId)} jobName ${String(receipt.jobName)} ≠ ${options.jobName}`,
      )
    }
    // 3 = pre-ADR-033 shape (no attempts trace); 4 = with attempts. Both are
    // legitimate historical shapes for chains this verifier reads back, so
    // the comparison deliberately leaves the literal-typed field.
    const version = receipt.schemaVersion as number
    if (version !== 3 && version !== 4) {
      problems.push(
        `receipt ${String(receipt.requestId)} schemaVersion ${String(version)} ∉ {3, 4}`,
      )
    }
    if (receipt.routeHash !== options.routeHash) {
      problems.push(`receipt ${String(receipt.requestId)} routeHash does not match the frozen plan`)
    }
    if (!receipt.ok) {
      errorReceipts += 1
      return
    }
    usage.requests += 1
    usage.promptTokens += receipt.promptTokens
    usage.completionTokens += receipt.completionTokens
    usage.totalTokens += receipt.promptTokens + receipt.completionTokens
    usage.costUsdMicros += receipt.costUsdMicros
  })
  return {
    ok: problems.length === 0,
    problems,
    requests: usage.requests,
    errorReceipts,
    usage,
  }
}

/** Receipt kinds carry the gateway version so old chains stay identifiable. */
export const SOLVE_RECEIPT_GATEWAY_VERSION = GATEWAY_VERSION
