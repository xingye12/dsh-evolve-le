/** Credentials and provider dispatch remain external to the proposal domain. */
import { mkdir, readdir, open } from 'node:fs/promises'
import { prepareSupervisorDirectory } from './host-directory.js'
import { join, dirname } from 'node:path'
import { canonicalJson, parseCanonicalJson, sha256Hex } from '../state/canonical.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { validateRef } from '../state/object-store.js'
import type {
  NativeLlmCompletionRequest,
  NativeLlmCompletionResult,
} from '../dsh/native-llm-adapter.js'
import { readCanonicalFile, publishCanonical } from './evidence.js'
import { assertExact, ExecutionError } from './types.js'
export interface ActionModelLimits {
  maxRequests: number
  maxInputTokens: number
  maxOutputTokens: number
  maxTotalTokens: number
  maxCostUsdMicros: number
  maxRequestBytes: number
  inputUsdMicrosPerMillion: number
  outputUsdMicrosPerMillion: number
}
interface ModelIntent {
  executionId: string
  requestId: string
  request: ObjectRef
  requestDigest: string
  sequence: number
  reservedTokens: number
  reservedUsdMicros: number
}
interface ModelResult {
  status: 'SETTLED' | 'AMBIGUOUS' | 'OVERRUN'
  promptTokens: number
  completionTokens: number
  costUsdMicros: number
  result?: NativeLlmCompletionResult
}
export class ActionModelGateway {
  private tail: Promise<unknown> = Promise.resolve()
  private revoked = false
  private paused = false
  private historyRequired = false
  private ledgerReady: Promise<void> | null = null
  constructor(
    private readonly options: {
      root: string
      store: ObjectStore
      executionId: string
      provider: string
      model: string
      limits: ActionModelLimits
      dispatch: (
        requestId: string,
        request: NativeLlmCompletionRequest,
        signal: AbortSignal,
      ) => Promise<NativeLlmCompletionResult>
    },
  ) {
    this.options = { ...options, limits: structuredClone(options.limits) }
    for (const [key, value] of Object.entries(options.limits))
      if (!Number.isSafeInteger(value) || value < 0 || (!key.endsWith('PerMillion') && value === 0))
        throw new ExecutionError('invalid model gateway limits')
  }
  revoke(): void {
    this.revoked = true
  }
  async quiesce(): Promise<void> {
    this.paused = true
    await this.drain()
  }
  resume(): void {
    if (!this.revoked) this.paused = false
  }
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined)
  }
  private cost(input: number, output: number): number {
    const l = this.options.limits
    const cost = Number(
      (BigInt(input) * BigInt(l.inputUsdMicrosPerMillion) +
        BigInt(output) * BigInt(l.outputUsdMicrosPerMillion) +
        999999n) /
        1000000n,
    )
    if (!Number.isSafeInteger(cost)) throw new ExecutionError('model cost overflow')
    return cost
  }
  private get ledgerRoot(): string {
    return `${this.options.root}.ledger`
  }
  private ledgerHeader() {
    return {
      protocol: 'dsh-evolve-le/model-ledger/v1',
      executionId: this.options.executionId,
      provider: this.options.provider,
      model: this.options.model,
      limits: this.options.limits,
    }
  }
  private async initializeLedger(): Promise<void> {
    const entries = async (path: string): Promise<string[] | null> => {
      try {
        return await readdir(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    const [requests, ledger] = await Promise.all([
      entries(this.options.root),
      entries(this.ledgerRoot),
    ])
    if (requests === null && ledger === null) {
      if (this.historyRequired)
        throw new ExecutionError('model ledger missing for previously started execution')
      // Only an entirely fresh account may initialize. Partial initialization or
      // loss is deliberately not repaired into an empty spending history.
      await prepareSupervisorDirectory(this.options.root)
      await prepareSupervisorDirectory(join(this.ledgerRoot, 'intents'))
      await publishCanonical(join(this.ledgerRoot, 'header.json'), this.ledgerHeader())
      const parent = await open(dirname(this.options.root), 'r')
      try {
        await parent.sync()
      } finally {
        await parent.close()
      }
      return
    }
    if (requests === null || ledger === null)
      throw new ExecutionError('model ledger or request history missing')
  }
  private async ledgerNames(): Promise<string[]> {
    this.ledgerReady ??= this.initializeLedger()
    await this.ledgerReady
    const header = await readCanonicalFile(join(this.ledgerRoot, 'header.json'))
    if (canonicalJson(header) !== canonicalJson(this.ledgerHeader()))
      throw new ExecutionError('model ledger configuration drift')
    try {
      const [requests, witnesses] = await Promise.all([
        readdir(this.options.root),
        readdir(join(this.ledgerRoot, 'intents')),
      ])
      requests.sort()
      witnesses.sort()
      if (canonicalJson(requests.map((name) => `${name}.json`).sort()) !== canonicalJson(witnesses))
        throw new ExecutionError('model ledger request history missing or unexpected')
      return requests
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ExecutionError('model ledger or request history missing')
      throw error
    }
  }
  private async records(): Promise<Array<{ intent: ModelIntent; result: ModelResult | null }>> {
    const names = await this.ledgerNames(),
      records: Array<{ intent: ModelIntent; result: ModelResult | null }> = []
    for (const name of names) {
      const intent = (await readCanonicalFile(
        join(this.options.root, name, 'intent.json'),
      )) as ModelIntent
      const witness = await readCanonicalFile(join(this.ledgerRoot, 'intents', `${name}.json`))
      validateRef(witness)
      if (
        canonicalJson(
          parseCanonicalJson((await this.options.store.read(witness)).toString('utf8')),
        ) !== canonicalJson(intent)
      )
        throw new ExecutionError('model ledger intent mismatch')
      assertExact(intent, [
        'executionId',
        'requestId',
        'request',
        'requestDigest',
        'sequence',
        'reservedTokens',
        'reservedUsdMicros',
      ])
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(name) ||
        !Number.isSafeInteger(intent.sequence) ||
        intent.sequence < 1 ||
        intent.reservedTokens !==
          this.options.limits.maxInputTokens + this.options.limits.maxOutputTokens ||
        intent.reservedUsdMicros !==
          this.cost(this.options.limits.maxInputTokens, this.options.limits.maxOutputTokens)
      )
        throw new ExecutionError('invalid model intent reservation/sequence')
      if (intent.executionId !== this.options.executionId || intent.requestId !== name)
        throw new ExecutionError('model intent identity mismatch')
      validateRef(intent.request)
      const requestBytes = await this.options.store.read(intent.request)
      if (
        requestBytes.length > this.options.limits.maxRequestBytes ||
        sha256Hex(requestBytes) !== intent.requestDigest
      )
        throw new ExecutionError('model intent request digest/size mismatch')
      const request: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(requestBytes),
      )
      assertExact(request, ['provider', 'model', 'messages', 'tools'], ['system', 'userText'])
      if (
        request.provider !== this.options.provider ||
        request.model !== this.options.model ||
        !Array.isArray(request.messages) ||
        !Array.isArray(request.tools)
      )
        throw new ExecutionError('stored model route/request mismatch')
      let result: ModelResult | null = null
      try {
        const ref = await readCanonicalFile(join(this.options.root, name, 'result.json'))
        validateRef(ref)
        result = parseCanonicalJson(
          (await this.options.store.read(ref)).toString('utf8'),
        ) as ModelResult
        assertExact(
          result,
          ['status', 'promptTokens', 'completionTokens', 'costUsdMicros'],
          ['result'],
        )
        if (
          !['SETTLED', 'AMBIGUOUS', 'OVERRUN'].includes(result.status) ||
          ![result.promptTokens, result.completionTokens, result.costUsdMicros].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          )
        )
          throw new ExecutionError('invalid model settlement')
        if (result.status === 'AMBIGUOUS') {
          if (
            result.promptTokens !== 0 ||
            result.completionTokens !== 0 ||
            result.costUsdMicros !== 0 ||
            result.result !== undefined
          )
            throw new ExecutionError('invalid ambiguous model settlement')
        } else {
          if (
            !result.result ||
            typeof result.result.responseText !== 'string' ||
            result.result.promptTokens !== result.promptTokens ||
            result.result.completionTokens !== result.completionTokens ||
            result.costUsdMicros !== this.cost(result.promptTokens, result.completionTokens)
          )
            throw new ExecutionError('model settlement usage/cost mismatch')
          const overrun =
            result.promptTokens > this.options.limits.maxInputTokens ||
            result.completionTokens > this.options.limits.maxOutputTokens ||
            result.costUsdMicros > intent.reservedUsdMicros
          if ((result.status === 'OVERRUN') !== overrun)
            throw new ExecutionError('model settlement overrun mismatch')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      records.push({ intent, result })
    }
    records.sort((a, b) => a.intent.sequence - b.intent.sequence)
    for (let i = 0; i < records.length; i++)
      if (records[i]!.intent.sequence !== i + 1)
        throw new ExecutionError('model request sequence gap')
    return records
  }
  async usage(recovery?: { existingOnly: boolean }) {
    if (recovery?.existingOnly) this.historyRequired = true
    let promptTokens = 0,
      completionTokens = 0
    let settledUsdMicros = 0,
      reservedUsdMicros = 0,
      settledTokens = 0,
      reservedTokens = 0
    const records = await this.records()
    for (const r of records) {
      if (r.result?.status === 'SETTLED' || r.result?.status === 'OVERRUN') {
        settledUsdMicros += r.result.costUsdMicros
        settledTokens += r.result.promptTokens + r.result.completionTokens
        promptTokens += r.result.promptTokens
        completionTokens += r.result.completionTokens
      } else {
        reservedUsdMicros += r.intent.reservedUsdMicros
        reservedTokens += r.intent.reservedTokens
      }
    }
    if (
      ![settledUsdMicros, reservedUsdMicros, settledTokens, reservedTokens].every(
        Number.isSafeInteger,
      )
    )
      throw new ExecutionError('model ledger total overflow')
    return {
      promptTokens,
      completionTokens,
      requests: records.length,
      settledUsdMicros,
      reservedUsdMicros,
      settledTokens,
      reservedTokens,
      ambiguous: records.filter((r) => !r.result || r.result.status === 'AMBIGUOUS').length,
    }
  }
  complete(
    requestId: string,
    request: unknown,
    signal: AbortSignal,
  ): Promise<NativeLlmCompletionResult> {
    let captured: unknown
    try {
      captured = structuredClone(request)
    } catch {
      return Promise.reject(new ExecutionError('invalid model request input'))
    }
    const result = this.tail
      .catch(() => undefined)
      .then(() => this.perform(requestId, captured, signal))
    this.tail = result
    return result
  }
  private async perform(
    requestId: string,
    request: unknown,
    signal: AbortSignal,
  ): Promise<NativeLlmCompletionResult> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(requestId))
      throw new ExecutionError('invalid logical model request ID')
    assertExact(request, ['provider', 'model', 'messages', 'tools'], ['system', 'userText'])
    if (
      request.provider !== this.options.provider ||
      request.model !== this.options.model ||
      !Array.isArray(request.messages) ||
      !Array.isArray(request.tools) ||
      (request.system !== undefined && typeof request.system !== 'string')
    )
      throw new ExecutionError('model route/request mismatch')
    // Model-facing JSON may contain fractional schema constants. Hash exact JSON
    // bytes, while durable accounting quantities remain canonical integers.
    const bytes = Buffer.from(JSON.stringify(request))
    if (bytes.length > this.options.limits.maxRequestBytes)
      throw new ExecutionError('model request envelope exceeded')
    const digest = sha256Hex(bytes),
      records = await this.records(),
      previous = records.find((r) => r.intent.requestId === requestId)
    if (previous) {
      if (previous.intent.requestDigest !== digest)
        throw new ExecutionError('model request ID reused with different input')
      if (previous.result?.status === 'SETTLED' && previous.result.result)
        return previous.result.result
      throw new ExecutionError('AMBIGUOUS/failed model dispatch; refusing to repeat')
    }
    if (this.revoked || this.paused || signal.aborted)
      throw new ExecutionError('model capability revoked/aborted')
    const usage = await this.usage(),
      l = this.options.limits,
      reservedTokens = l.maxInputTokens + l.maxOutputTokens,
      reservedUsdMicros = this.cost(l.maxInputTokens, l.maxOutputTokens)
    if (usage.ambiguous > 0 || records.some((r) => r.result?.status === 'OVERRUN'))
      throw new ExecutionError('AMBIGUOUS/overrun action model account; new dispatch forbidden')
    if (
      usage.requests >= l.maxRequests ||
      usage.settledTokens + usage.reservedTokens + reservedTokens > l.maxTotalTokens ||
      usage.settledUsdMicros + usage.reservedUsdMicros + reservedUsdMicros > l.maxCostUsdMicros
    )
      throw new ExecutionError('action model budget exhausted before dispatch')
    await mkdir(this.options.root, { recursive: true, mode: 0o700 })
    const root = join(this.options.root, requestId)
    const requestRef = await this.options.store.put(bytes, {
      mediaType: 'application/vnd.dsh-evolve-le.model-request+json',
      label: 'DEV_OBSERVED',
    })
    const intent: ModelIntent = {
      executionId: this.options.executionId,
      requestId,
      request: requestRef,
      requestDigest: digest,
      sequence: records.length + 1,
      reservedTokens,
      reservedUsdMicros,
    }
    const intentRef = await this.options.store.put(Buffer.from(canonicalJson(intent)), {
      mediaType: 'application/vnd.dsh-evolve-le.model-intent+json',
      label: 'CONTROLLER_INTERNAL',
    })
    await publishCanonical(join(this.ledgerRoot, 'intents', `${requestId}.json`), intentRef)
    await publishCanonical(join(root, 'intent.json'), intent)
    if (this.revoked || this.paused || signal.aborted)
      throw new ExecutionError('model capability revoked before dispatch; reservation retained')
    let result: NativeLlmCompletionResult
    try {
      result = await this.options.dispatch(
        requestId,
        JSON.parse(bytes.toString('utf8')) as NativeLlmCompletionRequest,
        signal,
      )
    } catch {
      const ref = await this.options.store.put(
        Buffer.from(
          canonicalJson({
            status: 'AMBIGUOUS',
            promptTokens: 0,
            completionTokens: 0,
            costUsdMicros: 0,
          }),
        ),
        {
          mediaType: 'application/vnd.dsh-evolve-le.model-settlement+json',
          label: 'CONTROLLER_INTERNAL',
        },
      )
      await publishCanonical(join(root, 'result.json'), ref)
      throw new ExecutionError('AMBIGUOUS provider dispatch; reservation retained')
    }
    if (
      typeof result.responseText !== 'string' ||
      !Number.isSafeInteger(result.promptTokens) ||
      result.promptTokens! < 0 ||
      !Number.isSafeInteger(result.completionTokens) ||
      result.completionTokens! < 0
    )
      throw new ExecutionError('AMBIGUOUS invalid provider usage; reservation retained')
    const input = result.promptTokens!,
      output = result.completionTokens!,
      costUsdMicros = this.cost(input, output),
      overrun =
        input > l.maxInputTokens || output > l.maxOutputTokens || costUsdMicros > reservedUsdMicros
    const settled: ModelResult = {
      status: overrun ? 'OVERRUN' : 'SETTLED',
      promptTokens: input,
      completionTokens: output,
      costUsdMicros,
      result,
    }
    const ref = await this.options.store.put(Buffer.from(canonicalJson(settled)), {
      mediaType: 'application/vnd.dsh-evolve-le.model-settlement+json',
      label: 'CONTROLLER_INTERNAL',
    })
    await publishCanonical(join(root, 'result.json'), ref)
    if (overrun)
      throw new ExecutionError('provider usage exceeded frozen reservation; action failed')
    return result
  }
  async artifacts(): Promise<ObjectRef[]> {
    const records = await this.records()
    const refs: ObjectRef[] = [
      await this.options.store.put(Buffer.from(canonicalJson(this.ledgerHeader())), {
        mediaType: 'application/vnd.dsh-evolve-le.model-ledger+json',
        label: 'CONTROLLER_INTERNAL',
      }),
    ]
    for (const record of records) {
      refs.push(record.intent.request)
      refs.push(
        await this.options.store.put(Buffer.from(canonicalJson(record.intent)), {
          mediaType: 'application/vnd.dsh-evolve-le.model-intent+json',
          label: 'CONTROLLER_INTERNAL',
        }),
      )
      try {
        const ref = await readCanonicalFile(
          join(this.options.root, record.intent.requestId, 'result.json'),
        )
        validateRef(ref)
        refs.push(ref)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return refs
  }
}
