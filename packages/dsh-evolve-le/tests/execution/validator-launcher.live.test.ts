import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { freezeExecutionInputs } from '../../src/execution/input-manifest.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { makeSpec } from './fixtures.js'
import { openObjectStore } from '../../src/state/object-store.js'
import {
  startValidatorSupervisor,
  readValidatorSupervisorResult,
} from '../../src/execution/validator-launcher.js'
import type { ValidatorSupervisorConfig } from '../../src/execution/validator-supervisor.js'
it.skipIf(process.env.DSH_DOCKER_ENGINE_PROBES !== '1' || process.getuid?.() !== 0)(
  'launches a real flock owner, retains preflight failure evidence, and adopts its terminal result',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'validator-launch-'))
    try {
      const storeRoot = join(root, 'cas'),
        store = await openObjectStore(storeRoot)
      const facts = await store.put(Buffer.from('{}'), {
        mediaType: 'application/json',
        label: 'CONTROLLER_INTERNAL',
      })
      const inputSource = join(root, 'input-source')
      await mkdir(inputSource)
      await writeFile(join(inputSource, 'config.json'), '{}')
      const inputManifest = await freezeExecutionInputs(
        store,
        [{ target: '/input', root: inputSource }],
        { bytes: 1024, fileBytes: 1024, inodes: 16 },
      )
      const spec = makeSpec()
      spec.kind = 'validator'
      spec.parentExecutionId = 'proposal-parent'
      delete spec.gateway
      spec.inputs = [facts, inputManifest]
      spec.policy = facts
      spec.reservation = facts
      spec.mounts = spec.mounts.filter((m) => m.target !== '/gateway')
      spec.command = [
        '/input/capsule/runtime/node',
        '/input/capsule/runner/bin/validator-worker.js',
        '/input/config.json',
      ]
      spec.deadlineUtc = new Date(Date.now() + 30000).toISOString()
      const config: ValidatorSupervisorConfig = {
        protocol: 'dsh-evolve-le/validator-supervisor/v2',
        spec,
        inputManifest,
        hostRoot: join(root, 'hosts'),
        executionRoot: join(root, 'executions'),
        resourceRoot: join(root, 'resources'),
        cgroupRoot: join(root, 'not-delegated'),
        storeRoot,
        security: { seccompJson: '{}', apparmorProfile: 'not-loaded', cgroupParent: 'test' },
        pools: {
          proposal: { slots: 1, memoryBytes: 1, cpuMillis: 1, pids: 1, bytes: 1, inodes: 1 },
          test: { slots: 1, memoryBytes: 1, cpuMillis: 1, pids: 1, bytes: 1, inodes: 1 },
          validator: { slots: 1, memoryBytes: 1, cpuMillis: 1, pids: 1, bytes: 1, inodes: 1 },
        },
        validator: {
          sourceSnapshot: facts,
          dependencyClosureSha256: 'a'.repeat(64),
          runnerSourceDir: join(root, 'trusted-lib'),
        },
      }
      const launched = await startValidatorSupervisor(config)
      expect(launched.pid).toBeGreaterThan(0)
      let result = await readValidatorSupervisorResult(config)
      const deadline = Date.now() + 15000
      while (!result && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        result = await readValidatorSupervisorResult(config)
      }
      expect(result).not.toBeNull()
      expect(result!.outcome).toBe('INCOMPLETE')
      expect(result!.execution).toBeNull()
      expect(result!.validation).toBeNull()
      expect(result!.failure).not.toBeNull()
      const reason = (await store.read(result!.failure!)).toString()
      expect(reason).toMatch(/cgroup|Docker|image|delegated|AppArmor/)
      const owner = JSON.parse(await readFile(join(launched.root, 'owners/00000001.json'), 'utf8'))
      expect(owner.pid).toBe(launched.pid)
      expect(await startValidatorSupervisor(config)).toEqual({ pid: null, root: launched.root })
      const resultPath = join(launched.root, 'validator-supervisor-result.json'),
        original = await readFile(resultPath, 'utf8')
      await writeFile(resultPath, canonicalJson({ ...result, outcome: 'SUCCEEDED' }))
      await expect(readValidatorSupervisorResult(config)).rejects.toThrow(
        /success without execution/,
      )
      await writeFile(resultPath, canonicalJson({ ...result, failure: null }))
      await expect(readValidatorSupervisorResult(config)).rejects.toThrow(/failure evidence/)
      await writeFile(resultPath, original)

      await expect(
        startValidatorSupervisor({
          ...config,
          validator: { ...config.validator, runnerSourceDir: join(root, 'changed') },
        }),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
