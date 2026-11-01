/** Read-only platform diagnosis. Never relaxes policy to make a probe green. */
import { readFile } from 'node:fs/promises'
import type { DockerEngine } from './docker-engine.js'
export interface SandboxDoctorReport {
  protocol: 'dsh-evolve-le/sandbox-doctor/v1'
  checkedAt: string
  ready: false
  platform: {
    dockerVersion: string
    apiVersion: string
    kernel: string
    cgroupVersion: string
    securityOptions: string[]
  }
  blockers: string[]
  checks: Array<{ name: string; status: 'PASS' | 'FAIL' | 'NOT_RUN'; detail: string }>
}
export async function doctorDockerSandbox(engine: DockerEngine): Promise<SandboxDoctorReport> {
  const info = await engine.json('GET', '/info'),
    version = await engine.json('GET', '/version')
  const checks: SandboxDoctorReport['checks'] = []
  checks.push({
    name: 'linux',
    status: info.OSType === 'linux' ? 'PASS' : 'FAIL',
    detail: String(info.OSType),
  })
  checks.push({
    name: 'cgroup-v2',
    status: info.CgroupVersion === '2' ? 'PASS' : 'FAIL',
    detail: `observed cgroup v${String(info.CgroupVersion)}`,
  })
  for (const name of ['MemoryLimit', 'SwapLimit', 'CpuCfsQuota', 'PidsLimit'])
    checks.push({ name, status: info[name] === true ? 'PASS' : 'FAIL', detail: String(info[name]) })
  const securityOptions = Array.isArray(info.SecurityOptions)
    ? info.SecurityOptions.map(String)
    : []
  checks.push({
    name: 'seccomp',
    status: securityOptions.some((s) => s.startsWith('name=seccomp')) ? 'PASS' : 'FAIL',
    detail: securityOptions.join(','),
  })
  const apparmor = await readFile('/sys/kernel/security/apparmor/profiles', 'utf8').catch(
    () => null,
  )
  checks.push({
    name: 'enforced-lsm',
    status:
      apparmor !== null && securityOptions.some((s) => s.startsWith('name=apparmor'))
        ? 'PASS'
        : 'FAIL',
    detail:
      apparmor === null
        ? 'AppArmor kernel interface unavailable'
        : 'AppArmor kernel interface observed; profile digest still requires validation',
  })
  for (const name of [
    'image-and-capsule-compatibility',
    'readonly-and-credential-canaries',
    'network-and-gateway-authorization',
    'resource-exhaustion',
    'shell-descendant-reaping',
    'snapshot-consistency',
    'production-loader',
    'crash-replay-and-cas-audit',
  ])
    checks.push({
      name,
      status: 'NOT_RUN',
      detail: 'requires the frozen image/profile, trusted supervisor and full acceptance suite',
    })
  return {
    protocol: 'dsh-evolve-le/sandbox-doctor/v1',
    checkedAt: new Date().toISOString(),
    ready: false,
    platform: {
      dockerVersion: String(version.Version),
      apiVersion: String(version.ApiVersion),
      kernel: String(info.KernelVersion),
      cgroupVersion: String(info.CgroupVersion),
      securityOptions,
    },
    blockers: checks.filter((c) => c.status === 'FAIL').map((c) => `${c.name}: ${c.detail}`),
    checks,
  }
}
