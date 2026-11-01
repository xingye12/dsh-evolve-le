import { describe, it, expect } from 'vitest'
import { managedShellEnvironment } from '../../src/execution/shell-environment.js'
describe('frozen managed DSH shell environment', () => {
  it('preserves normal DSH facts without accepting ordinary environment overrides', () => {
    expect(
      managedShellEnvironment({
        DSH_HOME: '/work/home',
        DSH_SHELL: '1',
        DSH_SESSION_ID: 'execution-main',
        DSH_SESSION_JSONL: '/work/sessions/main.jsonl',
      }),
    ).toEqual({
      DSH_HOME: '/work/home',
      DSH_SHELL: '1',
      DSH_SESSION_ID: 'execution-main',
      DSH_SESSION_JSONL: '/work/sessions/main.jsonl',
    })
  })
  it.each([
    { LD_PRELOAD: '/bad' },
    { DSH_HOME: '/root' },
    { DSH_SESSION_JSONL: '/work/../secret' },
    { DSH_SESSION_ID: 'x\ny' },
  ])('rejects expanded or untrusted environment %j', (value) => {
    expect(() => managedShellEnvironment(value)).toThrow()
  })
})
