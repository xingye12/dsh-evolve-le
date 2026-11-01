/** Verify immutable parent identity and pinned runtime for proposal and validator inputs. */
import { createHash } from 'node:crypto'
import { sha256Hex } from '../state/canonical.js'
import { type ObjectRef, type ObjectStore } from '../state/object-store.js'
import {
  buildCanonicalTar,
  candidateIdFromDigest,
  type CanonicalFile,
} from '../candidate/canonical.js'
import { validateManifest } from '../schema.js'
import { NODE_RUNTIME_BINARY_SHA256, NODE_RUNTIME_VERSION } from '../builder/pinned-runtime.js'
import { readSourceSnapshot, readCapturedTree, type SourceSnapshot } from './snapshot.js'
import { ExecutionError } from './types.js'
type Files = SourceSnapshot['files']
function digest(files: Files): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    hash.update(`${file.path}\0file\0${file.mode & 0o111 ? '1' : '0'}\0${file.content.digest}\n`)
  return hash.digest('hex')
}
export async function readTrustedRuntimeInputs(options: {
  store: ObjectStore
  parentSnapshot: ObjectRef
  parentCapsuleInventory: ObjectRef
  workerInventory: ObjectRef
  dependencyClosureSha256: string
}) {
  const { store } = options
  const parent = await readSourceSnapshot(store, options.parentSnapshot),
    capsule = await readCapturedTree(store, options.parentCapsuleInventory),
    worker = await readCapturedTree(store, options.workerInventory)
  const sourceHash = async (files: Files) => {
    const canonical: CanonicalFile[] = []
    for (const file of files)
      canonical.push({ path: file.path, mode: file.mode, content: await store.read(file.content) })
    return sha256Hex(buildCanonicalTar(canonical))
  }
  const parentHash = await sourceHash(parent.files),
    parentSourceDigest = `sha256:${parentHash}`,
    index = new Map(capsule.files.map((f) => [f.path, f]))
  const get = (path: string) => {
    const file = index.get(path)
    if (!file) throw new ExecutionError(`parent capsule missing ${path}`)
    return file
  }
  const json = async (path: string): Promise<unknown> =>
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await store.read(get(path).content)),
    )
  const manifest = validateManifest('capsule', await json('manifest.json'))
  if (!manifest.ok) throw new ExecutionError('invalid trusted parent capsule manifest')
  const identity = manifest.value.identity as { sourceDigest: string; candidateId: string }
  if (
    identity.sourceDigest !== parentSourceDigest ||
    identity.candidateId !== candidateIdFromDigest(parentHash)
  )
    throw new ExecutionError('parent capsule/source identity mismatch')
  const runtime = manifest.value.runtime as {
    digest: string
    nodeRuntime: { sha256: string; version: string }
  }
  if (
    get('runtime/node').content.digest !== NODE_RUNTIME_BINARY_SHA256 ||
    get('runtime/node').mode !== 0o755 ||
    runtime.nodeRuntime.sha256 !== NODE_RUNTIME_BINARY_SHA256 ||
    runtime.nodeRuntime.version !== NODE_RUNTIME_VERSION
  )
    throw new ExecutionError('parent capsule runtime differs from pinned Node')
  if (runtime.digest !== get('runtime/install-manifest.json').content.digest)
    throw new ExecutionError('parent install manifest binding mismatch')
  const pkg = (await json('candidate/package.json')) as { name?: unknown }
  if (
    typeof pkg.name !== 'string' ||
    !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name) ||
    ['.', '..'].includes(pkg.name)
  )
    throw new ExecutionError('invalid parent candidate package identity')
  const prefix = `node_modules/${pkg.name}/`,
    dependencies = capsule.files
      .filter((f) => f.path.startsWith('node_modules/') && !f.path.startsWith(prefix))
      .map((f) => ({ ...f, path: f.path.slice('node_modules/'.length) }))
  if (digest(dependencies) !== options.dependencyClosureSha256)
    throw new ExecutionError('parent capsule dependency bytes differ from frozen closure')
  return {
    parent,
    capsule,
    worker,
    parentSourceDigest,
    candidatePackage: pkg.name,
    candidateId: identity.candidateId,
  }
}
