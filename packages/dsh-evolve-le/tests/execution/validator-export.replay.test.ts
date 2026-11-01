import { existsSync } from 'node:fs'
import { readFile, mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readCapturedTree, captureSourceSnapshot } from '../../src/execution/snapshot.js'
import { stageDeclaredSource } from '../../src/builder/staging.js'
import { captureCanonicalSource } from '../../src/candidate/canonical.js'
import { LinuxExecutionHost } from '../../src/execution/linux-host.js'
import { executionName } from '../../src/execution/types.js'
import { makeSpec } from './fixtures.js'
import { it, expect, vi } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import {
  readValidatorExport,
  verifyValidatorExport,
  type ValidatorExport,
} from '../../src/execution/validator-export.js'
const report = process.env.DSH_VALIDATOR_REPLAY_REPORT ?? ''
it.skipIf(!report || !existsSync(report))(
  'reopens externally verified capsule artifacts from durable CAS with identity checks',
  async () => {
    const document = JSON.parse(await readFile(report, 'utf8')) as {
      casRoot: string
      exports: ValidatorExport[]
    }
    const store = await openObjectStore(document.casRoot)
    expect(document.exports).toHaveLength(2)
    for (const value of document.exports) {
      const receipt = await store.put(Buffer.from(canonicalJson(value)), {
        mediaType: 'application/vnd.dsh-evolve-le.validator-export+json',
        label: 'CONTROLLER_INTERNAL',
      })
      expect(
        await readValidatorExport(store, receipt, {
          executionId: value.executionId,
          sourceDigest: value.sourceDigest,
        }),
      ).toEqual(value)
      await expect(
        readValidatorExport(store, receipt, {
          executionId: 'foreign',
          sourceDigest: value.sourceDigest,
        }),
      ).rejects.toThrow(/binding/)
    }
    // Recreate a stopped output solely from its immutable external artifacts;
    // this exercises current export code without rerunning candidate/model work.
    const root = await mkdtemp(join(tmpdir(), 'validator-cas-replay-'))
    try {
      const value = document.exports[0]!,
        workspaceRoot = join(root, 'workspace'),
        workRoot = join(root, 'work')
      await mkdir(workRoot, { recursive: true })
      await mkdir(join(workspaceRoot, 'build/capsule'), { recursive: true })
      const tree = await readCapturedTree(store, value.capsuleInventory)
      for (const file of tree.files) {
        const target = join(workspaceRoot, 'build/capsule', file.path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, await store.read(file.content), { mode: file.mode })
      }
      for (const [path, ref] of [
        ['build/capsule.tar', value.capsuleTar],
        ['build/capsule.tar.gz', value.capsuleArchive],
        ['build/build-manifest.json', value.buildManifest],
      ] as const)
        await writeFile(join(workspaceRoot, path), await store.read(ref))
      await writeFile(join(workRoot, 'validator-result.json'), await store.read(value.diagnostic))
      await stageDeclaredSource(resolve('packages/candidate-baseline'), join(root, 'source'))
      const source = await captureCanonicalSource(join(root, 'source')),
        lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
          dependencyClosureSha256: string
        }
      const options = {
        executionId: value.executionId,
        workspaceRoot,
        workRoot,
        source,
        store,
        dependencyClosureSha256: lock.dependencyClosureSha256,
        runnerSourceDir: resolve('packages/dsh-evolve-le/lib'),
        limits: {
          bytes: 512 * 1024 * 1024,
          fileBytes: 160 * 1024 * 1024,
          inodes: 32768,
          diagnosticBytes: 2 * 1024 * 1024,
        },
      }
      expect((await verifyValidatorExport(options)).value).toEqual(value)
      await expect(
        verifyValidatorExport({ ...options, dependencyClosureSha256: '0'.repeat(64) }),
      ).rejects.toThrow(/closure/)
      // Production host export uses the same captured snapshot and includes
      // the verified receipt in its artifact set. Sampling is simulated here;
      // this is an export replay, not a host-platform acceptance test.
      const parent = makeSpec(),
        spec = makeSpec()
      const snapshot = await captureSourceSnapshot({
        root: join(root, 'source'),
        spec: parent,
        store,
        child: 'child-1',
      })
      spec.kind = 'validator'
      spec.executionId = value.executionId
      spec.parentExecutionId = parent.executionId
      spec.inputs = [snapshot]
      delete spec.gateway
      spec.limits.workspace = { bytes: options.limits.bytes, inodes: options.limits.inodes }
      spec.limits.fileBytes = options.limits.fileBytes
      spec.limits.outputBytes = options.limits.diagnosticBytes
      const hostRoot = join(root, 'host'),
        executionRoot = join(hostRoot, executionName(spec))
      await mkdir(executionRoot, { recursive: true })
      await rename(workspaceRoot, join(executionRoot, 'workspace'))
      await rename(workRoot, join(executionRoot, 'work'))
      const host = new LinuxExecutionHost({
        root: hostRoot,
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
        validator: {
          sourceSnapshot: snapshot,
          dependencyClosureSha256: lock.dependencyClosureSha256,
          runnerSourceDir: options.runnerSourceDir,
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
      const exported = await host.export(spec, 'SUCCEEDED')
      expect(exported.outcome).toBe('SUCCEEDED')
      const marker = JSON.parse(
        await readFile(join(executionRoot, 'validator-export.json'), 'utf8'),
      )
      expect(exported.artifacts.some((ref) => ref.digest === marker.digest)).toBe(true)
      expect(
        await readValidatorExport(store, marker, {
          executionId: spec.executionId,
          sourceDigest: value.sourceDigest,
        }),
      ).toEqual(value)
      expect((await host.export({ ...spec, inputs: [] }, 'SUCCEEDED')).outcome).toBe('FAILED')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  180000,
)
