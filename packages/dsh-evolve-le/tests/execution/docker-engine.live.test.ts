/** Real Engine transport/syscall probes. NOT production sandbox acceptance. */
import { cp, mkdtemp, mkdir, chmod, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { localDockerEngine, decodeDockerStream } from '../../src/execution/docker-engine.js'
import { buildContainerConfig, assertContainerConfig } from '../../src/execution/docker-policy.js'
import { ContainerShell } from '../../src/execution/shell.js'
import { makeSpec } from './fixtures.js'
import { executionName } from '../../src/execution/types.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { SECCOMP_PROFILE } from '../../src/execution/security.js'
const enabled = process.env.DSH_DOCKER_ENGINE_PROBES === '1'
describe.skipIf(!enabled)('real Docker Engine probes (platform gate remains separate)', () => {
  it('runs frozen Node and bash under closed seccomp; preserves shared edits and readonly input', async () => {
    const image = 'ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55'
    const root = await mkdtemp(join(tmpdir(), 'dsh-engine-probe-'))
    const input = join(root, 'input'),
      workspace = join(root, 'workspace')
    await mkdir(join(input, 'capsule', 'runtime'), { recursive: true })
    await mkdir(join(input, 'capsule', 'runner'), { recursive: true })
    await mkdir(workspace)
    await cp(process.execPath, join(input, 'capsule', 'runtime', 'node'))
    await chmod(root, 0o755)
    await chmod(workspace, 0o777)
    await writeFile(
      join(input, 'capsule', 'runner', 'probe.mjs'),
      `import {spawnSync} from 'node:child_process';import{writeFile,readFile}from'node:fs/promises';await writeFile('/dev/shm/shm-probe','ok');await writeFile('/workspace/agent.txt','agent');const shell=spawnSync('/bin/bash',['--noprofile','--norc','-c','cat /workspace/agent.txt > /workspace/shell.txt'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8'});if(shell.status!==0)throw Error(JSON.stringify(shell));let ro=false;try{await writeFile('/input/denied','bad')}catch{ro=true}if(!ro)throw Error('input writable');console.log(JSON.stringify({shared:await readFile('/workspace/shell.txt','utf8'),readonly:ro}));`,
    )
    const engine = localDockerEngine()
    let id: string | undefined
    try {
      const created = await engine.json<{ Id: string }>(
        'POST',
        `/containers/create?name=dsh-engine-probe-${process.pid}-${Date.now()}`,
        {
          Image: image,
          User: '65532:65532',
          Entrypoint: ['/input/capsule/runtime/node', '/input/capsule/runner/probe.mjs'],
          Cmd: [],
          Env: ['PATH=/usr/bin:/bin'],
          WorkingDir: '/workspace',
          Labels: { 'dsh.owner': 'dsh-evolve-le-engine-probe' },
          HostConfig: {
            ReadonlyRootfs: true,
            ReadonlyPaths: ['/dev'],
            NetworkMode: 'none',
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges=true', `seccomp=${JSON.stringify(SECCOMP_PROFILE)}`],
            AutoRemove: false,
            RestartPolicy: { Name: 'no' },
            Memory: 256 * 1024 * 1024,
            MemorySwap: 256 * 1024 * 1024,
            PidsLimit: 64,
            Mounts: [
              { Type: 'bind', Source: input, Target: '/input', ReadOnly: true },
              { Type: 'bind', Source: workspace, Target: '/workspace' },
            ],
          },
        },
      )
      id = created.Id
      await engine.request('POST', `/containers/${id}/start`)
      const result = await engine.json<{ StatusCode: number }>(
        'POST',
        `/containers/${id}/wait?condition=not-running`,
        undefined,
        { timeoutMs: 10000 },
      )
      const logs = decodeDockerStream(
        (await engine.request('GET', `/containers/${id}/logs?stdout=true&stderr=true`)).body,
        1048576,
      )
      expect(result.StatusCode, logs.stderr.toString()).toBe(0)
      expect(JSON.parse(logs.stdout.toString())).toEqual({ shared: 'agent', readonly: true })
      expect(await readFile(join(workspace, 'shell.txt'), 'utf8')).toBe('agent')
    } finally {
      if (id) {
        await engine.request('POST', `/containers/${id}/kill?signal=KILL`).catch(() => undefined)
        await engine.request('DELETE', `/containers/${id}?force=false&v=false`)
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
  it('executes foreground shell in the same domain and kills the domain on a detached descendant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-shell-probe-'))
    const input = join(root, 'input'),
      workspace = join(root, 'workspace'),
      work = join(root, 'work')
    await mkdir(join(input, 'capsule', 'runtime'), { recursive: true })
    await mkdir(join(input, 'capsule', 'runner'), { recursive: true })
    await mkdir(workspace)
    await mkdir(work)
    await cp(process.execPath, join(input, 'capsule', 'runtime', 'node'))
    await chmod(root, 0o755)
    await chmod(workspace, 0o777)
    await chmod(work, 0o777)
    await writeFile(join(input, 'capsule', 'runner', 'probe.mjs'), `setInterval(()=>{},1000)`)
    const engine = localDockerEngine(),
      spec = makeSpec()
    spec.runId = `shell-${Date.now()}`
    spec.deadlineUtc = new Date(Date.now() + 30000).toISOString()
    let id: string | undefined
    let aborted = false
    try {
      const created = await engine.json<{ Id: string }>(
        'POST',
        `/containers/create?name=${executionName(spec)}`,
        {
          Image: 'ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55',
          User: '65532:65532',
          Entrypoint: ['/input/capsule/runtime/node', '/input/capsule/runner/probe.mjs'],
          Cmd: [],
          Env: ['PATH=/usr/bin:/bin'],
          WorkingDir: '/workspace',
          Labels: { 'dsh.owner': 'dsh-evolve-le-engine-probe' },
          HostConfig: {
            ReadonlyRootfs: true,
            ReadonlyPaths: ['/dev'],
            NetworkMode: 'none',
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges=true', `seccomp=${JSON.stringify(SECCOMP_PROFILE)}`],
            AutoRemove: false,
            RestartPolicy: { Name: 'no' },
            Memory: 256 * 1024 * 1024,
            MemorySwap: 256 * 1024 * 1024,
            PidsLimit: 64,
            Mounts: [
              { Type: 'bind', Source: input, Target: '/input', ReadOnly: true },
              { Type: 'bind', Source: workspace, Target: '/workspace' },
              { Type: 'bind', Source: work, Target: '/work' },
            ],
          },
        },
      )
      id = created.Id
      await engine.request('POST', `/containers/${id}/start`)
      const store = await openObjectStore(join(root, 'cas'))
      const shell = new ContainerShell({
        engine,
        store,
        async abort() {
          aborted = true
          const actual = await engine.json<{ State: { Paused: boolean } }>(
            'GET',
            `/containers/${id}/json`,
          )
          if (actual.State.Paused) await engine.request('POST', `/containers/${id}/unpause`)
          await engine.request('POST', `/containers/${id}/kill?signal=KILL`)
          await engine.json('POST', `/containers/${id}/wait?condition=not-running`)
        },
      })
      const result = await shell.run(spec, {
        command: 'echo shared > authored.txt; cat authored.txt',
        cwd: '/workspace',
        timeoutMs: 5000,
        invocationId: 'shell-1',
      })
      expect((await store.read(result.stdout)).toString()).toBe('shared\n')
      expect(result.exitCode).toBe(0)
      expect(aborted).toBe(false)
      await expect(
        shell.run(spec, {
          command: 'sleep 60 </dev/null >/dev/null 2>&1 &',
          cwd: '/workspace',
          timeoutMs: 5000,
          invocationId: 'shell-2',
        }),
      ).rejects.toThrow(/descendants/)
      expect(aborted).toBe(true)
      const actual = await engine.json<{ State: { Running: boolean } }>(
        'GET',
        `/containers/${id}/json`,
      )
      expect(actual.State.Running).toBe(false)
    } finally {
      if (id) {
        await engine.request('POST', `/containers/${id}/kill?signal=KILL`).catch(() => undefined)
        await engine.request('DELETE', `/containers/${id}?force=false&v=false`)
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)

  it('checks the real create/inspect configuration without launching on an incompatible host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-config-probe-'))
    const spec = makeSpec()
    spec.runId = `config-${Date.now()}`
    spec.image = {
      reference: 'ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55',
      id: 'sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55',
      platform: 'linux/amd64',
    }
    for (const mount of spec.mounts) {
      mount.source = join(root, mount.target.slice(1))
      await mkdir(mount.source)
    }
    const security = {
      seccompJson: JSON.stringify(SECCOMP_PROFILE),
      apparmorProfile: 'dsh-proposal-v1',
      cgroupParent: '/dsh-executor',
    }
    const engine = localDockerEngine()
    let id: string | undefined
    try {
      const created = await engine.json<{ Id: string }>(
        'POST',
        `/containers/create?name=${executionName(spec)}`,
        buildContainerConfig(spec, security),
      )
      id = created.Id
      const actual = await engine.json('GET', `/containers/${id}/json`)
      assertContainerConfig(spec, security, actual)
      expect((actual.State as { Status: string }).Status).toBe('created')
    } finally {
      if (id) await engine.request('DELETE', `/containers/${id}?force=false&v=false`)
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
})
