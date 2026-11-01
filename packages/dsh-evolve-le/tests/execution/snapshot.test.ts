import { mkdtemp, mkdir, writeFile, symlink, link, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import {
  captureSourceSnapshot,
  readSourceSnapshot,
  materializeSourceSnapshot,
} from '../../src/execution/snapshot.js'
import { makeSpec } from './fixtures.js'
const roots: string[] = []
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'execution-snapshot-'))
  roots.push(root)
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'index.ts'), 'export const x = 1\n')
  const store = await openObjectStore(join(root, 'objects'))
  return { root, source, store }
}
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true })
})
describe('immutable no-follow source capture', () => {
  it('binds exact bytes, survives live drift and materializes only verified CAS', async () => {
    const { root, source, store } = await setup()
    const ref = await captureSourceSnapshot({
      root: source,
      store,
      spec: makeSpec(),
      child: 'child-1',
    })
    await writeFile(join(source, 'index.ts'), 'drift')
    const snapshot = await readSourceSnapshot(store, ref)
    expect(snapshot.totalBytes).toBe(19)
    const dest = join(root, 'restored')
    await materializeSourceSnapshot(store, ref, dest)
    expect(await readFile(join(dest, 'index.ts'), 'utf8')).toBe('export const x = 1\n')
  })
  it.each(['symlink', 'hardlink', 'nested-symlink'])(
    'rejects %s even inside declared source',
    async (kind) => {
      const { source, store } = await setup()
      if (kind === 'hardlink') await link(join(source, 'index.ts'), join(source, 'copy.ts'))
      else if (kind === 'symlink') await symlink('/etc/passwd', join(source, 'secret.ts'))
      else await symlink(source, join(source, 'loop'))
      await expect(
        captureSourceSnapshot({ root: source, store, spec: makeSpec(), child: 'child-1' }),
      ).rejects.toThrow()
    },
  )
  it('rejects bytes and inode overflow before exporting success', async () => {
    const { source, store } = await setup()
    const spec = makeSpec()
    spec.limits.fileBytes = 3
    await expect(
      captureSourceSnapshot({ root: source, store, spec, child: 'child-1' }),
    ).rejects.toThrow(/limit/)
    spec.limits.fileBytes = 100
    spec.limits.workspace.inodes = 1
    await expect(
      captureSourceSnapshot({ root: source, store, spec, child: 'child-1' }),
    ).rejects.toThrow(/limit/)
  })
  it('does not overwrite a materialization directory', async () => {
    const { source, store } = await setup()
    const ref = await captureSourceSnapshot({
      root: source,
      store,
      spec: makeSpec(),
      child: 'child-1',
    })
    await expect(materializeSourceSnapshot(store, ref, source)).rejects.toThrow()
  })
})
