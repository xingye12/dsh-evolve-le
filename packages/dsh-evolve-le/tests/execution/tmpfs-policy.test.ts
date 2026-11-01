import { it, expect } from 'vitest'
import { executionTmpfsMode } from '../../src/execution/linux-host.js'
import { makeSpec } from './fixtures.js'
it('requires explicit frozen validator exec policy and keeps proposal/work noexec', () => {
  const spec = makeSpec()
  expect(executionTmpfsMode(spec, 'workspace', {})).toBe('noexec')
  expect(() =>
    executionTmpfsMode(spec, 'workspace', { workspaceExecution: 'validator-exec/v1' }),
  ).toThrow()
  spec.kind = 'validator'
  delete spec.gateway
  expect(() => executionTmpfsMode(spec, 'workspace', {})).toThrow(/profile/)
  expect(executionTmpfsMode(spec, 'workspace', { workspaceExecution: 'validator-exec/v1' })).toBe(
    'exec',
  )
  expect(executionTmpfsMode(spec, 'work', { workspaceExecution: 'validator-exec/v1' })).toBe(
    'noexec',
  )
})
