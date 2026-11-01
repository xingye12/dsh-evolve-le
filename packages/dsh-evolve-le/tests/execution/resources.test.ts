import { describe, expect, it } from 'vitest'
import { ResourceAdmission, parseCgroupSample } from '../../src/execution/resources.js'
import { makeSpec } from './fixtures.js'
describe('resource accounting and independent test pool', () => {
  it('reserves test capacity independently and never double charges same execution', () => {
    const a = new ResourceAdmission({
      proposal: {
        slots: 1,
        memoryBytes: 512 * 1024 * 1024,
        cpuMillis: 2000,
        pids: 128,
        bytes: 100 * 1024 * 1024,
        inodes: 10000,
      },
      test: {
        slots: 1,
        memoryBytes: 512 * 1024 * 1024,
        cpuMillis: 2000,
        pids: 128,
        bytes: 100 * 1024 * 1024,
        inodes: 10000,
      },
      validator: {
        slots: 1,
        memoryBytes: 512 * 1024 * 1024,
        cpuMillis: 2000,
        pids: 128,
        bytes: 100 * 1024 * 1024,
        inodes: 10000,
      },
    })
    const s = makeSpec()
    expect(a.reserve(s)).toBe(true)
    expect(a.reserve(s)).toBe(true)
    const other = makeSpec()
    other.executionId = 'other'
    expect(a.reserve(other)).toBe(false)
    const test = makeSpec()
    test.executionId = 'test'
    test.kind = 'test'
    delete test.gateway
    test.mounts = test.mounts.filter((m) => m.target !== '/gateway')
    expect(a.reserve(test)).toBe(true)
    a.release(s.executionId)
    expect(a.reserve(other)).toBe(true)
  })
  it('refuses reused execution identity with a changed quota', () => {
    const caps = {
      slots: 2,
      memoryBytes: 1e9,
      cpuMillis: 4000,
      pids: 1000,
      bytes: 1e9,
      inodes: 10000,
    }
    const a = new ResourceAdmission({ proposal: caps, test: caps, validator: caps })
    const s = makeSpec()
    a.reserve(s)
    s.limits.pids++
    expect(() => a.reserve(s)).toThrow(/identity/)
  })
  it('requires exact integer resource facts and detects CPU total independently of rate', () => {
    const sample = parseCgroupSample({
      'cpu.stat': 'usage_usec 1000001\nuser_usec 1\n',
      'memory.peak': '1234\n',
      'memory.events': 'oom 1\noom_kill 1\n',
      'pids.current': '0\n',
      'pids.events': 'max 2\n',
      'cgroup.events': 'populated 0\nfrozen 1\n',
      'io.stat': '',
    })
    expect(sample.cpuTimeUs).toBe(1000001)
    expect(sample.populated).toBe(false)
    expect(sample.frozen).toBe(true)
    expect(() => parseCgroupSample({ 'cpu.stat': 'usage_usec -1' })).toThrow()
  })
})
