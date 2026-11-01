import { readExecutionCancellation } from '../../src/execution/cancellation.js'
import { executionName } from '../../src/execution/types.js'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { captureSourceSnapshot } from '../../src/execution/snapshot.js'
import {
  prepareValidatorPair,
  readValidatorPair,
  collectValidatorPair,
  cancelValidatorPair,
} from '../../src/execution/validator-pair.js'
import { makeSpec } from './fixtures.js'
it('freezes two independent domains and refuses duplicate executors or a result without both executions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'validator-pair-'))
  try {
    const store = await openObjectStore(join(root, 'cas')),
      parent = makeSpec(),
      source = join(root, 'source')
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
      storeRoot: join(root, 'cas'),
      resourceRoot: join(root, 'resources'),
      cgroupRoot: join(root, 'cgroup'),
      security: { seccompJson: '{}', apparmorProfile: 'test', cgroupParent: 'test' },
      pools: { proposal: caps, test: caps, validator: caps },
    }
    const frozenDeadline = parent.deadlineUtc
    const pending = prepareValidatorPair({
      store,
      parent,
      child: 'child-1',
      sourceSnapshot: snapshot,
      dependencyClosureSha256: 'a'.repeat(64),
      inputManifest: snapshot,
      inputs: [snapshot],
      profile,
    })
    parent.deadlineUtc = '2030-01-01T00:00:00.000Z'
    const ref = await pending
    const plan = await readValidatorPair(store, ref)
    expect(plan.configs).toHaveLength(2)
    expect(plan.configs[0]!.spec.executionId).not.toBe(plan.configs[1]!.spec.executionId)
    expect(plan.configs[0]!.spec.mounts.find((m) => m.target === '/workspace')!.source).not.toBe(
      plan.configs[1]!.spec.mounts.find((m) => m.target === '/workspace')!.source,
    )
    expect(
      plan.configs.every((c) => c.spec.deadlineUtc === frozenDeadline && !c.spec.gateway),
    ).toBe(true)
    expect(await collectValidatorPair(store, ref)).toBeNull()
    await cancelValidatorPair(store, ref, 'parent cancelled')
    for (const config of plan.configs)
      expect(
        await readExecutionCancellation(
          join(config.hostRoot, executionName(config.spec)),
          config.spec,
        ),
      ).toBe('parent cancelled')
    expect(await collectValidatorPair(store, ref)).toBeNull()
    const testPair = await prepareValidatorPair({
      store,
      parent: { ...parent, deadlineUtc: frozenDeadline },
      child: 'child-1',
      sourceSnapshot: snapshot,
      dependencyClosureSha256: 'a'.repeat(64),
      inputManifest: snapshot,
      inputs: [snapshot],
      profile: { ...profile, kind: 'test' },
    })
    const testPlan = await readValidatorPair(store, testPair)
    expect(testPlan.configs.every((config) => config.spec.kind === 'test')).toBe(true)
    expect(testPlan.configs[0].spec.executionId).not.toBe(plan.configs[0].spec.executionId)
    const corrupt = await store.put(
      Buffer.from(canonicalJson({ ...plan, configs: [plan.configs[0], plan.configs[0]] })),
      { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
    )
    await expect(readValidatorPair(store, corrupt)).rejects.toThrow(/independent/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
