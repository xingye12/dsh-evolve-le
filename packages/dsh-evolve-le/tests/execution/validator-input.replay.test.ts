import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { it, expect } from 'vitest'
import { openObjectStore, type ObjectRef } from '../../src/state/object-store.js'
import { readSourceSnapshot } from '../../src/execution/snapshot.js'
import { composeValidatorInputs } from '../../src/execution/validator-input.js'
const report = process.env.DSH_VALIDATOR_COMPOSITION_REPORT ?? ''
it.skipIf(!report || !existsSync(report))(
  'recomposes the exact real-validator input graph from retained CAS evidence',
  async () => {
    const document = JSON.parse(await readFile(report, 'utf8')) as {
      casRoot: string
      inputComposition: { inputManifest: ObjectRef; sourceDigest: string; inputs: ObjectRef[] }
    }
    const store = await openObjectStore(document.casRoot),
      refs = document.inputComposition.inputs
    const source = await readSourceSnapshot(store, refs[1]!),
      lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
        dependencyClosureSha256: string
      }
    const options = {
      store,
      sourceSnapshot: refs[1]!,
      parentSnapshot: refs[2]!,
      parentCapsuleInventory: refs[3]!,
      workerInventory: refs[4]!,
      proposalExecutionId: source.executionId,
      proposalSpecDigest: source.specDigest,
      child: source.child,
      dependencyClosureSha256: lock.dependencyClosureSha256,
    }
    expect((await composeValidatorInputs(options)).inputManifest).toEqual(
      document.inputComposition.inputManifest,
    )
    await expect(
      composeValidatorInputs({ ...options, proposalSpecDigest: '0'.repeat(64) }),
    ).rejects.toThrow(/spec digest/)
  },
  120000,
)
