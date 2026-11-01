import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { captureSourceSnapshot } from '../../src/execution/snapshot.js'
import { composeValidatorInputs } from '../../src/execution/validator-input.js'
import { canonicalHash } from '../../src/state/canonical.js'
import { makeSpec } from './fixtures.js'
it('rejects a snapshot from a different proposal or child before accepting runtime inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'validator-input-'))
  try {
    const store = await openObjectStore(join(root, 'cas')),
      source = join(root, 'source')
    await mkdir(source)
    await writeFile(join(source, 'index.ts'), 'export {}')
    const spec = makeSpec(),
      snapshot = await captureSourceSnapshot({ root: source, store, spec, child: 'child-1' })
    const options = {
      store,
      sourceSnapshot: snapshot,
      parentSnapshot: snapshot,
      parentCapsuleInventory: snapshot,
      workerInventory: snapshot,
      proposalExecutionId: 'foreign',
      proposalSpecDigest: canonicalHash(spec),
      child: 'child-1',
      dependencyClosureSha256: 'a'.repeat(64),
    }
    await expect(composeValidatorInputs(options)).rejects.toThrow(/proposal/)
    await expect(
      composeValidatorInputs({
        ...options,
        proposalExecutionId: spec.executionId,
        child: 'another',
      }),
    ).rejects.toThrow(/child/)
    await expect(
      composeValidatorInputs({
        ...options,
        proposalExecutionId: spec.executionId,
        proposalSpecDigest: '0'.repeat(64),
      }),
    ).rejects.toThrow(/spec digest/)
    await expect(
      composeValidatorInputs({ ...options, sourceSnapshot: { ...snapshot, label: 'SEALED' } }),
    ).rejects.toThrow(/sealed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
