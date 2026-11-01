/** Cross-supervisor admission. Files are authoritative; flock serializes short transactions. */
import { spawn } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { canonicalHash } from '../state/canonical.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { ResourceAdmission, type ResourceCapacity } from './resources.js'
import {
  ExecutionError,
  validateExecutionSpec,
  type ExecutionSpec,
  type ExecutionKind,
} from './types.js'
export interface AdmissionControl {
  reserve(spec: ExecutionSpec): boolean | Promise<boolean>
  release(executionId: string): void | Promise<void>
}
interface LedgerRequest {
  root: string
  pools: Record<ExecutionKind, ResourceCapacity>
  operation: 'reserve' | 'release'
  executionId: string
  spec?: ExecutionSpec
}
export async function changeResourceReservation(request: LedgerRequest): Promise<boolean> {
  const root = request.root
  if (resolve(root) !== root || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(request.executionId))
    throw new ExecutionError('invalid reservation ledger identity')
  await publishCanonical(join(root, 'capacity.json'), request.pools)
  const recordsRoot = join(root, 'reservations')
  await mkdir(recordsRoot, { recursive: true, mode: 0o700 })
  const current = join(recordsRoot, request.executionId)
  if (request.operation === 'release') {
    await readCanonicalFile(join(current, 'reserved.json'))
    await publishCanonical(join(current, 'released.json'), {
      executionId: request.executionId,
      released: true,
    })
    return true
  }
  if (!request.spec || request.spec.executionId !== request.executionId)
    throw new ExecutionError('invalid reservation spec')
  validateExecutionSpec(request.spec)
  let previous: unknown
  try {
    previous = await readCanonicalFile(join(current, 'reserved.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (previous !== undefined) {
    const spec = validateExecutionSpec(previous)
    if (canonicalHash(spec) !== canonicalHash(request.spec))
      throw new ExecutionError('resource reservation identity drift')
    try {
      await readCanonicalFile(join(current, 'released.json'))
      throw new ExecutionError('released execution identity cannot reserve again')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return true
  }
  const admission = new ResourceAdmission(request.pools)
  for (const name of (await readdir(recordsRoot)).sort()) {
    let released = false
    try {
      await readCanonicalFile(join(recordsRoot, name, 'released.json'))
      released = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (released) continue
    const spec = validateExecutionSpec(
      await readCanonicalFile(join(recordsRoot, name, 'reserved.json')),
    )
    if (!admission.reserve(spec))
      throw new ExecutionError('persisted reservations exceed frozen host capacity')
  }
  if (!admission.reserve(request.spec)) return false
  await publishCanonical(join(current, 'reserved.json'), request.spec)
  return true
}
export class PersistentResourceAdmission implements AdmissionControl {
  constructor(
    private readonly options: { root: string; pools: Record<ExecutionKind, ResourceCapacity> },
  ) {}
  private async transaction(
    operation: 'reserve' | 'release',
    executionId: string,
    spec?: ExecutionSpec,
  ): Promise<boolean> {
    const request: LedgerRequest = {
      ...this.options,
      operation,
      executionId,
      ...(spec ? { spec } : {}),
    }
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const nonce = randomUUID(),
      path = join(this.options.root, 'requests', `${nonce}.json`)
    await publishCanonical(path, request)
    const moduleDir = dirname(fileURLToPath(import.meta.url)),
      entry = moduleDir.endsWith('/src/execution')
        ? resolve(moduleDir, '../../lib/bin/resource-reservation.js')
        : resolve(moduleDir, '../bin/resource-reservation.js')
    // Kernel lock has no time-based takeover; SIGKILL releases it atomically.
    return new Promise<boolean>((resolveRun, reject) => {
      const child = spawn(
        '/usr/bin/flock',
        [
          '--exclusive',
          '--no-fork',
          join(this.options.root, 'ledger.lock'),
          process.execPath,
          entry,
          path,
        ],
        { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = '',
        stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(
          new ExecutionError('reservation transaction timeout; reconcile original execution ID'),
        )
      }, 10000)
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString('utf8')
        if (stdout.length > 4096) child.kill('SIGKILL')
      })
      child.stderr.on('data', (b: Buffer) => {
        stderr = (stderr + b.toString('utf8')).slice(-4096)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new ExecutionError(stderr || 'resource transaction failed'))
          return
        }
        try {
          const value = JSON.parse(stdout) as { admitted?: unknown }
          if (typeof value.admitted !== 'boolean')
            throw new ExecutionError('invalid reservation receipt')
          resolveRun(value.admitted)
        } catch (error) {
          reject(error)
        }
      })
    })
  }
  reserve(spec: ExecutionSpec): Promise<boolean> {
    return this.transaction('reserve', spec.executionId, spec)
  }
  async release(executionId: string): Promise<void> {
    await this.transaction('release', executionId)
  }
}
/** Entry-point reader only accepts a supervisor-owned request file. */
export async function runResourceReservationRequest(path: string): Promise<boolean> {
  const raw = (await readCanonicalFile(path)) as LedgerRequest
  if (resolve(raw.root) !== raw.root || !path.startsWith(join(raw.root, 'requests') + '/'))
    throw new ExecutionError('resource request outside registry')
  return changeResourceReservation(raw)
}
