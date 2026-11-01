import { cancelProposalSupervisor } from '../../src/execution/supervisor.js'
import { executionName } from '../../src/execution/types.js'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import {
  requestExecutionCancellation,
  readExecutionCancellation,
} from '../../src/execution/cancellation.js'
import { makeSpec } from './fixtures.js'
it('persists a bound cancellation before launch, rejects drift and never follows a request symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-cancel-'))
  const spec = makeSpec()
  try {
    expect(await readExecutionCancellation(root, spec)).toBeNull()
    await requestExecutionCancellation(root, spec, 'operator cancellation')
    await requestExecutionCancellation(root, spec, 'operator cancellation')
    expect(await readExecutionCancellation(root, structuredClone(spec))).toBe(
      'operator cancellation',
    )
    await expect(requestExecutionCancellation(root, spec, 'replacement')).rejects.toThrow(
      /conflict/,
    )
    const changed = structuredClone(spec)
    changed.maxElapsedMs += 1
    await expect(readExecutionCancellation(root, changed)).rejects.toThrow(/binding/)
    await rm(join(root, 'cancel-request.json'))
    await symlink('/etc/passwd', join(root, 'cancel-request.json'))
    await expect(readExecutionCancellation(root, spec)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('publishes proposal cancellation in the deterministic owner root before a supervisor exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-cancel-'))
  const spec = makeSpec()
  try {
    await cancelProposalSupervisor({ hostRoot: root, spec }, 'controller cancelled')
    expect(await readExecutionCancellation(join(root, executionName(spec)), spec)).toBe(
      'controller cancelled',
    )
    const changed = structuredClone(spec)
    changed.maxElapsedMs += 1
    await expect(
      cancelProposalSupervisor({ hostRoot: root, spec: changed }, 'controller cancelled'),
    ).rejects.toThrow(/conflict/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
