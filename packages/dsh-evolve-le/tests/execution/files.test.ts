import { mkdtemp, mkdir, writeFile, symlink, link, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  readCapabilityFile,
  writeCapabilityFile,
  listCapabilityDirectory,
} from '../../src/execution/files.js'
describe('host file capabilities over untrusted workspace', () => {
  it('uses the same tree as shell while rejecting path, symlink and hardlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workspace-files-'))
    try {
      const tree = join(root, 'workspace')
      await mkdir(tree)
      await writeFile(join(root, 'secret'), 'keep')
      await writeCapabilityFile(tree, 'child/src/index.ts', Buffer.from('source'), 100)
      expect((await readCapabilityFile(tree, 'child/src/index.ts', 100)).toString()).toBe('source')
      expect(await listCapabilityDirectory(tree, 'child/src', 20)).toEqual(['index.ts'])
      await symlink(root, join(tree, 'escape'))
      await expect(
        writeCapabilityFile(tree, 'escape/secret', Buffer.from('bad'), 100),
      ).rejects.toThrow()
      await expect(readCapabilityFile(tree, 'escape/secret', 100)).rejects.toThrow()
      await link(join(root, 'secret'), join(tree, 'linked'))
      await expect(writeCapabilityFile(tree, 'linked', Buffer.from('bad'), 100)).rejects.toThrow()
      await expect(
        writeCapabilityFile(tree, '../secret', Buffer.from('bad'), 100),
      ).rejects.toThrow()
      expect(await readFile(join(root, 'secret'), 'utf8')).toBe('keep')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
