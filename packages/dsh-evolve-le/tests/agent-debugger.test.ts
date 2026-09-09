import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDebuggerError, remoteAgentDebugger, type RemoteRoutePlan } from '../src/index.js'

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

function plan(baseUrl: string): RemoteRoutePlan {
  return {
    routeId: 'debugger-test',
    baseUrl,
    model: 'fake-debugger',
    temperature: 0,
    maxOutputTokens: 2048,
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 2,
    retry: { maxAttempts: 1, backoffMs: [] },
  }
}

async function endpoint(reply: unknown): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 17, completion_tokens: 19 },
      }),
    )
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}/v1`
}

async function emptyContentEndpoint(): Promise<string> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        // This is the observed reasoning-model failure shape: no answer,
        // but the endpoint confirms it consumed tokens.
        choices: [{ message: { content: '', reasoning_content: 'hidden chain' } }],
        usage: { prompt_tokens: 200, completion_tokens: 2048 },
      }),
    )
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}/v1`
}

const trace = {
  actionId: 'eval-1',
  normalizedTrialDigest: `sha256:${'a'.repeat(64)}`,
  trajectoryDigest: `sha256:${'b'.repeat(64)}`,
  diagnosticTraceDigest: `sha256:${'c'.repeat(64)}`,
  bundle: { events: [{ index: 0, kind: 'tool', data: {} }], tests: [{ index: 0 }] },
}

describe('LLM Agent Debugger', () => {
  it('accepts only an anchored diagnosis and emits a receipt without prompt text', async () => {
    const baseUrl = await endpoint({
      diagnoses: [
        {
          diagnosticTraceDigest: trace.diagnosticTraceDigest,
          summary: 'The test was not run after the final tool mutation.',
          failureModes: ['incomplete-verification'],
          confidence: 0.8,
          evidence: [{ source: 'events', index: 0 }],
          suggestedSurfaces: ['workflow'],
          insufficientEvidence: false,
        },
      ],
    })
    const result = await remoteAgentDebugger({
      plan: plan(baseUrl),
      credential: 'secret',
    }).attribute({
      traces: [trace],
    })
    const artifact = result.artifact.toString('utf8')
    expect(artifact).toContain('dsh-evolve-le/agent-debugger/v1')
    expect(artifact).toContain('incomplete-verification')
    expect(artifact).not.toContain('secret')
    expect(artifact).not.toContain('agent-debugger-contract')
    expect(JSON.parse(artifact)).toMatchObject({
      aggregate: {
        failureModes: [{ mode: 'incomplete-verification', count: 1 }],
        suggestedSurfaces: [{ surface: 'workflow', count: 1 }],
      },
    })
  })

  it('fails closed when the model invents an evidence index', async () => {
    const baseUrl = await endpoint({
      diagnoses: [
        {
          diagnosticTraceDigest: trace.diagnosticTraceDigest,
          summary: 'Unsupported.',
          failureModes: ['unknown'],
          confidence: 0.1,
          evidence: [{ source: 'tests', index: 9 }],
          suggestedSurfaces: [],
          insufficientEvidence: true,
        },
      ],
    })
    await expect(
      remoteAgentDebugger({ plan: plan(baseUrl), credential: 'secret' }).attribute({
        traces: [trace],
      }),
    ).rejects.toBeInstanceOf(AgentDebuggerError)
  })

  it('persists known usage for an empty reasoning-model answer instead of treating it as free', async () => {
    const result = await remoteAgentDebugger({
      plan: plan(await emptyContentEndpoint()),
      credential: 'secret',
    }).attributeWithReceipt({ traces: [trace] })
    expect(result.outcome).toBe('error')
    if (result.outcome === 'error') {
      expect(result.receipt).toMatchObject({
        status: 'error',
        promptTokens: 200,
        completionTokens: 2048,
        modelReportedUsage: true,
      })
      expect(result.receipt.responseSha256).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(result.receipt.costUsdMicros).not.toBeNull()
    }
  })
})
