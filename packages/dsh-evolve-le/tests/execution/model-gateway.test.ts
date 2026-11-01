import Ajv from 'ajv'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { ActionModelGateway } from '../../src/execution/model-gateway.js'
describe('external action model reservation and ambiguous dispatch', () => {
  it('shares durable spend across sessions and reuses completed logical requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-model-'))
    const store = await openObjectStore(join(root, 'cas'))
    let calls = 0
    const options = {
      root: join(root, 'requests'),
      store,
      executionId: 'action',
      provider: 'fixture',
      model: 'fixture',
      limits: {
        maxRequests: 2,
        maxInputTokens: 100,
        maxOutputTokens: 20,
        maxTotalTokens: 500,
        maxCostUsdMicros: 1000,
        maxRequestBytes: 10000,
        inputUsdMicrosPerMillion: 1000000,
        outputUsdMicrosPerMillion: 1000000,
      },
      async dispatch() {
        calls++
        return { responseText: 'done', promptTokens: 2, completionTokens: 1 }
      },
    }
    const request = {
      provider: 'fixture',
      model: 'fixture',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    }
    try {
      const gateway = new ActionModelGateway(options)
      expect(
        (await gateway.complete('main-request', request, new AbortController().signal))
          .responseText,
      ).toBe('done')
      const artifacts = await gateway.artifacts()
      const header = JSON.parse((await store.read(artifacts[0]!)).toString('utf8'))
      const schema = new Ajv({ strict: true }).compile(
        JSON.parse(await readFile('schemas/model.ledger.schema.json', 'utf8')),
      )
      expect(schema(header), JSON.stringify(schema.errors)).toBe(true)
      expect(schema({ ...header, credentials: 'forbidden' })).toBe(false)
      const replay = new ActionModelGateway(options)
      await replay.complete('main-request', request, new AbortController().signal)
      expect(calls).toBe(1)
      await replay.complete('subagent-request', request, new AbortController().signal)
      expect(calls).toBe(2)
      await expect(
        replay.complete('recovery-request', request, new AbortController().signal),
      ).rejects.toThrow(/budget/)
      expect((await replay.usage()).settledUsdMicros).toBe(6)
      const intentPath = join(options.root, 'main-request', 'intent.json')
      const original = await readFile(intentPath, 'utf8')
      const intent = JSON.parse(original)
      for (const mutation of [
        { reservedUsdMicros: -1 },
        { reservedTokens: 0 },
        { requestDigest: '0'.repeat(64) },
        { sequence: 1.5 },
      ]) {
        await writeFile(intentPath, JSON.stringify({ ...intent, ...mutation }))
        await expect(new ActionModelGateway(options).usage()).rejects.toThrow()
      }
      await writeFile(intentPath, original)
      const bad = await store.put(
        Buffer.from(
          JSON.stringify({
            status: 'SETTLED',
            promptTokens: 2,
            completionTokens: 1,
            costUsdMicros: -10,
            result: { responseText: 'done', promptTokens: 2, completionTokens: 1 },
          }),
        ),
        { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
      )
      await writeFile(join(options.root, 'main-request', 'result.json'), JSON.stringify(bad))
      await expect(new ActionModelGateway(options).usage()).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('records AMBIGUOUS, retains worst-case reservation and never blindly repeats a paid request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-model-'))
    const store = await openObjectStore(join(root, 'cas'))
    let calls = 0
    const options = {
      root: join(root, 'requests'),
      store,
      executionId: 'action',
      provider: 'fixture',
      model: 'fixture',
      limits: {
        maxRequests: 4,
        maxInputTokens: 100,
        maxOutputTokens: 20,
        maxTotalTokens: 500,
        maxCostUsdMicros: 1000,
        maxRequestBytes: 10000,
        inputUsdMicrosPerMillion: 1000000,
        outputUsdMicrosPerMillion: 1000000,
      },
      async dispatch(): Promise<never> {
        calls++
        throw Error('transport lost after send')
      },
    }
    const request = { provider: 'fixture', model: 'fixture', messages: [], tools: [] }
    try {
      const gateway = new ActionModelGateway(options)
      await expect(gateway.complete('req', request, new AbortController().signal)).rejects.toThrow(
        /AMBIGUOUS/,
      )
      const replay = new ActionModelGateway(options)
      await expect(replay.complete('req', request, new AbortController().signal)).rejects.toThrow(
        /AMBIGUOUS/,
      )
      await expect(replay.complete('new', request, new AbortController().signal)).rejects.toThrow(
        /AMBIGUOUS/,
      )
      expect(calls).toBe(1)
      expect((await replay.usage()).reservedUsdMicros).toBe(120)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('model ledger loss and frozen dispatch inputs', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'model-ledger-'))
    const store = await openObjectStore(join(root, 'cas'))
    let calls = 0
    const options = {
      root: join(root, 'models'),
      store,
      executionId: 'action',
      provider: 'fixture',
      model: 'fixture',
      limits: {
        maxRequests: 2,
        maxInputTokens: 100,
        maxOutputTokens: 20,
        maxTotalTokens: 500,
        maxCostUsdMicros: 1000,
        maxRequestBytes: 10000,
        inputUsdMicrosPerMillion: 1000000,
        outputUsdMicrosPerMillion: 1000000,
      },
      async dispatch() {
        calls++
        return { responseText: 'done', promptTokens: 2, completionTokens: 1 }
      },
    }
    const request = { provider: 'fixture', model: 'fixture', messages: [], tools: [] }
    return {
      root,
      options,
      request,
      get calls() {
        return calls
      },
    }
  }
  it.each(['last-request', 'request-root', 'ledger-root'])(
    'fails closed when %s disappears across reopen',
    async (loss) => {
      const f = await fixture()
      try {
        await new ActionModelGateway(f.options).complete(
          'paid',
          f.request,
          new AbortController().signal,
        )
        await rm(
          loss === 'last-request'
            ? join(f.options.root, 'paid')
            : loss === 'request-root'
              ? f.options.root
              : `${f.options.root}.ledger`,
          {
            recursive: true,
          },
        )
        const reopened = new ActionModelGateway(f.options)
        await expect(reopened.usage()).rejects.toThrow(/ledger/)
        await expect(
          reopened.complete('next', f.request, new AbortController().signal),
        ).rejects.toThrow(/ledger/)
        expect(f.calls).toBe(1)
      } finally {
        await rm(f.root, { recursive: true, force: true })
      }
    },
  )
  it('refuses initialization when the executor proves an execution already started', async () => {
    const f = await fixture()
    try {
      const first = new ActionModelGateway(f.options)
      await first.complete('first', f.request, new AbortController().signal)
      await rm(f.options.root, { recursive: true })
      await rm(`${f.options.root}.ledger`, { recursive: true })
      const reopened = new ActionModelGateway(f.options)
      await expect(reopened.usage({ existingOnly: true })).rejects.toThrow(/ledger missing/)
      await expect(
        reopened.complete('second', f.request, new AbortController().signal),
      ).rejects.toThrow(/ledger missing/)
      expect(f.calls).toBe(1)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
  it('rejects budget drift on reopen and freezes options after construction', async () => {
    const f = await fixture()
    try {
      const gateway = new ActionModelGateway(f.options)
      await gateway.complete('first', f.request, new AbortController().signal)
      f.options.limits.maxRequests = 99
      await expect(new ActionModelGateway(f.options).usage()).rejects.toThrow(/ledger/)
      await gateway.complete('second', f.request, new AbortController().signal)
      await expect(
        gateway.complete('third', f.request, new AbortController().signal),
      ).rejects.toThrow(/budget/)
      expect(f.calls).toBe(2)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
  it('rechecks revocation after the durable reservation before provider dispatch', async () => {
    const f = await fixture()
    try {
      let reserved!: () => void, release!: () => void
      const reached = new Promise<void>((resolve) => {
        reserved = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const store = {
        ...f.options.store,
        async put(...args: Parameters<typeof f.options.store.put>) {
          const ref = await f.options.store.put(...args)
          if (args[1].mediaType === 'application/vnd.dsh-evolve-le.model-request+json') {
            reserved()
            await gate
          }
          return ref
        },
      }
      const gateway = new ActionModelGateway({ ...f.options, store })
      const pending = gateway.complete('first', f.request, new AbortController().signal)
      const rejected = expect(pending).rejects.toThrow(/revoked before dispatch/)
      await reached
      gateway.revoke()
      release()
      await rejected
      expect(f.calls).toBe(0)
      const usage = await new ActionModelGateway(f.options).usage()
      expect(usage.ambiguous).toBe(1)
      expect(usage.reservedUsdMicros).toBe(120)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
  it('captures request bytes before queueing rather than dispatching caller mutations', async () => {
    const f = await fixture()
    try {
      const gateway = new ActionModelGateway(f.options)
      const pending = gateway.complete('first', f.request, new AbortController().signal)
      f.request.model = 'mutated'
      await expect(pending).resolves.toMatchObject({ responseText: 'done' })
      expect(f.calls).toBe(1)
    } finally {
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
