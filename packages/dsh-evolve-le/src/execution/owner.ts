/** Fenced ownership is acquired under flock, never by time-based lock stealing. */
import { mkdir, readdir, readFile, stat, lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalJson } from '../state/canonical.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { readBootClock } from './resources.js'
import { ExecutionError } from './types.js'
export interface OwnerGeneration {
  protocol: 'dsh-evolve-le/execution-owner/v1'
  generation: number
  token: string
  pid: number
  startTime: string
  bootId: string
  specDigest: string
}
async function latest(root: string): Promise<OwnerGeneration | null> {
  const directory = join(root, 'owners'),
    names = await readdir(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
  const records = names.filter((n) => !n.startsWith('.staging-')).sort()
  for (let i = 0; i < records.length; i++)
    if (records[i] !== `${String(i + 1).padStart(8, '0')}.json`)
      throw new ExecutionError('owner generation sequence corrupt')
  if (!records.length) return null
  return (await readCanonicalFile(join(directory, records.at(-1)!))) as OwnerGeneration
}
async function assertKernelOwner(root: string): Promise<void> {
  const inode = await stat(join(root, 'owner.lock'), { bigint: true }),
    device = inode.dev
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n)
  const owned = (await readFile('/proc/locks', 'utf8')).split('\n').some((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts[1] !== 'FLOCK' || parts[3] !== 'WRITE' || parts[4] !== String(process.pid))
      return false
    const id = parts[5]?.split(':')
    return (
      id?.length === 3 &&
      BigInt(`0x${id[0]}`) === major &&
      BigInt(`0x${id[1]}`) === minor &&
      BigInt(id[2]!) === inode.ino
    )
  })
  if (!owned)
    throw new ExecutionError('supervisor must hold its kernel flock before claiming ownership')
}
export async function claimOwnerGeneration(
  root: string,
  specDigest: string,
): Promise<OwnerGeneration> {
  await assertKernelOwner(root)
  if (!/^[a-f0-9]{64}$/.test(specDigest)) throw new ExecutionError('invalid owner spec digest')
  await mkdir(join(root, 'owners'), { recursive: true, mode: 0o700 })
  const previous = await latest(root)
  if (previous && previous.specDigest !== specDigest) throw new ExecutionError('owner spec drift')
  const raw = await readFile('/proc/self/stat', 'utf8'),
    startTime = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19]!
  const record: OwnerGeneration = {
    protocol: 'dsh-evolve-le/execution-owner/v1',
    generation: (previous?.generation ?? 0) + 1,
    token: randomUUID(),
    pid: process.pid,
    startTime,
    bootId: (await readBootClock()).bootId,
    specDigest,
  }
  await publishCanonical(
    join(root, 'owners', `${String(record.generation).padStart(8, '0')}.json`),
    record,
  )
  return record
}
export async function assertOwnerGeneration(root: string, owner: OwnerGeneration): Promise<void> {
  const current = await latest(root)
  if (!current || canonicalJson(current) !== canonicalJson(owner))
    throw new ExecutionError('supervisor owner generation fenced')
}

/** Only the new kernel-lock owner can replace a dead predecessor's endpoint. */
export async function reclaimActionEndpoint(root: string, owner: OwnerGeneration): Promise<void> {
  await assertKernelOwner(root)
  await assertOwnerGeneration(root, owner)
  const directory = join(root, 'ipc')
  const parent = await lstat(directory)
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o022) !== 0
  )
    throw new ExecutionError('unsafe action endpoint directory')
  const endpoint = join(directory, 'action.sock')
  const existing = await lstat(endpoint).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!existing) return
  if (!existing.isSocket())
    throw new ExecutionError('refusing to replace non-socket action endpoint')
  await unlink(endpoint)
}

/** Read actual kernel ownership for scheduler recovery; a stale PID file is insufficient. */
export async function readKernelLockOwner(root: string): Promise<number | null> {
  const inode = await lstat(join(root, 'owner.lock'), { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!inode) return null
  if (!inode.isFile() || inode.nlink !== 1n || (Number(inode.mode) & 0o022) !== 0)
    throw new ExecutionError('unsafe kernel owner lock file')
  const device = inode.dev,
    major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n),
    minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n)
  for (const line of (await readFile('/proc/locks', 'utf8')).split('\n')) {
    const parts = line.trim().split(/\s+/),
      id = parts[5]?.split(':')
    if (parts[1] !== 'FLOCK' || parts[3] !== 'WRITE' || id?.length !== 3) continue
    if (
      BigInt(`0x${id[0]}`) === major &&
      BigInt(`0x${id[1]}`) === minor &&
      BigInt(id[2]!) === inode.ino
    ) {
      const pid = Number(parts[4])
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new ExecutionError('invalid kernel owner PID')
      return pid
    }
  }
  return null
}
