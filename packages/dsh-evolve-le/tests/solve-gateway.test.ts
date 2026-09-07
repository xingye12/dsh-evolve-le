/**
 * Solve gateway contract tests (ADR-030, specs/02 §13 / specs/05 §7): the
 * live SOLVER route's TCB gateway, mounted on the artifact listener, is the
 * only holder of the credential on the solve side. These tests pin the
 * firewall contract before the integration wires it up:
 *
 *  - per-trial bearer tokens: 401 without one, and a 401 makes NO receipt,
 *    NO upstream call, and leaks neither token nor prompt content;
 *  - requestIds are PER TRIAL — concurrent trials keep independent gapless
 *    chains (the deliberate difference from the proposer proxy's global
 *    sequence);
 *  - locked route/model/temperature/max_tokens on every upstream request,
 *    credential only in Authorization, receipts redacted to hashes;
 *  - hard budget stops refuse atomically before the request leaves the
 *    process and still append an error receipt;
 *  - upstream errors/timeouts become TOLERATED error receipts — counted
 *    separately, excluded from usage — because a solve trial must survive a
 *    mid-session 429 (the other deliberate difference from the proposer's
 *    verifyRemoteReceipts);
 *  - restart replay: reopening the same stateDir continues each trial's
 *    sequence and usage instead of re-minting a budget; a corrupted chain
 *    fails closed at ready().
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { request as httpsRequest } from 'node:https'
import { afterAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { openSolveGateway, SOLVE_GATEWAY_PATH, type SolveGateway } from '../src/solver/gateway.js'
import { verifySolveReceipts } from '../src/solver/receipts.js'
import { remoteRoutePlanHash, type RemoteRoutePlan } from '../src/proposer/remote-gateway.js'

const exec = promisify(execFile)

const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function freshStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'solve-gw-'))
  workRoots.push(dir)
  return dir
}

const PLAN: RemoteRoutePlan = {
  routeId: 'deepseek/zen-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'deepseek-v4-flash',
  temperature: 0,
  maxOutputTokens: 512,
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  // ADR-033: part of the frozen route lock; 1 attempt keeps the classic
  // single-request behavior these pins assert.
  retry: { maxAttempts: 1, backoffMs: [] },
}

/** Upstream stand-in capturing every request it serves. */
class FakeUpstream {
  readonly requests: Array<{ auth: string | undefined; url: string; body: Record<string, unknown> }>
  private readonly server: Server
  private behavior: (body: Record<string, unknown>) => { status: number; payload: unknown }

  constructor() {
    this.requests = []
    this.behavior = () => ({ status: 200, payload: {} })
    this.server = createHttpServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const body = JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>
        this.requests.push({ auth: req.headers['authorization'], url: req.url ?? '', body })
        const { status, payload } = this.behavior(body)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      })
    })
  }

  serve(handler: (body: Record<string, unknown>) => { status: number; payload: unknown }): void {
    this.behavior = handler
  }

  listen(): Promise<string> {
    return new Promise((resolveListen) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo
        resolveListen(`http://127.0.0.1:${String(address.port)}/v1`)
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolveClose) => this.server.close(() => resolveClose()))
  }
}

/** One throwaway TLS listener wrapping the gateway handler. */
interface Mounted {
  url: string
  close(): Promise<void>
}

async function mount(gateway: SolveGateway): Promise<Mounted> {
  const dir = await mkdtemp(join(tmpdir(), 'solve-gw-tls-'))
  workRoots.push(dir)
  const key = join(dir, 'server.key')
  const cert = join(dir, 'server.crt')
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-subj',
    '/CN=127.0.0.1',
    '-days',
    '2',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ])
  const server = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    gateway.handler,
  )
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address() as AddressInfo
  return {
    url: `https://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  }
}

interface Reply {
  status: number
  body: Record<string, unknown>
}

/** One gateway POST with node:https (the same client discipline as the capsule). */
function post(url: string, token: string | null, body: unknown, timeoutMs = 5_000): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpsRequest(
      {
        url: undefined,
        hostname: '127.0.0.1',
        port: Number(new URL(url).port),
        path: SOLVE_GATEWAY_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(payload.length),
          ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        },
        agent: false,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolveReply({
              status: res.statusCode ?? 0,
              body: JSON.parse(text === '' ? '{}' : text) as Record<string, unknown>,
            })
          } catch {
            rejectReply(new Error(`unparseable reply: ${text}`))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('client timeout')))
    req.on('error', rejectReply)
    req.end(payload)
  })
}

const TURN = (userText: string) => ({
  v: 1,
  type: 'complete',
  sections: [{ name: 'tcb:solve-policy', order: 0, text: 'policy text' }],
  userText,
})

const OK_BODY = {
  status: 200,
  payload: {
    choices: [{ message: { content: 'model turn output' } }],
    usage: { prompt_tokens: 41, completion_tokens: 7 },
  },
}

describe('solve gateway: token-authenticated TCB firewall (ADR-030)', () => {
  it('serves authenticated completes with a locked route and redacted receipts', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => OK_BODY)
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-solve-credential',
    })
    const mounted = await mount(gateway)
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('dsh-trial-alpha')
      const token = (await readFile(tokenFilePath, 'utf8')).trim()
      expect(token).toMatch(/^[0-9a-f]{64}$/)

      const first = await post(mounted.url, token, TURN('first solve turn'))
      const second = await post(mounted.url, token, TURN('second solve turn'))
      expect(first.status).toBe(200)
      expect(first.body['type']).toBe('ok')
      expect(first.body['responseText']).toBe('model turn output')
      expect(first.body['routeHash']).toBe(remoteRoutePlanHash({ ...PLAN, baseUrl }))
      expect(second.body['requestId']).toBe('req-2')

      // Locked request shape; the credential exists only in the header.
      expect(upstream.requests).toHaveLength(2)
      for (const request of upstream.requests) {
        expect(request.url).toBe('/v1/chat/completions')
        expect(request.auth).toBe('Bearer sk-SECRET-solve-credential')
        expect(request.body['model']).toBe(PLAN.model)
        expect(request.body['temperature']).toBe(PLAN.temperature)
        expect(request.body['max_tokens']).toBe(PLAN.maxOutputTokens)
      }

      await gateway.close()
      const receiptsPath = join(stateDir, 'receipts', 'dsh-trial-alpha.jsonl')
      const raw = await readFile(receiptsPath, 'utf8')
      const receipts = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(receipts.map((r) => r['requestId'])).toEqual(['req-1', 'req-2'])
      expect(receipts.map((r) => r['jobName'])).toEqual(['dsh-trial-alpha', 'dsh-trial-alpha'])
      expect(receipts.map((r) => r['ok'])).toEqual([true, true])
      expect(receipts[0]!['schemaVersion']).toBe(4)
      expect(receipts[0]!['attempts']).toEqual([{ ok: true }])
      expect(receipts[0]!['costUsdMicros']).toBe(41 * 3 + 7 * 15)

      // REDACTION: no credential, no token, no prompt or response text.
      expect(raw).not.toContain('sk-SECRET-solve-credential')
      expect(raw).not.toContain(token)
      expect(raw).not.toContain('first solve turn')
      expect(raw).not.toContain('model turn output')

      const fact = await gateway.terminalFact('dsh-trial-alpha')
      expect(fact.ok).toBe(true)
      expect(fact.usage.requests).toBe(2)
      expect(fact.usage.costUsdMicros).toBe(2 * (41 * 3 + 7 * 15))
    } finally {
      await gateway.close().catch(() => undefined)
      await mounted.close()
      await upstream.close()
    }
  })

  it('forwards native message history and tool schemas, returning structured tool calls', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => ({
      status: 200,
      payload: {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'solve_exec', arguments: '{"command":"pwd"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 13, completion_tokens: 5 },
      },
    }))
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-native-solve',
    })
    const mounted = await mount(gateway)
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('dsh-trial-native')
      const token = (await readFile(tokenFilePath, 'utf8')).trim()
      const body = {
        ...TURN('native compatibility text'),
        userText: JSON.stringify([{ role: 'user', content: 'inspect' }]),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call-0', name: 'solve_exec', arguments: '{}' }],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-0',
                content: [{ type: 'text', text: 'ok' }],
              },
            ],
          },
        ],
        tools: [{ name: 'solve_exec', description: 'run', parameters: { type: 'object' } }],
      }
      const reply = await post(mounted.url, token, body)
      expect(reply.status).toBe(200)
      expect(reply.body['toolCalls']).toEqual([
        { id: 'call-1', name: 'solve_exec', arguments: '{"command":"pwd"}' },
      ])
      expect(reply.body['responseSha256']).toMatch(/^[0-9a-f]{64}$/)
      expect(upstream.requests[0]?.body['messages']).toEqual([
        { role: 'user', content: 'inspect' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-0',
              type: 'function',
              function: { name: 'solve_exec', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-0', content: 'ok' },
      ])
      expect(upstream.requests[0]?.body['tools']).toEqual([
        {
          type: 'function',
          function: { name: 'solve_exec', description: 'run', parameters: { type: 'object' } },
        },
      ])
    } finally {
      await gateway.close().catch(() => undefined)
      await mounted.close()
      await upstream.close()
    }
  })

  it('401s unauthenticated requests with no receipt, no upstream call, no leakage', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-solve-credential',
    })
    const mounted = await mount(gateway)
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('dsh-trial-beta')
      const token = (await readFile(tokenFilePath, 'utf8')).trim()

      const missing = await post(mounted.url, null, TURN('no auth header'))
      expect(missing.status).toBe(401)
      const wrong = await post(mounted.url, `${'0'.repeat(64)}`, TURN('unknown token'))
      expect(wrong.status).toBe(401)
      // A truncated token is not a prefix-match for the real one.
      const truncated = await post(mounted.url, token.slice(0, 63), TURN('truncated token'))
      expect(truncated.status).toBe(401)

      expect(upstream.requests).toHaveLength(0)
      expect(JSON.stringify(missing.body)).not.toContain('no auth header')
      expect(JSON.stringify(wrong.body)).not.toContain(token)
      await gateway.close()
      const receiptsDir = join(stateDir, 'receipts')
      const files = await readFile(receiptsDir, 'utf8').catch(() => '')
      expect(files).toBe('')
      const fact = await gateway.terminalFact('dsh-trial-beta')
      expect(fact.ok).toBe(false)
      expect(fact.problems.join('\n')).toContain('missing')
    } finally {
      await gateway.close().catch(() => undefined)
      await mounted.close()
      await upstream.close()
    }
  })

  it('keeps concurrent trials on independent gapless chains', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    let served = 0
    upstream.serve(() => {
      served += 1
      return OK_BODY
    })
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    const mounted = await mount(gateway)
    try {
      await gateway.ready()
      const alpha = (await gateway.enrollTrial('dsh-alpha')).tokenFilePath
      const beta = (await gateway.enrollTrial('dsh-beta')).tokenFilePath
      const tokenA = (await readFile(alpha, 'utf8')).trim()
      const tokenB = (await readFile(beta, 'utf8')).trim()
      expect(tokenA).not.toBe(tokenB)

      // Interleave: A, B, B, A.
      await post(mounted.url, tokenA, TURN('a1'))
      await post(mounted.url, tokenB, TURN('b1'))
      await post(mounted.url, tokenB, TURN('b2'))
      await post(mounted.url, tokenA, TURN('a2'))
      expect(served).toBe(4)

      await gateway.close()
      const alphaReceipts = (await readFile(join(stateDir, 'receipts', 'dsh-alpha.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const betaReceipts = (await readFile(join(stateDir, 'receipts', 'dsh-beta.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(alphaReceipts.map((r) => r['requestId'])).toEqual(['req-1', 'req-2'])
      expect(betaReceipts.map((r) => r['requestId'])).toEqual(['req-1', 'req-2'])
      // A token from one trial cannot be replayed against the other's name:
      // attribution comes from the token, never from a client-supplied id.
      expect(alphaReceipts.every((r) => r['jobName'] === 'dsh-alpha')).toBe(true)
      expect(betaReceipts.every((r) => r['jobName'] === 'dsh-beta')).toBe(true)

      const factA = await gateway.terminalFact('dsh-alpha')
      const factB = await gateway.terminalFact('dsh-beta')
      expect(factA.ok && factB.ok).toBe(true)
      expect(factA.usage.requests).toBe(2)
      expect(factB.usage.requests).toBe(2)
    } finally {
      await gateway.close().catch(() => undefined)
      await mounted.close()
      await upstream.close()
    }
  })

  it('refuses past the per-trial budget atomically and still appends an error receipt', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => OK_BODY)
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
      budget: { maxRequests: 1, maxTotalTokens: 1_000_000, maxCostUsdMicros: 1_000_000 },
    })
    const mounted = await mount(gateway)
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('dsh-capped')
      const token = (await readFile(tokenFilePath, 'utf8')).trim()
      await post(mounted.url, token, TURN('allowed'))
      const refused = await post(mounted.url, token, TURN('refused'))
      expect(refused.status).toBe(200)
      expect(refused.body['type']).toBe('error')
      expect(String(refused.body['message'])).toMatch(/budget/)

      expect(upstream.requests).toHaveLength(1)
      await gateway.close()
      const receipts = (await readFile(join(stateDir, 'receipts', 'dsh-capped.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(receipts.map((r) => r['requestId'])).toEqual(['req-1', 'req-2'])
      expect(receipts[1]!['ok']).toBe(false)
      expect(String(receipts[1]!['error'])).toMatch(/budget/)
    } finally {
      await gateway.close().catch(() => undefined)
      await mounted.close()
      await upstream.close()
    }
  })

  it('tolerates upstream error receipts in verification but excludes them from usage', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    let calls = 0
    upstream.serve(() => {
      calls += 1
      if (calls % 2 === 1) return { status: 429, payload: { error: 'rate limited' } }
      return OK_BODY
    })
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    const mounted = await mount(gateway)
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('dsh-flaky')
      const token = (await readFile(tokenFilePath, 'utf8')).trim()
      const throttled = await post(mounted.url, token, TURN('throttled turn'))
      expect(throttled.body['type']).toBe('error')
      expect(String(throttled.body['message'])).toMatch(/429/)
      const fine = await post(mounted.url, token, TURN('recovered turn'))
      expect(fine.body['type']).toBe('ok')

      await gateway.close()
      // D1: an error receipt is an expected mid-trial event — the chain still
      // verifies, the failed turn is not billed.
      const fact = await gateway.terminalFact('dsh-flaky')
      expect(fact.ok).toBe(true)
      expect(fact.errorReceipts).toBe(1)
      expect(fact.usage.requests).toBe(1)
      expect(fact.usage.promptTokens).toBe(41)
      const raw = await readFile(join(stateDir, 'receipts', 'dsh-flaky.jsonl'), 'utf8')
      expect(raw).not.toContain('throttled turn')
      expect(raw).not.toContain('sk-x')
    } finally {
      await gateway.close().catch(() => undefined)
      await mounted.close()
      await upstream.close()
    }
  })

  it('replays state on reopen: sequences and usage continue, corruption fails closed', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => OK_BODY)
    const stateDir = await freshStateDir()
    const gateway = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    const mounted = await mount(gateway)
    let token = ''
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('dsh-resume')
      token = (await readFile(tokenFilePath, 'utf8')).trim()
      await post(mounted.url, token, TURN('before restart'))
      await gateway.close()
    } finally {
      await mounted.close()
    }

    // Reopen: same stateDir, same plan → the trial continues, not restarts.
    const gateway2 = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    const mounted2 = await mount(gateway2)
    try {
      await gateway2.ready()
      const reused = await gateway2.enrollTrial('dsh-resume')
      const token2 = (await readFile(reused.tokenFilePath, 'utf8')).trim()
      expect(token2).toBe(token)
      const factBefore = await gateway2.terminalFact('dsh-resume')
      expect(factBefore.usage.requests).toBe(1)
      const next = await post(mounted2.url, token2, TURN('after restart'))
      expect(next.body['requestId']).toBe('req-2')
      await gateway2.close()
      const factAfter = await gateway2.terminalFact('dsh-resume')
      expect(factAfter.ok).toBe(true)
      expect(factAfter.usage.requests).toBe(2)
      expect(factAfter.usage.promptTokens).toBe(82)
    } finally {
      await gateway2.close().catch(() => undefined)
      await mounted2.close()
    }

    // Corrupted chain: the reopen must fail closed before any new spend.
    const receiptsPath = join(stateDir, 'receipts', 'dsh-resume.jsonl')
    await writeFile(receiptsPath, 'this is not json\n', 'utf8')
    const gateway3 = openSolveGateway({
      stateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    await expect(gateway3.ready()).rejects.toThrow()
    await gateway3.close().catch(() => undefined)
  })

  it('verifySolveReceipts fails closed on gaps, wrong trial, wrong route, missing file', async () => {
    const stateDir = await freshStateDir()
    const routeHash = remoteRoutePlanHash(PLAN)
    const receiptLine = (requestId: string, jobName: string, route: string): string =>
      JSON.stringify({
        schemaVersion: 4,
        gatewayVersion: 'dsh-evolve-le/model-gateway/v1',
        jobName,
        requestId,
        route: PLAN.routeId,
        routeHash: route,
        promptSha256: 'a'.repeat(64),
        responseSha256: 'b'.repeat(64),
        promptTokens: 1,
        completionTokens: 1,
        costUsdMicros: 18,
        ok: true,
        modelReportedUsage: true,
        attempts: [{ ok: true }],
      })
    const path = join(stateDir, 'gap.jsonl')
    await writeFile(
      path,
      `${receiptLine('req-1', 'j', routeHash)}\n${receiptLine('req-3', 'j', routeHash)}\n`,
      'utf8',
    )
    const gap = await verifySolveReceipts({ receiptsPath: path, routeHash, jobName: 'j' })
    expect(gap.ok).toBe(false)
    expect(gap.problems.some((problem) => problem.includes('sequence'))).toBe(true)

    const wrongJob = await verifySolveReceipts({ receiptsPath: path, routeHash, jobName: 'other' })
    expect(wrongJob.ok).toBe(false)
    expect(wrongJob.problems.join('\n')).toContain('jobName')

    const wrongRoute = await verifySolveReceipts({
      receiptsPath: path,
      routeHash: 'f'.repeat(64),
      jobName: 'j',
    })
    expect(wrongRoute.ok).toBe(false)
    expect(wrongRoute.problems.join('\n')).toContain('routeHash')

    const missing = await verifySolveReceipts({
      receiptsPath: join(stateDir, 'absent.jsonl'),
      routeHash,
      jobName: 'j',
    })
    expect(missing.ok).toBe(false)
    expect(missing.problems.join('\n')).toContain('missing')
  })
})
