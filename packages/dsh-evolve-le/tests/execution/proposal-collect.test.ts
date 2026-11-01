import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { collectProposalSupervisor } from '../../src/execution/proposal-launcher.js'
import { makeProposalConfig } from './fixtures.js'
it('refuses orphan collection without recorded effects instead of creating a fresh proposer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collect-no-effects-'))
  try {
    const config = makeProposalConfig()
    config.hostRoot = join(root, 'host')
    config.executionRoot = join(root, 'executions')
    config.resourceRoot = join(root, 'resources')
    config.storeRoot = join(root, 'cas')
    config.tests.profile = {
      ...config.tests.profile,
      hostRoot: config.hostRoot,
      executionRoot: config.executionRoot,
      resourceRoot: config.resourceRoot,
      storeRoot: config.storeRoot,
    }
    await expect(collectProposalSupervisor(config)).rejects.toThrow(/recorded execution effects/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
