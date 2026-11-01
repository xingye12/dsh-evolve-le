import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openActionRpc, callActionRpc } from '../../src/execution/rpc.js'
describe('action-scoped bounded IPC', () => {
  it('binds the endpoint to one execution and rejects revoked calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-rpc-'))
    const socketPath = join(root, 'action.sock')
    let calls = 0
    const rpc = await openActionRpc({
      socketPath,
      executionId: 'execution-1',
      socketUid: process.getuid!(),
      socketGid: process.getgid!(),
      maxFrameBytes: 4096,
      maxConnections: 2,
      async handler(request) {
        calls++
        return { value: request.args }
      },
    })
    try {
      expect(
        await callActionRpc({
          socketPath,
          executionId: 'execution-1',
          invocationId: '1',
          method: 'shell',
          args: { command: 'echo hi' },
        }),
      ).toEqual({ value: { command: 'echo hi' } })
      await expect(
        callActionRpc({
          socketPath,
          executionId: 'other',
          invocationId: '2',
          method: 'shell',
          args: {},
        }),
      ).rejects.toThrow(/execution/)
      rpc.revoke()
      await expect(
        callActionRpc({
          socketPath,
          executionId: 'execution-1',
          invocationId: '3',
          method: 'shell',
          args: {},
        }),
      ).rejects.toThrow(/revoked/)
      expect(calls).toBe(1)
    } finally {
      await Promise.all([rpc.close(), rpc.close()])
      await rpc.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('limits frame bytes before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-rpc-'))
    const socketPath = join(root, 'action.sock')
    let calls = 0
    const rpc = await openActionRpc({
      socketPath,
      executionId: 'execution',
      socketUid: process.getuid!(),
      socketGid: process.getgid!(),
      maxFrameBytes: 256,
      maxConnections: 1,
      async handler() {
        calls++
        return null
      },
    })
    try {
      await expect(
        callActionRpc({
          socketPath,
          executionId: 'execution',
          invocationId: '1',
          method: 'shell',
          args: { command: 'x'.repeat(1024) },
          timeoutMs: 1000,
        }),
      ).rejects.toThrow()
      expect(calls).toBe(0)
    } finally {
      await Promise.all([rpc.close(), rpc.close()])
      await rpc.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
