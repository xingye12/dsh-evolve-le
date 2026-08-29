/**
 * Content-addressed object store (specs/06 §3): every large or immutable
 * artifact is written to a staging file, fsynced, hashed, and only then
 * published with a no-clobber hard link into `objects/sha256/<aa>/<digest>`.
 * An existing digest is byte-verified, never overwritten. Symlinks are
 * refused at verify time (only regular files validate); scrub re-verifies
 * every reachable object and fails closed on corruption — no silent
 * re-download, repair is a collect-with-provenance receipt, else
 * `EVIDENCE_CORRUPT`.
 * @module @dsh-evolve-le/core/state/object-store
 */

import { open } from 'node:fs/promises'
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sha256Hex } from './canonical.js'

export const OBJECT_ALGORITHM = 'sha256'

/** Labels fixed at object creation; they can never be downgraded later. */
export type ObjectLabel =
  'PUBLIC_SPEC' | 'DEV_OBSERVED' | 'DEV_GUARD' | 'SEALED' | 'CONTROLLER_INTERNAL'

export interface ObjectRef {
  algorithm: 'sha256'
  digest: string
  size: number
  mediaType: string
  label: ObjectLabel
}

export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(`object-store: ${message}`)
    this.name = 'ObjectStoreError'
  }
}

export interface ObjectStore {
  readonly root: string
  /** Write bytes durably and publish under their digest (idempotent). */
  put(bytes: Buffer, meta: { mediaType: string; label: ObjectLabel }): Promise<ObjectRef>
  /** Resolve a ref: the file must exist, be a regular file, and match. */
  verify(ref: ObjectRef): Promise<void>
  /** Read back object bytes after verifying the ref. */
  read(ref: ObjectRef): Promise<Buffer>
  /** Re-verify every ref in the list (scrub). */
  scrub(refs: readonly ObjectRef[]): Promise<{ verified: number }>
}

export function objectPath(root: string, digest: string): string {
  return join(root, 'sha256', digest.slice(0, 2), digest)
}

export async function openObjectStore(root: string): Promise<ObjectStore> {
  await mkdir(join(root, 'sha256'), { recursive: true })
  const stagingRoot = join(root, 'staging')
  await mkdir(stagingRoot, { recursive: true })
  const verify = async (ref: ObjectRef): Promise<void> => {
    validateRef(ref)
    const target = objectPath(root, ref.digest)
    const stats = await lstat(target).catch(() => undefined)
    if (stats === undefined) throw new ObjectStoreError(`object ${ref.digest} is missing`)
    if (!stats.isFile()) throw new ObjectStoreError(`object ${ref.digest} is not a regular file`)
    const bytes = await readFile(target)
    if (bytes.length !== ref.size) {
      throw new ObjectStoreError(`object ${ref.digest} size ${bytes.length} != ref ${ref.size}`)
    }
    const digest = sha256Hex(bytes)
    if (digest !== ref.digest) {
      throw new ObjectStoreError(`object ${ref.digest} content hashes to ${digest}`)
    }
  }
  const store: ObjectStore = {
    root,
    async put(bytes, meta) {
      const digest = sha256Hex(bytes)
      const target = objectPath(root, digest)
      const ref: ObjectRef = {
        algorithm: 'sha256',
        digest,
        size: bytes.length,
        mediaType: meta.mediaType,
        label: meta.label,
      }
      const existing = await lstat(target).catch(() => undefined)
      if (existing !== undefined) {
        await verifyBytes(target, digest, bytes)
        return ref
      }
      // staging write → fsync → no-clobber publish → fsync directory.
      const stagingDir = await mkdtemp(join(stagingRoot, 'put-'))
      try {
        const stagingFile = join(stagingDir, 'object')
        await writeFile(stagingFile, bytes, { flag: 'wx' })
        await fsyncPath(stagingFile)
        await mkdir(dirname(target), { recursive: true })
        try {
          await link(stagingFile, target)
        } catch (error) {
          // Concurrent publish of the same digest: verify, never overwrite.
          if ((await lstat(target).catch(() => undefined)) === undefined) throw error
          await verifyBytes(target, digest, bytes)
          return ref
        }
        await fsyncPath(dirname(target))
        return ref
      } finally {
        await rm(stagingDir, { recursive: true, force: true })
      }
    },
    verify,
    async read(ref) {
      await verify(ref)
      return readFile(objectPath(root, ref.digest))
    },
    async scrub(refs) {
      for (const ref of refs) await verify(ref)
      return { verified: refs.length }
    },
  }
  return store
}

async function verifyBytes(target: string, digest: string, expected: Buffer): Promise<void> {
  const current = await readFile(target)
  if (current.length !== expected.length || Buffer.compare(current, expected) !== 0) {
    throw new ObjectStoreError(
      `object ${digest} already exists with different bytes (collision or corruption)`,
    )
  }
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const LABELS: readonly string[] = [
  'PUBLIC_SPEC',
  'DEV_OBSERVED',
  'DEV_GUARD',
  'SEALED',
  'CONTROLLER_INTERNAL',
]

/** Validate a ref read back from durable records (exact shape, fail closed). */
export function validateRef(ref: unknown): asserts ref is ObjectRef {
  const record = ref as Record<string, unknown> | null
  const problem = (() => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      return 'ref must be an object'
    }
    const keys = Object.keys(record).sort()
    if (keys.length !== 5 || keys.join(',') !== 'algorithm,digest,label,mediaType,size') {
      return `wrong field set: ${keys.join(',')}`
    }
    if (record['algorithm'] !== 'sha256') return 'algorithm must be sha256'
    if (typeof record['digest'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['digest'])) {
      return 'digest must be 64-hex'
    }
    const size = record['size']
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      return 'size must be a non-negative safe integer'
    }
    if (typeof record['mediaType'] !== 'string' || record['mediaType'] === '') {
      return 'mediaType must be a non-empty string'
    }
    if (typeof record['label'] !== 'string' || !LABELS.includes(record['label'])) {
      return 'unknown label'
    }
    return undefined
  })()
  if (problem !== undefined) {
    const fields =
      record !== null && typeof record === 'object' && !Array.isArray(record)
        ? Object.keys(record).join(',')
        : typeof record
    throw new ObjectStoreError(`invalid object ref: ${problem} (fields: ${fields})`)
  }
}

/** List all published digests (maintenance/test surface). */
export async function listObjectDigests(root: string): Promise<string[]> {
  const shardRoot = join(root, 'sha256')
  const digests: string[] = []
  const shards = await readdir(shardRoot, { withFileTypes: true }).catch(() => [])
  for (const shard of shards) {
    if (!shard.isDirectory()) continue
    for (const name of await readdir(join(shardRoot, shard.name))) {
      digests.push(name)
    }
  }
  return digests.sort()
}
