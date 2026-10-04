import { describe, expect, it } from 'vitest'
import {
  diagnoseTrace,
  candidateOverview,
  renderOverview,
  type TraceEvent,
} from '../src/attribution/trajdebug.js'
const events: TraceEvent[] = [
  {
    eventId: 'atif-0',
    source: 'atif',
    sourceIndex: 0,
    actor: 'runtime',
    kind: 'trajectory:system',
    data: { content: 'must test' },
    agentId: null,
  },
  {
    eventId: 'atif-1',
    source: 'atif',
    sourceIndex: 1,
    actor: 'agent',
    kind: 'trajectory:assistant',
    data: { content: 'skip tests' },
    agentId: 'a',
  },
  {
    eventId: 'atif-2',
    source: 'atif',
    sourceIndex: 2,
    actor: 'tool',
    kind: 'tool',
    data: { content: 'failed' },
    agentId: 'a',
  },
]
const input = {
  runId: 'r',
  candidateId: 'c',
  actionId: 'eval-1',
  opaqueTaskId: 'task',
  attempt: 1,
  split: 'dev-observed' as const,
  inputDigest: 'sha256:' + 'a'.repeat(64),
  bundle: { events, tests: [{ detail: 'failed' }], terminal: { agentParticipation: 'ran' } },
}
const finding = {
  eventId: 'atif-1',
  wrongContentQuote: 'skip tests',
  referenceQuote: 'must test',
  referenceEventId: 'atif-0',
  conflictWith: 'task',
  failureMode: 'incomplete-verification',
  module: 'verify',
}
describe('TrajDebug v4 contracts', () => {
  it('abstains on missing state; retains rejected future and fabricated citations', async () => {
    const report = await diagnoseTrace(input, async (request) => ({
      status: 'completed',
      output:
        request.stage === 'detect'
          ? {
              findings: [
                finding,
                {
                  ...finding,
                  referenceEventId: 'atif-2',
                  referenceQuote: 'failed',
                  conflictWith: 'context',
                },
                { ...finding, wrongContentQuote: 'invented' },
              ],
            }
          : { states: [] },
    }))
    expect(report.findings).toHaveLength(1)
    expect(report.rejectedFindings).toHaveLength(2)
    expect(report.instances[0]?.resolution).toBe('unknown')
    expect(report.criticalFailure).toBeNull()
  })
  it('selects grounded cause and invokes independent suggestion-only recover', async () => {
    const stages: string[] = []
    const report = await diagnoseTrace(input, async (request) => {
      stages.push(request.stage)
      return {
        status: 'completed',
        output:
          request.stage === 'detect'
            ? { findings: [finding] }
            : request.stage === 'state'
              ? {
                  states: [
                    {
                      instanceId: (request.payload.instances as { instanceId: string }[])[0]!
                        .instanceId,
                      resolution: 'active',
                      terminalConnection: 'semantic',
                      terminalEvidence: { source: 'tests', index: 0, quote: 'failed' },
                      explanation: 'terminal test fails',
                    },
                  ],
                }
              : {
                  suggestions: [
                    {
                      surface: 'workflow',
                      mechanism: 'require testing',
                      hypothesis: 'test omission decreases',
                      mechanismTest: 'test omission fixture',
                      preservationTest: 'successful fixture',
                      evidenceFindingIds: ['f-0-0'],
                    },
                  ],
                },
      }
    })
    expect(stages).toEqual(['detect', 'state', 'recover'])
    expect(report.criticalFailure?.originStep).toBe(1)
    expect(report.suggestions).toHaveLength(1)
  })
  it('does not infer causes for never initialized or missing traces', async () => {
    const report = await diagnoseTrace(
      {
        ...input,
        bundle: { events: [], tests: [], terminal: { agentParticipation: 'never-initialized' } },
      },
      async () => {
        throw Error('must not call')
      },
    )
    expect(report.executionStatus).toBe('unanalyzable')
  })
  it('keeps every window beyond 192 events and records budget skips', async () => {
    const long = Array.from({ length: 241 }, (_, i) => ({
      ...events[1]!,
      eventId: `atif-${i}`,
      sourceIndex: i,
    }))
    const report = await diagnoseTrace(
      { ...input, bundle: { ...input.bundle, events: long } },
      async () => ({ status: 'budget-skipped', output: null }),
    )
    expect(report.stages).toHaveLength(5)
    expect(report.executionStatus).toBe('budget-skipped')
  })
  it('counts trials once per group, keeps candidate ownership and excludes guarded/tournament rows', () => {
    const observations = [
      {
        ...input,
        outcome: 'failure' as const,
        reward: 0 as const,
        costUsdMicros: 0,
        durationMs: 1,
      },
      {
        ...input,
        actionId: 'success',
        outcome: 'success' as const,
        reward: 1 as const,
        costUsdMicros: 0,
        durationMs: 1,
      },
      {
        ...input,
        candidateId: 'sibling',
        actionId: 'other',
        outcome: 'failure' as const,
        reward: 0 as const,
        costUsdMicros: 0,
        durationMs: 1,
      },
      {
        ...input,
        actionId: 'tourn-1',
        outcome: 'failure' as const,
        reward: 0 as const,
        costUsdMicros: 0,
        durationMs: 1,
      },
    ]
    const overview = candidateOverview('r', 'c', observations, [])
    expect(overview.totalTrials).toBe(2)
    expect(overview.failedTrials).toBe(1)
    expect(overview.distinctTasks).toBe(1)
    expect(renderOverview(overview)).toContain('Trial success rate')
    expect(candidateOverview('r', 'empty', observations, []).totalTrials).toBe(0)
  })
})

describe('repair and quote qualification', () => {
  it.each(['semantic', 'irreversible', 'budget-debt'])(
    'does not select a fixed %s cause without specific impact/debt evidence',
    async (connection) => {
      const report = await diagnoseTrace(input, async (request) => ({
        status: 'completed',
        output:
          request.stage === 'detect'
            ? { findings: [finding] }
            : {
                states: [
                  {
                    instanceId: (request.payload.instances as { instanceId: string }[])[0]!
                      .instanceId,
                    resolution: 'fixed',
                    terminalConnection: connection,
                    fixEvidence: { source: 'events', index: 2, quote: 'failed' },
                    terminalEvidence: { source: 'tests', index: 0, quote: 'failed' },
                    explanation: 'claimed repair',
                  },
                ],
              },
      }))
      expect(report.criticalFailure).toBeNull()
    },
  )
  it('verifies whitespace-normalized quotes with original field positions and clusters concrete repeats', async () => {
    const report = await diagnoseTrace(
      {
        ...input,
        bundle: {
          ...input.bundle,
          events: [{ ...events[0]!, data: { content: 'must\n  test' } }, events[1]!, events[2]!],
        },
      },
      async (request) => ({
        status: 'completed',
        output:
          request.stage === 'detect'
            ? { findings: [finding, { ...finding, failureMode: 'policy-violation' }] }
            : { states: [] },
      }),
    )
    expect(report.findings).toHaveLength(2)
    expect(report.findings[0]?.referenceQuote).toMatchObject({
      field: '/content',
      start: 0,
      end: 11,
      actualQuote: 'must\n  test',
    })
    expect(report.instances).toHaveLength(1)
  })
  it('records malformed stage output as call failure rather than no errors', async () => {
    const report = await diagnoseTrace(input, async () => ({
      status: 'completed',
      output: { unexpected: true },
    }))
    expect(report.executionStatus).toBe('call-failed')
    expect(report.stages[0]?.reason).toContain('expected array')
  })
})

describe('content citation requirement', () => {
  it('rejects a quote matching only nested event identity metadata', async () => {
    const bundle = {
      ...input.bundle,
      events: [
        events[0]!,
        { ...events[1]!, data: { content: 'skip tests', event_id: 'atif-1' } },
        events[2]!,
      ],
    }
    const report = await diagnoseTrace({ ...input, bundle }, async () => ({
      status: 'completed',
      output: { findings: [{ ...finding, wrongContentQuote: 'atif-1' }] },
    }))
    expect(report.findings).toEqual([])
    expect(report.rejectedFindings[0]?.reason).toContain('quote absent')
    expect(report.criticalFailure).toBeNull()
  })
})
