/** Descriptor-anchored file capabilities for a workspace writable by untrusted code. */
import { constants } from 'node:fs'
import { open, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ExecutionError } from './types.js'
function segments(relative: string, allowRoot = false): string[] {
  if (relative === '' && allowRoot) return []
  const parts = relative.split('/')
  if (
    !relative ||
    relative.length > 4096 ||
    relative !== relative.normalize('NFC') ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    parts.some((p) => !p || p === '.' || p === '..') ||
    parts.length > 32
  )
    throw new ExecutionError('invalid file capability path')
  return parts
}
function anchor(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`
}
async function directory(
  root: string,
  parts: string[],
  create: boolean,
  owner?: { uid: number; gid: number },
): Promise<FileHandle> {
  let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const part of parts) {
      const child = join(anchor(handle), part)
      let created = false
      if (create) {
        try {
          await mkdir(child, { mode: 0o750 })
          created = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      const next = await open(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      if (created) {
        if (owner) await next.chown(owner.uid, owner.gid)
        await handle.sync()
      }
      await handle.close()
      handle = next
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
export async function readCapabilityFile(
  root: string,
  relative: string,
  maxBytes: number,
): Promise<Buffer> {
  const parts = segments(relative),
    leaf = parts.pop()!
  const parent = await directory(root, parts, false)
  try {
    const file = await open(
      join(anchor(parent), leaf),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
        throw new ExecutionError('invalid/oversize capability file')
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const bytes = Buffer.alloc(Math.min(65536, maxBytes - size + 1))
        const r = await file.read(bytes, 0, bytes.length, null)
        if (!r.bytesRead) break
        size += r.bytesRead
        if (size > maxBytes) throw new ExecutionError('capability file read limit')
        chunks.push(bytes.subarray(0, r.bytesRead))
      }
      return Buffer.concat(chunks)
    } finally {
      await file.close()
    }
  } finally {
    await parent.close()
  }
}
export async function listCapabilityDirectory(
  root: string,
  relative: string,
  maxEntries: number,
): Promise<string[]> {
  const handle = await directory(root, segments(relative, true), false)
  try {
    const entries = await readdir(anchor(handle))
    if (entries.length > maxEntries) throw new ExecutionError('directory entry limit')
    return entries.sort()
  } finally {
    await handle.close()
  }
}
export async function writeCapabilityFile(
  root: string,
  relative: string,
  bytes: Buffer,
  maxBytes: number,
  owner?: { uid: number; gid: number },
): Promise<void> {
  if (bytes.length > maxBytes) throw new ExecutionError('file capability write byte limit')
  const parts = segments(relative),
    leaf = parts.pop()!
  const parent = await directory(root, parts, true, owner)
  const temp = `.write-${randomUUID()}`
  try {
    const path = join(anchor(parent), leaf)
    // Final symlinks/hardlinks are rejected, never followed or truncated.
    let existing: FileHandle | undefined
    try {
      existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const stat = await existing.stat()
      if (!stat.isFile() || stat.nlink !== 1)
        throw new ExecutionError('file capability link/special target')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    } finally {
      await existing?.close()
    }
    const file = await open(
      join(anchor(parent), temp),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(bytes)
      if (owner) await file.chown(owner.uid, owner.gid)
      await file.chmod(0o644)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(join(anchor(parent), temp), path)
    await parent.sync()
  } finally {
    await unlink(join(anchor(parent), temp)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await parent.close()
  }
}
