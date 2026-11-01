import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { WorkerStreamReceiver } from '../../src/execution/stream.js'
function frame(channel: number, text: string) {
  const h = Buffer.alloc(8)
  h[0] = channel
  h.writeUInt32BE(Buffer.byteLength(text), 4)
  return Buffer.concat([h, Buffer.from(text)])
}
function event(sequence: number) {
  return (
    JSON.stringify({
      protocol: 'dsh-evolve-le/worker-event/v1',
      executionId: 'execution',
      sequence,
      sessionId: 'main',
      event: { type: 'step/start' },
    }) + '\n'
  )
}
describe('external bounded worker event receiver', () => {
  it('persists split frames, replays identical prefixes and rejects sequence gaps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-stream-')),
      store = await openObjectStore(join(root, 'cas'))
    try {
      const options = {
        root: join(root, 'stream'),
        store,
        executionId: 'execution',
        maxBytes: 4096,
        maxFrameBytes: 1024,
      }
      const receiver = await WorkerStreamReceiver.open(options),
        bytes = frame(1, event(1))
      await receiver.write(bytes.subarray(0, 3))
      await receiver.write(bytes.subarray(3))
      await receiver.end()
      const reopened = await WorkerStreamReceiver.open(options)
      await reopened.write(bytes)
      await reopened.write(frame(1, event(2)))
      await reopened.end()
      expect((await reopened.artifacts()).length).toBe(2)
      const bad = await WorkerStreamReceiver.open(options)
      await expect(bad.write(frame(1, event(4)))).rejects.toThrow(/sequence/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('rejects unfinished frames and output flooding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-stream-')),
      store = await openObjectStore(join(root, 'cas'))
    try {
      const options = {
        root: join(root, 'stream'),
        store,
        executionId: 'execution',
        maxBytes: 1024,
        maxFrameBytes: 512,
      }
      const receiver = await WorkerStreamReceiver.open(options)
      await receiver.write(Buffer.from([1, 0]))
      await expect(receiver.end()).rejects.toThrow(/partial/)
      const other = await WorkerStreamReceiver.open({ ...options, root: join(root, 'other') })
      await expect(other.write(frame(2, 'x'.repeat(513)))).rejects.toThrow(/limit/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
