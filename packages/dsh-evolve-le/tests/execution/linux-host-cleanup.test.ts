import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { LinuxExecutionHost } from '../../src/execution/linux-host.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { makeSpec } from './fixtures.js'
it('never treats an inaccessible cgroup path as an absent released resource', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-cleanup-'))
  try {
    const store = await openObjectStore(join(root, 'cas')),
      loop = join(root, 'loop')
    await symlink(loop, loop)
    const host = new LinuxExecutionHost({
      root: join(root, 'host'),
      cgroupRoot: loop,
      store,
      engine: {
        async json() {
          throw Error('not used')
        },
        async request() {
          throw Error('not used')
        },
      },
      security: { seccompJson: '{}', apparmorProfile: 'test', cgroupParent: 'test' },
      actions: {
        async quiesce() {},
        async resume() {},
        async revoke() {},
        async cancelChildren() {},
        async close() {},
        async artifacts() {
          return []
        },
      },
    })
    await expect(host.cleanup(makeSpec())).rejects.toMatchObject({ code: 'ELOOP' })
    await rm(loop)
    const released = await host.cleanup(makeSpec())
    expect(JSON.parse((await store.read(released)).toString('utf8')).cgroupRemoved).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
