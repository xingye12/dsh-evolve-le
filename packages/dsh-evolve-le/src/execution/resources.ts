/** Executor resource admission is separate from search scheduling. */
import { readFile } from 'node:fs/promises'
import { canonicalHash } from '../state/canonical.js'
import { ExecutionError, type ExecutionKind, type ExecutionSpec } from './types.js'
export interface ResourceCapacity {
  slots: number
  memoryBytes: number
  cpuMillis: number
  pids: number
  bytes: number
  inodes: number
}
export class ResourceAdmission {
  private readonly active = new Map<
    string,
    { specDigest: string; kind: ExecutionKind; demand: ResourceCapacity }
  >()
  constructor(private readonly pools: Record<ExecutionKind, ResourceCapacity>) {
    for (const cap of Object.values(pools))
      for (const value of Object.values(cap))
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new ExecutionError('invalid host capacity')
  }
  reserve(spec: ExecutionSpec): boolean {
    const existing = this.active.get(spec.executionId),
      digest = canonicalHash(spec)
    if (existing) {
      if (existing.specDigest !== digest)
        throw new ExecutionError('resource reservation identity drift')
      return true
    }
    const l = spec.limits,
      spaces = [l.workspace, l.work, l.tmp, l.shm]
    // Conservative tmpfs upper bound, including host-side writes outside cgroup.
    const demand: ResourceCapacity = {
      slots: 1,
      memoryBytes: l.memoryBytes + spaces.reduce((a, s) => a + s.bytes, 0),
      cpuMillis: l.cpuMillis,
      pids: l.pids,
      bytes: spaces.reduce((a, s) => a + s.bytes, 0),
      inodes: spaces.reduce((a, s) => a + s.inodes, 0),
    }
    const totals = { ...demand }
    for (const r of this.active.values())
      if (r.kind === spec.kind)
        for (const key of Object.keys(totals) as Array<keyof ResourceCapacity>)
          totals[key] += r.demand[key]
    for (const key of Object.keys(totals) as Array<keyof ResourceCapacity>)
      if (!Number.isSafeInteger(totals[key]) || totals[key] > this.pools[spec.kind][key])
        return false
    this.active.set(spec.executionId, { specDigest: digest, kind: spec.kind, demand })
    return true
  }
  release(executionId: string): void {
    this.active.delete(executionId)
  }
  snapshot(): unknown {
    return [...this.active.entries()].map(([executionId, r]) => ({ executionId, ...r }))
  }
}
export interface CgroupSample {
  /** Local profile reports Docker state, not cumulative host cgroup counters. */
  accounting?: 'docker-hard-limits+wall-clock'
  cpuTimeUs: number
  memoryPeakBytes: number
  oom: number
  oomKill: number
  pidsCurrent: number
  pidsMaxEvents: number
  populated: boolean
  frozen: boolean
  ioStat: string
}
function integer(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value.trim()))
    throw new ExecutionError('missing/invalid cgroup integer')
  const number = Number(value.trim())
  if (!Number.isSafeInteger(number)) throw new ExecutionError('cgroup counter overflow')
  return number
}
function counters(value: string | undefined): Record<string, number> {
  if (value === undefined) throw new ExecutionError('missing cgroup counters')
  const result: Record<string, number> = {}
  for (const line of value.trim().split('\n')) {
    if (!line) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 2 || Object.hasOwn(result, parts[0]!))
      throw new ExecutionError('invalid cgroup counters')
    result[parts[0]!] = integer(parts[1])
  }
  return result
}
export function parseCgroupSample(files: Record<string, string>): CgroupSample {
  const cpu = counters(files['cpu.stat']),
    mem = counters(files['memory.events']),
    pids = counters(files['pids.events']),
    events = counters(files['cgroup.events'])
  const required = (map: Record<string, number>, key: string) => {
    const value = map[key]
    if (value === undefined) throw new ExecutionError(`missing cgroup ${key}`)
    return value
  }
  const populated = required(events, 'populated'),
    frozen = required(events, 'frozen')
  if (![0, 1].includes(populated) || ![0, 1].includes(frozen))
    throw new ExecutionError('invalid cgroup state')
  if (files['io.stat'] === undefined) throw new ExecutionError('missing cgroup io.stat')
  return {
    cpuTimeUs: required(cpu, 'usage_usec'),
    memoryPeakBytes: integer(files['memory.peak']),
    oom: required(mem, 'oom'),
    oomKill: required(mem, 'oom_kill'),
    pidsCurrent: integer(files['pids.current']),
    pidsMaxEvents: required(pids, 'max'),
    populated: populated === 1,
    frozen: frozen === 1,
    ioStat: files['io.stat'],
  }
}

export interface BootClock {
  bootId: string
  elapsedMs: number
}
/** Same monotonic origin across supervisor restarts on one boot. */
export async function readBootClock(): Promise<BootClock> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  const uptime = (await readFile('/proc/uptime', 'utf8')).split(' ')[0] ?? ''
  if (!/^[a-f0-9-]{36}$/.test(bootId) || !/^\d+\.\d+$/.test(uptime))
    throw new ExecutionError('invalid host boot clock')
  const elapsedMs = Math.floor(Number(uptime) * 1000)
  if (!Number.isSafeInteger(elapsedMs)) throw new ExecutionError('host boot clock overflow')
  return { bootId, elapsedMs }
}
