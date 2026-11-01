/** Versioned action-only IPC. No endpoint, container or host path overrides. */
import { createConnection, createServer, type Socket } from 'node:net'
import { chmod, chown, lstat, unlink } from 'node:fs/promises'
import { canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { assertExact, ExecutionError } from './types.js'
export const ACTION_RPC_PROTOCOL = 'dsh-evolve-le/action-rpc/v1' as const
const METHODS = [
  'model',
  'mutation-count',
  'read-input',
  'list-input',
  'write-child',
  'snapshot',
  'test-child',
  'finish',
  'shell',
  'cancel-shell',
  'event',
] as const
export interface ActionRpcRequest {
  protocol: typeof ACTION_RPC_PROTOCOL
  executionId: string
  invocationId: string
  method: (typeof METHODS)[number]
  args: unknown
}
function validateRequest(value: unknown, executionId: string): asserts value is ActionRpcRequest {
  assertExact(value, ['protocol', 'executionId', 'invocationId', 'method', 'args'])
  if (value.protocol !== ACTION_RPC_PROTOCOL || value.executionId !== executionId)
    throw new ExecutionError('IPC execution/protocol mismatch')
  if (
    typeof value.invocationId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value.invocationId) ||
    !METHODS.includes(value.method as (typeof METHODS)[number])
  )
    throw new ExecutionError('invalid IPC invocation/method')
}
export async function openActionRpc(options: {
  socketPath: string
  executionId: string
  socketUid: number
  socketGid: number
  maxFrameBytes: number
  maxConnections: number
  handler: (request: ActionRpcRequest, signal: AbortSignal) => Promise<unknown>
}) {
  if (
    !Number.isSafeInteger(options.maxFrameBytes) ||
    options.maxFrameBytes < 128 ||
    !Number.isSafeInteger(options.maxConnections) ||
    options.maxConnections < 1
  )
    throw new ExecutionError('invalid IPC limits')
  // Never unlink an existing endpoint belonging to a potentially live execution.
  if (await lstat(options.socketPath).catch(() => null))
    throw new ExecutionError('action endpoint already exists; reconcile owner first')
  const sockets = new Set<Socket>()
  let revoked = false
  const server = createServer((socket) => {
    if (sockets.size >= options.maxConnections) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    const controller = new AbortController()
    let chunks: Buffer[] = []
    let size = 0
    let dispatched = false
    let done = false
    const timeout = setTimeout(() => socket.destroy(), 30000)
    const reply = (value: unknown) => {
      const bytes = Buffer.from(canonicalJson(value) + '\n')
      if (bytes.length > options.maxFrameBytes) {
        socket.destroy()
        return
      }
      done = true
      socket.end(bytes)
    }
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(timeout)
      sockets.delete(socket)
      if (!done) controller.abort()
    })
    socket.on('data', (chunk: Buffer) => {
      if (dispatched) {
        socket.destroy()
        return
      }
      size += chunk.length
      if (size > options.maxFrameBytes) {
        socket.destroy()
        return
      }
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      const bytes = Buffer.concat(chunks)
      chunks = []
      const newline = bytes.indexOf(10)
      if (newline !== bytes.length - 1) {
        socket.destroy()
        return
      }
      let request: ActionRpcRequest
      try {
        if (revoked) throw new ExecutionError('action capability revoked')
        const value = parseCanonicalJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)),
        )
        validateRequest(value, options.executionId)
        request = value
      } catch (error) {
        reply({ ok: false, error: error instanceof Error ? error.message : 'invalid IPC frame' })
        return
      }
      dispatched = true
      clearTimeout(timeout)
      void options
        .handler(request, controller.signal)
        .then(
          (value) => {
            reply({ ok: true, value })
          },
          (error) =>
            reply({
              ok: false,
              error: error instanceof Error ? error.message.slice(0, 2048) : 'IPC operation failed',
            }),
        )
        .catch(() => socket.destroy())
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, resolve)
  })
  try {
    await chmod(options.socketPath, 0o660)
    await chown(options.socketPath, options.socketUid, options.socketGid)
  } catch (error) {
    await new Promise<void>((r) => server.close(() => r()))
    await unlink(options.socketPath).catch(() => undefined)
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    socketPath: options.socketPath,
    revoke() {
      revoked = true
    },
    close(): Promise<void> {
      // Cleanup and error/finally paths may race; all callers adopt one close.
      closing ??= (async () => {
        revoked = true
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await unlink(options.socketPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      })()
      return closing
    },
  }
}
export function callActionRpc(options: {
  socketPath: string
  executionId: string
  invocationId: string
  method: ActionRpcRequest['method']
  args: unknown
  timeoutMs?: number
  maxFrameBytes?: number
  signal?: AbortSignal
}): Promise<unknown> {
  if (options.signal?.aborted) return Promise.reject(new ExecutionError('IPC request aborted'))
  const request: ActionRpcRequest = {
    protocol: ACTION_RPC_PROTOCOL,
    executionId: options.executionId,
    invocationId: options.invocationId,
    method: options.method,
    args: options.args,
  }
  validateRequest(request, options.executionId)
  const frame = Buffer.from(canonicalJson(request) + '\n')
  const max = options.maxFrameBytes ?? 1048576
  if (frame.length > max) return Promise.reject(new ExecutionError('IPC request byte limit'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath)
    let chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const abort = () =>
      finish(new ExecutionError('IPC request aborted; external operation must reconcile'))
    const timer = setTimeout(
      () => finish(new ExecutionError('IPC request timeout; external operation must reconcile')),
      options.timeoutMs ?? 300000,
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    socket.on('connect', () => socket.write(frame))
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        finish(new ExecutionError('IPC response byte limit'))
        return
      }
      chunks.push(chunk)
      if (!chunk.includes(10)) return
      const bytes = Buffer.concat(chunks)
      chunks = []
      const end = bytes.indexOf(10)
      try {
        if (end !== bytes.length - 1) throw new ExecutionError('invalid IPC response framing')
        const value = parseCanonicalJson(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)),
        )
        if (value === null || typeof value !== 'object' || Array.isArray(value))
          throw new ExecutionError('invalid IPC response')
        if ((value as { ok?: unknown }).ok !== true)
          throw new ExecutionError(String((value as { error?: unknown }).error ?? 'IPC failed'))
        assertExact(value, ['ok', 'value'])
        finish(null, value.value)
      } catch (error) {
        finish(error instanceof Error ? error : new ExecutionError('invalid IPC response'))
      }
    })
    socket.on('error', (e) => finish(e))
    socket.on('close', () =>
      finish(new ExecutionError('IPC closed without result; reconcile invocation')),
    )
  })
}
