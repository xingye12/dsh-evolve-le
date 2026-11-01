import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import {
  assertOwnerGeneration,
  reclaimActionEndpoint,
  readKernelLockOwner,
  type OwnerGeneration,
} from '../../src/execution/owner.js'
function start(root: string) {
  return spawn(
    '/usr/bin/flock',
    [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      '75',
      '--no-fork',
      join(root, 'owner.lock'),
      process.execPath,
      resolve('packages/dsh-evolve-le/tests/fixtures/execution-owner.mjs'),
      root,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
}
describe('kernel-owned supervisor fencing', () => {
  it('prevents live-owner takeover and fences the old generation after real SIGKILL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'execution-owner-'))
    let first: ReturnType<typeof start> | undefined, third: ReturnType<typeof start> | undefined
    const ready = (child: ReturnType<typeof start>) =>
      new Promise<OwnerGeneration>((r, j) => {
        child.stdout.once('data', (b) => {
          try {
            r(JSON.parse(String(b)))
          } catch (e) {
            j(e)
          }
        })
        child.once('error', j)
        child.once('close', (code, signal) =>
          j(new Error(`owner exited before ready: ${code}/${signal}`)),
        )
      })
    try {
      expect(await readKernelLockOwner(root)).toBeNull()
      first = start(root)
      const owner1 = await ready(first)
      expect(owner1.generation).toBe(1)
      expect(await readKernelLockOwner(root)).toBe(first.pid)
      await assertOwnerGeneration(root, owner1)
      await expect(reclaimActionEndpoint(root, owner1)).rejects.toThrow(/kernel flock/)
      const second = start(root),
        [code] = await once(second, 'close')
      expect(code).toBe(75)
      first.kill('SIGKILL')
      await once(first, 'close')
      expect(await readKernelLockOwner(root)).toBeNull()
      third = start(root)
      const owner2 = await ready(third)
      expect(owner2.generation).toBe(2)
      await expect(assertOwnerGeneration(root, owner1)).rejects.toThrow(/fenced/)
      await assertOwnerGeneration(root, owner2)
    } finally {
      first?.kill('SIGKILL')
      if (third && third.exitCode === null && third.signalCode === null) {
        third.kill('SIGKILL')
        await once(third, 'close')
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
