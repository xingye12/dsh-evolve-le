import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect, vi } from 'vitest'
import { LinuxExecutionHost } from '../../src/execution/linux-host.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { executionName } from '../../src/execution/types.js'
import { makeSpec } from './fixtures.js'
it('fails a validator export without frozen source binding and retains worker diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'validator-host-export-'))
  try {
    const store = await openObjectStore(join(root, 'cas')),
      spec = makeSpec()
    spec.kind = 'validator'
    delete spec.gateway
    const work = join(root, executionName(spec), 'work')
    await mkdir(work, { recursive: true })
    await writeFile(join(work, 'validator-failure.json'), '{"error":"fixture compile failed"}\n')
    const host = new LinuxExecutionHost({
      root,
      cgroupRoot: join(root, 'not-mounted'),
      store,
      engine: {
        async request() {
          throw Error('unused')
        },
        async json() {
          throw Error('unused')
        },
      },
      security: { seccompJson: '{}', apparmorProfile: 'unused', cgroupParent: 'unused' },
      actions: {
        async quiesce() {},
        async resume() {},
        async revoke() {},
        async cancelChildren() {},
        async close() {},
        async artifacts() {
          return []
        },
      },
    })
    vi.spyOn(host, 'sample').mockResolvedValue({
      cpuTimeUs: 1,
      memoryPeakBytes: 1,
      oom: 0,
      oomKill: 0,
      pidsCurrent: 0,
      pidsMaxEvents: 0,
      populated: false,
      frozen: false,
      ioStat: '',
    })
    const failed = await host.export(spec, 'FAILED')
    expect(failed.outcome).toBe('FAILED')
    expect(failed.artifacts.length).toBeGreaterThan(1)
    const raw = await Promise.all(failed.artifacts.map((r) => store.read(r)))
    expect(raw.some((b) => b.toString().includes('fixture compile failed'))).toBe(true)
    const incomplete = await host.export(spec, 'SUCCEEDED')
    expect(incomplete.outcome).toBe('INCOMPLETE')
    expect(incomplete.failureReason).toMatch(/validator.*input/i)
    vi.mocked(host.sample).mockResolvedValue({
      cpuTimeUs: 1,
      memoryPeakBytes: 1,
      oom: 0,
      oomKill: 0,
      pidsCurrent: 1,
      pidsMaxEvents: 0,
      populated: true,
      frozen: false,
      ioStat: '',
    })
    await expect(host.export(spec, 'SUCCEEDED')).rejects.toThrow(/empty/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
