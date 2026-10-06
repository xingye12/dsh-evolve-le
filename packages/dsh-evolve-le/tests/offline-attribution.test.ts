import { describe, expect, it } from 'vitest'
import {
  adaptTrajectory,
  scoreEvaluation,
  baselineInput,
  validateBaseline,
} from '../src/attribution/offline-evaluation.js'

const sample = {
  messages: [
    { step: 0, role: 'user', name: 'human', content: 'You must run tests' },
    { step: 1, role: 'assistant', name: 'agent', content: 'I will skip tests' },
    { step: 2, role: 'assistant', name: 'agent', content: 'Tests failed' },
  ],
  metadata: {
    reward: 0,
    task_id: 't',
    annotation: {
      critical_error_step: 1,
      critical_error_type: 'verify.Omission',
      secret: 'GOLD_SENTINEL',
    },
    extra: { solution: 'GOLD_SENTINEL' },
  },
}
describe('offline attribution evaluation contract', () => {
  it('isolates labels and preserves original message indices and identity', () => {
    const item = adaptTrajectory(sample, 'sample.json')
    expect(item.goldStep).toBe(1)
    expect(item.bundle.events.map((e) => e.sourceIndex)).toEqual([0, 1, 2])
    expect(item.bundle.events[0]?.kind).toBe('trajectory:user')
    expect(JSON.stringify(item.bundle)).not.toContain('GOLD_SENTINEL')
    expect(JSON.stringify(baselineInput(item.bundle, 10000))).not.toContain('critical_error_step')
  })
  it('rejects misaligned labels, duplicate indices, successes and unsupported roles', () => {
    expect(() => adaptTrajectory({ ...sample, messages: [sample.messages[1]] }, 'bad')).toThrow()
    expect(() =>
      adaptTrajectory({ ...sample, metadata: { ...sample.metadata, reward: 1 } }, 'bad'),
    ).toThrow()
    expect(() =>
      adaptTrajectory(
        { ...sample, metadata: { ...sample.metadata, annotation: { critical_error_step: 0 } } },
        'bad',
      ),
    ).toThrow()
  })
  it('validates baseline original quotations and terminal evidence', () => {
    const item = adaptTrajectory(sample, 'sample.json')
    const output = {
      finding: {
        eventId: 'trace-step-1',
        wrongContentQuote: 'skip tests',
        referenceEventId: 'trace-step-0',
        referenceQuote: 'must run tests',
        conflictWith: 'task',
        failureMode: 'test-omission',
        module: 'verify',
      },
      terminalEvidence: { source: 'events', index: 2, quote: 'Tests failed' },
      explanation: 'Omitting tests left the failure unresolved.',
    }
    expect(validateBaseline(output, item.bundle).step).toBe(1)
    expect(() =>
      validateBaseline(
        { ...output, terminalEvidence: { source: 'events', index: 2, quote: 'invented' } },
        item.bundle,
      ),
    ).toThrow()
    expect(validateBaseline({ finding: null }, item.bundle).step).toBeNull()
  })
  it('keeps missing, abstained and failed cases in the fixed denominator', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => ({
      ...adaptTrajectory(sample, id),
      id,
      taskId: id,
    }))
    const metrics = scoreEvaluation(
      items,
      [
        {
          id: 'a',
          method: 'v4',
          predictedStep: 1,
          module: 'verify',
          status: 'completed',
          detectedSteps: [1],
          costUsdMicros: 10,
          durationMs: 2,
          calls: 1,
        },
        {
          id: 'b',
          method: 'v4',
          predictedStep: 2,
          module: 'act',
          status: 'completed',
          detectedSteps: [1],
          costUsdMicros: 20,
          durationMs: 2,
          calls: 1,
        },
        {
          id: 'c',
          method: 'v4',
          predictedStep: null,
          module: null,
          status: 'call-failed',
          detectedSteps: [],
          costUsdMicros: 30,
          durationMs: 2,
          calls: 1,
        },
      ],
      1000,
    )
    expect(metrics.methods.v4.total).toBe(4)
    expect(metrics.methods.v4.correct).toBe(1)
    expect(metrics.methods.v4.answered).toBe(2)
    expect(metrics.methods.v4.missing).toBe(1)
    expect(metrics.methods.v4.accuracy).toBe(0.25)
    expect(metrics.methods.v4.answerAccuracy).toBe(0.5)
    expect(metrics.methods.v4.coverage).toBe(0.5)
    expect(metrics.complete).toBe(false)
    expect(scoreEvaluation(items, [], 1000)).toEqual(scoreEvaluation(items, [], 1000))
    expect(() =>
      scoreEvaluation(
        items,
        [
          {
            id: 'a',
            method: 'v4',
            predictedStep: 1,
            module: 'verify',
            status: 'completed',
            detectedSteps: [],
            costUsdMicros: 0,
            durationMs: 0,
            calls: 0,
          },
          {
            id: 'a',
            method: 'v4',
            predictedStep: 1,
            module: 'verify',
            status: 'completed',
            detectedSteps: [],
            costUsdMicros: 0,
            durationMs: 0,
            calls: 0,
          },
        ],
        1000,
      ),
    ).toThrow()
  })
  it('never silently drops long baseline input', () => {
    expect(() => baselineInput(adaptTrajectory(sample, 'a').bundle, 50)).toThrow('envelope')
  })
})
