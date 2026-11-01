/** Bounded HTTP client for the local Unix Docker API. No host shell or CLI. */
import { request as httpRequest } from 'node:http'
import { ExecutionError } from './types.js'
export class DockerApiError extends ExecutionError {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly endpoint: string,
    message: string,
  ) {
    super(`Docker ${method} ${endpoint} HTTP ${status}: ${message}`)
  }
}
export interface DockerResponse {
  status: number
  body: Buffer
}
export interface DockerEngine {
  stream?(
    method: string,
    path: string,
    options: {
      onChunk: (chunk: Buffer) => Promise<void>
      timeoutMs: number
      maxBytes: number
      signal?: AbortSignal
    },
  ): Promise<void>
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
  ): Promise<DockerResponse>
  json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
  ): Promise<T>
}
export function localDockerEngine(
  socketPath = '/var/run/docker.sock',
  apiVersion = '1.54',
): DockerEngine {
  if (!socketPath.startsWith('/') || !/^1\.\d+$/.test(apiVersion))
    throw new ExecutionError('invalid Docker endpoint')
  const request: DockerEngine['request'] = async (method, path, body, options = {}) => {
    if (!path.startsWith('/') || path.includes('\0'))
      throw new ExecutionError('invalid Docker API path')
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath,
          path: `/v${apiVersion}${path}`,
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : undefined,
          signal: options.signal,
        },
        (res) => {
          const chunks: Buffer[] = []
          let length = 0
          res.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > (options.maxBytes ?? 16 * 1024 * 1024)) {
              clearTimeout(timer)
              reject(new ExecutionError('Docker response byte limit exceeded'))
              res.destroy()
              req.destroy()
              return
            }
            chunks.push(chunk)
          })
          res.on('error', reject)
          res.on('end', () => {
            clearTimeout(timer)
            const bytes = Buffer.concat(chunks)
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              reject(
                new DockerApiError(status, method, path, bytes.toString('utf8').slice(0, 1024)),
              )
              return
            }
            resolve({ status, body: bytes })
          })
        },
      )
      // Absolute deadline, not just idle socket timeout.
      const timer = setTimeout(() => {
        reject(new ExecutionError('Docker API timeout; reconcile original operation before retry'))
        req.destroy()
      }, options.timeoutMs ?? 30_000)
      req.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      req.end(payload)
    })
  }
  return {
    request,
    async stream(method, path, options) {
      await new Promise<void>((resolveRun, reject) => {
        const req = httpRequest(
          { socketPath, path: `/v${apiVersion}${path}`, method, signal: options.signal },
          (res) => {
            if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
              res.resume()
              reject(new DockerApiError(res.statusCode ?? 0, method, path, 'stream rejected'))
              return
            }
            void (async () => {
              let bytes = 0
              for await (const chunk of res) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                bytes += buffer.length
                if (bytes > options.maxBytes)
                  throw new ExecutionError('Docker stream total byte limit')
                await options.onChunk(buffer)
              }
              resolveRun()
            })().catch((error) => {
              res.destroy()
              req.destroy()
              reject(error)
            })
          },
        )
        const timer = setTimeout(() => {
          req.destroy()
          reject(new ExecutionError('Docker stream deadline'))
        }, options.timeoutMs)
        req.on('error', reject)
        req.on('close', () => clearTimeout(timer))
        req.end()
      })
    },
    async json<T>(
      method: string,
      path: string,
      body?: unknown,
      options?: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal },
    ): Promise<T> {
      const r = await request(method, path, body, options)
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.body)) as T
      } catch {
        throw new ExecutionError('invalid Docker JSON response')
      }
    },
  }
}
/** Docker multiplex stream: preserve bounded stdout/stderr separately. */
export function decodeDockerStream(
  bytes: Buffer,
  maxBytes: number,
): { stdout: Buffer; stderr: Buffer } {
  let offset = 0
  let total = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new ExecutionError('truncated Docker stream frame')
    const channel = bytes[offset]
    const size = bytes.readUInt32BE(offset + 4)
    if (
      (channel !== 1 && channel !== 2) ||
      bytes.subarray(offset + 1, offset + 4).some((v) => v !== 0) ||
      size > bytes.length - offset - 8
    )
      throw new ExecutionError('invalid Docker stream frame')
    total += size
    if (total > maxBytes) throw new ExecutionError('Docker stream output limit')
    ;(channel === 1 ? stdout : stderr).push(bytes.subarray(offset + 8, offset + 8 + size))
    offset += 8 + size
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}
