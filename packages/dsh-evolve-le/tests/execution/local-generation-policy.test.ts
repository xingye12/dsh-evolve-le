import { it, expect } from 'vitest'
import {
  assertDockerPlatform,
  buildContainerConfig,
  assertContainerConfig,
} from '../../src/execution/docker-policy.js'
import { makeSpec } from './fixtures.js'
const security = {
  profile: 'local-generation/v1' as const,
  seccompJson: JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }),
  apparmorProfile: 'none',
  cgroupParent: '/unused',
}
const info = {
  OSType: 'linux',
  CgroupVersion: '1',
  MemoryLimit: true,
  SwapLimit: true,
  PidsLimit: true,
  CpuCfsQuota: true,
  SecurityOptions: ['name=seccomp,profile=builtin'],
}
it('explicit local generation supports cgroup v1 without removing container security or limits', () => {
  expect(() => assertDockerPlatform(info, security)).not.toThrow()
  expect(() => assertDockerPlatform(info)).toThrow()
  expect(() => assertDockerPlatform({ ...info, MemoryLimit: false }, security)).toThrow()
  expect(() => assertDockerPlatform({ ...info, SecurityOptions: [] }, security)).toThrow()
  const spec = makeSpec(),
    config = buildContainerConfig(spec, security)
  expect(config.HostConfig.ReadonlyRootfs).toBe(true)
  expect(config.HostConfig.NetworkMode).toBe('none')
  expect(config.HostConfig.Memory).toBe(spec.limits.memoryBytes)
  expect(config.HostConfig.PidsLimit).toBe(spec.limits.pids)
  expect(config.HostConfig.CapDrop).toEqual(['ALL'])
  expect(config.HostConfig.SecurityOpt).toHaveLength(2)
  expect(config.HostConfig.CgroupParent).toBe('')
  const actual = {
    Image: spec.image.id,
    Config: config,
    HostConfig: structuredClone(config.HostConfig),
    Mounts: spec.mounts.map((m) => ({
      Type: 'bind',
      Source: m.source,
      Destination: m.target,
      RW: !m.readOnly,
      Propagation: 'rprivate',
    })),
  }
  expect(() => assertContainerConfig(spec, security, actual)).not.toThrow()
  actual.HostConfig.ReadonlyRootfs = false
  expect(() => assertContainerConfig(spec, security, actual)).toThrow()
  expect(() => buildContainerConfig({ ...spec, kind: 'validator' }, security)).toThrow()
})
