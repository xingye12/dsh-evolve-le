import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect, vi } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { openGenerationLiveDispatch } from '../../src/execution/generation-live-dispatch.js'
import { makeProposalConfig } from './fixtures.js'
it('sends one bounded native tool request, retains credentials only in header, and never retries errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generation-live-'))
  const credential = 'fake-secret-generation-test'
  const fetcher = vi.fn(async (_url: unknown, init: any) => {
    expect(init.headers.authorization).toBe(`Bearer ${credential}`)
    expect(JSON.parse(init.body).messages[0]).toEqual({ role: 'system', content: 'system' })
    expect(JSON.stringify(JSON.parse(init.body))).not.toContain(credential)
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call',
                  type: 'function',
                  function: { name: 'proposal_finish', arguments: '{}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
      { status: 200 },
    )
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    const store = await openObjectStore(join(root, 'cas'))
    const plan = {
      routeId: 'test',
      baseUrl: 'https://model.example/v1',
      model: 'fixed',
      temperature: 0,
      maxOutputTokens: 1024,
      inputUsdPerMTok: 0,
      outputUsdPerMTok: 0,
      retry: { maxAttempts: 1, backoffMs: [] },
    }
    const route = await store.put(Buffer.from(canonicalJson(plan)), {
      label: 'CONTROLLER_INTERNAL',
      mediaType: 'application/json',
    })
    const file = join(root, 'credential')
    await writeFile(file, credential, { mode: 0o600 })
    const config = {
      ...makeProposalConfig(),
      model: { ...makeProposalConfig().model, mode: 'live' as const, route },
      spec: {
        ...makeProposalConfig().spec,
        deadlineUtc: new Date(Date.now() + 60000).toISOString(),
      },
    }
    const dispatch = await openGenerationLiveDispatch(config, store, file)
    const request = {
      provider: 'replay',
      model: 'fixed',
      system: 'system',
      messages: [{ role: 'user', content: 'generate' }],
      tools: [],
    }
    const result = await dispatch('request', request, new AbortController().signal)
    expect(result.toolCalls?.[0]?.name).toBe('proposal_finish')
    expect(JSON.stringify(result)).not.toContain(credential)
    await expect(
      dispatch('large', { ...request, system: 'x'.repeat(20000) }, new AbortController().signal),
    ).rejects.toThrow(/input/)
    fetcher.mockImplementation(async () => new Response('upstream failure', { status: 503 }))
    await expect(dispatch('fail', request, new AbortController().signal)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  }
})
