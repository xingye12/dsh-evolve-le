import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adaptTrajectory } from '../src/attribution/offline-evaluation.js'
import { runOfflineEvaluation, type EvaluationProfile } from '../src/attribution/offline-runner.js'
import type { AttributionAttempt } from '../src/attribution/agent-debugger.js'
const item = adaptTrajectory(
  {
    messages: [
      { step: 0, role: 'user', content: 'must test' },
      { step: 1, role: 'assistant', content: 'skip tests' },
      { step: 2, role: 'assistant', content: 'failed' },
    ],
    metadata: { task_id: 'task', reward: 0, annotation: { critical_error_step: 1 } },
  },
  'case-001',
)
const profile: EvaluationProfile = {
  runId: 'offline-test',
  totalUsdMicros: 1000000,
  totalWallSeconds: 3600,
  maxInputBytes: 524288,
  requestTimeoutMs: 1000,
  perCaseCalls: 16,
  perCaseTokens: 2000000,
  perCaseUsdMicros: 1000000,
  bootstrapSamples: 100,
  sourceIdentity: { source: 'fixture' },
  plan: {
    routeId: 'fixture',
    baseUrl: 'http://localhost',
    model: 'fixture',
    temperature: 0,
    maxOutputTokens: 100,
    inputUsdPerMTok: 0.14,
    outputUsdPerMTok: 0.28,
    retry: { maxAttempts: 1, backoffMs: [] },
  },
}
const attempt = (output: unknown): AttributionAttempt => ({
  outcome: 'ok',
  artifact: Buffer.from(JSON.stringify({ output })),
  receipt: {
    routeId: 'fixture',
    routeHash: 'sha256:' + 'a'.repeat(64),
    inputSha256: 'sha256:' + 'b'.repeat(64),
    status: 'ok',
    responseSha256: 'sha256:' + 'c'.repeat(64),
    promptTokens: 10,
    completionTokens: 10,
    costUsdMicros: 5,
    modelReportedUsage: true,
    attempts: [{ ok: true }],
  },
})
describe('offline controller evaluation', () => {
  it('runs v4 only with a 65536 output cap, validates a root and replays without repayment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-v4-64k-'))
    const selected: EvaluationProfile = {
      ...profile,
      methods: ['v4'],
      plan: { ...profile.plan, maxOutputTokens: 65536 },
    }
    const stages: string[] = []
    const execute = {
      baseline: async () => {
        throw Error('baseline must not run')
      },
      stage: async (request: import('../src/attribution/trajdebug.js').StageRequest) => {
        stages.push(request.stage)
        return attempt(
          request.stage === 'detect'
            ? {
                findings: [
                  {
                    eventId: 'trace-step-1',
                    wrongContentQuote: 'skip tests',
                    referenceEventId: 'trace-step-0',
                    referenceQuote: 'must test',
                    conflictWith: 'task',
                    module: 'verify',
                    failureMode: 'test-omission',
                  },
                ],
              }
            : {
                states: [
                  {
                    instanceId: (request.payload.instances as { instanceId: string }[])[0]!
                      .instanceId,
                    resolution: 'active',
                    terminalConnection: 'semantic',
                    terminalEvidence: { source: 'events', index: 2, quote: 'failed' },
                    explanation: 'Unresolved test omission caused failure.',
                  },
                ],
              },
        )
      },
    }
    try {
      const first = await runOfflineEvaluation({ root, profile: selected, items: [item], execute })
      expect(stages).toEqual(['detect', 'state'])
      expect(first.predictions).toHaveLength(1)
      expect(first.summary.complete).toBe(true)
      expect(first.summary.selectedMethods).toEqual(['v4'])
      expect(first.summary.methods.v4.correct).toBe(1)
      expect(first.summary.methods.v4.calls).toBe(2)
      expect(first.summary.comparison).toBeNull()
      const replay = await runOfflineEvaluation({ root, profile: selected, items: [item], execute })
      expect(replay.metricsRef).toEqual(first.metricsRef)
      expect(stages).toEqual(['detect', 'state'])
      await expect(
        runOfflineEvaluation({
          root,
          profile: {
            ...selected,
            plan: { ...selected.plan, maxOutputTokens: 32768 },
          },
          items: [item],
          execute,
        }),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('runs only the frozen baseline method and completes without a comparison', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-baseline-'))
    let baselineCalls = 0
    try {
      const selected = { ...profile, methods: ['single-pass'] as const }
      const execute = {
        stage: async () => {
          throw Error('v4 must not run')
        },
        baseline: async () => {
          baselineCalls++
          return attempt({ finding: null })
        },
      }
      const first = await runOfflineEvaluation({ root, profile: selected, items: [item], execute })
      expect(first.summary.complete).toBe(true)
      expect(first.summary.comparison).toBeNull()
      expect(first.predictions).toHaveLength(1)
      const second = await runOfflineEvaluation({ root, profile: selected, items: [item], execute })
      expect(baselineCalls).toBe(1)
      expect(second.metricsRef).toEqual(first.metricsRef)
      await expect(
        runOfflineEvaluation({ root, profile, items: [item], execute }),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('prepares without network, resumes stages and rejects changed manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-eval-'))
    let requests = 0
    const execute = {
      stage: async () => {
        requests++
        return attempt({ findings: [] })
      },
      baseline: async () => {
        requests++
        return attempt({ finding: null })
      },
    }
    try {
      expect((await runOfflineEvaluation({ root, profile, items: [item] })).summary.complete).toBe(
        false,
      )
      const first = await runOfflineEvaluation({ root, profile, items: [item], execute })
      expect(requests).toBe(2)
      expect(first.summary.complete).toBe(true)
      const second = await runOfflineEvaluation({ root, profile, items: [item], execute })
      expect(requests).toBe(2)
      expect(second.metricsRef).toEqual(first.metricsRef)
      expect(second.summary.methods.v4.total).toBe(1)
      await expect(
        runOfflineEvaluation({
          root,
          profile: { ...profile, sourceIdentity: { source: 'changed' } },
          items: [item],
          execute,
        }),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('records budget skips without invoking the model or shrinking the denominator', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-budget-'))
    let requests = 0
    try {
      const result = await runOfflineEvaluation({
        root,
        profile: { ...profile, totalUsdMicros: 1 },
        items: [item],
        execute: {
          stage: async () => {
            requests++
            return attempt({ findings: [] })
          },
          baseline: async () => {
            requests++
            return attempt({ finding: null })
          },
        },
      })
      expect(requests).toBe(0)
      expect(result.summary.complete).toBe(true)
      expect(result.summary.methods.v4.accuracy).toBe(0)
      expect(result.summary.methods.v4.statuses['budget-skipped']).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('replays committed stages before an interrupted report publication without repaying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-stage-'))
    let requests = 0
    const execute = {
      stage: async () => {
        requests++
        return attempt({ findings: [] })
      },
      baseline: async () => {
        requests++
        return attempt({ finding: null })
      },
    }
    try {
      await expect(
        runOfflineEvaluation({
          root,
          profile,
          items: [item],
          execute,
          faultHook: async (point, id) => {
            if (point === 'action-committed' && id === 'offline-v4-case-001-detect-0')
              throw Error('injected crash')
          },
        }),
      ).rejects.toThrow('injected')
      expect(requests).toBe(2)
      const recovered = await runOfflineEvaluation({ root, profile, items: [item], execute })
      expect(requests).toBe(2)
      expect(recovered.summary.complete).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
