/** Durable action-wide tool accounting. Unknown effects are never re-executed. */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { validateRef, type ObjectStore, type ObjectRef } from '../state/object-store.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { ExecutionError, assertExact } from './types.js'
export class InvocationLog {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly options: {
      root: string
      store: ObjectStore
      executionId: string
      maxCalls: number
      maxBytes: number
    },
  ) {}
  invoke<T>(
    invocationId: string,
    method: string,
    args: unknown,
    effect: () => Promise<T>,
  ): Promise<T> {
    const task = this.tail
      .catch(() => undefined)
      .then(() => this.perform(invocationId, method, args, effect))
    this.tail = task
    return task
  }
  private async perform<T>(
    invocationId: string,
    method: string,
    args: unknown,
    effect: () => Promise<T>,
  ): Promise<T> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(invocationId) || !method || method.length > 128)
      throw new ExecutionError('invalid external invocation identity')
    const argsRef = await this.options.store.put(Buffer.from(canonicalJson(args)), {
      mediaType: 'application/vnd.dsh-evolve-le.tool-arguments+json',
      label: 'DEV_OBSERVED',
    })
    const binding = {
      executionId: this.options.executionId,
      invocationId,
      method,
      argsDigest: canonicalHash(args),
      args: argsRef,
    }
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const root = join(this.options.root, invocationId)
    let previous: unknown
    try {
      previous = await readCanonicalFile(join(root, 'intent.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (previous !== undefined) {
      assertExact(previous, [
        'executionId',
        'invocationId',
        'method',
        'argsDigest',
        'args',
        'sequence',
      ])
      const { sequence, ...previousBinding } = previous
      if (
        !Number.isSafeInteger(sequence) ||
        Number(sequence) < 1 ||
        canonicalJson(previousBinding) !== canonicalJson(binding)
      )
        throw new ExecutionError('same invocation ID with different args/method')
      let completed: unknown
      try {
        completed = await readCanonicalFile(join(root, 'result.json'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        throw new ExecutionError('AMBIGUOUS external invocation; refusing to repeat effect')
      }
      validateRef(completed)
      const result = parseCanonicalJson((await this.options.store.read(completed)).toString('utf8'))
      assertExact(result, ['ok'], ['value', 'error'])
      if (result.ok === true && 'value' in result) return result.value as T
      if (result.ok === false && typeof result.error === 'string')
        throw new ExecutionError(result.error)
      throw new ExecutionError('invalid invocation result receipt')
    }
    const calls = (await readdir(this.options.root, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    ).length
    if (calls >= this.options.maxCalls)
      throw new ExecutionError('external action tool call budget exhausted')
    await publishCanonical(join(root, 'intent.json'), { ...binding, sequence: calls + 1 })
    try {
      const value = await effect()
      const bytes = Buffer.from(canonicalJson({ ok: true, value }))
      if (bytes.length > this.options.maxBytes)
        throw new ExecutionError('external invocation output byte limit')
      const ref = await this.options.store.put(bytes, {
        mediaType: 'application/vnd.dsh-evolve-le.tool-result+json',
        label: 'DEV_OBSERVED',
      })
      await publishCanonical(join(root, 'result.json'), ref)
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 2048) : 'tool failed'
      const ref = await this.options.store.put(
        Buffer.from(canonicalJson({ ok: false, error: message })),
        { mediaType: 'application/vnd.dsh-evolve-le.tool-result+json', label: 'DEV_OBSERVED' },
      )
      await publishCanonical(join(root, 'result.json'), ref)
      throw error
    }
  }
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined)
  }
  async results(): Promise<Array<{ method: string; value: unknown }>> {
    const output: Array<{ method: string; value: unknown }> = []
    const names = await readdir(this.options.root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const name of names.sort()) {
      const intent = (await readCanonicalFile(join(this.options.root, name, 'intent.json'))) as {
        method: string
      }
      try {
        const ref = await readCanonicalFile(join(this.options.root, name, 'result.json'))
        validateRef(ref)
        const result = parseCanonicalJson(
          (await this.options.store.read(ref)).toString('utf8'),
        ) as { ok?: unknown; value?: unknown }
        if (result.ok === true) output.push({ method: intent.method, value: result.value })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return output
  }
  async count(method: string): Promise<number> {
    let count = 0
    const names = await readdir(this.options.root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const name of names) {
      const intent = (await readCanonicalFile(join(this.options.root, name, 'intent.json'))) as {
        method?: unknown
      }
      if (intent.method === method) count++
    }
    return count
  }
  async assertSettled(): Promise<void> {
    // Validate even completed records before opening any recovered capability.
    await this.artifacts()
    const names = await readdir(this.options.root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    for (const name of names) {
      try {
        await readCanonicalFile(join(this.options.root, name, 'result.json'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new ExecutionError('AMBIGUOUS tool effect; recovered action must fail')
        throw error
      }
    }
  }
  async artifacts(): Promise<ObjectRef[]> {
    const refs: ObjectRef[] = []
    const names = await readdir(this.options.root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const sequences: number[] = []
    for (const name of names.sort()) {
      const intent = await readCanonicalFile(join(this.options.root, name, 'intent.json'))
      assertExact(intent, [
        'executionId',
        'invocationId',
        'method',
        'argsDigest',
        'args',
        'sequence',
      ])
      if (
        intent.executionId !== this.options.executionId ||
        intent.invocationId !== name ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name) ||
        typeof intent.method !== 'string' ||
        intent.method.length === 0 ||
        intent.method.length > 128 ||
        !Number.isSafeInteger(intent.sequence) ||
        Number(intent.sequence) < 1
      )
        throw new ExecutionError('invalid stored invocation binding')
      sequences.push(Number(intent.sequence))
      validateRef(intent.args)
      const args = parseCanonicalJson((await this.options.store.read(intent.args)).toString('utf8'))
      if (canonicalHash(args) !== intent.argsDigest)
        throw new ExecutionError('stored invocation args digest mismatch')
      refs.push(intent.args)
      refs.push(
        await this.options.store.put(Buffer.from(canonicalJson(intent)), {
          mediaType: 'application/vnd.dsh-evolve-le.tool-intent+json',
          label: 'CONTROLLER_INTERNAL',
        }),
      )
      try {
        const ref = await readCanonicalFile(join(this.options.root, name, 'result.json'))
        validateRef(ref)
        await this.options.store.verify(ref)
        refs.push(ref)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    sequences.sort((a, b) => a - b)
    if (sequences.length > this.options.maxCalls || sequences.some((s, i) => s !== i + 1))
      throw new ExecutionError('stored invocation sequence/budget mismatch')
    return refs
  }
}
