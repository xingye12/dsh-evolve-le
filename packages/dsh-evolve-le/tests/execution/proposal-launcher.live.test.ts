/** Detached owner bootstrap probe, deliberately rejected before target dispatch. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { canonicalJson } from '../../src/state/canonical.js'
import { openObjectStore, type ObjectRef } from '../../src/state/object-store.js'
import {
  startProposalSupervisor,
  collectProposalSupervisor,
} from '../../src/execution/proposal-launcher.js'
import { readProposalProcessState } from '../../src/execution/proposal-process.js'
import { validateProposalSupervisorConfig } from '../../src/execution/proposal-config.js'
import { executionName } from '../../src/execution/types.js'
import { makeSpec } from './fixtures.js'
const report = process.env.DSH_PROPOSAL_INPUT_REPORT ?? ''
it.skipIf(process.env.DSH_DOCKER_ENGINE_PROBES !== '1' || !existsSync(report))(
  'launches one kernel-owned proposer, preserves preflight failure and refuses a blind model relaunch',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'proposal-launch-'))
    try {
      const input = JSON.parse(await readFile(report, 'utf8')) as {
        casRoot: string
        result: { inputManifest: ObjectRef; inputs: ObjectRef[] }
        config: { executionId: string; provider: string; model: string }
      }
      const store = await openObjectStore(input.casRoot)
      const facts = await store.put(Buffer.from('{}'), {
        mediaType: 'application/json',
        label: 'CONTROLLER_INTERNAL',
      })
      const route = await store.put(
        Buffer.from(
          canonicalJson({
            protocol: 'dsh-evolve-le/model-replay/v1',
            provider: input.config.provider,
            model: input.config.model,
            responses: [{ responseText: 'unused', promptTokens: 1, completionTokens: 1 }],
          }),
        ),
        { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
      )
      const spec = makeSpec()
      spec.executionId = input.config.executionId
      spec.deadlineUtc = new Date(Date.now() + 60000).toISOString()
      spec.command = [
        '/input/capsule/runtime/node',
        '/input/capsule/runner/bin/docker-proposer-worker.js',
        '/input/config.json',
      ]
      spec.inputs = input.result.inputs
      spec.policy = facts
      spec.reservation = facts
      spec.gateway = { route, authorization: facts }
      const host = {
        hostRoot: join(root, 'host'),
        executionRoot: join(root, 'executions'),
        storeRoot: store.root,
        resourceRoot: join(root, 'resources'),
        cgroupRoot: join(root, 'not-delegated'),
        security: { seccompJson: '{}', apparmorProfile: 'not-loaded', cgroupParent: 'test' },
        pools: {
          proposal: {
            slots: 1,
            memoryBytes: 1e9,
            cpuMillis: 4000,
            pids: 1024,
            bytes: 1e9,
            inodes: 100000,
          },
          test: {
            slots: 1,
            memoryBytes: 1e9,
            cpuMillis: 4000,
            pids: 1024,
            bytes: 1e9,
            inodes: 100000,
          },
          validator: {
            slots: 1,
            memoryBytes: 1e9,
            cpuMillis: 4000,
            pids: 1024,
            bytes: 1e9,
            inodes: 100000,
          },
        },
      }
      for (const mount of spec.mounts)
        mount.source = join(
          host.hostRoot,
          executionName(spec),
          mount.target === '/gateway' ? 'ipc' : mount.target.slice(1),
        )
      const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
        dependencyClosureSha256: string
      }
      const config = validateProposalSupervisorConfig({
        protocol: 'dsh-evolve-le/proposal-supervisor/v1',
        ...host,
        spec,
        inputManifest: input.result.inputManifest,
        model: {
          provider: input.config.provider,
          model: input.config.model,
          route,
          limits: {
            maxRequests: 8,
            maxInputTokens: 8192,
            maxOutputTokens: 1024,
            maxTotalTokens: 100000,
            maxCostUsdMicros: 1,
            maxRequestBytes: 1048576,
            inputUsdMicrosPerMillion: 0,
            outputUsdMicrosPerMillion: 0,
          },
        },
        tests: {
          parentSnapshot: spec.inputs[1],
          parentCapsuleInventory: spec.inputs[2],
          workerInventory: spec.inputs[3],
          dependencyClosureSha256: lock.dependencyClosureSha256,
          profile: {
            ...host,
            kind: 'test',
            image: spec.image,
            policy: facts,
            limits: spec.limits,
            maxElapsedMs: spec.maxElapsedMs,
          },
        },
      })
      const target = join(root, 'untrusted-store'),
        alias = join(root, 'store-alias')
      await mkdir(target)
      await symlink(target, alias)
      await expect(
        startProposalSupervisor({
          ...config,
          storeRoot: alias,
          tests: { ...config.tests, profile: { ...config.tests.profile, storeRoot: alias } },
        }),
      ).rejects.toThrow(/unsafe supervisor directory/)
      await expect(readFile(join(target, 'sha256'))).rejects.toMatchObject({ code: 'ENOENT' })
      const launched = await startProposalSupervisor(config)
      expect(launched.pid).toBeGreaterThan(0)
      let state = await readProposalProcessState(config)
      const deadline = performance.now() + 20000
      while ((state.pid || !state.failures.length) && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        state = await readProposalProcessState(config)
      }
      expect(state.status).toBe('INCOMPLETE')
      expect(state.result).toBeNull()
      expect(state.pid).toBeNull()
      expect(state.failures).toHaveLength(1)
      await expect(readFile(join(launched.root, 'models'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(startProposalSupervisor(config)).rejects.toThrow(/model relaunch refused/)
      await expect(collectProposalSupervisor(config)).rejects.toThrow(/recorded execution effects/)
      await expect(
        startProposalSupervisor({
          ...config,
          model: { ...config.model, limits: { ...config.model.limits, maxRequests: 9 } },
        }),
      ).rejects.toThrow(/conflict/)
      const failure = JSON.parse((await store.read(state.failures[0]!)).toString('utf8'))
      expect(JSON.parse((await store.read(failure.configuration)).toString('utf8'))).toEqual(config)
      if (process.env.DSH_PROPOSAL_LAUNCH_RECEIPT)
        await writeFile(
          process.env.DSH_PROPOSAL_LAUNCH_RECEIPT,
          JSON.stringify(
            {
              protocol: 'dsh-evolve-le/proposal-launch-probe/v1',
              casRoot: store.root,
              configuration: failure.configuration,
              failures: state.failures,
              status: state.status,
              scope:
                'Actual detached process; preflight failure; no candidate or model dispatch; no production acceptance',
            },
            null,
            2,
          ) + '\n',
        )
      await rm(join(launched.root, 'failures'), { recursive: true, force: true })
      const missingFailureIndex = await readProposalProcessState(config)
      expect(missingFailureIndex.status).toBe('INCOMPLETE')
      expect(missingFailureIndex.failures).toEqual([])
      await expect(startProposalSupervisor(config)).rejects.toThrow(/explicit reconcile/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)
