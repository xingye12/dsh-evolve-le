import { describe, expect, it } from 'vitest'
import { effectiveTaskAgentTimeoutMs, parseTaskAgentTimeoutSec } from '../src/task-timeout.js'

describe('Terminal-Bench live solver task timeout binding', () => {
  it("reads only the agent timeout and maps it to Harbor's effective ceiling", () => {
    expect(
      parseTaskAgentTimeoutSec(
        ['[agent]', 'timeout_sec = 900.0', '', '[verifier]', 'timeout_sec = 60.0'].join('\n'),
      ),
    ).toBe(900)
    expect(effectiveTaskAgentTimeoutMs(900)).toBe(2_700_000)
  })

  it('fails closed on absent, duplicate, or invalid agent timeout declarations', () => {
    expect(() => parseTaskAgentTimeoutSec('[task]\nname = "missing"')).toThrow(/no \[agent]/)
    expect(() => parseTaskAgentTimeoutSec('[agent]\ntimeout_sec = 1\ntimeout_sec = 2')).toThrow(
      /more than once/,
    )
    expect(() => parseTaskAgentTimeoutSec('[agent]\ntimeout_sec = -1')).toThrow(/finite number/)
  })
})
