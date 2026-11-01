import { describe, expect, it } from 'vitest'
import {
  buildContainerConfig,
  assertContainerConfig,
  assertDockerPlatform,
} from '../../src/execution/docker-policy.js'
import { makeSpec } from './fixtures.js'
const security = {
  seccompJson: JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }),
  apparmorProfile: 'dsh-proposal-v1',
  cgroupParent: '/dsh-executor',
}
function inspection() {
  const spec = makeSpec()
  const body = buildContainerConfig(spec, security)
  return {
    spec,
    body,
    actual: {
      Id: 'container-1',
      Image: spec.image.id,
      Platform: 'linux',
      Config: { ...body },
      HostConfig: { ...body.HostConfig },
      Mounts: spec.mounts.map((m) => ({
        Type: 'bind',
        Source: m.source,
        Destination: m.target,
        RW: !m.readOnly,
        Propagation: 'rprivate',
      })),
      State: { Status: 'created', Running: false, Paused: false, Pid: 0 },
    },
  }
}
describe('Docker actual configuration gate', () => {
  it('checks the actual image, command, all mounts and every security limit', () => {
    const { spec, actual } = inspection()
    expect(() => assertContainerConfig(spec, security, actual)).not.toThrow()
  })
  it.each([
    (x: ReturnType<typeof inspection>) => {
      x.actual.HostConfig.Privileged = true
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.HostConfig.NetworkMode = 'host'
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.HostConfig.CapAdd = ['SYS_ADMIN']
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.HostConfig.Memory = 0
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.HostConfig.AutoRemove = true
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.Config.User = '0'
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.Image = `sha256:${'c'.repeat(64)}`
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.Mounts[0]!.RW = true
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.HostConfig.RestartPolicy.Name = 'always'
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.Config.Env.push('SECRET=leak')
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.Config.Entrypoint = ['/bin/sh']
    },
    (x: ReturnType<typeof inspection>) => {
      x.actual.Mounts.push({
        Type: 'bind',
        Source: '/var/run/docker.sock',
        Destination: '/docker',
        RW: true,
        Propagation: 'rprivate',
      })
    },
  ])('rejects policy drift %#', (mutate) => {
    const x = inspection()
    mutate(x)
    expect(() => assertContainerConfig(x.spec, security, x.actual)).toThrow(/mismatch|forbidden/)
  })
  it('fails production preflight on the observed cgroup v1 host', () => {
    expect(() =>
      assertDockerPlatform({
        OSType: 'linux',
        CgroupVersion: '1',
        MemoryLimit: true,
        SwapLimit: true,
        PidsLimit: true,
        CpuCfsQuota: true,
        SecurityOptions: ['name=seccomp,profile=builtin', 'name=apparmor'],
      }),
    ).toThrow(/cgroup v2/)
  })
})
