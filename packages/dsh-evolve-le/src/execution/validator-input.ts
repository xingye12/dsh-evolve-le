import { readTrustedRuntimeInputs } from './runtime-input.js'
/** Assemble validator inputs from immutable evidence. No candidate import or build on host. */
import { canonicalJson, sha256Hex } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { buildCanonicalTar } from '../candidate/canonical.js'
import type { BuildInput } from '../builder/pipeline.js'
import { readSourceSnapshot, type SourceSnapshot } from './snapshot.js'
import { publishExecutionInputs } from './input-manifest.js'
import { ExecutionError } from './types.js'
type Files = SourceSnapshot['files']
export async function composeValidatorInputs(options: {
  store: ObjectStore
  sourceSnapshot: ObjectRef
  parentSnapshot: ObjectRef
  /** Must be selected by trusted Archive/controller code, never by a child. */
  parentCapsuleInventory: ObjectRef
  workerInventory: ObjectRef
  proposalExecutionId: string
  proposalSpecDigest: string
  child: string
  dependencyClosureSha256: string
  treeV2ParentEvidence?: BuildInput['treeV2ParentEvidence']
}): Promise<{
  inputManifest: ObjectRef
  sourceDigest: string
  parentSourceDigest: string
  inputs: ObjectRef[]
}> {
  for (const ref of [
    options.sourceSnapshot,
    options.parentSnapshot,
    options.parentCapsuleInventory,
    options.workerInventory,
  ]) {
    validateRef(ref)
    if (ref.label === 'DEV_GUARD' || ref.label === 'SEALED')
      throw new ExecutionError('guard/sealed validator input forbidden')
  }
  const { store } = options,
    source = await readSourceSnapshot(store, options.sourceSnapshot)
  if (source.executionId !== options.proposalExecutionId)
    throw new ExecutionError('validator source belongs to another proposal execution')
  if (source.specDigest !== options.proposalSpecDigest)
    throw new ExecutionError('validator source proposal spec digest mismatch')
  if (source.child !== options.child)
    throw new ExecutionError('validator source belongs to another child')
  if (!/^[a-f0-9]{64}$/.test(options.dependencyClosureSha256))
    throw new ExecutionError('invalid frozen validator dependency closure')
  const sourceFiles = await Promise.all(
    source.files.map(async (file) => ({
      path: file.path,
      mode: file.mode,
      content: await store.read(file.content),
    })),
  )
  const sourceDigest = `sha256:${sha256Hex(buildCanonicalTar(sourceFiles))}`
  const { parent, capsule, worker, parentSourceDigest } = await readTrustedRuntimeInputs(options)
  if (
    !worker.files.some((f) => f.path === 'bin/validator-worker.js') ||
    !worker.files.some((f) => f.path === 'schema.js')
  )
    throw new ExecutionError('trusted worker closure lacks validator entry/schema')
  const files: Files = []
  const append = (base: string, entries: Files) => {
    for (const file of entries) files.push({ ...file, path: base + file.path })
  }
  append('source/', source.files)
  append('parent/', parent.files)
  // Select the parent's immutable runtime closure; its original self-describing
  // capsule remains unchanged in CAS. The worker overlay is independently pinned.
  append(
    'capsule/',
    capsule.files.filter(
      (f) =>
        f.path.startsWith('node_modules/') ||
        ['runtime/node', 'runtime/install-manifest.json', 'candidate/package.json'].includes(
          f.path,
        ),
    ),
  )
  append('capsule/runner/', worker.files)
  if (!worker.files.some((f) => f.path === 'package.json'))
    files.push({
      path: 'capsule/runner/package.json',
      mode: 0o644,
      content: await store.put(Buffer.from('{"type":"module"}\n'), {
        mediaType: 'application/json',
        label: 'CONTROLLER_INTERNAL',
      }),
    })
  const config = {
    protocol: 'dsh-evolve-le/validator/v1',
    sourceDigest,
    dependencyClosureSha256: options.dependencyClosureSha256,
    ...(options.treeV2ParentEvidence === undefined
      ? {}
      : { treeV2ParentEvidence: options.treeV2ParentEvidence }),
  }
  files.push({
    path: 'config.json',
    mode: 0o644,
    content: await store.put(Buffer.from(JSON.stringify(config) + '\n'), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    }),
  })
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const inventory = await store.put(
    Buffer.from(
      canonicalJson({ files, totalBytes: files.reduce((n, f) => n + f.content.size, 0) }),
    ),
    {
      mediaType: 'application/vnd.dsh-evolve-le.artifact-inventory+json',
      label: 'CONTROLLER_INTERNAL',
    },
  )
  const inputManifest = await publishExecutionInputs(store, [{ target: '/input', inventory }])
  return {
    inputManifest,
    sourceDigest,
    parentSourceDigest,
    inputs: [
      inputManifest,
      options.sourceSnapshot,
      options.parentSnapshot,
      options.parentCapsuleInventory,
      options.workerInventory,
    ],
  }
}
