import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { it, expect } from 'vitest'
import { canonicalHash, canonicalJson } from '../../src/state/canonical.js'
import { openObjectStore, type ObjectRef, type ObjectStore } from '../../src/state/object-store.js'
import { readSourceSnapshot } from '../../src/execution/snapshot.js'
import { ProposalValidatorTests } from '../../src/execution/proposal-tests.js'
import { readValidatorPair } from '../../src/execution/validator-pair.js'
import { makeSpec } from './fixtures.js'
const report = process.env.DSH_PROPOSAL_PARENT_REPORT ?? ''
it.skipIf(process.env.DSH_DOCKER_ENGINE_PROBES !== '1' || !existsSync(report))(
  'retains both real validator preflight failures as failed online feedback with independent test slots',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'proposal-tests-'))
    try {
      const document = JSON.parse(await readFile(report, 'utf8')) as {
        casRoot: string
        inputComposition: { inputs: ObjectRef[] }
      }
      const store = await openObjectStore(document.casRoot),
        refs = document.inputComposition.inputs,
        spec = makeSpec()
      spec.deadlineUtc = new Date(Date.now() + 30000).toISOString()
      const original = await readSourceSnapshot(store, refs[1]!)
      const source = await store.put(
        Buffer.from(
          canonicalJson({
            ...original,
            executionId: spec.executionId,
            specDigest: canonicalHash(spec),
            child: 'child-1',
          }),
        ),
        { mediaType: 'application/vnd.dsh-evolve-le.source-snapshot+json', label: 'DEV_OBSERVED' },
      )
      const caps = {
        slots: 1,
        memoryBytes: 1e9,
        cpuMillis: 4000,
        pids: 1024,
        bytes: 1e9,
        inodes: 100000,
      }
      const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
        dependencyClosureSha256: string
      }
      const options = {
        root: join(root, 'tests'),
        store,
        spec,
        children: ['child-1'],
        parentSnapshot: refs[2]!,
        parentCapsuleInventory: refs[3]!,
        workerInventory: refs[4]!,
        dependencyClosureSha256: lock.dependencyClosureSha256,
        profile: {
          kind: 'test' as const,
          image: spec.image,
          policy: spec.policy,
          limits: spec.limits,
          maxElapsedMs: spec.maxElapsedMs,
          hostRoot: join(root, 'host'),
          executionRoot: join(root, 'executions'),
          storeRoot: store.root,
          resourceRoot: join(root, 'resources'),
          cgroupRoot: join(root, 'not-delegated'),
          security: { seccompJson: '{}', apparmorProfile: 'not-loaded', cgroupParent: 'test' },
          pools: { proposal: caps, test: caps, validator: caps },
        },
      }
      const service = new ProposalValidatorTests(options)
      await expect(service.prepare('foreign', source)).rejects.toThrow(/allocation/)
      const planRef = await service.prepare('child-1', source)
      expect(
        (await readValidatorPair(store, planRef)).configs.every(
          (config) => config.spec.kind === 'test',
        ),
      ).toBe(true)
      const result = await service.test('child-1', source)
      expect(result.ok).toBe(false)
      expect(result.output).toContain('not Archive admission')
      const reopened = new ProposalValidatorTests(options)
      expect(await reopened.test('child-1', source)).toEqual(result)
      const receipt = JSON.parse((await store.read(result.receipt)).toString('utf8'))
      const aggregate = JSON.parse((await store.read(receipt.aggregate)).toString('utf8'))
      expect(aggregate.results).toHaveLength(2)
      expect(aggregate.status).toBe('FAILED')
      for (const ref of aggregate.results)
        expect(JSON.parse((await store.read(ref)).toString('utf8')).failure).not.toBeNull()
      const artifacts = await reopened.artifacts()
      await store.scrub(artifacts)
      if (process.env.DSH_PROPOSAL_TEST_RECEIPT)
        await writeFile(
          process.env.DSH_PROPOSAL_TEST_RECEIPT,
          JSON.stringify(
            {
              protocol: 'dsh-evolve-le/proposal-online-test-probe/v1',
              casRoot: store.root,
              plan: planRef,
              result,
              artifacts,
              scope: 'Two real preflight failures; no candidate execution, paid model or admission',
            },
            null,
            2,
          ) + '\n',
        )
      await expect(reopened.cancel()).rejects.toThrow(/cleanup unconfirmed/)
      await expect(reopened.prepare('child-1', source)).rejects.toThrow(/revoked/)
      // Pause durable plan creation at the CAS boundary while cancellation arrives.
      let release!: () => void, reached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const preparing = new Promise<void>((resolve) => {
        reached = resolve
      })
      const gatedStore: ObjectStore = {
        ...store,
        async put(bytes, metadata) {
          if (metadata.mediaType === 'application/vnd.dsh-evolve-le.validator-pair+json') {
            reached()
            await gate
          }
          return store.put(bytes, metadata)
        },
      }
      const race = new ProposalValidatorTests({
        ...options,
        store: gatedStore,
        root: join(root, 'racing-tests'),
      })
      const preparation = race.prepare('child-1', source)
      const prepared = preparation.then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      )
      await preparing
      const cancellation = race.cancel().then(
        () => ({ error: null }),
        (error) => ({ error }),
      )
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            await readFile(join(root, 'racing-tests/cancel.json'))
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      } finally {
        release()
      }
      expect((await prepared).error?.message).toMatch(/revoked/)
      expect((await cancellation).error?.message).toMatch(/unconfirmed/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  60000,
)
