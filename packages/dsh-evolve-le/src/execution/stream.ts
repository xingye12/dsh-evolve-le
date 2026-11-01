/** External, append-only receiver. Worker events remain worker-reported facts. */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { readCanonicalFile, publishCanonical } from './evidence.js'
import { assertExact, ExecutionError } from './types.js'
interface StreamOptions {
  root: string
  store: ObjectStore
  executionId: string
  maxBytes: number
  maxFrameBytes: number
}
export class WorkerStreamReceiver {
  private pending = Buffer.alloc(0)
  private line = Buffer.alloc(0)
  private total = 0
  private lastSequence = 0
  private readonly refs = new Map<string, ObjectRef>()
  private stderrOccurrence = new Map<string, number>()
  private constructor(private readonly options: StreamOptions) {}
  static async open(options: StreamOptions): Promise<WorkerStreamReceiver> {
    const receiver = new WorkerStreamReceiver(options)
    await mkdir(options.root, { recursive: true, mode: 0o700 })
    for (const name of (await readdir(options.root))
      .filter((n) => !n.startsWith('.staging-'))
      .sort()) {
      const ref = await readCanonicalFile(join(options.root, name))
      validateRef(ref)
      await options.store.verify(ref)
      receiver.refs.set(name, ref)
      receiver.total += ref.size
      if (name.startsWith('event-'))
        receiver.lastSequence = Math.max(receiver.lastSequence, Number(name.slice(6, -5)))
    }
    if (receiver.total > options.maxBytes)
      throw new ExecutionError('worker stream total byte limit')
    for (let i = 1; i <= receiver.lastSequence; i++)
      if (!receiver.refs.has(`event-${String(i).padStart(8, '0')}.json`))
        throw new ExecutionError('persisted worker event sequence gap')
    return receiver
  }
  private async persist(name: string, bytes: Buffer, mediaType: string): Promise<void> {
    const previous = this.refs.get(name)
    if (previous) {
      if (previous.digest !== sha256Hex(bytes))
        throw new ExecutionError('worker replay event bytes changed')
      return
    }
    if (bytes.length + this.total > this.options.maxBytes)
      throw new ExecutionError('worker stream total byte limit')
    const ref = await this.options.store.put(bytes, { mediaType, label: 'DEV_OBSERVED' })
    await publishCanonical(join(this.options.root, name), ref)
    this.refs.set(name, ref)
    this.total += bytes.length
  }
  async write(chunk: Buffer): Promise<void> {
    this.pending = Buffer.concat([this.pending, chunk])
    while (this.pending.length >= 8) {
      const channel = this.pending[0],
        size = this.pending.readUInt32BE(4)
      if ((channel !== 1 && channel !== 2) || this.pending.subarray(1, 4).some((v) => v !== 0))
        throw new ExecutionError('invalid Docker worker stream frame')
      if (size > this.options.maxFrameBytes)
        throw new ExecutionError('worker stream frame byte limit')
      if (this.pending.length < size + 8) return
      const payload = this.pending.subarray(8, size + 8)
      this.pending = this.pending.subarray(size + 8)
      if (channel === 2) {
        const digest = sha256Hex(payload),
          occurrence = this.stderrOccurrence.get(digest) ?? 0
        this.stderrOccurrence.set(digest, occurrence + 1)
        await this.persist(
          `stderr-${digest}-${String(occurrence).padStart(8, '0')}.json`,
          payload,
          'application/vnd.dsh-evolve-le.worker-stderr',
        )
        continue
      }
      this.line = Buffer.concat([this.line, payload])
      if (this.line.length > this.options.maxFrameBytes)
        throw new ExecutionError('worker event line byte limit')
      for (;;) {
        const end = this.line.indexOf(10)
        if (end < 0) break
        const bytes = this.line.subarray(0, end)
        this.line = this.line.subarray(end + 1)
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        assertExact(value, ['protocol', 'executionId', 'sequence', 'sessionId', 'event'])
        if (
          value.protocol !== 'dsh-evolve-le/worker-event/v1' ||
          value.executionId !== this.options.executionId ||
          !Number.isSafeInteger(value.sequence) ||
          Number(value.sequence) < 1
        )
          throw new ExecutionError('invalid worker event envelope')
        const seq = Number(value.sequence)
        if (seq > this.lastSequence + 1) throw new ExecutionError('worker event sequence gap')
        await this.persist(
          `event-${String(seq).padStart(8, '0')}.json`,
          bytes,
          'application/vnd.dsh-evolve-le.worker-event+json',
        )
        this.lastSequence = Math.max(seq, this.lastSequence)
      }
    }
  }
  async end(): Promise<void> {
    if (this.pending.length || this.line.length)
      throw new ExecutionError('partial worker stream frame or line')
  }
  async artifacts(): Promise<ObjectRef[]> {
    for (const ref of this.refs.values()) await this.options.store.verify(ref)
    return [...this.refs.values()]
  }
}
