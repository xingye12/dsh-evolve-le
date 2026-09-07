/**
 * ADR-033 retry-loop contract tests: the single shared upstream core both
 * TCB proxies delegate to. The frozen retry policy retries ONLY transient
 * infrastructure failures — upstream 5xx and network failures — inside the
 * caller's total wall-clock budget. 4xx, per-attempt timeouts, empty content
 * and malformed tool calls never retry (ambiguity resolves to FAIL), every
 * attempt lands in `attempts` for the caller to receipt, and the loop never
 * outlives `retryTotalBudgetMs`.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { upstreamChatCompletion, type UpstreamChatResult } from '../src/proposer/upstream.js'
import type { RemoteRoutePlan } from '../src/proposer/remote-gateway.js'
import type { RouteRetryPolicy } from '../src/config/run-config.js'

const servers: Server[] = []

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections?.()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
})

const SECTIONS = [{ name: 'tcb:proposal-policy', order: 0, text: 'policy text' }]
const USER_TEXT = 'retry contract probe'

function plan(baseUrl: string, retry: RouteRetryPolicy): RemoteRoutePlan {
  return {
    routeId: 'deepseek/zen-compatible',
    baseUrl,
    model: 'deepseek-v4-flash',
    temperature: 0,
    maxOutputTokens: 512,
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    retry,
  }
}

interface Behavior {
  status: number
  payload: unknown
  /** Called with the request sequence number when the response ends. */
  onServed?: (sequence: number, at: number) => void
}

/** Upstream stand-in whose behavior is a per-sequence script. */
class FakeUpstream {
  private readonly server: Server
  private served = 0
  private behavior: (sequence: number) => Behavior

  constructor() {
    this.behavior = () => ({ status: 200, payload: {} })
    this.server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        this.served += 1
        const { status, payload, onServed } = this.behavior(this.served)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        onServed?.(this.served, Date.now())
      })
    })
    servers.push(this.server)
  }

  serve(behavior: (sequence: number) => Behavior): void {
    this.behavior = behavior
  }

  listen(): Promise<string> {
    return new Promise((resolveListen) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo
        resolveListen(`http://127.0.0.1:${String(address.port)}/v1`)
      })
    })
  }

  servedCount(): number {
    return this.served
  }
}

/** A listener that accepts connections and never answers. */
function hangingServer(): Promise<Server> {
  return new Promise((resolveListen) => {
    const server = createServer((req) => {
      req.resume()
      // deliberately no response
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolveListen(server))
  })
}

function okPayload(): unknown {
  return {
    choices: [{ message: { content: 'recovered' } }],
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  }
}

function complete(
  baseUrl: string,
  retry: RouteRetryPolicy,
  options: { requestTimeoutMs?: number; retryTotalBudgetMs?: number } = {},
): Promise<UpstreamChatResult> {
  return upstreamChatCompletion({
    plan: plan(baseUrl, retry),
    credential: 'sk-x',
    sections: SECTIONS,
    userText: USER_TEXT,
    requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
    retryTotalBudgetMs: options.retryTotalBudgetMs ?? 60_000,
  })
}

describe('upstream retry loop (ADR-033)', () => {
  it('recovers on 500-then-200 with the full attempts trace on the ok result', async () => {
    const upstream = new FakeUpstream()
    upstream.serve((sequence) =>
      sequence === 1
        ? { status: 500, payload: { error: 'transient' } }
        : { status: 200, payload: okPayload() },
    )
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 4, backoffMs: [10, 10, 10] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe('recovered')
      expect(result.attempts).toEqual([
        { ok: false, error: 'upstream 500', httpStatus: 500 },
        { ok: true },
      ])
      // Billed from the recovered attempt's API-reported usage.
      expect(result.promptTokens).toBe(7)
      expect(result.completionTokens).toBe(3)
    }
    expect(upstream.servedCount()).toBe(2)
  })

  it('exhausts maxAttempts on persistent 5xx and reports the last failure', async () => {
    const upstream = new FakeUpstream()
    upstream.serve(() => ({ status: 500, payload: { error: 'boom' } }))
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 4, backoffMs: [5, 5, 5] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.httpStatus).toBe(500)
      expect(result.attempts).toEqual([
        { ok: false, error: 'upstream 500', httpStatus: 500 },
        { ok: false, error: 'upstream 500', httpStatus: 500 },
        { ok: false, error: 'upstream 500', httpStatus: 500 },
        { ok: false, error: 'upstream 500', httpStatus: 500 },
      ])
    }
    expect(upstream.servedCount()).toBe(4)
  })

  it('never retries 4xx — the failure is immediate and final', async () => {
    const upstream = new FakeUpstream()
    upstream.serve(() => ({ status: 400, payload: { error: 'bad request' } }))
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 4, backoffMs: [5, 5, 5] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.httpStatus).toBe(400)
      expect(result.attempts).toEqual([{ ok: false, error: 'upstream 400', httpStatus: 400 }])
    }
    expect(upstream.servedCount()).toBe(1)
  })

  it('stops retrying at the first non-retryable failure (500 then 400)', async () => {
    const upstream = new FakeUpstream()
    upstream.serve((sequence) =>
      sequence === 1
        ? { status: 500, payload: { error: 'transient' } }
        : { status: 400, payload: { error: 'final' } },
    )
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 4, backoffMs: [5, 5, 5] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // The final failure is the 400; the trace keeps both attempts in order.
      expect(result.httpStatus).toBe(400)
      expect(result.attempts).toEqual([
        { ok: false, error: 'upstream 500', httpStatus: 500 },
        { ok: false, error: 'upstream 400', httpStatus: 400 },
      ])
    }
    expect(upstream.servedCount()).toBe(2)
  })

  it('never retries a per-attempt timeout', async () => {
    const hanging = await hangingServer()
    const address = hanging.address() as AddressInfo
    const result = await complete(
      `http://127.0.0.1:${String(address.port)}/v1`,
      { maxAttempts: 4, backoffMs: [5, 5, 5] },
      { requestTimeoutMs: 150 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.timedOut).toBe(true)
      expect(result.attempts).toEqual([
        { ok: false, error: 'request timed out after 150ms', timedOut: true },
      ])
    }
  })

  it('retries network failures up to maxAttempts', async () => {
    // Grab a port and close it again: every attempt fails with ECONNREFUSED.
    const probe = createServer(() => undefined)
    servers.push(probe)
    const address = await new Promise<AddressInfo>((resolveListen) => {
      probe.listen(0, '127.0.0.1', () => resolveListen(probe.address() as AddressInfo))
    })
    const port = address.port
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()))
    const result = await complete(`http://127.0.0.1:${String(port)}/v1`, {
      maxAttempts: 3,
      backoffMs: [5, 5],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/^network failure:/)
      expect(result.attempts).toHaveLength(3)
      for (const attempt of result.attempts) {
        expect(attempt.ok).toBe(false)
        expect(attempt.error).toMatch(/^network failure:/)
        expect(attempt.httpStatus).toBeUndefined()
      }
    }
  })

  it('honors the inter-attempt backoff ordering', async () => {
    const upstream = new FakeUpstream()
    const servedAt: number[] = []
    upstream.serve(() => ({
      status: 500,
      payload: { error: 'boom' },
      onServed: (_sequence, at) => servedAt.push(at),
    }))
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 3, backoffMs: [150, 150] })
    expect(result.ok).toBe(false)
    expect(upstream.servedCount()).toBe(3)
    expect(servedAt).toHaveLength(3)
    // Attempt i+1 starts at least one backoff period after attempt i ended
    // (generous slack for timer jitter; the point is the ordering, not ms).
    expect(servedAt[1]! - servedAt[0]!).toBeGreaterThanOrEqual(100)
    expect(servedAt[2]! - servedAt[1]!).toBeGreaterThanOrEqual(100)
  })

  it('never outlives the caller budget: a backoff beyond it stops the loop', async () => {
    const upstream = new FakeUpstream()
    upstream.serve(() => ({ status: 500, payload: { error: 'boom' } }))
    const baseUrl = await upstream.listen()
    // Budget 100ms; the first backoff alone costs 1000ms, so only the first
    // attempt may run — the loop must stop before the second attempt.
    const result = await complete(
      baseUrl,
      { maxAttempts: 4, backoffMs: [1000, 1000, 1000] },
      { retryTotalBudgetMs: 100 },
    )
    expect(result.ok).toBe(false)
    expect(upstream.servedCount()).toBe(1)
    expect(result.attempts).toHaveLength(1)
  })

  it('shrinks each attempt budget to what the total budget leaves', async () => {
    // requestTimeoutMs 5000 vs retryTotalBudgetMs 150: the single attempt is
    // bounded by 150ms, not 5000ms — the loop can never outlive its consumer.
    const hanging = await hangingServer()
    const address = hanging.address() as AddressInfo
    const result = await complete(
      `http://127.0.0.1:${String(address.port)}/v1`,
      { maxAttempts: 4, backoffMs: [5, 5, 5] },
      { requestTimeoutMs: 5_000, retryTotalBudgetMs: 150 },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.timedOut).toBe(true)
      expect(result.error).toBe('request timed out after 150ms')
    }
  })

  it('never retries empty content (a reasoning model burning max_tokens)', async () => {
    const upstream = new FakeUpstream()
    upstream.serve(() => ({
      status: 200,
      payload: { choices: [{ message: { content: '', reasoning_content: 'thinking' } }] },
    }))
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 4, backoffMs: [5, 5, 5] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('upstream returned empty content (finish_reason length?)')
      expect(result.attempts).toHaveLength(1)
    }
    expect(upstream.servedCount()).toBe(1)
  })

  it('never retries a malformed tool call', async () => {
    const upstream = new FakeUpstream()
    upstream.serve(() => ({
      status: 200,
      payload: { choices: [{ message: { content: '', tool_calls: [{ function: {} }] } }] },
    }))
    const baseUrl = await upstream.listen()
    const result = await complete(baseUrl, { maxAttempts: 4, backoffMs: [5, 5, 5] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('upstream returned malformed tool call')
      expect(result.attempts).toHaveLength(1)
    }
    expect(upstream.servedCount()).toBe(1)
  })
})
