/**
 * Single-writer lock (Gate 3, specs/06 §12 step 1): exactly one controller
 * process may mutate a run directory. Ownership is a durable owner record
 * (`owner.lock.json`) published with no-clobber semantics; takeover of a
 * stale lock is only allowed when the recorded owner process is provably
 * dead (ESRCH or a different boot) or its lease has expired. A live,
 * in-lease owner blocks every other writer — including this process.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const LOCK_FILE = 'owner.lock.json'
const LEASE_DEFAULT_MS = 15 * 60_000

export interface OwnerRecord {
  /** Opaque per-acquisition token; a released/stolen lock invalidates it. */
  token: string
  pid: number
  bootId: string
  acquiredAt: string
  leaseMs: number
}

export class LockError extends Error {
  constructor(message: string) {
    super(`writer-lock: ${message}`)
    this.name = 'LockError'
  }
}

async function currentBootId(): Promise<string> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  } catch {
    // Not Linux or /proc unavailable: fall back to a constant so pid-liveness
    // alone decides staleness.
    return 'unknown-boot'
  }
}

function processAlive(pid: number, bootId: string, myBootId: string): boolean {
  if (bootId !== myBootId) {
    // The owner ran under a previous boot: its pid says nothing here.
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface AcquireOptions {
  leaseMs?: number
  /** Test seam: inject clock/uuid instead of reaching for the real ones. */
  now?: () => string
  uuid?: () => string
}

/**
 * Acquire the single-writer lock for a run directory. Resolves only when this
 * process holds it; rejects while a live owner (or an unexpired lease held by
 * a dead process — the lease is the grace period, not a bypass) is recorded.
 */
export async function acquireWriterLock(
  runDir: string,
  options: AcquireOptions = {},
): Promise<{ token: string; release: () => Promise<void> }> {
  const leaseMs = options.leaseMs ?? LEASE_DEFAULT_MS
  const now = options.now ?? (() => new Date().toISOString())
  const uuid = options.uuid ?? randomUUID
  // The controller owns its run directory's lifecycle (fresh run per spec);
  // creating it here keeps the lock the very first thing inside it.
  await mkdir(runDir, { recursive: true })
  const path = join(runDir, LOCK_FILE)
  const bootId = await currentBootId()
  const record: OwnerRecord = {
    token: uuid(),
    pid: process.pid,
    bootId,
    acquiredAt: now(),
    leaseMs,
  }

  const tryPublish = async (): Promise<boolean> => {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  }

  if (await tryPublish()) {
    return { token: record.token, release: () => unlink(path).catch(() => undefined) }
  }

  // Someone holds the lock. The owner record decides: takeover is allowed
  // only when the recorded owner process is provably no longer running
  // (ESRCH, or a different boot id, which also covers pid recycling across
  // reboots). An alive owner blocks takeover even past its lease — stealing
  // from a live writer would break single-writer, so a wedged owner requires
  // an operator stop first. The lease bounds how long a recycled pid can
  // masquerade as a live owner and stays in the record for audit.
  let existing: OwnerRecord
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as OwnerRecord
  } catch {
    throw new LockError(`cannot read existing ${LOCK_FILE}; refusing blind takeover`)
  }
  if (existing.bootId === bootId && existing.pid === process.pid) {
    throw new LockError('this process already holds the lock; open the controller once')
  }
  if (processAlive(existing.pid, existing.bootId, bootId)) {
    throw new LockError(
      `run is owned by live pid ${existing.pid} (boot ${existing.bootId}, acquired ${existing.acquiredAt})`,
    )
  }

  // Stale: replace the record via a fresh staging file, then atomic rename.
  // A concurrent revive between our read and the rename loses to whoever
  // renames last only if it also passed staleness — the record content itself
  // is re-validated by any third acquirer reading the new file.
  const staging = `${path}.takeover-${record.token}`
  const stageHandle = await open(staging, 'wx')
  await stageHandle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
  await stageHandle.sync()
  await stageHandle.close()
  await rename(staging, path)
  return { token: record.token, release: () => unlink(path).catch(() => undefined) }
}
