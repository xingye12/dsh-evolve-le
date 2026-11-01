import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  localDockerEngine,
  decodeDockerStream,
  DockerApiError,
} from '../../src/execution/docker-engine.js'
describe('bounded local Docker protocol', () => {
  it('uses the Unix API and preserves argv data without a host shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docker-api-'))
    const socket = join(root, 'engine.sock')
    let body = ''
    const server = createServer((req, res) => {
      req.on('data', (b) => {
        body += String(b)
      })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ path: req.url }))
      })
    })
    await new Promise<void>((r) => server.listen(socket, r))
    try {
      const engine = localDockerEngine(socket)
      expect(
        await engine.json('POST', '/containers/x/exec', {
          Cmd: ['bash', '-c', '$(touch /never-run)'],
        }),
      ).toEqual({ path: '/v1.54/containers/x/exec' })
      expect(JSON.parse(body).Cmd[2]).toBe('$(touch /never-run)')
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
      await rm(root, { recursive: true, force: true })
    }
  })
  it('bounds daemon responses and preserves ambiguous timeout as error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'docker-api-'))
    const socket = join(root, 'engine.sock')
    const server = createServer((req, res) => {
      if (req.url?.includes('wait')) return
      res.end('x'.repeat(100))
    })
    await new Promise<void>((r) => server.listen(socket, r))
    try {
      const engine = localDockerEngine(socket)
      await expect(engine.request('GET', '/large', undefined, { maxBytes: 16 })).rejects.toThrow(
        /limit/,
      )
      await expect(engine.request('GET', '/wait', undefined, { timeoutMs: 10 })).rejects.toThrow(
        /reconcile/,
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
      await rm(root, { recursive: true, force: true })
    }
  })
  it('separates Docker streams and rejects truncated or forged frames', () => {
    const frame = (stream: number, text: string) => {
      const header = Buffer.alloc(8)
      header[0] = stream
      header.writeUInt32BE(Buffer.byteLength(text), 4)
      return Buffer.concat([header, Buffer.from(text)])
    }
    const bytes = Buffer.concat([frame(1, 'out'), frame(2, 'error')])
    expect(decodeDockerStream(bytes, 100).stderr.toString()).toBe('error')
    expect(() => decodeDockerStream(bytes, 2)).toThrow(/limit/)
    expect(() => decodeDockerStream(bytes.subarray(0, -1), 100)).toThrow()
    expect(() => decodeDockerStream(frame(9, 'bad'), 100)).toThrow()
    expect(new DockerApiError(404, 'GET', '/x', 'missing').status).toBe(404)
  })
})
