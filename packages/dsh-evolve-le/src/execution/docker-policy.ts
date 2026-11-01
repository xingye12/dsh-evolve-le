/** A closed Docker create policy, compared against the real daemon before start. */
import { canonicalJson } from '../state/canonical.js'
import { ExecutionError, validateExecutionSpec, type ExecutionSpec } from './types.js'
export interface DockerSecurity {
  profile?: 'local-generation/v1'
  seccompJson: string
  apparmorProfile: string
  cgroupParent: string
}
export function assertDockerPlatform(
  info: Record<string, unknown>,
  security?: DockerSecurity,
): void {
  const local = security?.profile === 'local-generation/v1'
  if (info.OSType !== 'linux' || (!local && info.CgroupVersion !== '2'))
    throw new ExecutionError('production sandbox requires Linux cgroup v2')
  for (const key of ['MemoryLimit', 'SwapLimit', 'PidsLimit', 'CpuCfsQuota'])
    if (info[key] !== true) throw new ExecutionError(`Docker missing ${key}`)
  const opts = info.SecurityOptions
  if (
    !Array.isArray(opts) ||
    !opts.some((s) => String(s).startsWith('name=seccomp')) ||
    (!local && !opts.some((s) => String(s).startsWith('name=apparmor')))
  )
    throw new ExecutionError('production sandbox requires seccomp and AppArmor')
}
export function buildContainerConfig(spec: ExecutionSpec, security: DockerSecurity) {
  validateExecutionSpec(spec)
  const local = security.profile === 'local-generation/v1'
  if (local && spec.kind !== 'proposal')
    throw new ExecutionError('local profile is proposal generation only')
  let seccomp: unknown
  try {
    seccomp = JSON.parse(security.seccompJson)
  } catch {
    throw new ExecutionError('invalid seccomp JSON')
  }
  const seccompObject = record(seccomp)
  if (seccompObject.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(seccompObject.syscalls))
    throw new ExecutionError('seccomp requires default deny syscall policy')
  if (
    !/^[a-zA-Z0-9_.-]+$/.test(security.apparmorProfile) ||
    !security.cgroupParent.startsWith('/') ||
    security.cgroupParent === '/'
  )
    throw new ExecutionError('invalid fixed Docker security profile')
  const l = spec.limits
  return {
    Image: spec.image.reference,
    User: '65532:65532',
    Entrypoint: [...spec.command],
    Cmd: [] as string[],
    WorkingDir: '/workspace',
    Env: ['HOME=/work/home', 'TMPDIR=/tmp', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', 'TZ=UTC'],
    Labels: {
      'dsh.owner': 'dsh-evolve-le',
      'dsh.run': spec.runId,
      'dsh.action': spec.actionId,
      'dsh.attempt': spec.attemptId,
      'dsh.execution': spec.executionId,
    },
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: false,
    StdinOnce: false,
    Tty: false,
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      Runtime: 'runc',
      Init: true,
      UsernsMode: '',
      ReadonlyPaths: [
        '/proc/bus',
        '/proc/fs',
        '/proc/irq',
        '/proc/sys',
        '/proc/sysrq-trigger',
        '/dev',
      ],
      NetworkMode: 'none',
      IpcMode: 'private',
      PidMode: '',
      UTSMode: '',
      CgroupnsMode: 'private',
      CgroupParent: local ? '' : security.cgroupParent,
      CapDrop: ['ALL'],
      CapAdd: [] as string[],
      SecurityOpt: [
        'no-new-privileges=true',
        `seccomp=${security.seccompJson}`,
        ...(!local ? [`apparmor=${security.apparmorProfile}`] : []),
      ],
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      PidsLimit: l.pids,
      Memory: l.memoryBytes,
      MemorySwap: l.memoryBytes,
      NanoCpus: l.cpuMillis * 1_000_000,
      Ulimits: [
        { Name: 'nofile', Soft: l.nofile, Hard: l.nofile },
        { Name: 'fsize', Soft: l.fileBytes, Hard: l.fileBytes },
        { Name: 'core', Soft: 0, Hard: 0 },
      ],
      Tmpfs: {
        '/tmp': `rw,nosuid,nodev,noexec,size=${l.tmp.bytes},nr_inodes=${l.tmp.inodes},mode=1777`,
        '/dev/shm': `rw,nosuid,nodev,noexec,size=${l.shm.bytes},nr_inodes=${l.shm.inodes},mode=1777`,
      },
      Mounts: spec.mounts.map((m) => ({
        Type: 'bind',
        Source: m.source,
        Target: m.target,
        ReadOnly: m.readOnly,
        BindOptions: { Propagation: 'rprivate' },
      })),
      Devices: [] as unknown[],
      DeviceRequests: [] as unknown[],
      VolumesFrom: [] as string[],
      Binds: [] as string[],
      LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '2' } },
    },
  }
}
type CreateConfig = ReturnType<typeof buildContainerConfig>
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ExecutionError('invalid Docker inspection')
  return value as Record<string, unknown>
}
function equal(actual: unknown, expected: unknown, path: string): void {
  if (canonicalJson(actual ?? null) !== canonicalJson(expected ?? null))
    throw new ExecutionError(`Docker actual config mismatch: ${path}`)
}
export function assertContainerConfig(
  spec: ExecutionSpec,
  security: DockerSecurity,
  inspection: unknown,
): void {
  const actual = record(inspection),
    config = record(actual.Config),
    host = record(actual.HostConfig),
    expected = buildContainerConfig(spec, security)
  equal(actual.Image, spec.image.id, 'Image')
  for (const key of ['User', 'Entrypoint', 'Cmd', 'WorkingDir', 'Env', 'Tty', 'OpenStdin'])
    equal(config[key], expected[key as keyof CreateConfig], `Config.${key}`)
  const labels = record(config.Labels)
  for (const [key, value] of Object.entries(expected.Labels))
    equal(labels[key], value, `Labels.${key}`)
  for (const [key, value] of Object.entries(expected.HostConfig)) {
    // Engine normalizes empty collections to null and parses seccomp JSON.
    if (['Devices', 'DeviceRequests', 'VolumesFrom', 'Binds', 'CapAdd'].includes(key)) {
      if (host[key] !== null && host[key] !== undefined)
        equal(host[key], value, `HostConfig.${key}`)
    } else if (key === 'SecurityOpt') {
      if (!Array.isArray(host.SecurityOpt))
        throw new ExecutionError('Docker actual config mismatch: SecurityOpt')
      const opts = host.SecurityOpt.map(String)
      if (!opts.includes('no-new-privileges=true') && !opts.includes('no-new-privileges'))
        throw new ExecutionError('Docker actual config mismatch: no-new-privileges')
      if (
        (security.profile !== 'local-generation/v1' &&
          !opts.includes(`apparmor=${security.apparmorProfile}`)) ||
        !opts.some((o) => o.startsWith('seccomp=')) ||
        opts.length !== (security.profile === 'local-generation/v1' ? 2 : 3)
      )
        throw new ExecutionError('Docker actual config mismatch: security profiles')
      const seccomp = opts.find((o) => o.startsWith('seccomp='))!.slice(8)
      try {
        equal(JSON.parse(seccomp), JSON.parse(security.seccompJson), 'SecurityOpt.seccomp')
      } catch {
        throw new ExecutionError('Docker actual config mismatch: seccomp bytes')
      }
    } else if (key === 'Mounts') {
      if (!Array.isArray(host.Mounts))
        throw new ExecutionError('Docker actual config mismatch: HostConfig.Mounts')
      equal(
        host.Mounts.map((m) => ({ ReadOnly: false, ...record(m) })),
        value,
        'HostConfig.Mounts',
      )
    } else equal(host[key], value, `HostConfig.${key}`)
  }
  // Unexpected writable/host capabilities are rejected even if not emitted by us.
  for (const key of ['PublishAllPorts', 'OomKillDisable'])
    if (host[key] === true) throw new ExecutionError(`forbidden Docker ${key}`)
  for (const key of ['PortBindings', 'ExtraHosts', 'Links', 'GroupAdd', 'DeviceCgroupRules']) {
    const v = host[key]
    if (
      v !== undefined &&
      v !== null &&
      ((Array.isArray(v) && v.length > 0) ||
        (!Array.isArray(v) && Object.keys(record(v)).length > 0))
    )
      throw new ExecutionError(`forbidden Docker ${key}`)
  }
  const mounts = actual.Mounts
  if (!Array.isArray(mounts) || mounts.length !== spec.mounts.length)
    throw new ExecutionError('Docker actual config mismatch: Mounts')
  for (const m of spec.mounts) {
    const mounted = mounts.map(record).find((x) => x.Destination === m.target)
    if (!mounted) throw new ExecutionError('Docker actual config mismatch: missing mount')
    equal(mounted.Type, 'bind', 'Mount.Type')
    equal(mounted.Source, m.source, 'Mount.Source')
    equal(mounted.RW, !m.readOnly, 'Mount.RW')
    equal(mounted.Propagation, 'rprivate', 'Mount.Propagation')
  }
}
