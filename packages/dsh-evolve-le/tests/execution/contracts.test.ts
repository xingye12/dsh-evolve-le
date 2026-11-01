import { describe, expect, it } from 'vitest'
import {
  validateExecutionSpec,
  executionName,
  EXECUTION_PROTOCOL,
} from '../../src/execution/types.js'
import { makeSpec } from './fixtures.js'

describe('frozen Docker execution contract', () => {
  it('validates the complete spec and derives stable bounded names', () => {
    const spec = makeSpec()
    expect(validateExecutionSpec(spec)).toEqual(spec)
    expect(executionName(spec)).toMatch(/^dsh-proposal-[a-f0-9]{32}$/)
    expect(executionName(spec)).toBe(executionName(structuredClone(spec)))
    expect(spec.protocol).toBe(EXECUTION_PROTOCOL)
  })
  it.each([
    (s: Record<string, unknown>) => {
      s.protocol = 'legacy'
    },
    (s: Record<string, unknown>) => {
      s.extra = true
    },
    (s: Record<string, unknown>) => {
      s.deadlineUtc = 'tomorrow'
    },
    (s: Record<string, unknown>) => {
      s.executionId = '../../escape'
    },
    (s: Record<string, unknown>) => {
      s.command = ['/bin/sh', '-c', 'echo host']
    },
    (s: Record<string, unknown>) => {
      ;(s.image as Record<string, unknown>).reference = 'latest'
    },
    (s: Record<string, unknown>) => {
      ;(s.limits as Record<string, unknown>).memoryBytes = 0
    },
    (s: Record<string, unknown>) => {
      ;(s.limits as Record<string, unknown>).cpuMillis = 0.5
    },
    (s: Record<string, unknown>) => {
      s.gateway = { kind: 'arbitrary' }
    },
    (s: Record<string, unknown>) => {
      ;(s.mounts as Array<Record<string, unknown>>)[0]!.target = '/var/run/docker.sock'
    },
  ])('rejects malformed or privilege-expanding spec %#', (mutate) => {
    const spec = structuredClone(makeSpec()) as unknown as Record<string, unknown>
    mutate(spec)
    expect(() => validateExecutionSpec(spec)).toThrow()
  })
  it('rejects writable inputs and validator gateway', () => {
    const spec = makeSpec()
    spec.mounts[0]!.readOnly = false
    expect(() => validateExecutionSpec(spec)).toThrow(/read.only/i)
    const validator = makeSpec()
    validator.kind = 'validator'
    expect(() => validateExecutionSpec(validator)).toThrow(/gateway/i)
  })
  it.each(['DEV_GUARD', 'SEALED'] as const)('rejects %s input before dispatch', (label) => {
    const spec = makeSpec()
    spec.inputs = [{ ...spec.inputs[0]!, label }]
    expect(() => validateExecutionSpec(spec)).toThrow(/guard\/sealed/)
  })
})
