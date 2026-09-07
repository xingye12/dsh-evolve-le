/**
 * Solve-client abort contract (ADR-030, Task: cancel reaches the wire): when
 * the native agent loop's phase signal aborts (session/cancel, wall-clock
 * deadline), the adapter threads that signal into `complete()`, and the
 * client must DESTROY the in-flight HTTPS request — the gateway sees the
 * connection drop instead of a reply the capsule will never read, and the
 * capsule's unload invariant (no live sockets after teardown) still holds.
 *
 * Real TLS, real request, real abort: the server holds the response open
 * until it observes the client disconnect.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { openSolveGatewayClient } from '../src/acp/solve-client.js'

const exec = promisify(execFile)

const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

let caDir = ''

beforeAll(async () => {
  caDir = await mkdtemp(join(tmpdir(), 'solve-client-abort-ca-'))
  workRoots.push(caDir)
  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(caDir, 'server.key'),
    '-out',
    join(caDir, 'server.crt'),
    '-subj',
    '/CN=127.0.0.1',
    '-days',
    '2',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ])
}, 30_000)

const ROUTE_HASH = 'a'.repeat(64)
const TOKEN = 'b'.repeat(64)

describe('solve-client abort signal', () => {
  it('destroys the in-flight HTTPS request when the signal aborts', async () => {
    let sawRequest = false
    let sawDisconnect: (() => void) | undefined
    const disconnected = new Promise<void>((resolve) => {
      sawDisconnect = resolve
    })
    const server = createHttpsServer(
      {
        key: await readFile(join(caDir, 'server.key')),
        cert: await readFile(join(caDir, 'server.crt')),
      },
      (req, res) => {
        sawRequest = true
        // Hold the reply open; the test never answers. If the client destroys
        // the request, the socket closes underneath us.
        req.socket.on('close', () => sawDisconnect?.())
        res.on('close', () => sawDisconnect?.())
      },
    )
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen())
    })
    const address = server.address() as AddressInfo
    const previousCa = process.env['SSL_CERT_FILE']
    process.env['SSL_CERT_FILE'] = join(caDir, 'server.crt')
    try {
      const client = openSolveGatewayClient({
        url: `https://127.0.0.1:${String(address.port)}`,
        token: TOKEN,
        routeHash: ROUTE_HASH,
        timeoutMs: 60_000,
      })
      const controller = new AbortController()
      const pending = client.complete(
        { sections: [], userText: 'hang' },
        60_000,
        { signal: controller.signal },
      )
      // Let the request reach the server, then abort — the same ordering as
      // the agent loop's phase signal firing mid-request.
      await new Promise<void>((resolveTick) => setTimeout(resolveTick, 250))
      expect(sawRequest).toBe(true)
      controller.abort()
      await expect(pending).rejects.toThrow(/abort/i)
      // The server observed the disconnect: the wire is really torn down.
      await disconnected
      // No live sockets may survive the abort (the capsule's unload
      // invariant counts process handles after teardown).
      expect(server.listening).toBe(true)
    } finally {
      if (previousCa === undefined) delete process.env['SSL_CERT_FILE']
      else process.env['SSL_CERT_FILE'] = previousCa
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const client = openSolveGatewayClient({
      url: 'https://127.0.0.1:1',
      token: TOKEN,
      routeHash: ROUTE_HASH,
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      client.complete({ sections: [], userText: 'never sent' }, 5_000, {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i)
  })

  it('completes normally when the signal never aborts', async () => {
    const server = createHttpsServer(
      {
        key: await readFile(join(caDir, 'server.key')),
        cert: await readFile(join(caDir, 'server.crt')),
      },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            type: 'ok',
            requestId: 'r1',
            responseText: 'done',
            promptTokens: 3,
            completionTokens: 2,
            costUsdMicros: 9,
            routeHash: ROUTE_HASH,
          }),
        )
      },
    )
    await new Promise<void>((resolveListen) => {
      server.listen(0, '127.0.0.1', () => resolveListen())
    })
    const address = server.address() as AddressInfo
    const previousCa = process.env['SSL_CERT_FILE']
    process.env['SSL_CERT_FILE'] = join(caDir, 'server.crt')
    try {
      const client = openSolveGatewayClient({
        url: `https://127.0.0.1:${String(address.port)}`,
        token: TOKEN,
        routeHash: ROUTE_HASH,
      })
      const controller = new AbortController()
      const reply = await client.complete({ sections: [], userText: 'go' }, 5_000, {
        signal: controller.signal,
      })
      expect(reply).toMatchObject({ ok: true, responseText: 'done', promptTokens: 3 })
    } finally {
      if (previousCa === undefined) delete process.env['SSL_CERT_FILE']
      else process.env['SSL_CERT_FILE'] = previousCa
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    }
  })
})
