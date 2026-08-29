/**
 * Remote model gateway contract tests (Gate 8, specs/05 §7): the networked
 * proposer route runs the TCB proxy in the controller process. The sandbox
 * worker stays networkless — its model adapter is a Unix socket client — and
 * the proxy is the only holder of the credential. These tests pin the
 * firewall contract before the implementation:
 *
 *  - locked route/endpoint/model/params on every outbound request;
 *  - sequential requestId receipts with content REDACTED (sha256 only);
 *  - usage from the API when reported, deterministic accounting otherwise;
 *  - hard budget stops that refuse atomically and still append an error
 *    receipt (no silent continue);
 *  - upstream HTTP errors and timeouts become error receipts, never crashes
 *    and never content;
 *  - the credential appears in the Authorization header and NOWHERE else;
 *  - controller-side receipt-chain verification against the worker transcript
 *    (prompt/response hash equality, requestId sequence, no error receipts).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import {
  openRemoteModelProxy,
  remoteRoutePlanHash,
  verifyRemoteReceipts,
  type RemoteRoutePlan,
} from '../src/proposer/remote-gateway.js'
import { openRemoteModel } from '../src/proposer/remote-model.js'
import { tokenCount } from '../src/proposer/gateway.js'

const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

const PLAN: RemoteRoutePlan = {
  routeId: 'deepseek/zen-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'deepseek-v4-flash',
  temperature: 0,
  maxOutputTokens: 512,
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
}

/** Upstream stand-in capturing every request it serves. */
class FakeUpstream {
  readonly requests: Array<{ auth: string | undefined; url: string; body: Record<string, unknown> }>
  private readonly server: Server
  private behavior: (body: Record<string, unknown>) => { status: number; payload: unknown }

  constructor() {
    this.requests = []
    this.behavior = () => ({ status: 200, payload: {} })
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const body = JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>
        this.requests.push({
          auth: req.headers['authorization'],
          url: req.url ?? '',
          body,
        })
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

async function fresh(): Promise<{ dir: string; socketPath: string; receiptsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'remote-gw-'))
  workRoots.push(dir)
  return { dir, socketPath: join(dir, 'gw.sock'), receiptsPath: join(dir, 'receipts.jsonl') }
}

const REQUEST = (userText: string) => ({
  sections: [{ name: 'tcb:proposal-policy', order: 0, text: 'policy text' }],
  userText,
})

describe('remote model gateway: TCB proxy firewall (specs/05 §7)', () => {
  it('serves the socket protocol with a locked route and redacted receipts', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => ({
      status: 200,
      payload: {
        choices: [{ message: { content: '```json\n{"actions":[]}\n```' } }],
        usage: { prompt_tokens: 41, completion_tokens: 7 },
      },
    }))
    const { socketPath, receiptsPath, dir } = await fresh()
    const proxy = openRemoteModelProxy({
      socketPath,
      receiptsPath,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-credential-value',
    })
    try {
      const model = openRemoteModel({ socketPath })
      const first = await model.complete(REQUEST('first turn'))
      const second = await model.complete(REQUEST('second turn'))
      expect(first).toContain('"actions"')
      expect(second).toContain('"actions"')

      // Every outbound request: locked method/path/body and the bearer header.
      expect(upstream.requests).toHaveLength(2)
      for (const request of upstream.requests) {
        expect(request.url).toBe('/v1/chat/completions')
        expect(request.auth).toBe('Bearer sk-SECRET-credential-value')
        expect(request.body['model']).toBe(PLAN.model)
        expect(request.body['temperature']).toBe(PLAN.temperature)
        expect(request.body['max_tokens']).toBe(PLAN.maxOutputTokens)
        const messages = request.body['messages'] as { role: string; content: string }[]
        expect(messages.length).toBeGreaterThan(0)
      }

      await proxy.close()
      const receiptLines = (await readFile(receiptsPath, 'utf8')).trim().split('\n')
      expect(receiptLines).toHaveLength(2)
      const receipts = receiptLines.map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(receipts[0]!['requestId']).toBe('req-1')
      expect(receipts[1]!['requestId']).toBe('req-2')
      expect(receipts.map((r) => r['ok'])).toEqual([true, true])
      expect(receipts[0]!['route']).toBe(PLAN.routeId)
      expect(receipts[0]!['routeHash']).toBe(remoteRoutePlanHash({ ...PLAN, baseUrl }))
      expect(receipts[0]!['modelReportedUsage']).toBe(true)
      // API-reported tokens win over the character estimate.
      expect(receipts[0]!['promptTokens']).toBe(41)
      expect(receipts[0]!['completionTokens']).toBe(7)
      expect(receipts[0]!['costUsdMicros']).toBe(41 * 3 + 7 * 15)

      // REDACTION: no prompt text, no response text, no credential anywhere.
      const raw = await readFile(receiptsPath, 'utf8')
      expect(raw).not.toContain('sk-SECRET-credential-value')
      expect(raw).not.toContain('first turn')
      expect(raw).not.toContain('second turn')
      expect(raw).not.toContain('"actions"')
      expect(typeof receipts[0]!['promptSha256']).toBe('string')
      expect(typeof receipts[0]!['responseSha256']).toBe('string')

      const usage = proxy.usage()
      expect(usage.requests).toBe(2)
      expect(usage.promptTokens).toBe(82)
      expect(usage.costUsdMicros).toBe(2 * (41 * 3 + 7 * 15))
      expect(dir.length).toBeGreaterThan(0)
    } finally {
      await proxy.close().catch(() => undefined)
      await upstream.close()
    }
  })

  it('falls back to deterministic token accounting when the API reports no usage', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => ({
      status: 200,
      payload: { choices: [{ message: { content: 'ok' } }] },
    }))
    const { socketPath, receiptsPath } = await fresh()
    const proxy = openRemoteModelProxy({
      socketPath,
      receiptsPath,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    try {
      const model = openRemoteModel({ socketPath })
      const request = REQUEST('accounting fallback')
      const response = await model.complete(request)
      await proxy.close()
      const receipt = JSON.parse(
        (await readFile(receiptsPath, 'utf8')).trim().split('\n')[0]!,
      ) as Record<string, unknown>
      expect(receipt['modelReportedUsage']).toBe(false)
      expect(receipt['completionTokens']).toBe(tokenCount('ok'))
      expect(response).toBe('ok')
    } finally {
      await proxy.close().catch(() => undefined)
      await upstream.close()
    }
  })

  it('rejects empty model content as a failed request, never a receipt-worthy turn', async () => {
    // Reasoning models can burn the whole max_tokens on reasoning_content.
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => ({
      status: 200,
      payload: {
        choices: [
          { message: { content: '', reasoning_content: 'thinking…' }, finish_reason: 'length' },
        ],
        usage: { prompt_tokens: 88, completion_tokens: 32 },
      },
    }))
    const { socketPath, receiptsPath } = await fresh()
    const proxy = openRemoteModelProxy({
      socketPath,
      receiptsPath,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    try {
      const model = openRemoteModel({ socketPath })
      await expect(model.complete(REQUEST('empty content'))).rejects.toThrow(/empty content/)
      await proxy.close()
      const receipt = JSON.parse(
        (await readFile(receiptsPath, 'utf8')).trim().split('\n')[0]!,
      ) as Record<string, unknown>
      expect(receipt['ok']).toBe(false)
      // The failed request is not billed into the usage ledger.
      expect(proxy.usage().requests).toBe(0)
    } finally {
      await proxy.close().catch(() => undefined)
      await upstream.close()
    }
  })

  it('refuses past the request budget atomically and still appends an error receipt', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => ({
      status: 200,
      payload: { choices: [{ message: { content: 'fine' } }] },
    }))
    const { socketPath, receiptsPath } = await fresh()
    const proxy = openRemoteModelProxy({
      socketPath,
      receiptsPath,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
      budget: { maxRequests: 1, maxTotalTokens: 1_000_000, maxCostUsdMicros: 1_000_000 },
    })
    try {
      const model = openRemoteModel({ socketPath })
      await model.complete(REQUEST('allowed'))
      await expect(model.complete(REQUEST('refused'))).rejects.toThrow(/budget/)
      await proxy.close()
      const receipts = (await readFile(receiptsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(receipts).toHaveLength(2)
      expect(receipts[1]!['ok']).toBe(false)
      expect(String(receipts[1]!['error'])).toMatch(/budget/)
      // The refused request never reached the upstream.
      expect(upstream.requests).toHaveLength(1)
    } finally {
      await proxy.close().catch(() => undefined)
      await upstream.close()
    }
  })

  it('turns upstream HTTP errors and timeouts into error receipts without content', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(() => ({ status: 500, payload: { error: 'boom' } }))
    const { socketPath, receiptsPath } = await fresh()
    const proxy = openRemoteModelProxy({
      socketPath,
      receiptsPath,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-x',
    })
    try {
      const model = openRemoteModel({ socketPath })
      await expect(model.complete(REQUEST('http error'))).rejects.toThrow(/500/)
      await proxy.close()
      const receipt = JSON.parse(
        (await readFile(receiptsPath, 'utf8')).trim().split('\n')[0]!,
      ) as Record<string, unknown>
      expect(receipt['ok']).toBe(false)
      expect(receipt['httpStatus']).toBe(500)
      const raw = await readFile(receiptsPath, 'utf8')
      expect(raw).not.toContain('http error')
    } finally {
      await proxy.close().catch(() => undefined)
      await upstream.close()
    }

    // Timeout: the upstream accepts and never answers.
    const hanging = createServer((req, _res) => {
      req.resume()
      // deliberately no response
    })
    await new Promise<void>((resolveListen) => {
      hanging.listen(0, '127.0.0.1', () => resolveListen())
    })
    const address = hanging.address() as AddressInfo
    const timeoutDir = await fresh()
    const proxy2 = openRemoteModelProxy({
      socketPath: timeoutDir.socketPath,
      receiptsPath: timeoutDir.receiptsPath,
      plan: { ...PLAN, baseUrl: `http://127.0.0.1:${String(address.port)}/v1` },
      credential: 'sk-x',
      requestTimeoutMs: 150,
    })
    try {
      const model = openRemoteModel({ socketPath: timeoutDir.socketPath })
      await expect(model.complete(REQUEST('will time out'))).rejects.toThrow(/timed out/i)
      await proxy2.close()
      const receipt = JSON.parse(
        (await readFile(timeoutDir.receiptsPath, 'utf8')).trim().split('\n')[0]!,
      ) as Record<string, unknown>
      expect(receipt['ok']).toBe(false)
      expect(receipt['timedOut']).toBe(true)
    } finally {
      await proxy2.close().catch(() => undefined)
      await new Promise<void>((resolveClose) => hanging.close(() => resolveClose()))
    }
  })

  it('verifies the receipt chain against the worker transcript and fails closed', async () => {
    const upstream = new FakeUpstream()
    const baseUrl = await upstream.listen()
    const responses = ['response one', 'response two']
    upstream.serve(() => ({
      status: 200,
      payload: { choices: [{ message: { content: responses.shift() ?? 'x' } }] },
    }))
    const { socketPath, receiptsPath, dir } = await fresh()
    const plan = { ...PLAN, baseUrl }
    const proxy = openRemoteModelProxy({
      socketPath,
      receiptsPath,
      plan,
      credential: 'sk-x',
    })
    const transcriptPath = join(dir, 'transcript.jsonl')
    try {
      const model = openRemoteModel({ socketPath })
      const turns: string[] = []
      for (const text of ['turn one', 'turn two']) {
        const responseText = await model.complete(REQUEST(text))
        turns.push(
          JSON.stringify({
            kind: 'turn',
            seq: turns.length + 1,
            requestId: `req-${String(turns.length + 1)}`,
            promptSha256: 'filled-below',
            responseText,
          }),
        )
      }
      await proxy.close()
      const receipts = (await readFile(receiptsPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      // The transcript's prompt hashes must equal the receipt prompt hashes.
      const withPrompts = turns.map((line, index) => {
        const record = JSON.parse(line) as Record<string, unknown>
        record['promptSha256'] = receipts[index]!['promptSha256']
        return JSON.stringify(record)
      })
      await writeFileLines(transcriptPath, withPrompts)

      const good = await verifyRemoteReceipts({
        receiptsPath,
        transcriptPath,
        routeHash: remoteRoutePlanHash(plan),
      })
      expect(good.ok).toBe(true)
      expect(good.requests).toBe(2)

      // Tampered response text → hash mismatch.
      const tampered = withPrompts.map((line) =>
        line.replace('response two', 'response two tampered'),
      )
      await writeFileLines(transcriptPath, tampered)
      const bad = await verifyRemoteReceipts({
        receiptsPath,
        transcriptPath,
        routeHash: remoteRoutePlanHash(plan),
      })
      expect(bad.ok).toBe(false)
      expect(bad.problems.some((problem) => problem.includes('responseSha256'))).toBe(true)

      // Wrong route hash → refuse.
      const wrongRoute = await verifyRemoteReceipts({
        receiptsPath,
        transcriptPath,
        routeHash: 'f'.repeat(64),
      })
      expect(wrongRoute.ok).toBe(false)
    } finally {
      await proxy.close().catch(() => undefined)
      await upstream.close()
    }
  })

  it('rejects a receipt chain with gaps or error receipts', async () => {
    const { receiptsPath, dir } = await fresh()
    const receipt = (requestId: string, ok: boolean): string =>
      JSON.stringify({
        schemaVersion: 2,
        gatewayVersion: 'dsh-evolve-le/model-gateway/v1',
        requestId,
        route: PLAN.routeId,
        routeHash: remoteRoutePlanHash(PLAN),
        promptSha256: 'a'.repeat(64),
        responseSha256: 'b'.repeat(64),
        promptTokens: 1,
        completionTokens: 1,
        costUsdMicros: 18,
        ok,
        modelReportedUsage: true,
      })
    const transcriptPath = join(dir, 't.jsonl')
    const turn = (requestId: string, text: string): string =>
      JSON.stringify({
        kind: 'turn',
        seq: 1,
        requestId,
        promptSha256: 'a'.repeat(64),
        responseText: text,
      })
    // sha256('x') so responseSha256 'b…' mismatches unless text matches; craft
    // the gap case with matching hashes by leaving responseSha256 consistent.
    const { createHash } = await import('node:crypto')
    const textFor = 'x'
    const responseSha = createHash('sha256').update(textFor, 'utf8').digest('hex')
    const matchingReceipt = (requestId: string): string =>
      JSON.stringify({
        schemaVersion: 2,
        gatewayVersion: 'dsh-evolve-le/model-gateway/v1',
        requestId,
        route: PLAN.routeId,
        routeHash: remoteRoutePlanHash(PLAN),
        promptSha256: 'a'.repeat(64),
        responseSha256: responseSha,
        promptTokens: 1,
        completionTokens: 1,
        costUsdMicros: 18,
        ok: true,
        modelReportedUsage: true,
      })

    // Gap: req-1 then req-3.
    await writeFileLines(receiptsPath, [matchingReceipt('req-1'), matchingReceipt('req-3')])
    await writeFileLines(transcriptPath, [turn('req-1', textFor), turn('req-3', textFor)])
    const gap = await verifyRemoteReceipts({
      receiptsPath,
      transcriptPath,
      routeHash: remoteRoutePlanHash(PLAN),
    })
    expect(gap.ok).toBe(false)
    expect(gap.problems.some((problem) => problem.includes('sequence'))).toBe(true)

    // Error receipt present → the proposal cannot be admitted.
    await writeFileLines(receiptsPath, [receipt('req-1', false)])
    await writeFileLines(transcriptPath, [])
    const errored = await verifyRemoteReceipts({
      receiptsPath,
      transcriptPath,
      routeHash: remoteRoutePlanHash(PLAN),
    })
    expect(errored.ok).toBe(false)
  })
})

async function writeFileLines(path: string, lines: readonly string[]): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8')
}

beforeAll(() => {
  // Keep socket paths short (AF_UNIX 108-byte limit) — tmpdir is fine.
  expect(tmpdir().length).toBeLessThan(90)
})
