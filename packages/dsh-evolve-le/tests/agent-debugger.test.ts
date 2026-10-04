import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentDebuggerError,
  remoteAgentDebugger,
  selectDebuggerTraces,
  type RemoteRoutePlan,
} from '../src/index.js'

let server: Server | undefined
let requestBody: string | undefined

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
  requestBody = undefined
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
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requestBody = Buffer.concat(chunks).toString('utf8')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(reply) } }],
          usage: { prompt_tokens: 17, completion_tokens: 19 },
        }),
      )
    })
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
  bundle: {
    events: [
      {
        index: 0,
        eventId: 'e-0000',
        kind: 'trajectory:assistant',
        data: { content: 'skip tests' },
      },
      { index: 1, eventId: 'e-0001', kind: 'tool', data: { result: 'tests failed' } },
    ],
    tests: [{ index: 0, name: 'smoke', status: 'failed', detail: 'assertion failed' }],
  },
}

describe('LLM Agent Debugger', () => {
  it('keeps every input-envelope-fitting trace in deterministic order', () => {
    const traces = Array.from({ length: 5 }, (_unused, index) => ({
      ...trace,
      diagnosticTraceDigest: `sha256:${String(index).padStart(64, '0')}`,
    }))
    const selected = selectDebuggerTraces(traces.reverse(), 1_000_000)
    expect(selected).toHaveLength(5)
    expect(selected.map((entry) => entry.diagnosticTraceDigest)).toEqual(
      traces
        .map((entry) => entry.diagnosticTraceDigest)
        .sort()
        .slice(0, 5),
    )
  })

  it('accepts a quote-anchored lifecycle diagnosis and derives its critical failure', async () => {
    const baseUrl = await endpoint({
      diagnoses: [
        {
          traceId: 'trace-001',
          summary: 'The agent committed to skipping the failed test rather than repairing it.',
          suggestedSurfaces: ['workflow'],
          insufficientEvidence: false,
          triggers: [
            {
              triggerId: 't-1',
              step: 0,
              module: 'verify',
              violatedObject: 'the failed smoke test',
              wrongCommitment: { source: 'events', index: 0, quote: 'skip tests' },
              violatedReference: { source: 'events', index: 1, quote: 'tests failed' },
              confidence: 0.8,
            },
          ],
          instances: [
            {
              instanceId: 'i-1',
              triggerIds: ['t-1'],
              qualifiedOriginStep: 0,
              resolution: 'active',
              terminalConnection: 'semantic',
              terminalEvidence: { source: 'tests', index: 0, quote: 'failed' },
              explanation: 'The terminal smoke test remains failed.',
            },
          ],
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
    expect(artifact).toContain('dsh-evolve-le/agent-debugger/v3')
    expect(artifact).toContain(trace.diagnosticTraceDigest)
    expect(artifact).toContain('criticalFailure')
    expect(artifact).not.toContain('secret')
    expect(artifact).not.toContain('agent-debugger-contract')
    expect(requestBody).toContain('trace-001')
    expect(requestBody).not.toContain(trace.diagnosticTraceDigest)
    expect(JSON.parse(artifact)).toMatchObject({
      aggregate: {
        modules: [{ module: 'verify', count: 1 }],
        terminalConnections: [{ terminalConnection: 'semantic', count: 1 }],
      },
    })
  })

  it('fails closed when the model invents an evidence index', async () => {
    const baseUrl = await endpoint({
      diagnoses: [
        {
          traceId: 'trace-001',
          summary: 'Unsupported.',
          suggestedSurfaces: [],
          insufficientEvidence: false,
          triggers: [
            {
              triggerId: 't-1',
              step: 0,
              module: 'act',
              violatedObject: 'x',
              confidence: 0.1,
              wrongCommitment: { source: 'events', index: 9, quote: 'skip tests' },
              violatedReference: { source: 'events', index: 1, quote: 'tests failed' },
            },
          ],
          instances: [
            {
              instanceId: 'i-1',
              triggerIds: ['t-1'],
              qualifiedOriginStep: 0,
              resolution: 'unknown',
              terminalConnection: 'unknown',
              terminalEvidence: { source: 'tests', index: 0, quote: 'failed' },
              explanation: 'x',
            },
          ],
        },
      ],
    })
    await expect(
      remoteAgentDebugger({ plan: plan(baseUrl), credential: 'secret' }).attribute({
        traces: [trace],
      }),
    ).rejects.toBeInstanceOf(AgentDebuggerError)
  })

  it('fails closed when the model invents a short trace id', async () => {
    const baseUrl = await endpoint({
      diagnoses: [
        {
          traceId: 'trace-999',
          summary: 'Unsupported.',
          suggestedSurfaces: [],
          insufficientEvidence: true,
          triggers: [],
          instances: [],
        },
      ],
    })
    await expect(
      remoteAgentDebugger({ plan: plan(baseUrl), credential: 'secret' }).attribute({
        traces: [trace],
      }),
    ).rejects.toThrow(/unknown traceId/)
  })

  it('fails closed when a claimed quote is not verbatim in the cited event', async () => {
    const baseUrl = await endpoint({
      diagnoses: [
        {
          traceId: 'trace-001',
          summary: 'Unsupported claim.',
          suggestedSurfaces: [],
          insufficientEvidence: false,
          triggers: [
            {
              triggerId: 't-1',
              step: 0,
              module: 'act',
              violatedObject: 'x',
              confidence: 0.5,
              wrongCommitment: { source: 'events', index: 0, quote: 'invented quote' },
              violatedReference: { source: 'events', index: 1, quote: 'tests failed' },
            },
          ],
          instances: [
            {
              instanceId: 'i-1',
              triggerIds: ['t-1'],
              qualifiedOriginStep: 0,
              resolution: 'active',
              terminalConnection: 'semantic',
              terminalEvidence: { source: 'tests', index: 0, quote: 'failed' },
              explanation: 'x',
            },
          ],
        },
      ],
    })
    await expect(
      remoteAgentDebugger({ plan: plan(baseUrl), credential: 'secret' }).attribute({
        traces: [trace],
      }),
    ).rejects.toThrow(/quote is not verbatim/)
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
