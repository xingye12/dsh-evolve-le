import { expect, it } from 'vitest'
import { selectUncalledTail, mergeTail } from '../../../scripts/complete-swepro-v4.js'
import type { Prediction } from '../src/attribution/offline-evaluation.js'

const prediction = (id: string, status: string, calls = 0): Prediction => ({
  id,
  method: 'v4',
  predictedStep: null,
  module: null,
  status,
  detectedSteps: [],
  costUsdMicros: calls * 10,
  durationMs: 0,
  calls,
})

it('supplements only wholly uncalled budget skips, retaining paid failures', () => {
  const original = [prediction('case-001', 'partial', 2), prediction('case-002', 'budget-skipped')]
  expect(selectUncalledTail(original, ['offline-v4-case-001-detect-0'])).toEqual(['case-002'])
  const merged = mergeTail(original, [prediction('case-002', 'call-failed', 1)])
  expect(merged).toEqual([original[0], prediction('case-002', 'call-failed', 1)])
  expect(merged.reduce((sum, p) => sum + p.costUsdMicros, 0)).toBe(30)
})

it('refuses to repay a partially paid budget skip', () => {
  expect(() =>
    selectUncalledTail(
      [prediction('case-001', 'budget-skipped', 1)],
      ['offline-v4-case-001-detect-0'],
    ),
  ).toThrow('partially paid')
})

it('rejects missing, duplicate or unrelated supplement predictions', () => {
  const original = [prediction('case-001', 'partial', 2), prediction('case-002', 'budget-skipped')]
  expect(() => mergeTail(original, [])).toThrow()
  expect(() => mergeTail(original, [prediction('case-001', 'completed')])).toThrow()
  expect(() =>
    mergeTail(original, [prediction('case-002', 'completed'), prediction('case-002', 'completed')]),
  ).toThrow()
})
