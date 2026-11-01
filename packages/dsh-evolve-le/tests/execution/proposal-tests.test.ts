import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { captureSourceSnapshot } from '../../src/execution/snapshot.js'
import {
  ProposalValidatorTests,
  type ProposalTestOptions,
} from '../../src/execution/proposal-tests.js'
import { canonicalHash, canonicalJson } from '../../src/state/canonical.js'
import { makeSpec, ref } from './fixtures.js'
it('refuses cross-execution snapshots and persistently revokes tests before launching validators', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-tests-guard-'))
  try {
    const store = await openObjectStore(join(root, 'cas')),
      spec = makeSpec(),
      sourceRoot = join(root, 'source')
    await mkdir(sourceRoot)
    await writeFile(join(sourceRoot, 'index.ts'), 'export {}')
    const snapshot = await captureSourceSnapshot({
      root: sourceRoot,
      store,
      spec,
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
    const options: ProposalTestOptions = {
      root: join(root, 'tests'),
      store,
      spec,
      children: ['child-1'],
      parentSnapshot: ref,
      parentCapsuleInventory: ref,
      workerInventory: ref,
      dependencyClosureSha256: 'a'.repeat(64),
      profile: {
        kind: 'test',
        image: spec.image,
        policy: ref,
        limits: spec.limits,
        maxElapsedMs: spec.maxElapsedMs,
        hostRoot: join(root, 'host'),
        executionRoot: join(root, 'executions'),
        storeRoot: store.root,
        resourceRoot: join(root, 'resources'),
        cgroupRoot: join(root, 'cgroup'),
        security: { seccompJson: '{}', apparmorProfile: 'test', cgroupParent: 'test' },
        pools: { proposal: caps, test: caps, validator: caps },
      },
    }
    expect(
      () =>
        new ProposalValidatorTests({
          ...options,
          profile: { ...options.profile, kind: 'validator' },
        }),
    ).toThrow(/independent test pool/)
    const foreign = new ProposalValidatorTests({
      ...options,
      spec: { ...spec, executionId: 'foreign' },
    })
    await expect(foreign.prepare('child-1', snapshot)).rejects.toThrow(/execution mismatch/)
    const service = new ProposalValidatorTests(options)
    await service.cancel()
    const replay = new ProposalValidatorTests(options)
    await expect(replay.prepare('child-1', snapshot)).rejects.toThrow(/revoked/)
    expect(await replay.artifacts()).toEqual([])
    const foreignSnapshot = await captureSourceSnapshot({
      root: sourceRoot,
      store,
      spec: { ...spec, executionId: 'foreign' },
      child: 'child-1',
    })
    const wrongIntent = await store.put(
      Buffer.from(
        canonicalJson({
          protocol: 'dsh-evolve-le/proposal-test-intent/v1',
          specDigest: canonicalHash(spec),
          child: 'child-1',
          source: foreignSnapshot,
          parentSnapshot: ref,
          parentCapsuleInventory: ref,
          workerInventory: ref,
          dependencyClosureSha256: 'a'.repeat(64),
          profile: options.profile,
        }),
      ),
      { mediaType: 'application/vnd.dsh-evolve-le.proposal-test+json', label: 'DEV_OBSERVED' },
    )
    const auditRoot = join(root, 'audit', wrongIntent.digest)
    await mkdir(auditRoot, { recursive: true })
    await writeFile(join(auditRoot, 'intent.json'), canonicalJson(wrongIntent))
    const auditor = new ProposalValidatorTests({ ...options, root: join(root, 'audit') })
    await expect(auditor.artifacts()).rejects.toThrow(/snapshot.*binding/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
