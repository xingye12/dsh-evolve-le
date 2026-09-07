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
import type { RouteRetryPolicy } from '../config/run-config.js'
import {
  CANDIDATE_TEST_OUTPUT_CAP,
  runCandidateTestSuite,
  type CandidateTestRun,
} from '../builder/candidate-test-runner.js'
import { GATEWAY_VERSION, type GatewayBudget, type GatewayUsage } from './gateway.js'
import { upstreamChatCompletion, type UpstreamAttempt } from './upstream.js'
import type { NativeLlmToolSchema } from '../dsh/native-llm-adapter.js'

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
  /** ADR-033: frozen retry policy; part of the route lock. */
  retry: RouteRetryPolicy
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
        retry: plan.retry,
      }),
      'utf8',
    )
    .digest('hex')
}

export interface RemoteReceiptOk {
  schemaVersion: 3
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
  /** ADR-033: every upstream attempt of this request, in order. */
  attempts: UpstreamAttempt[]
}

export interface RemoteReceiptError {
  schemaVersion: 3
  gatewayVersion: string
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

/**
 * ADR-033: the worst-case wall clock of one request's retry loop — every
 * attempt at the full per-attempt budget plus all inter-attempt backoffs.
 * The remote runner derives the sandbox worker's socket-client timeout from
 * this value + margin, so the client always outlasts the proxy's retries.
 */
export function retryWorstCaseMs(
  retry: RouteRetryPolicy,
  requestTimeoutMs: number,
): number {
  return retry.maxAttempts * requestTimeoutMs + retry.backoffMs.reduce((sum, ms) => sum + ms, 0)
}

interface CompleteRequest {
  sections: { name: string; order: number; text: string }[]
  userText: string
  messages?: { role: string; content: unknown }[]
  tools?: NativeLlmToolSchema[]
}

/**
 * ADR-038: `candidate-tests` request — run the stage-6 typeLintUnit suite
 * over one child's merged parent+child view. Consumes no model-receipt
 * sequence and writes no receipts; the reply lands in the worker transcript
 * as the proposal_finish tool error it is.
 */
interface CandidateTestsRequest {
  type: 'candidate-tests'
  childName: string
  files: Record<string, string>
}

/** ADR-038 caps: a merged child view is a handful of small source files. */
const MAX_CANDIDATE_TEST_FILES = 500
const MAX_CANDIDATE_TEST_BYTES = 1024 * 1024
/** Same safe-directory pattern the tree-v2 finalizer enforces for child names. */
const CANDIDATE_TEST_CHILD_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * ADR-038: controller-side runner for `candidate-tests` requests. Injected
 * for contract tests; the default is the real stage-6 suite over a staged
 * merged view.
 */
export type CandidateTestRunner = (options: {
  childName: string
  files: Record<string, string>
}) => Promise<CandidateTestRun>

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
  /**
   * Wall-clock budget for one request's whole retry loop (ADR-033). Defaults
   * to the plan's worst case — maxAttempts × requestTimeoutMs + Σ backoff —
   * which is what the remote runner's socket-client timeout is derived from.
   */
  retryTotalBudgetMs?: number
  /** Socket file mode — the sandbox worker (a different uid) must connect. */
  socketMode?: number
  /**
   * ADR-038: controller-staged parent source view (path → utf8 content, the
   * same files parent-files.json names). Every parent-file byte in a
   * `candidate-tests` merged view is verified against this BEFORE anything
   * runs — the model cannot smuggle parent-file edits into the test run.
   * Requests are refused while it is absent.
   */
  parentSourceFiles?: Readonly<Record<string, string>>
  /**
   * ADR-038: parent capsule directory whose `node_modules/` the real runner
   * symlinks into the staged tree (the child's closure is by contract the
   * parent's). Required on live routes with the default runner.
   */
  candidateDependencyRoot?: string
  /** ADR-038: runner override for contract tests; defaults to the real suite. */
  candidateTestRunner?: CandidateTestRunner
  /** ADR-038: max `candidate-tests` runs per proxy lifetime. */
  maxCandidateTestRuns?: number
}): RemoteProxy {
  const routeHash = remoteRoutePlanHash(options.plan)
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS
  const retryTotalBudgetMs =
    options.retryTotalBudgetMs ?? retryWorstCaseMs(options.plan.retry, requestTimeoutMs)
  const usage: GatewayUsage = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsdMicros: 0,
  }
  let sequence = 0
  // ADR-038: candidate-tests runs never touch the model receipt sequence —
  // verifyRemoteReceipts asserts req-1..req-N with no gaps. Test runs get
  // their own counter, reply ids and budget.
  let testSequence = 0
  let testRuns = 0
  const candidateTestRunner =
    options.candidateTestRunner ??
    ((request) =>
      runCandidateTestSuite({
        ...request,
        ...(options.candidateDependencyRoot === undefined
          ? {}
          : { dependencyRoot: options.candidateDependencyRoot }),
      }))
  const maxCandidateTestRuns = options.maxCandidateTestRuns ?? 12
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
    attempts: UpstreamAttempt[],
  ): RemoteReceiptError => ({
    schemaVersion: 3,
    gatewayVersion: GATEWAY_VERSION,
    requestId,
    route: options.plan.routeId,
    routeHash,
    promptSha256: promptHash,
    ok: false,
    error,
    attempts,
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
    let parsed: { type?: string } & CompleteRequest
    try {
      parsed = JSON.parse(line) as { type?: string } & CompleteRequest
    } catch (error) {
      reply(socket, { v: 1, type: 'error', message: `bad request: ${(error as Error).message}` })
      return
    }
    if (parsed['type'] === 'candidate-tests') {
      await handleCandidateTests(parsed as unknown as CandidateTestsRequest, socket)
      return
    }
    if (parsed['type'] !== 'complete') {
      reply(socket, { v: 1, type: 'error', message: `bad request: unknown request type` })
      return
    }
    const request = parsed
    sequence += 1
    const requestId = `req-${sequence}`
    const promptHash = promptSha256({
      sections: request.sections,
      userText: request.userText,
      ...(request.messages === undefined ? {} : { messages: request.messages }),
      ...(request.tools === undefined ? {} : { tools: request.tools }),
    })
    const fail = (receipt: RemoteReceiptError, message: string): void => {
      appendReceipt(receipt)
      reply(socket, { v: 1, type: 'error', requestId, message })
    }
    if (closed) {
      fail(errorReceipt(requestId, promptHash, 'gateway is closed', []), 'gateway is closed')
      return
    }
    if (usage.requests >= (options.budget?.maxRequests ?? Number.POSITIVE_INFINITY)) {
      fail(
        errorReceipt(
          requestId,
          promptHash,
          `budget stop: ${usage.requests}/${String(options.budget?.maxRequests)} requests used`,
          [],
        ),
        `budget stop: ${usage.requests}/${String(options.budget?.maxRequests)} requests used`,
      )
      return
    }

    // Upstream call, budget stops and receipt policy live here; the locked
    // request shape, credential handling and the ADR-033 retry loop live in
    // upstream.ts (shared with the solve gateway since ADR-030).
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
      fail(
        {
          ...errorReceipt(requestId, promptHash, result.error, result.attempts),
          ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
          ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
        },
        result.error,
      )
      return
    }
    const totalAfter = usage.totalTokens + result.promptTokens + result.completionTokens
    const costAfter = usage.costUsdMicros + result.costUsdMicros
    if (
      totalAfter > (options.budget?.maxTotalTokens ?? Number.POSITIVE_INFINITY) ||
      costAfter > (options.budget?.maxCostUsdMicros ?? Number.POSITIVE_INFINITY)
    ) {
      fail(
        errorReceipt(
          requestId,
          promptHash,
          `budget stop: ${String(totalAfter)} tokens / ${String(costAfter)} µUSD would exceed the cap`,
          result.attempts,
        ),
        'budget stop: tokens or cost would exceed the cap',
      )
      return
    }
    usage.requests += 1
    usage.promptTokens += result.promptTokens
    usage.completionTokens += result.completionTokens
    usage.totalTokens = totalAfter
    usage.costUsdMicros = costAfter
    appendReceipt({
      schemaVersion: 3,
      gatewayVersion: GATEWAY_VERSION,
      requestId,
      route: options.plan.routeId,
      routeHash,
      promptSha256: promptHash,
      responseSha256:
        request.messages === undefined
          ? sha256Hex(result.content)
          : sha256Hex(JSON.stringify({ content: result.content, toolCalls: result.toolCalls })),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsdMicros: result.costUsdMicros,
      ok: true,
      modelReportedUsage: result.modelReportedUsage,
      attempts: result.attempts,
    })
    reply(socket, {
      v: 1,
      type: 'ok',
      requestId,
      promptSha256: promptHash,
      responseText: result.content,
      ...(result.toolCalls.length === 0 ? {} : { toolCalls: result.toolCalls }),
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      responseSha256:
        request.messages === undefined
          ? sha256Hex(result.content)
          : sha256Hex(JSON.stringify({ content: result.content, toolCalls: result.toolCalls })),
    })
  }

  /**
   * ADR-038: verify a merged child view against the staged parent view, then
   * run the stage-6 suite. Refusals reply as `result ok:false` — the worker
   * surfaces the text as a proposal_finish tool error, uniform for the model.
   */
  const handleCandidateTests = async (
    request: CandidateTestsRequest,
    socket: Socket,
  ): Promise<void> => {
    testSequence += 1
    const testRunId = `test-${String(testSequence)}`
    const refuse = (output: string): void => {
      reply(socket, { v: 1, type: 'result', testRunId, ok: false, output })
    }
    if (closed) {
      refuse('candidate-tests refused: gateway is closed')
      return
    }
    if (options.parentSourceFiles === undefined) {
      refuse('candidate-tests refused: the controller staged no parent source view for this proxy')
      return
    }
    // ADR-038: the real runner must symlink a node_modules into the staged
    // tree or vitest collects zero tests and the reply is always "failed".
    if (options.candidateTestRunner === undefined && options.candidateDependencyRoot === undefined) {
      refuse(
        'candidate-tests refused: no candidate dependency root for the real test runner (pass candidateDependencyRoot or an injected candidateTestRunner)',
      )
      return
    }
    if (testRuns >= maxCandidateTestRuns) {
      refuse(
        `candidate-tests refused: budget stop (${String(testRuns)}/${String(maxCandidateTestRuns)} runs used)`,
      )
      return
    }
    if (
      typeof request.childName !== 'string' ||
      !CANDIDATE_TEST_CHILD_NAME.test(request.childName)
    ) {
      refuse('candidate-tests refused: childName is not a safe directory name')
      return
    }
    const files = request.files
    if (files === null || typeof files !== 'object' || Array.isArray(files)) {
      refuse('candidate-tests refused: files must be an object')
      return
    }
    const entries = Object.entries(files)
    if (entries.length > MAX_CANDIDATE_TEST_FILES) {
      refuse(
        `candidate-tests refused: ${String(entries.length)} files exceeds the ${String(
          MAX_CANDIDATE_TEST_FILES,
        )}-file cap`,
      )
      return
    }
    let totalBytes = 0
    for (const [path, content] of entries) {
      if (typeof content !== 'string') {
        refuse(`candidate-tests refused: file ${path} content is not a string`)
        return
      }
      if (path === '' || path.startsWith('/') || path.split('/').includes('..')) {
        refuse(`candidate-tests refused: file path ${path} is not a safe relative path`)
        return
      }
      totalBytes += Buffer.byteLength(content, 'utf8')
      if (totalBytes > MAX_CANDIDATE_TEST_BYTES) {
        refuse(
          `candidate-tests refused: merged view exceeds the ${String(
            MAX_CANDIDATE_TEST_BYTES,
          )}-byte cap`,
        )
        return
      }
    }
    // A parent file may differ from the staged parent view only when the
    // child's intent declares it in runtime.modeComponents (the projection
    // contract the worker's finalizer already enforced) — plus
    // candidate.json, which is always the child's own identity document.
    // Everything else must be byte-identical: this keeps the test run honest,
    // the model edits only what the contract lets it edit. The controller
    // re-verifies the per-mode byte rules authoritatively at diffBoundary.
    let allowedParentChanges: Set<string>
    try {
      const intentRaw = JSON.parse(files['candidate.json'] ?? '') as Record<string, unknown>
      const rawRuntime = intentRaw['runtime']
      const rawModeComponents =
        rawRuntime !== null && typeof rawRuntime === 'object' && !Array.isArray(rawRuntime)
          ? (rawRuntime as Record<string, unknown>)['modeComponents']
          : undefined
      if (
        rawModeComponents === null ||
        typeof rawModeComponents !== 'object' ||
        Array.isArray(rawModeComponents)
      ) {
        throw new Error('no runtime.modeComponents object')
      }
      allowedParentChanges = new Set<string>()
      for (const entries of Object.values(rawModeComponents as Record<string, unknown>)) {
        if (!Array.isArray(entries)) throw new Error('modeComponents entries must be arrays')
        for (const entry of entries as unknown[]) {
          if (typeof entry !== 'string') throw new Error('modeComponents entries must be strings')
          allowedParentChanges.add(entry)
        }
      }
      allowedParentChanges.add('candidate.json')
    } catch (error) {
      refuse(
        `candidate-tests refused: merged view candidate.json does not declare runtime.modeComponents (${error instanceof Error ? error.message : String(error)})`,
      )
      return
    }
    for (const [path, parentContent] of Object.entries(options.parentSourceFiles)) {
      const sent = files[path]
      if (sent === undefined) {
        refuse(`candidate-tests refused: merged view is missing parent file ${path}`)
        return
      }
      if (sent !== parentContent && !allowedParentChanges.has(path)) {
        refuse(
          `candidate-tests refused: parent file ${path} bytes differ from the staged parent view (only runtime.modeComponents files and candidate.json may change)`,
        )
        return
      }
    }
    testRuns += 1
    try {
      const result = await candidateTestRunner({
        childName: request.childName,
        files: files as Record<string, string>,
        // ADR-039: the staged parent view travels into the runner (real or
        // injected) so the boundary can compare mounted surfaces per the
        // declared modeContract.
        ...(options.parentSourceFiles === undefined
          ? {}
          : { parentFiles: { ...options.parentSourceFiles } }),
      })
      reply(socket, {
        v: 1,
        type: 'result',
        testRunId,
        ok: result.ok,
        output: result.output.slice(0, CANDIDATE_TEST_OUTPUT_CAP),
      })
    } catch (error) {
      reply(socket, {
        v: 1,
        type: 'result',
        testRunId,
        ok: false,
        output: `candidate-tests failed: ${error instanceof Error ? error.message : String(error)}`,
      })
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

interface NativeProposalTranscript {
  protocol?: string
  audits?: unknown
}

interface NativeProposalAuditRecord {
  requestId?: unknown
  promptSha256?: unknown
  responseSha256?: unknown
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
  const transcriptLines = (await readFileLines(options.transcriptPath)).filter(
    (line) => line !== '',
  )
  const firstTranscript = transcriptLines[0]
  let nativeTranscript: NativeProposalTranscript | undefined
  if (firstTranscript !== undefined) {
    const parsed = JSON.parse(firstTranscript) as NativeProposalTranscript & { kind?: string }
    if (parsed.protocol === 'dsh-evolve-le/native-proposal/v1') nativeTranscript = parsed
  }

  if (nativeTranscript !== undefined) {
    if (transcriptLines.length !== 1) {
      problems.push('native proposal transcript must contain exactly one JSON document')
    }
    const audits = Array.isArray(nativeTranscript.audits)
      ? (nativeTranscript.audits as NativeProposalAuditRecord[])
      : []
    if (!Array.isArray(nativeTranscript.audits)) {
      problems.push('native proposal transcript is missing its gateway audits')
    }
    if (audits.length !== okReceipts.length) {
      problems.push(
        `native transcript has ${String(audits.length)} gateway audits but ${String(okReceipts.length)} successful receipts`,
      )
    }
    for (const [index, audit] of audits.entries()) {
      const receipt = okReceipts[index]
      if (receipt === undefined) break
      if (audit.requestId !== receipt.requestId) {
        problems.push(
          `native audit ${String(index + 1)} requestId ${String(audit.requestId)} ≠ ${receipt.requestId}`,
        )
      }
      if (audit.promptSha256 !== receipt.promptSha256) {
        problems.push(`native audit ${String(index + 1)} promptSha256 does not match the receipt`)
      }
      if (audit.responseSha256 !== receipt.responseSha256) {
        problems.push(`native audit ${String(index + 1)} responseSha256 does not match the receipt`)
      }
    }
  } else {
    const turns = transcriptLines
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
