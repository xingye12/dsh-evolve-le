import { mkdtemp, chmod, mkdir, symlink, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { prepareSupervisorDirectory } from '../../src/execution/host-directory.js'
it('creates private host state and refuses writable or symbolic ancestors before launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-directory-'))
  try {
    await prepareSupervisorDirectory(join(root, 'private', 'owner'))
    expect((await stat(join(root, 'private', 'owner'))).mode & 0o077).toBe(0)
    await mkdir(join(root, 'unsafe'))
    await chmod(join(root, 'unsafe'), 0o777)
    await expect(prepareSupervisorDirectory(join(root, 'unsafe', 'owner'))).rejects.toThrow(
      /unsafe/,
    )
    await symlink(join(root, 'private'), join(root, 'alias'))
    await expect(prepareSupervisorDirectory(join(root, 'alias', 'owner'))).rejects.toThrow(/unsafe/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
