import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { frozenReplayDispatch } from '../../src/execution/replay-transport.js'
import { ActionModelGateway } from '../../src/execution/model-gateway.js'
it('uses durable action sequence across replay transport reopen and refuses live/charged fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frozen-replay-'))
  try {
    const store = await openObjectStore(join(root, 'cas'))
    const route = await store.put(
      Buffer.from(
        canonicalJson({
          protocol: 'dsh-evolve-le/model-replay/v1',
          provider: 'replay',
          model: 'fixed',
          responses: [
            { responseText: 'one', promptTokens: 1, completionTokens: 1 },
            { responseText: 'two', promptTokens: 1, completionTokens: 1 },
          ],
        }),
      ),
      { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
    )
    const model = {
      provider: 'replay',
      model: 'fixed',
      limits: {
        maxRequests: 2,
        maxInputTokens: 100,
        maxOutputTokens: 20,
        maxTotalTokens: 500,
        maxCostUsdMicros: 1,
        maxRequestBytes: 10000,
        inputUsdMicrosPerMillion: 0,
        outputUsdMicrosPerMillion: 0,
      },
    }
    const options = { store, root: join(root, 'requests'), executionId: 'action', route, model }
    const request = {
      provider: 'replay',
      model: 'fixed',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    }
    const first = new ActionModelGateway({
      ...options,
      ...model,
      dispatch: await frozenReplayDispatch(options),
    })
    expect((await first.complete('main', request, new AbortController().signal)).responseText).toBe(
      'one',
    )
    const dispatch = await frozenReplayDispatch(options)
    const second = new ActionModelGateway({ ...options, ...model, dispatch })
    expect(
      (await second.complete('recovery', request, new AbortController().signal)).responseText,
    ).toBe('two')
    expect(
      (await second.complete('main', request, new AbortController().signal)).responseText,
    ).toBe('one')
    await expect(dispatch('unregistered', request, new AbortController().signal)).rejects.toThrow()
    await expect(
      frozenReplayDispatch({
        ...options,
        model: { ...model, limits: { ...model.limits, inputUsdMicrosPerMillion: 1 } },
      }),
    ).rejects.toThrow(/not enabled/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
