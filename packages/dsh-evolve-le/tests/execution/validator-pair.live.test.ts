import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { captureSourceSnapshot } from '../../src/execution/snapshot.js'
import {
  prepareValidatorPair,
  startNextValidator,
  collectValidatorPair,
  readValidatorPair,
} from '../../src/execution/validator-pair.js'
import { makeSpec } from './fixtures.js'
it.skipIf(process.env.DSH_DOCKER_ENGINE_PROBES !== '1' || process.getuid?.() !== 0)(
  'schedules two real standalone preflight failures and retains both rather than selecting a survivor',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'validator-pair-live-'))
    try {
      const store = await openObjectStore(join(root, 'cas')),
        parent = makeSpec(),
        source = join(root, 'source')
      parent.deadlineUtc = new Date(Date.now() + 30000).toISOString()
      await mkdir(source)
      await writeFile(join(source, 'index.ts'), 'export {}')
      const snapshot = await captureSourceSnapshot({
        root: source,
        store,
        spec: parent,
        child: 'child-1',
      })
      const caps = {
        slots: 1,
        memoryBytes: 1e9,
        cpuMillis: 4000,
        pids: 1024,
        bytes: 1e9,
        inodes: 100000,
      }
      const profile = {
        image: parent.image,
        policy: parent.policy,
        limits: parent.limits,
        maxElapsedMs: parent.maxElapsedMs,
        hostRoot: join(root, 'host'),
        executionRoot: join(root, 'executions'),
        storeRoot: store.root,
        resourceRoot: join(root, 'resources'),
        cgroupRoot: join(root, 'not-delegated'),
        security: { seccompJson: '{}', apparmorProfile: 'not-loaded', cgroupParent: 'test' },
        pools: { proposal: caps, test: caps, validator: caps },
      }
      const plan = await prepareValidatorPair({
        store,
        parent,
        child: 'child-1',
        sourceSnapshot: snapshot,
        dependencyClosureSha256: 'a'.repeat(64),
        inputManifest: snapshot,
        inputs: [snapshot],
        profile,
      })
      let result = await collectValidatorPair(store, plan)
      const deadline = Date.now() + 20000
      while (!result && Date.now() < deadline) {
        await startNextValidator(store, plan)
        await new Promise((r) => setTimeout(r, 100))
        result = await collectValidatorPair(store, plan)
      }
      expect(result).not.toBeNull()
      const summary = JSON.parse((await store.read(result!)).toString('utf8'))
      expect(summary.status).toBe('FAILED')
      expect(summary.results).toHaveLength(2)
      expect(summary.validations).toEqual([null, null])
      for (const ref of summary.results) {
        const entry = JSON.parse((await store.read(ref)).toString('utf8'))
        expect(entry.execution).toBeNull()
        expect(entry.failure).not.toBeNull()
      }
      expect(await startNextValidator(store, plan)).toBeNull()
      expect(await collectValidatorPair(store, plan)).toEqual(result)
      const configs = (await readValidatorPair(store, plan)).configs
      expect(configs[0].spec.executionId).not.toBe(configs[1].spec.executionId)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
