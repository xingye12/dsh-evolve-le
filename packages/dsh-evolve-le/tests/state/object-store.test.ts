/**
 * Object-store contract tests (Gate 3, specs/06 §3): content-addressed
 * publish is idempotent and byte-verified, existing digests are never
 * overwritten, and verify/scrub fail closed on missing, truncated, mutated,
 * or symlinked objects. The store is the evidence source of truth — a
 * passing `put` must mean the bytes are durable under their digest.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sha256Hex } from '../../src/state/canonical.js'
import {
  ObjectStoreError,
  listObjectDigests,
  objectPath,
  openObjectStore,
  validateRef,
} from '../../src/state/object-store.js'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshStore(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(root)
  return { root, store: await openObjectStore(root) }
}

const BYTES = Buffer.from('trajectory-bytes-v1\n', 'utf8')

describe('put', () => {
  it('publishes under sha256 and is idempotent for identical bytes', async () => {
    const { root, store } = await freshStore('dsh-obj-put-')
    const ref = await store.put(BYTES, { mediaType: 'application/json', label: 'DEV_OBSERVED' })
    expect(ref).toEqual({
      algorithm: 'sha256',
      digest: sha256Hex(BYTES),
      size: BYTES.length,
      mediaType: 'application/json',
      label: 'DEV_OBSERVED',
    })
    const again = await store.put(BYTES, { mediaType: 'application/json', label: 'SEALED' })
    expect(again.digest).toBe(ref.digest)
    await expect(store.read(ref)).resolves.toEqual(BYTES)
    expect(await listObjectDigests(root)).toEqual([ref.digest])
  })

  it('refuses a digest collision with different bytes', async () => {
    const { store } = await freshStore('dsh-obj-collide-')
    const ref = await store.put(BYTES, { mediaType: 'application/json', label: 'DEV_OBSERVED' })
    // Tamper the published bytes under the same path.
    const target = objectPath(store.root, ref.digest)
    await writeFile(target, Buffer.concat([BYTES, Buffer.from('tampered')]))
    await expect(
      store.put(BYTES, { mediaType: 'application/json', label: 'DEV_OBSERVED' }),
    ).rejects.toThrow(/different bytes/)
  })

  it('leaves no staging residue behind', async () => {
    const { root, store } = await freshStore('dsh-obj-clean-')
    await store.put(BYTES, { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' })
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(root, 'staging'))).toEqual([])
  })
})

describe('verify and read', () => {
  it('fails closed on a missing object', async () => {
    const { store } = await freshStore('dsh-obj-missing-')
    const ref = await store.put(BYTES, { mediaType: 'application/json', label: 'DEV_OBSERVED' })
    await rm(objectPath(store.root, ref.digest))
    await expect(store.verify(ref)).rejects.toThrow(/missing/)
    await expect(store.read(ref)).rejects.toThrow(/missing/)
  })

  it('fails closed on mutated content and size mismatch', async () => {
    const { store } = await freshStore('dsh-obj-mut-')
    const ref = await store.put(BYTES, { mediaType: 'application/json', label: 'DEV_OBSERVED' })
    const target = objectPath(store.root, ref.digest)
    // Same length, different bytes: only the content hash can catch it.
    await writeFile(target, Buffer.from('X'.repeat(BYTES.length)))
    await expect(store.verify(ref)).rejects.toThrow(/hashes to/)
    await rm(target)
    await store.put(Buffer.from('short'), { mediaType: 'text/plain', label: 'DEV_GUARD' })
    const shortRef = {
      algorithm: 'sha256' as const,
      digest: sha256Hex(Buffer.from('short')),
      size: 999,
      mediaType: 'text/plain',
      label: 'DEV_GUARD' as const,
    }
    await expect(store.verify(shortRef)).rejects.toThrow(/size/)
  })

  it('refuses a symlink standing in for an object', async () => {
    const { root, store } = await freshStore('dsh-obj-link-')
    const ref = await store.put(BYTES, { mediaType: 'application/json', label: 'SEALED' })
    const target = objectPath(root, ref.digest)
    await rm(target)
    await symlink('/etc/hostname', target)
    await expect(store.verify(ref)).rejects.toThrow(/not a regular file/)
  })

  it('scrub re-verifies every reachable object', async () => {
    const { store } = await freshStore('dsh-obj-scrub-')
    const refs = [
      await store.put(Buffer.from('a'), { mediaType: 'text/plain', label: 'PUBLIC_SPEC' }),
      await store.put(Buffer.from('b'), { mediaType: 'text/plain', label: 'DEV_OBSERVED' }),
    ]
    await expect(store.scrub(refs)).resolves.toEqual({ verified: 2 })
    await rm(objectPath(store.root, refs[1]!.digest))
    await expect(store.scrub(refs)).rejects.toThrow(/missing/)
  })
})

describe('validateRef', () => {
  const goodRef = {
    algorithm: 'sha256',
    digest: 'a'.repeat(64),
    size: 3,
    mediaType: 'text/plain',
    label: 'SEALED',
  }

  it('accepts the exact 5-field ref', () => {
    expect(() => validateRef(goodRef)).not.toThrow()
  })

  it('rejects extra fields, missing fields, bad digests, unknown labels', () => {
    expect(() => validateRef({ ...goodRef, extra: 1 })).toThrow(/wrong field set/)
    expect(() => validateRef({ ...goodRef, label: undefined })).toThrow(/label/)
    expect(() => validateRef({ ...goodRef, digest: 'XYZ' })).toThrow(/64-hex/)
    expect(() => validateRef({ ...goodRef, label: 'DEV' })).toThrow(/unknown label/)
    expect(() => validateRef({ ...goodRef, size: -1 })).toThrow(/safe integer/)
    expect(() => validateRef({ ...goodRef, size: 1.5 })).toThrow(/safe integer/)
    expect(() => validateRef(null)).toThrow(/must be an object/)
    expect(() => validateRef([goodRef])).toThrow(/must be an object/)
  })

  it('has a stable error type', () => {
    try {
      validateRef({ broken: true })
      expect.unreachable('validateRef must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ObjectStoreError)
    }
  })
})

describe('layout', () => {
  it('shards digests two-hex deep and lists them sorted', async () => {
    const { root, store } = await freshStore('dsh-obj-shard-')
    const one = await store.put(Buffer.from('one'), { mediaType: 'a', label: 'PUBLIC_SPEC' })
    const two = await store.put(Buffer.from('two'), { mediaType: 'a', label: 'PUBLIC_SPEC' })
    expect(objectPath(root, one.digest).endsWith(join(one.digest.slice(0, 2), one.digest))).toBe(
      true,
    )
    expect(await listObjectDigests(root)).toEqual(
      [one.digest, two.digest].sort((a, b) => (a < b ? -1 : 1)),
    )
    // A foreign file in a shard dir must not silently pass as an object.
    await mkdir(join(root, 'sha256', 'zz'), { recursive: true })
    await writeFile(join(root, 'sha256', 'zz', 'junk'), Buffer.from('junk'))
    expect(await listObjectDigests(root)).toHaveLength(3)
  })

  it('ignores an absent shard root instead of throwing', async () => {
    expect(await listObjectDigests(join(tmpdir(), 'dsh-absent-dir'))).toEqual([])
  })

  it('keeps objects readable across store re-open', async () => {
    const { root, store } = await freshStore('dsh-obj-reopen-')
    const ref = await store.put(BYTES, { mediaType: 'a', label: 'DEV_OBSERVED' })
    const reopened = await openObjectStore(root)
    await expect(reopened.read(ref)).resolves.toEqual(BYTES)
    // Read-only evidence must survive permission tightening by the operator.
    const target = objectPath(root, ref.digest)
    await chmod(target, 0o444)
    await expect(openObjectStore(root).then((s) => s.read(ref))).resolves.toEqual(BYTES)
  })
})
