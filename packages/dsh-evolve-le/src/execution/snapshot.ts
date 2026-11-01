/** Linux descriptor-anchored capture. Caller must externally freeze ALL writers. */
import { constants } from 'node:fs'
import { open, readdir, mkdir, chmod } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { ExecutionError, SNAPSHOT_PROTOCOL, assertExact, type ExecutionSpec } from './types.js'
export interface SourceSnapshot {
  protocol: typeof SNAPSHOT_PROTOCOL
  executionId: string
  specDigest: string
  child: string
  files: Array<{ path: string; mode: number; content: ObjectRef }>
  totalBytes: number
}
function validPath(path: string): void {
  if (
    !path ||
    path.length > 4096 ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((s) => !s || s === '.' || s === '..') ||
    path.split('/').length > 32
  )
    throw new ExecutionError('invalid snapshot path')
}
function fdPath(fd: number): string {
  return `/proc/self/fd/${fd}`
}
export async function captureSourceSnapshot(options: {
  root: string
  store: ObjectStore
  spec: ExecutionSpec
  child: string
}): Promise<ObjectRef> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(options.child))
    throw new ExecutionError('invalid snapshot child')
  const tree = await captureBoundedTree({
    root: options.root,
    store: options.store,
    limits: { ...options.spec.limits.workspace, fileBytes: options.spec.limits.fileBytes },
  })
  const snapshot: SourceSnapshot = {
    protocol: SNAPSHOT_PROTOCOL,
    executionId: options.spec.executionId,
    specDigest: canonicalHash(options.spec),
    child: options.child,
    ...tree,
  }
  const ref = await options.store.put(Buffer.from(canonicalJson(snapshot)), {
    mediaType: 'application/vnd.dsh-evolve-le.source-snapshot+json',
    label: 'DEV_OBSERVED',
  })
  await readSourceSnapshot(options.store, ref)
  return ref
}
/** Shared capture mechanism, distinct source and validator-output envelopes. */
export async function captureBoundedTree(options: {
  root: string
  store: ObjectStore
  limits: { bytes: number; inodes: number; fileBytes: number }
}): Promise<Pick<SourceSnapshot, 'files' | 'totalBytes'>> {
  for (const value of Object.values(options.limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new ExecutionError('invalid capture limits')
  const { store, limits } = options
  const snapshot: Pick<SourceSnapshot, 'files' | 'totalBytes'> = { files: [], totalBytes: 0 }
  let inodes = 0
  const walk = async (dir: FileHandle, prefix: string, depth: number): Promise<void> => {
    if (++inodes > limits.inodes || depth > 32)
      throw new ExecutionError('snapshot inode/depth limit')
    const names = (await readdir(fdPath(dir.fd))).sort()
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name
      validPath(path)
      const child = await open(
        join(fdPath(dir.fd), name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const before = await child.stat({ bigint: true })
        if (before.isDirectory()) {
          await walk(child, path, depth + 1)
          continue
        }
        if (!before.isFile() || before.nlink !== 1n)
          throw new ExecutionError('snapshot link/special file rejected')
        if (
          ++inodes > limits.inodes ||
          before.size > BigInt(limits.fileBytes) ||
          before.size + BigInt(snapshot.totalBytes) > BigInt(limits.bytes)
        )
          throw new ExecutionError('snapshot size/inode limit')
        if ((Number(before.mode) & 0o7000) !== 0)
          throw new ExecutionError('snapshot privileged mode')
        // Never readFile() an untrusted growing file without a bound.
        const chunks: Buffer[] = []
        let bytes = 0
        for (;;) {
          const buffer = Buffer.alloc(Math.min(65536, limits.fileBytes - bytes + 1))
          const r = await child.read(buffer, 0, buffer.length, null)
          if (!r.bytesRead) break
          bytes += r.bytesRead
          if (bytes > limits.fileBytes || bytes + snapshot.totalBytes > limits.bytes)
            throw new ExecutionError('snapshot read limit')
          chunks.push(buffer.subarray(0, r.bytesRead))
        }
        const after = await child.stat({ bigint: true })
        if (
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          BigInt(bytes) !== after.size ||
          after.nlink !== 1n
        )
          throw new ExecutionError('snapshot changed during capture')
        const content = await store.put(Buffer.concat(chunks), {
          mediaType: 'application/octet-stream',
          label: 'DEV_OBSERVED',
        })
        snapshot.files.push({ path, mode: Number(before.mode) & 0o111 ? 0o755 : 0o644, content })
        snapshot.totalBytes += bytes
      } finally {
        await child.close()
      }
    }
  }
  const root = await open(
    options.root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await walk(root, '', 0)
  } finally {
    await root.close()
  }
  if (!snapshot.files.length) throw new ExecutionError('empty snapshot')
  snapshot.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return snapshot
}
export async function readSourceSnapshot(
  store: ObjectStore,
  ref: ObjectRef,
): Promise<SourceSnapshot> {
  const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
  assertExact(value, ['protocol', 'executionId', 'specDigest', 'child', 'files', 'totalBytes'])
  if (
    value.protocol !== SNAPSHOT_PROTOCOL ||
    typeof value.executionId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value.executionId) ||
    typeof value.child !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value.child) ||
    typeof value.specDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.specDigest) ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    value.files.length > 65536
  )
    throw new ExecutionError('invalid snapshot envelope')
  await validateCapturedTree(store, value)
  return value as unknown as SourceSnapshot
}
export async function readCapturedTree(
  store: ObjectStore,
  ref: ObjectRef,
  limits = { bytes: 512 * 1024 * 1024, fileBytes: 160 * 1024 * 1024, inodes: 65536 },
): Promise<Pick<SourceSnapshot, 'files' | 'totalBytes'>> {
  for (const quantity of Object.values(limits))
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new ExecutionError('invalid inventory limits')
  validateRef(ref)
  if (ref.size > 16 * 1024 * 1024) throw new ExecutionError('inventory envelope limit')
  const value = parseCanonicalJson((await store.read(ref)).toString('utf8'))
  assertExact(value, ['files', 'totalBytes'])
  if (
    !Number.isSafeInteger(value.totalBytes) ||
    Number(value.totalBytes) > limits.bytes ||
    !Array.isArray(value.files) ||
    value.files.length > limits.inodes
  )
    throw new ExecutionError('inventory total limit')
  let declaredBytes = 0
  for (const file of value.files) {
    assertExact(file, ['path', 'mode', 'content'])
    validateRef(file.content)
    declaredBytes += file.content.size
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > limits.bytes)
      throw new ExecutionError('inventory aggregate limit')
    if (file.content.size > limits.fileBytes) throw new ExecutionError('inventory file limit')
  }
  await validateCapturedTree(store, value)
  return value as unknown as Pick<SourceSnapshot, 'files' | 'totalBytes'>
}
async function validateCapturedTree(
  store: ObjectStore,
  value: Record<string, unknown>,
): Promise<void> {
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 65536)
    throw new ExecutionError('invalid captured inventory')
  let previous = ''
  let total = 0
  const allPaths = new Set<string>()
  for (const file of value.files) {
    assertExact(file, ['path', 'mode', 'content'])
    if (typeof file.path !== 'string') throw new ExecutionError('invalid snapshot path')
    validPath(file.path)
    if (file.path <= previous || (file.mode !== 0o644 && file.mode !== 0o755))
      throw new ExecutionError('invalid snapshot inventory ordering/mode')
    const parts = file.path.split('/')
    for (let i = 1; i < parts.length; i++)
      if (allPaths.has(parts.slice(0, i).join('/')))
        throw new ExecutionError('snapshot file/directory conflict')
    allPaths.add(file.path)
    previous = file.path
    validateRef(file.content)
    await store.verify(file.content)
    total += file.content.size
  }
  if (!Number.isSafeInteger(total) || total !== value.totalBytes)
    throw new ExecutionError('snapshot byte count mismatch')
}
export async function materializeSourceSnapshot(
  store: ObjectStore,
  ref: ObjectRef,
  destination: string,
): Promise<void> {
  const snapshot = await readSourceSnapshot(store, ref)
  await mkdir(destination, { mode: 0o700 }) // No reuse or overwrite of live trees.
  for (const file of snapshot.files) {
    const parts = file.path.split('/')
    const leaf = parts.pop()!
    const parent = join(destination, ...parts)
    await mkdir(parent, { recursive: true })
    const handle = await open(
      join(parent, leaf),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      file.mode,
    )
    try {
      await handle.writeFile(await store.read(file.content))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  // Seal after creation; directory permissions are not the container mount policy.
  const seal = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await seal(child)
      else
        await chmod(
          child,
          snapshot.files.find((f) => join(destination, f.path) === child)!.mode & 0o111
            ? 0o555
            : 0o444,
        )
    }
    await chmod(path, 0o555)
  }
  await seal(destination)
}
