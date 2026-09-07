import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NATIVE_DSH_PACKAGE_PINS } from '../src/dsh/native-composition.js'
import { openNativeDshCatalog } from '../src/builder/staging.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function builtCatalog(options: { omit?: string; withoutEntry?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-catalog-'))
  roots.push(root)
  for (const [index, [name, version]] of NATIVE_DSH_PACKAGE_PINS.entries()) {
    if (name === options.omit) continue
    const dir = join(root, 'packages', 'core', `package-${index}`)
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify({ name, version, main: 'lib/index.js' })}\n`,
    )
    if (name !== options.withoutEntry) await writeFile(join(dir, 'lib/index.js'), 'export {}\n')
  }
  await mkdir(join(root, 'vendor'), { recursive: true })
  return root
}

describe('native DSH catalog admission', () => {
  it('accepts exactly the built rc.5 native root set', async () => {
    const catalog = await openNativeDshCatalog(await builtCatalog())
    expect(catalog.packages.size).toBe(NATIVE_DSH_PACKAGE_PINS.length)
    expect([...catalog.packages.keys()].sort()).toEqual(
      NATIVE_DSH_PACKAGE_PINS.map(([name]) => name).sort(),
    )
  })

  it('fails closed when one required native package is absent', async () => {
    await expect(
      openNativeDshCatalog(
        await builtCatalog({ omit: '@deepseek-ai/dsh-agent-spine-demo' }),
      ),
    ).rejects.toThrow(/missing required @deepseek-ai\/dsh-agent-spine-demo/)
  })

  it('fails closed when a pinned package has not been built', async () => {
    await expect(
      openNativeDshCatalog(await builtCatalog({ withoutEntry: '@deepseek-ai/dsh-tools' })),
    ).rejects.toThrow(/dsh-tools@0\.1\.0-rc\.5 is not built/)
  })

  it('requires a real absolute catalog root', async () => {
    await expect(openNativeDshCatalog('relative/dsh')).rejects.toThrow(/must be absolute/)

    const root = await builtCatalog()
    const link = `${root}-link`
    roots.push(link)
    await symlink(root, link)
    await expect(openNativeDshCatalog(link)).rejects.toThrow(/must be a real directory/)
  })
})
