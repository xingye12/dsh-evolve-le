/** Frozen input graph has no spec back-reference: inventory -> bytes, spec -> manifest. */
import { constants } from 'node:fs'
import { open, mkdir, readdir, lstat, chmod, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalJson, canonicalHash, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { captureBoundedTree, readCapturedTree, type SourceSnapshot } from './snapshot.js'
import { assertExact, ExecutionError, type ExecutionSpec } from './types.js'
type Target = '/input' | '/dependencies' | '/toolchain'
interface InputManifest {
  protocol: 'dsh-evolve-le/execution-input/v1'
  trees: Array<{ target: Target; inventory: ObjectRef }>
}
const targets: readonly string[] = ['/input', '/dependencies', '/toolchain']
function allowed(ref: ObjectRef): void {
  validateRef(ref)
  if (ref.label === 'DEV_GUARD' || ref.label === 'SEALED')
    throw new ExecutionError('guard/sealed execution input forbidden')
}
async function readManifest(store: ObjectStore, ref: ObjectRef): Promise<InputManifest> {
  allowed(ref)
  if (ref.size > 1048576) throw new ExecutionError('input manifest envelope limit')
  const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
  assertExact(value, ['protocol', 'trees'])
  if (
    value.protocol !== 'dsh-evolve-le/execution-input/v1' ||
    !Array.isArray(value.trees) ||
    !value.trees.length ||
    value.trees.length > 3
  )
    throw new ExecutionError('invalid execution input manifest')
  let previous = '',
    bytes = 0,
    files = 0
  for (const tree of value.trees) {
    assertExact(tree, ['target', 'inventory'])
    if (
      typeof tree.target !== 'string' ||
      !targets.includes(tree.target) ||
      tree.target <= previous
    )
      throw new ExecutionError('invalid/duplicate input target')
    previous = tree.target
    validateRef(tree.inventory)
    allowed(tree.inventory)
    const inventory = await readCapturedTree(store, tree.inventory)
    bytes += inventory.totalBytes
    files += inventory.files.length
    if (files > 32768) throw new ExecutionError('execution input file count limit')
    if (bytes > 1024 * 1024 * 1024) throw new ExecutionError('execution input aggregate limit')
    for (const file of inventory.files) allowed(file.content)
  }
  if (!value.trees.some((t) => (t as { target: string }).target === '/input'))
    throw new ExecutionError('missing execution /input inventory')
  return value as unknown as InputManifest
}
export async function freezeExecutionInputs(
  store: ObjectStore,
  trees: readonly { target: Target; root: string }[],
  limits: { bytes: number; fileBytes: number; inodes: number },
): Promise<ObjectRef> {
  if (
    limits.bytes > 512 * 1024 * 1024 ||
    limits.fileBytes > 160 * 1024 * 1024 ||
    limits.inodes > 65536
  )
    throw new ExecutionError('input freeze limit exceeds profile')
  const manifest: InputManifest = { protocol: 'dsh-evolve-le/execution-input/v1', trees: [] }
  for (const tree of [...trees].sort((a, b) =>
    a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
  )) {
    if (!targets.includes(tree.target)) throw new ExecutionError('invalid frozen input target')
    const inventory = await captureBoundedTree({ root: tree.root, store, limits })
    const ref = await store.put(Buffer.from(canonicalJson(inventory)), {
      mediaType: 'application/vnd.dsh-evolve-le.artifact-inventory+json',
      label: 'CONTROLLER_INTERNAL',
    })
    manifest.trees.push({ target: tree.target, inventory: ref })
  }
  const ref = await store.put(Buffer.from(canonicalJson(manifest)), {
    mediaType: 'application/vnd.dsh-evolve-le.execution-input+json',
    label: 'CONTROLLER_INTERNAL',
  })
  await readManifest(store, ref)
  return ref
}
async function readonlyTree(path: string, remaining: { value: number }): Promise<void> {
  if (--remaining.value < 0) throw new ExecutionError('execution input inode drift')
  const stat = await lstat(path)
  if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o222) !== 0)
    throw new ExecutionError('execution input is writable or not root-owned')
  if (stat.isDirectory())
    for (const name of await readdir(path)) await readonlyTree(join(path, name), remaining)
  else if (!stat.isFile() || stat.nlink !== 1)
    throw new ExecutionError('execution input link/special file')
}
async function verifyTree(
  store: ObjectStore,
  root: string,
  inventory: Pick<SourceSnapshot, 'files' | 'totalBytes'>,
): Promise<void> {
  const directories = new Set<string>([''])
  for (const file of inventory.files) {
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }
  const inodes = directories.size + inventory.files.length
  await readonlyTree(root, { value: inodes })
  let actual: Pick<SourceSnapshot, 'files' | 'totalBytes'>
  try {
    actual = await captureBoundedTree({
      root,
      store,
      limits: {
        bytes: Math.max(1, inventory.totalBytes),
        fileBytes: Math.max(1, ...inventory.files.map((f) => f.content.size)),
        inodes,
      },
    })
  } catch {
    throw new ExecutionError('execution input drift or capture limit')
  }
  const physical = (tree: Pick<SourceSnapshot, 'files' | 'totalBytes'>) => ({
    totalBytes: tree.totalBytes,
    files: tree.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      digest: file.content.digest,
      size: file.content.size,
    })),
  })
  if (canonicalJson(physical(actual)) !== canonicalJson(physical(inventory)))
    throw new ExecutionError('execution input bytes/mode drift')
}
export async function materializeExecutionInputs(
  store: ObjectStore,
  ref: ObjectRef,
  actionRoot: string,
): Promise<void> {
  const manifest = await readManifest(store, ref)
  for (const tree of manifest.trees) {
    const inventory = await readCapturedTree(store, tree.inventory),
      destination = join(actionRoot, tree.target.slice(1))
    const existing = await lstat(destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (existing) {
      await verifyTree(store, destination, inventory)
      continue
    }
    const stage = join(actionRoot, `.input-staging-${randomUUID()}`)
    await mkdir(stage, { mode: 0o700 })
    try {
      for (const file of inventory.files) {
        const path = join(stage, file.path)
        await mkdir(dirname(path), { recursive: true, mode: 0o755 })
        const handle = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          file.mode & 0o111 ? 0o555 : 0o444,
        )
        try {
          await handle.writeFile(await store.read(file.content))
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      const seal = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true }))
          if (entry.isDirectory()) await seal(join(path, entry.name))
        await chmod(path, 0o555)
        const fd = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        )
        try {
          await fd.sync()
        } finally {
          await fd.close()
        }
      }
      await seal(stage)
      await verifyTree(store, stage, inventory)
      await rename(stage, destination)
      const parent = await open(
        actionRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
}
export async function verifyExecutionInputs(
  store: ObjectStore,
  ref: ObjectRef,
  spec: ExecutionSpec,
): Promise<ObjectRef> {
  if (!spec.inputs.some((r) => canonicalJson(r) === canonicalJson(ref)))
    throw new ExecutionError('input manifest absent from spec')
  const manifest = await readManifest(store, ref),
    mounts = spec.mounts.filter((m) => m.readOnly && m.target !== '/gateway')
  if (mounts.length !== manifest.trees.length)
    throw new ExecutionError('input inventory/mount count mismatch')
  for (const tree of manifest.trees) {
    const mount = mounts.find((m) => m.target === tree.target)
    if (!mount) throw new ExecutionError('input inventory lacks declared read-only mount')
    const inventory = await readCapturedTree(store, tree.inventory)
    await verifyTree(store, mount.source, inventory)
    if (tree.target === '/input')
      for (const command of spec.command.filter(
        (arg, index) => index < 2 || arg.startsWith('/input/'),
      )) {
        if (
          !command.startsWith('/input/') ||
          !inventory.files.some((f) => f.path === command.slice(7))
        )
          throw new ExecutionError('frozen worker entry absent from input inventory')
      }
  }
  return store.put(
    Buffer.from(
      canonicalJson({
        protocol: 'dsh-evolve-le/execution-input-verification/v1',
        specDigest: canonicalHash(spec),
        manifest: ref,
        inventories: manifest.trees.map((t) => t.inventory),
      }),
    ),
    {
      mediaType: 'application/vnd.dsh-evolve-le.execution-input-verification+json',
      label: 'CONTROLLER_INTERNAL',
    },
  )
}

export async function executionInputArtifacts(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<ObjectRef[]> {
  const manifest = await readManifest(store, ref),
    refs: ObjectRef[] = [ref]
  for (const tree of manifest.trees) {
    refs.push(tree.inventory)
    for (const file of (await readCapturedTree(store, tree.inventory)).files)
      refs.push(file.content)
  }
  return refs
}

/** Compose existing immutable inventories without copying a mutable source directory. */
export async function publishExecutionInputs(
  store: ObjectStore,
  trees: readonly { target: Target; inventory: ObjectRef }[],
): Promise<ObjectRef> {
  const manifest: InputManifest = {
    protocol: 'dsh-evolve-le/execution-input/v1',
    trees: [...trees].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
  }
  const ref = await store.put(Buffer.from(canonicalJson(manifest)), {
    mediaType: 'application/vnd.dsh-evolve-le.execution-input+json',
    label: 'CONTROLLER_INTERNAL',
  })
  await readManifest(store, ref)
  return ref
}
