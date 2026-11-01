import { mkdtemp, writeFile, chmod, readFile, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { writeTypeLintUnitConfigs } from '../../src/builder/type-lint-unit.js'
it('replaces the working config without writing through the frozen source inode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'validator-config-'))
  try {
    await writeFile(join(root, 'tsconfig.json'), '{"candidate":"identity-only"}')
    await chmod(join(root, 'tsconfig.json'), 0o444)
    await link(join(root, 'tsconfig.json'), join(root, 'frozen-original'))
    await writeTypeLintUnitConfigs(root)
    expect(await readFile(join(root, 'frozen-original'), 'utf8')).toBe(
      '{"candidate":"identity-only"}',
    )
    expect(
      JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8')).compilerOptions.noEmit,
    ).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
