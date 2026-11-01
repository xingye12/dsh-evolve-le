/** Real flock/CLI/CAS bootstrap rejection. This intentionally does not authorize a Docker worker. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it, expect } from 'vitest'
import { openObjectStore, type ObjectRef } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { captureBoundedTree } from '../../src/execution/snapshot.js'
import { composeProposalInputs } from '../../src/execution/proposal-input.js'
import { readFrozenGeneration } from '../../src/execution/proposal-generation-process.js'
import { executionName } from '../../src/execution/types.js'
import { makeProposalConfig } from './fixtures.js'
const exec = promisify(execFile)
const report = process.env.DSH_GENERATION_INPUT_REPORT
it.skipIf(!report)(
  'rejects incompatible host before model dispatch, records failure and refuses blind relaunch',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'generation-bootstrap-'))
    try {
      const source = JSON.parse(await readFile(report!, 'utf8'))
      const store = await openObjectStore(source.casRoot)
      const put = (value: unknown) =>
        store.put(Buffer.from(canonicalJson(value)), {
          mediaType: 'application/json',
          label: 'CONTROLLER_INTERNAL',
        })
      const refs: ObjectRef[] = source.result.inputs
      const workerInventory = await put(
        await captureBoundedTree({
          root: resolve('packages/dsh-evolve-le/lib'),
          store,
          limits: { bytes: 32 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, inodes: 8192 },
        }),
      )
      const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8'))
      const worker = {
        ...source.config,
        executionId: 'generation-bootstrap',
        width: 1,
        generationOnly: true,
      }
      const input = await composeProposalInputs({
        store,
        parentSnapshot: refs[1]!,
        parentCapsuleInventory: refs[2]!,
        workerInventory,
        dependencyClosureSha256: lock.dependencyClosureSha256,
        config: worker,
        catalog: refs[4]!,
        evidenceInventory: refs[5]!,
      })
      const route = await put({
        protocol: 'dsh-evolve-le/model-replay/v1',
        provider: worker.provider,
        model: worker.model,
        responses: [{ responseText: 'must never dispatch', promptTokens: 1, completionTokens: 1 }],
      })
      const { tests: _tests, ...base } = makeProposalConfig()
      const config = {
        ...base,
        protocol: 'dsh-evolve-le/proposal-generation/v1',
        hostRoot: join(root, 'host'),
        executionRoot: join(root, 'executions'),
        resourceRoot: join(root, 'resources'),
        cgroupRoot: join(root, 'not-delegated'),
        storeRoot: store.root,
        inputManifest: input.inputManifest,
        model: { ...base.model, mode: 'replay', route },
        spec: {
          ...base.spec,
          executionId: worker.executionId,
          inputs: input.inputs,
          deadlineUtc: new Date(Date.now() + 60000).toISOString(),
          gateway: { route, authorization: route },
        },
      }
      for (const mount of config.spec.mounts)
        mount.source = join(
          config.hostRoot,
          executionName(config.spec),
          mount.target === '/gateway' ? 'ipc' : mount.target.slice(1),
        )
      const configPath = join(root, 'config.json')
      await writeFile(configPath, canonicalJson(config), { mode: 0o600 })
      const cli = resolve('packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js')
      await expect(
        exec(process.execPath, [cli, 'run', configPath], { timeout: 30000 }),
      ).rejects.toMatchObject({ code: 1 })
      const first = await readFrozenGeneration(config)
      expect(first.result.outcome).toBe('INCOMPLETE')
      expect(first.result.execution).toBeNull()
      expect(first.result.submission).toBeNull()
      const attempt = join(config.hostRoot, executionName(config.spec))
      expect(
        await readdir(join(attempt, 'models')).catch((error) =>
          error.code === 'ENOENT' ? [] : Promise.reject(error),
        ),
      ).toEqual([])
      await expect(
        exec(process.execPath, [cli, 'run', configPath], { timeout: 30000 }),
      ).rejects.toMatchObject({ code: 1 })
      expect(await readFrozenGeneration(config)).toEqual(first)
      const read = await exec(process.execPath, [cli, 'read', configPath], { timeout: 30000 })
      expect(JSON.parse(read.stdout).result).toEqual(first.result)
      await expect(
        readFrozenGeneration({
          ...config,
          model: {
            ...config.model,
            limits: { ...config.model.limits, maxRequests: config.model.limits.maxRequests + 1 },
          },
        }),
      ).rejects.toThrow(/drift/)
      // No execution effects were registered, so sweep must not claim anything was reclaimed.
      await expect(
        exec(process.execPath, [cli, 'sweep', configPath], { timeout: 30000 }),
      ).rejects.toMatchObject({ code: 1 })
      const output = process.env.DSH_GENERATION_BOOTSTRAP_REPORT
      if (output)
        await writeFile(
          output,
          JSON.stringify(
            {
              scope: 'real CLI/flock/CAS preflight rejection only; zero worker/model dispatch',
              casRoot: store.root,
              config,
              result: first,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  240000,
)
