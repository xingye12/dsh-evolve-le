import { describe, it, expect } from 'vitest'
import { load } from 'js-yaml'
import { dockerProposalComposition } from '../../src/execution/composition.js'
describe('frozen proposal Docker Cordis overlay', () => {
  it('uses standard native Loader rows and external shell, with no writable capsule config', () => {
    const config = dockerProposalComposition({
      candidatePackage: '@dsh-evolve-le/candidate-test',
      candidateId: 'c_test',
      executionId: 'execution',
      socketPath: '/gateway/action.sock',
      shellTimeoutMs: 1000,
      outputBytes: 1048576,
    })
    const rows = load(config) as Array<{ name: string; config?: Record<string, unknown> }>
    expect(rows.find((r) => r.name === '@deepseek-ai/dsh-tool-bash')!.config).toEqual({
      enableRunInBackground: false,
    })
    expect(rows.find((r) => r.name === '@dsh-evolve-le/candidate-test')!.config?.mode).toBe(
      'propose',
    )
    expect(rows.some((r) => r.name.startsWith('./'))).toBe(false)
    expect(rows.some((r) => r.name.includes('bash-local'))).toBe(false)
    expect(rows.some((r) => r.name === '@deepseek-ai/dsh-compaction-basic')).toBe(true)
    expect(rows.some((r) => r.name === '@deepseek-ai/dsh-subagent')).toBe(true)
  })
})
