import { describe, expect, it } from 'vitest'
import { revalidateCapturedStates } from '../../../scripts/revalidate-swepro-state.js'
import {
  diagnoseTrace,
  type FailureReport,
  type TraceBundle,
} from '../src/attribution/trajdebug.js'

const bundle: TraceBundle = {
  events: [
    {
      eventId: 'rule',
      source: 'atif',
      sourceIndex: 0,
      actor: 'user',
      kind: 'trajectory:user',
      data: { content: 'must test' },
      agentId: null,
    },
    {
      eventId: 'error',
      source: 'atif',
      sourceIndex: 1,
      actor: 'agent',
      kind: 'trajectory:assistant',
      data: { content: 'skip tests' },
      agentId: 'a',
    },
    {
      eventId: 'failure',
      source: 'atif',
      sourceIndex: 2,
      actor: 'tool',
      kind: 'tool',
      data: { content: 'failed' },
      agentId: null,
    },
    {
      eventId: 'summary',
      source: 'atif',
      sourceIndex: 3,
      actor: 'agent',
      kind: 'trajectory:assistant',
      data: { content: 'done' },
      agentId: 'a',
    },
  ],
  tests: [],
  terminal: { agentParticipation: 'ran' },
}
async function original(): Promise<FailureReport> {
  return diagnoseTrace(
    {
      runId: 'old',
      candidateId: 'c',
      actionId: 'trial',
      opaqueTaskId: 't',
      attempt: 1,
      split: 'dev-observed',
      inputDigest: 'sha256:' + 'a'.repeat(64),
      bundle,
    },
    async (request) => ({
      status: 'completed',
      output:
        request.stage === 'detect'
          ? {
              findings: [
                {
                  eventId: 'error',
                  referenceEventId: 'rule',
                  wrongContentQuote: 'skip tests',
                  referenceQuote: 'must test',
                  conflictWith: 'task',
                  failureMode: 'omission',
                  module: 'verify',
                },
              ],
            }
          : { states: [] },
    }),
  )
}
describe('read-only State-rule ablation', () => {
  it('changes only State/Select, preserves the source report and exposes strict vs new results', async () => {
    const source = await original()
    const before = JSON.stringify(source)
    const instanceId = source.instances[0]!.instanceId
    const captures = [
      {
        payload: { instances: [{ instanceId }], contextIncomplete: true },
        output: {
          states: [
            {
              instanceId,
              resolution: 'active',
              terminalConnection: 'semantic',
              terminalEvidence: { source: 'events', index: 2, quote: 'failed' },
              explanation: 'The error caused test failure.',
            },
          ],
        },
      },
    ]
    const strict = revalidateCapturedStates(source, bundle, captures, {
      statePolicy: 'strict',
      citationPolicy: 'strict',
    })
    const relaxed = revalidateCapturedStates(source, bundle, captures, {
      statePolicy: 'model-judgment',
      citationPolicy: 'advisory',
    })
    expect(strict.criticalFailure).toBeNull()
    expect(relaxed.criticalFailure?.originStep).toBe(1)
    expect(relaxed.instances[0]?.resolution).toBe('active')
    expect(relaxed.findings).toEqual(source.findings)
    expect(JSON.stringify(source)).toBe(before)
    expect(relaxed.evidenceSufficiency).toBe('insufficient')
  })
  it('refuses State replies belonging to a different candidate pool or missing instances', async () => {
    const source = await original()
    const instanceId = source.instances[0]!.instanceId
    const options = { statePolicy: 'model-judgment' as const, citationPolicy: 'advisory' as const }
    expect(() => revalidateCapturedStates(source, bundle, [], options)).toThrow('missing recorded')
    expect(() =>
      revalidateCapturedStates(
        source,
        bundle,
        [
          {
            payload: { instances: [{ instanceId }], contextIncomplete: false },
            output: { states: [{ instanceId: 'other', resolution: 'active' }] },
          },
        ],
        options,
      ),
    ).toThrow('identity mismatch')
    expect(() =>
      revalidateCapturedStates(
        source,
        bundle,
        [
          {
            payload: { instances: [{ instanceId }], contextIncomplete: false },
            output: { states: [] },
          },
        ],
        options,
      ),
    ).toThrow('missing recorded')
  })
})
