import { describe, expect, it } from 'vitest'
import {
  diagnoseTrace,
  candidateOverview,
  renderOverview,
  validateFinding,
  stateAnchor,
  validateInstanceState,
  type TraceEvent,
} from '../src/attribution/trajdebug.js'
import { validateDiagnosticArtifact } from '../src/attribution/schemas.js'
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
  it('abstains on missing state; rejects future references and audits unmatched citations', async () => {
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
    expect(report.findings).toHaveLength(2)
    expect(report.rejectedFindings).toHaveLength(1)
    expect(report.findings[1]?.wrongContentQuote).toMatchObject({
      quote: 'invented',
      matchStatus: 'unmatched',
      actualQuote: null,
      field: null,
      start: null,
      end: null,
    })
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
      { ...input, trajectoryPolicy: 'windowed', bundle: { ...input.bundle, events: long } },
      async () => ({ status: 'budget-skipped', output: null }),
    )
    expect(report.stages).toHaveLength(5)
    expect(report.executionStatus).toBe('budget-skipped')
  })
  it('shows all events and uncropped fields to Detect and State in one trajectory', async () => {
    const content = 'start ' + 'x'.repeat(5000) + ' end'
    const long = [
      ...events,
      ...Array.from({ length: 238 }, (_, i) => ({
        ...events[1]!,
        eventId: `atif-${i + 3}`,
        sourceIndex: i + 3,
        data: { content },
      })),
      { ...events[2]!, eventId: 'acp-0', source: 'acp' as const, sourceIndex: 0 },
    ]
    const seen: string[] = []
    const report = await diagnoseTrace(
      { ...input, maxInputBytes: 2000000, bundle: { ...input.bundle, events: long } },
      async (request) => {
        seen.push(request.stage)
        if (request.stage === 'detect') {
          expect(request.window).toBe(0)
          expect(request.payload.events).toHaveLength(242)
          expect((request.payload.events as TraceEvent[])[3]!.data).toEqual({ content })
          expect(request.payload.references).toEqual([])
          expect(request.payload.tests).toEqual(input.bundle.tests)
          return {
            status: 'completed',
            output: {
              findings: [
                {
                  ...finding,
                  eventId: 'atif-200',
                  referenceEventId: 'atif-3',
                  conflictWith: 'self',
                  wrongContentQuote: ' end',
                  referenceQuote: 'start ',
                },
              ],
            },
          }
        }
        expect((request.payload.context as { events: TraceEvent[] }).events).toHaveLength(242)
        expect((request.payload.context as { events: TraceEvent[] }).events[3]!.data).toEqual({
          content,
        })
        expect(request.payload.contextIncomplete).toBe(false)
        return { status: 'completed', output: { states: [] } }
      },
    )
    expect(seen).toEqual(['detect', 'state'])
    expect(report.findings[0]?.step).toBe(200)
    expect(report.findings[0]?.referenceQuote.index).toBe(3)
    expect(report.coverage.omissions).toEqual([])
    expect(report.coverage.contextIncomplete).toBe(false)
  })
  it('records an oversized full trajectory without splitting or paying for a partial view', async () => {
    const report = await diagnoseTrace({ ...input, maxInputBytes: 100 }, async () => {
      throw Error('must not call')
    })
    expect(report.stages).toHaveLength(1)
    expect(report.stages[0]).toMatchObject({
      stage: 'detect',
      status: 'budget-skipped',
      reason: 'input-envelope',
    })
    expect(report.executionStatus).toBe('budget-skipped')
    expect(report.criticalFailure).toBeNull()
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
  it('accepts failure evidence before the final summary and retains active with cropped context', async () => {
    const report = await diagnoseTrace(
      {
        ...input,
        trajectoryPolicy: 'windowed',
        bundle: {
          ...input.bundle,
          events: [
            ...events,
            {
              ...events[1]!,
              eventId: 'atif-3',
              sourceIndex: 3,
              data: { content: 'Task completed. ' + 'x'.repeat(4000) },
            },
          ],
        },
      },
      async (request) => ({
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
                      terminalEvidence: { source: 'events', index: 2, quote: 'failed' },
                      explanation: 'The failed test demonstrates the unresolved error.',
                    },
                  ],
                }
              : { suggestions: [] },
      }),
    )
    expect(report.coverage.contextIncomplete).toBe(true)
    expect(report.instances[0]?.resolution).toBe('active')
    expect(report.instances[0]?.terminalEvidence?.index).toBe(2)
    expect(report.instances[0]?.evidenceIssues).toContain('context-incomplete')
    expect(report.criticalFailure?.originStep).toBe(1)
    validateDiagnosticArtifact('failure-report', report)
  })
  it.each([
    ['active', 'semantic'],
    ['fixed', 'none'],
    ['fixed', 'irreversible'],
    ['fixed', 'budget-debt'],
  ])(
    'retains %s/%s judgment when supporting anchors are absent',
    (resolution, terminalConnection) => {
      const state = validateInstanceState(
        { resolution, terminalConnection, explanation: 'Model judgment.' },
        input.bundle,
        { step: 1, source: 'atif' },
        { statePolicy: 'model-judgment', citationPolicy: 'advisory', contextIncomplete: false },
      )
      expect(state.resolution).toBe(resolution)
      expect(state.terminalConnection).toBe(terminalConnection)
      expect(state.evidenceIssues?.length).toBeGreaterThan(0)
    },
  )
  it('audits malformed or out-of-order anchors without discarding a valid lifecycle judgment', () => {
    const state = validateInstanceState(
      {
        resolution: 'fixed',
        terminalConnection: 'budget-debt',
        fixEvidence: { source: 'events', index: 99, quote: 'repair' },
        terminalEvidence: { source: 'events', index: 0, quote: 'must test' },
        wastedSteps: [{ source: 'events', index: 0, quote: 'must test' }],
        explanation: 'A claimed repair with incomplete support.',
      },
      input.bundle,
      { step: 1, source: 'atif' },
      { statePolicy: 'model-judgment', citationPolicy: 'advisory', contextIncomplete: false },
    )
    expect(state.resolution).toBe('fixed')
    expect(state.fixEvidence).toBeNull()
    expect(state.evidenceIssues).toEqual(
      expect.arrayContaining([
        'fixEvidence: Error: missing evidence index',
        'terminal-order-unverified',
        'wasted-step-order-unverified',
      ]),
    )
  })
  it('still rejects malformed lifecycle states and preserves legacy gating', () => {
    const options = {
      statePolicy: 'model-judgment' as const,
      citationPolicy: 'advisory' as const,
      contextIncomplete: false,
    }
    expect(() =>
      validateInstanceState(
        { resolution: 'invented', terminalConnection: 'semantic', explanation: 'x' },
        input.bundle,
        { step: 1, source: 'atif' },
        options,
      ),
    ).toThrow('invalid lifecycle state')
    expect(() =>
      validateInstanceState(
        { resolution: 'active', terminalConnection: 'invented', explanation: 'x' },
        input.bundle,
        { step: 1, source: 'atif' },
        options,
      ),
    ).toThrow('invalid lifecycle state')
    expect(() =>
      validateInstanceState(
        {
          resolution: 'active',
          terminalConnection: 'semantic',
          terminalEvidence: { source: 'events', index: 1, quote: 'skip tests' },
          explanation: 'x',
        },
        input.bundle,
        { step: 1, source: 'atif' },
        { ...options, statePolicy: 'strict' },
      ),
    ).toThrow('connection requires subsequent or terminal evidence')
  })
  it.each(['semantic', 'irreversible', 'budget-debt'])(
    'does not select a fixed %s cause without specific impact/debt evidence',
    async (connection) => {
      const report = await diagnoseTrace({ ...input, statePolicy: 'strict' }, async (request) => ({
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

describe('advisory citation policy', () => {
  it('preserves the strict profile for legacy diagnosis replay', async () => {
    const report = await diagnoseTrace({ ...input, citationPolicy: 'strict' }, async () => ({
      status: 'completed',
      output: {
        findings: [
          { ...finding, wrongContentQuote: '`skip tests`' },
          { ...finding, failureMode: 'x'.repeat(101) },
        ],
      },
    }))
    expect(report.findings).toEqual([])
    expect(report.rejectedFindings.map((f) => f.reason)).toEqual([
      'Error: quote absent from evidence content',
      'Error: invalid text',
    ])
  })
  it('does not mistake nested event identity metadata for matched content', async () => {
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
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.wrongContentQuote).toMatchObject({
      matchStatus: 'unmatched',
      actualQuote: null,
      quote: 'atif-1',
    })
    expect(report.criticalFailure).toBeNull()
  })
  it('accepts formatting differences, paraphrases and failure modes longer than 3000 characters', async () => {
    const report = await diagnoseTrace(input, async (request) => ({
      status: 'completed',
      output:
        request.stage === 'detect'
          ? {
              findings: [
                {
                  ...finding,
                  wrongContentQuote: '`skip tests`',
                  referenceQuote: 'Testing is mandatory',
                  failureMode: 'x'.repeat(4000),
                },
              ],
            }
          : request.stage === 'state'
            ? {
                states: [
                  {
                    instanceId: (request.payload.instances as { instanceId: string }[])[0]!
                      .instanceId,
                    resolution: 'active',
                    terminalConnection: 'semantic',
                    terminalEvidence: {
                      source: 'events',
                      index: 2,
                      quote: 'The tests did not pass',
                    },
                    explanation: 'The omission persisted.',
                  },
                ],
              }
            : { suggestions: [] },
    }))
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.failureMode).toHaveLength(4000)
    expect(report.rejectedFindings).toEqual([])
    expect(report.criticalFailure?.originStep).toBe(1)
    expect(report.instances[0]?.terminalEvidence?.matchStatus).toBe('unmatched')
    expect(report.evidenceSufficiency).toBe('insufficient')
    validateDiagnosticArtifact('failure-report', report)
    const forged = structuredClone(report)
    forged.findings[0]!.wrongContentQuote.actualQuote = 'pretend verified'
    expect(() => validateDiagnosticArtifact('failure-report', forged)).toThrow()
  })
  it('keeps strict legacy helpers and structural evidence checks', () => {
    const allowed = new Set(events.map((e) => e.eventId))
    expect(() =>
      validateFinding({ ...finding, wrongContentQuote: 'invented' }, input.bundle, allowed, 'f'),
    ).toThrow('quote absent')
    expect(() =>
      validateFinding({ ...finding, eventId: 'missing' }, input.bundle, allowed, 'f', 'advisory'),
    ).toThrow()
    expect(() =>
      validateFinding(
        { ...finding, referenceEventId: 'missing' },
        input.bundle,
        allowed,
        'f',
        'advisory',
      ),
    ).toThrow()
    expect(() =>
      validateFinding(
        { ...finding, wrongContentQuote: '' },
        input.bundle,
        allowed,
        'f',
        'advisory',
      ),
    ).toThrow()
    expect(() =>
      stateAnchor({ source: 'events', index: 99, quote: 'anything' }, input.bundle, 'advisory'),
    ).toThrow()
    expect(() =>
      stateAnchor({ source: 'unknown', index: 2, quote: 'anything' }, input.bundle, 'advisory'),
    ).toThrow()
  })
  it('does not merge unmatched references from different events', async () => {
    const report = await diagnoseTrace(
      {
        ...input,
        bundle: {
          ...input.bundle,
          events: [
            { ...events[0]! },
            { ...events[0]!, eventId: 'other-rule', sourceIndex: 1 },
            { ...events[1]!, sourceIndex: 2 },
            { ...events[2]!, sourceIndex: 3 },
          ],
        },
      },
      async (request) => ({
        status: 'completed',
        output:
          request.stage === 'detect'
            ? {
                findings: [finding, { ...finding, referenceEventId: 'other-rule' }].map((f) => ({
                  ...f,
                  referenceQuote: 'Testing is mandatory',
                })),
              }
            : { states: [] },
      }),
    )
    expect(report.instances).toHaveLength(2)
  })
})
