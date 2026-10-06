import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { adaptTrajectory } from '../../src/attribution/offline-evaluation.js'
import {
  runOfflineEvaluation,
  type EvaluationProfile,
} from '../../src/attribution/offline-runner.js'
import type { AttributionAttempt } from '../../src/attribution/agent-debugger.js'
const root = process.argv[2]!,
  kill = process.argv[3]
const item = adaptTrajectory(
  {
    messages: [
      { step: 0, role: 'user', content: 'You must test' },
      { step: 1, role: 'assistant', content: 'skip tests' },
      { step: 2, role: 'assistant', content: 'failed' },
    ],
    metadata: { task_id: 'task', reward: 0, annotation: { critical_error_step: 1 } },
  },
  'case-001',
)
const profile: EvaluationProfile = {
  runId: 'offline-fault',
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
async function attempt(name: string, output: unknown): Promise<AttributionAttempt> {
  await appendFile(join(root, 'fixture-calls.jsonl'), JSON.stringify({ name }) + '\n')
  return {
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
  }
}
const result = await runOfflineEvaluation({
  root,
  profile,
  items: [item],
  execute: {
    baseline: () => attempt('baseline', { finding: null }),
    stage: (request) =>
      attempt(
        request.stage,
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
                  explanation: 'Test omission left failure.',
                },
              ],
            },
      ),
  },
  faultHook: async (point, id) => {
    if (`${point}:${id}` === kill) process.kill(process.pid, 'SIGKILL')
  },
})
await writeFile(join(root, 'fixture-result.json'), JSON.stringify(result) + '\n')
