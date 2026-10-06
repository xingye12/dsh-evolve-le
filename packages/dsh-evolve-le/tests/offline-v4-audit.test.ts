import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from '../src/schema.js'
import { openObjectStore } from '../src/state/object-store.js'
import { adaptTrajectory } from '../src/attribution/offline-evaluation.js'
import { runOfflineEvaluation, type EvaluationProfile } from '../src/attribution/offline-runner.js'
import type { AttributionAttempt } from '../src/attribution/agent-debugger.js'

it('audits full retained v4 population including rejected evidence and incomplete-context abstention without a model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-v4-audit-'))
  let requests = 0
  try {
    const store = await openObjectStore(join(root, 'objects'))
    const items = [],
      sourceRefs = []
    for (let index = 1; index <= 86; index++) {
      const bytes = Buffer.from(
        JSON.stringify({
          messages: [
            {
              step: 0,
              role: 'user',
              content: 'must test' + (index === 2 ? ' x'.repeat(3000) : ''),
            },
            { step: 1, role: 'assistant', content: 'skip tests' },
            { step: 2, role: 'assistant', content: 'failed' },
          ],
          metadata: { task_id: `task-${index}`, reward: 0, annotation: { critical_error_step: 1 } },
        }),
      )
      items.push(
        adaptTrajectory(
          JSON.parse(bytes.toString()),
          `case-${String(index).padStart(3, '0')}`,
          bytes,
        ),
      )
      sourceRefs.push(
        await store.put(bytes, { label: 'CONTROLLER_INTERNAL', mediaType: 'application/json' }),
      )
    }
    const profile: EvaluationProfile = {
      runId: 'offline-v4-audit-fixture',
      methods: ['v4'],
      totalUsdMicros: 20000000,
      totalWallSeconds: 3600,
      maxInputBytes: 524288,
      requestTimeoutMs: 1000,
      perCaseCalls: 16,
      perCaseTokens: 2000000,
      perCaseUsdMicros: 1000000,
      bootstrapSamples: 100,
      sourceIdentity: { fixture: 'no-network' },
      plan: {
        routeId: 'fixture',
        model: 'fixture',
        baseUrl: 'http://localhost',
        temperature: 0,
        maxOutputTokens: 65536,
        inputUsdPerMTok: 0.3,
        outputUsdPerMTok: 1.2,
        retry: { maxAttempts: 1, backoffMs: [] },
      },
    }
    const result = await runOfflineEvaluation({
      root,
      profile,
      items,
      sourceRefs,
      execute: {
        baseline: async () => {
          throw Error('no baseline')
        },
        stage: async (request): Promise<AttributionAttempt> => {
          const events = (request.payload.events ?? []) as { data: { content: string } }[]
          const long = events.some((e) => e.data.content.includes('<omitted>'))
          // Distinct task IDs are private; fixture controls cases by sequential Detect requests.
          const count = requests++
          const output =
            request.stage === 'detect'
              ? {
                  findings:
                    count <= 5
                      ? [
                          {
                            eventId: 'trace-step-1',
                            wrongContentQuote: 'skip tests',
                            referenceEventId: count === 4 ? 'trace-step-2' : 'trace-step-0',
                            referenceQuote: 'must test',
                            conflictWith: 'task',
                            module: 'verify',
                            failureMode: 'test-omission',
                          },
                        ]
                      : [],
                }
              : {
                  states: [
                    {
                      instanceId: (request.payload.instances as { instanceId: string }[])[0]!
                        .instanceId,
                      resolution: 'active',
                      terminalConnection: 'semantic',
                      terminalEvidence:
                        count === 6
                          ? { source: 'events', index: 1, quote: 'skip tests' }
                          : { source: 'events', index: 2, quote: 'failed' },
                      explanation: 'Failure remained after test omission.',
                    },
                  ],
                }
          if (count === 2) {
            expect(long).toBe(false)
            expect(events[0]!.data.content.length).toBeGreaterThan(3000)
          }
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
        },
      },
    })
    await writeFile(join(root, 'manifest-ref.json'), JSON.stringify(result.manifestRef))
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx/esm', join(repoRoot, 'scripts/audit-swepro-v4.ts'), root],
      { cwd: repoRoot },
    )
    const audit = JSON.parse(await readFile(join(root, 'v4-audit.json'), 'utf8'))
    expect(audit).toMatchObject({
      total: 86,
      correct: 3,
      answered: 3,
      detected: 3,
      findings: 3,
      rejected: 1,
      contextIncomplete: 0,
      paidRecoverCalls: 0,
      reportReplaySame: true,
      modelActions: 89,
      costUsdMicros: 445,
      nonFinalTerminalEvidence: { entries: 1, trials: 1 },
      forcedUnknownDueCropping: { instances: 0, trials: 0 },
    })
    expect(audit.stageStatuses).toEqual({ 'detect/completed': 86, 'state/completed': 3 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 180000)
