import { mkdtemp, mkdir, writeFile, symlink, link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { captureBoundedTree, readCapturedTree } from '../../src/execution/snapshot.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { openObjectStore } from '../../src/state/object-store.js'
it('captures bounded binary artifacts and rejects links and aggregate overflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-tree-'))
  const source = join(root, 'output')
  const store = await openObjectStore(join(root, 'cas'))
  const options = { root: source, store, limits: { fileBytes: 16, bytes: 20, inodes: 8 } }
  try {
    await mkdir(source)
    await writeFile(join(source, 'binary'), Buffer.from([0, 255, 1]))
    const captured = await captureBoundedTree(options)
    expect(captured.totalBytes).toBe(3)
    const ref = await store.put(Buffer.from(canonicalJson(captured)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
    await expect(
      readCapturedTree(store, ref, { bytes: 2, fileBytes: 16, inodes: 8 }),
    ).rejects.toThrow(/limit/)
    expect(await readCapturedTree(store, ref, options.limits)).toEqual(captured)
    await symlink('/etc/passwd', join(source, 'escape'))
    await expect(captureBoundedTree(options)).rejects.toThrow()
    await rm(join(source, 'escape'))
    await link(join(source, 'binary'), join(source, 'hard'))
    await expect(captureBoundedTree(options)).rejects.toThrow(/link/)
    await rm(join(source, 'hard'))
    await writeFile(join(source, 'a'), Buffer.alloc(16))
    await writeFile(join(source, 'b'), Buffer.alloc(16))
    await expect(captureBoundedTree(options)).rejects.toThrow(/limit/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
