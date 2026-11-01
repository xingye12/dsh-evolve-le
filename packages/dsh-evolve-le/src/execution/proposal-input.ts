import type { ArchiveCatalog } from '../proposer/catalog.js'
import type { ExportManifest } from '../proposer/export.js'
/** CAS-only proposal input composition. Parent selection and credential routing stay external. */
import {
  buildCanonicalTar,
  candidateIdFromDigest,
  CANONICAL_SOURCE_CAPS,
} from '../candidate/canonical.js'
import { canonicalJson, sha256Hex } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { assertNativeDshClosure } from '../dsh/native-composition.js'
import { readCapturedTree, type SourceSnapshot } from './snapshot.js'
import { readTrustedRuntimeInputs } from './runtime-input.js'
import { publishExecutionInputs, executionInputArtifacts } from './input-manifest.js'
import {
  validateProposalWorkerConfig,
  type ProposalWorkerConfig,
} from './proposal-worker-config.js'
import { assertExact, ExecutionError } from './types.js'
import { EXPORT_VERSION, merkleRootOf, PROPOSER_READ_LABELS } from '../proposer/export.js'
export async function composeProposalInputs(options: {
  store: ObjectStore
  parentSnapshot: ObjectRef
  parentCapsuleInventory: ObjectRef
  workerInventory: ObjectRef
  dependencyClosureSha256: string
  config: ProposalWorkerConfig
  catalog: ObjectRef
  /** Frozen standard evidence export, including manifest.json and objects/. */
  evidenceInventory: ObjectRef
  priorRejections?: ObjectRef
}): Promise<{ inputManifest: ObjectRef; inputs: ObjectRef[]; children: string[] }> {
  const frozen = structuredClone({ ...options, store: undefined }),
    store = options.store
  const config = validateProposalWorkerConfig(frozen.config)
  const refs = [
    frozen.parentSnapshot,
    frozen.parentCapsuleInventory,
    frozen.workerInventory,
    frozen.catalog,
    frozen.evidenceInventory,
    ...(frozen.priorRejections ? [frozen.priorRejections] : []),
  ]
  for (const ref of refs) {
    validateRef(ref)
    if (ref.label === 'DEV_GUARD' || ref.label === 'SEALED')
      throw new ExecutionError('guard/sealed proposal input forbidden')
    await store.verify(ref)
  }
  const runtime = await readTrustedRuntimeInputs({ ...frozen, store })
  if (
    config.parentSourceHash !== runtime.parentSourceDigest ||
    config.candidateId !== runtime.candidateId ||
    config.candidatePackage !== runtime.candidatePackage
  )
    throw new ExecutionError('proposal worker parent identity mismatch')
  const install = runtime.capsule.files.find((f) => f.path === 'runtime/install-manifest.json')!
  const manifest = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await store.read(install.content)),
  ) as {
    entries?: Array<{ name: string; version: string }>
    packages?: Array<{ name: string; version: string }>
  }
  const packages = manifest.entries ?? manifest.packages
  if (!Array.isArray(packages))
    throw new ExecutionError('proposal dependency inventory unavailable')
  assertNativeDshClosure(packages)
  for (const name of [
    '@deepseek-ai/dsh-shell',
    '@deepseek-ai/dsh-shell-env',
    '@deepseek-ai/dsh-tool-bash',
  ])
    if (!packages.some((p) => p.name === name && p.version === '0.1.0-rc.5'))
      throw new ExecutionError(`missing pinned shell dependency ${name}`)
  for (const path of [
    'bin/docker-proposer-worker.js',
    'execution/proposal-worker-config.js',
    'dsh/container-shell-plugin.js',
  ])
    if (!runtime.worker.files.some((f) => f.path === path))
      throw new ExecutionError(`trusted worker closure missing ${path}`)
  const files: SourceSnapshot['files'] = []
  const append = (prefix: string, entries: SourceSnapshot['files']) => {
    for (const file of entries) files.push({ ...file, path: prefix + file.path })
  }
  append('parent/', runtime.parent.files)
  append(
    'capsule/',
    runtime.capsule.files.filter((f) =>
      ['runtime/', 'candidate/', 'node_modules/'].some((prefix) => f.path.startsWith(prefix)),
    ),
  )
  append('capsule/runner/', runtime.worker.files)
  const put = (bytes: Buffer) =>
    store.put(bytes, { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' })
  if (!runtime.worker.files.some((f) => f.path === 'package.json'))
    files.push({
      path: 'capsule/runner/package.json',
      mode: 0o644,
      content: await put(Buffer.from('{"type":"module"}\n')),
    })
  files.push(
    { path: 'config.json', mode: 0o644, content: await put(Buffer.from(canonicalJson(config))) },
    { path: 'archive-catalog.json', mode: 0o644, content: frozen.catalog },
    {
      path: 'parent-files.json',
      mode: 0o644,
      content: await put(Buffer.from(canonicalJson(runtime.parent.files.map((file) => file.path)))),
    },
    ...(frozen.priorRejections
      ? [{ path: 'prior-rejections.json', mode: 0o644, content: frozen.priorRejections }]
      : []),
  )
  const evidence = await readCapturedTree(store, frozen.evidenceInventory)
  const manifestFile = evidence.files.find((file) => file.path === 'manifest.json')
  if (!manifestFile) throw new ExecutionError('proposal export manifest missing')
  const exported: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await store.read(manifestFile.content)),
  )
  assertExact(exported, [
    'schemaVersion',
    'exportVersion',
    'exportId',
    'principal',
    'purpose',
    'allowedLabels',
    'objects',
    'createdFromStateHash',
    'merkleRoot',
    'canaryAbsence',
  ])
  if (
    exported.schemaVersion !== 1 ||
    exported.exportVersion !== EXPORT_VERSION ||
    !Array.isArray(exported.objects) ||
    !Array.isArray(exported.allowedLabels) ||
    exported.allowedLabels.some((label) => !PROPOSER_READ_LABELS.includes(label)) ||
    evidence.files.length !== exported.objects.length + 1
  )
    throw new ExecutionError('invalid proposal export envelope')
  assertExact(exported.canaryAbsence, ['checkedObjects', 'tokenFingerprints', 'result'])
  if (
    exported.canaryAbsence.result !== 'absent' ||
    exported.canaryAbsence.checkedObjects !== exported.objects.length
  )
    throw new ExecutionError('proposal export canary receipt missing')
  const digests: string[] = []
  for (const object of exported.objects) {
    assertExact(object, ['digest', 'size', 'mediaType', 'label', 'path'])
    validateRef({
      algorithm: 'sha256',
      digest: object.digest,
      size: object.size,
      mediaType: object.mediaType,
      label: object.label,
    })
    if (
      !PROPOSER_READ_LABELS.includes(object.label as 'DEV_OBSERVED') ||
      !exported.allowedLabels.includes(object.label) ||
      object.path !== `objects/${object.digest}`
    )
      throw new ExecutionError('forbidden proposal export object')
    const file = evidence.files.find((file) => file.path === object.path)
    if (
      !file ||
      file.content.digest !== object.digest ||
      file.content.size !== object.size ||
      !PROPOSER_READ_LABELS.includes(file.content.label)
    )
      throw new ExecutionError('proposal export inventory differs from manifest')
    if (digests.includes(String(object.digest)))
      throw new ExecutionError('duplicate proposal export object')
    digests.push(String(object.digest))
  }
  if (exported.merkleRoot !== merkleRootOf(digests))
    throw new ExecutionError('proposal export Merkle root mismatch')
  append('export/', evidence.files)
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
    inputs: [inputManifest, ...refs],
    children: Array.from({ length: config.width }, (_, i) => `child-${i + 1}`),
  }
}

/** Read the exact frozen parent/config that the native target will consume. */
export async function readProposalInputBinding(
  store: ObjectStore,
  inputManifest: ObjectRef,
  spec: import('./types.js').ExecutionSpec,
) {
  if (
    spec.kind !== 'proposal' ||
    !spec.inputs.some((ref) => canonicalJson(ref) === canonicalJson(inputManifest)) ||
    canonicalJson(spec.command) !==
      canonicalJson([
        '/input/capsule/runtime/node',
        '/input/capsule/runner/bin/docker-proposer-worker.js',
        '/input/config.json',
      ])
  )
    throw new ExecutionError('proposal execution input/command binding mismatch')
  // Validates labels, aggregate limits, refs and every tree before selecting /input.
  await executionInputArtifacts(store, inputManifest)
  const manifest = JSON.parse((await store.read(inputManifest)).toString('utf8')) as {
    trees: Array<{ target: string; inventory: ObjectRef }>
  }
  const tree = manifest.trees.find((tree) => tree.target === '/input')
  if (!tree) throw new ExecutionError('proposal /input tree missing')
  const input = await readCapturedTree(store, tree.inventory)
  const configFile = input.files.find((file) => file.path === 'config.json')
  if (!configFile || configFile.content.size > 65536)
    throw new ExecutionError('proposal worker config missing/oversize')
  const config = validateProposalWorkerConfig(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await store.read(configFile.content)),
    ),
  )
  if (
    config.executionId !== spec.executionId ||
    config.outputBytes > spec.limits.outputBytes ||
    config.shellTimeoutMs > spec.limits.shellTimeoutMs
  )
    throw new ExecutionError('proposal worker execution/limits binding mismatch')
  const sourceFiles = input.files.filter((file) => file.path.startsWith('parent/'))
  if (
    !sourceFiles.length ||
    sourceFiles.length > CANONICAL_SOURCE_CAPS.maxFiles ||
    sourceFiles.reduce((total, file) => total + file.content.size, 0) >
      CANONICAL_SOURCE_CAPS.maxBytes ||
    sourceFiles.some((file) => file.content.size > CANONICAL_SOURCE_CAPS.maxSingleFileBytes)
  )
    throw new ExecutionError('proposal frozen parent source limits')
  const files = await Promise.all(
    sourceFiles.map(async (file) => ({
      path: file.path.slice('parent/'.length),
      mode: file.mode,
      content: await store.read(file.content),
    })),
  )
  const tar = buildCanonicalTar(files),
    sha256 = sha256Hex(tar)
  if (`sha256:${sha256}` !== config.parentSourceHash)
    throw new ExecutionError('proposal frozen parent digest mismatch')
  if (config.candidateId !== candidateIdFromDigest(sha256))
    throw new ExecutionError('proposal frozen parent candidate id mismatch')
  const parentList = input.files.find((file) => file.path === 'parent-files.json')
  if (
    !parentList ||
    canonicalJson(JSON.parse((await store.read(parentList.content)).toString('utf8'))) !==
      canonicalJson(files.map((file) => file.path))
  )
    throw new ExecutionError('proposal frozen parent file list mismatch')
  const document = async (path: string): Promise<unknown> => {
    const file = input.files.find((file) => file.path === path)
    if (!file || file.content.size > spec.limits.fileBytes)
      throw new ExecutionError('proposal input document missing/oversize')
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await store.read(file.content)),
    )
  }
  const catalog = (await document('archive-catalog.json')) as ArchiveCatalog
  const exportManifest = (await document('export/manifest.json')) as ExportManifest
  return {
    config,
    catalog,
    exportManifest,
    parent: {
      files,
      tar,
      sha256,
      bytes: files.reduce((total, file) => total + file.content.length, 0),
    },
    children: Array.from({ length: config.width }, (_, i) => `child-${i + 1}`),
  }
}
