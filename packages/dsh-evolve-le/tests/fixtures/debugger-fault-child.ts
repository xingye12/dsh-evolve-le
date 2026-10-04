import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Controller } from '../../src/controller/controller.js'
import { FakeProvider } from '../../src/controller/provider.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { defaultRunConfig } from '../../src/config/run-config.js'
import { synchronizeDiagnostics } from '../../src/attribution/lifecycle.js'
import type { DurableFailureAttributor } from '../../src/attribution/agent-debugger.js'
const [root, kill, callCap] = process.argv.slice(2)
if (!root) throw Error('root required')
await mkdir(root, { recursive: true })
const config = defaultRunConfig({
  runId: 'debugger-crash',
  tasksRoot: root,
  baselineSourceDir: root,
  agentDebuggerRoute: 'zen',
})
config.agentDebugger!.maxInputBytes = 16384
config.agentDebugger!.maxOutputTokens = 1024
config.agentDebugger!.requestTimeoutMs = 10000
config.budget.attributionCalls = Number(callCap ?? 100)
config.budget.attributionTokens = 1000000
config.modelRoutes.push({ ...config.modelRoutes[0]!, id: 'zen' })
const provider = new FakeProvider({
  outcome: 'failure',
  costUsdMicros: 0,
  durationMs: 0,
  diagnosticBundle: Buffer.from(
    JSON.stringify({
      protocol: 'dsh-evolve-le/diagnostic-trace-bundle/v3',
      terminal: { agentParticipation: 'ran' },
      events: [
        {
          index: 0,
          eventId: 'atif-0',
          source: 'atif',
          sourceIndex: 0,
          actor: 'agent',
          kind: 'trajectory:assistant',
          agentId: 'a',
          data: { content: 'unknown result' },
        },
      ],
      tests: [],
    }),
  ),
})
const controller = await Controller.open(
  join(root, 'controller'),
  join(root, 'objects'),
  {
    runId: config.runId,
    budgetLimits: {
      usd: 500000000,
      'task-trials': 10,
      'attribution-calls': 100,
      'attribution-tokens': 1000000,
      'wall-clock-seconds': 100000,
    },
    onBoundary: (point, id) => {
      if (
        kill === `${point}:${id}` ||
        (kill === `${point}:overview-parent` && id?.startsWith('debugger-v4/overview/parent/'))
      )
        process.kill(process.pid, 'SIGKILL')
    },
  },
  provider,
)
try {
  if (controller.state.phase === 'DRAFT') {
    await controller.changePhase('PREFLIGHT', 'fixture')
    await controller.registerCandidate({
      candidateId: 'parent',
      sourceHash: 'sha256:' + 'a'.repeat(64),
      parentCandidateId: null,
      proposalActionId: null,
    })
    await controller.registerCandidate({
      candidateId: 'sibling',
      sourceHash: 'sha256:' + 'b'.repeat(64),
      parentCandidateId: null,
      proposalActionId: null,
    })
    await controller.registerCandidate({
      candidateId: 'empty',
      sourceHash: 'sha256:' + 'c'.repeat(64),
      parentCandidateId: null,
      proposalActionId: null,
    })
  }
  for (const [actionId, candidateId] of [
    ['eval-1', 'parent'],
    ['eval-2', 'sibling'],
  ] as const) {
    if (!Object.values(controller.state.observations).some((o) => o.actionId === actionId)) {
      await controller.runEvaluation({
        actionId,
        candidateId,
        opaqueTaskId: 'task',
        attempt: 1,
        split: 'dev-observed',
        waveId: null,
        estimate: [{ dimension: 'task-trials', amount: 1 }],
      })
    }
  }
  const attributor: DurableFailureAttributor = {
    async attribute() {
      throw Error('legacy call forbidden')
    },
    async attributeWithReceipt() {
      throw Error('legacy call forbidden')
    },
    async stageWithReceipt(request) {
      await appendFile(join(root, 'calls.jsonl'), JSON.stringify(request) + '\n')
      return {
        outcome: 'ok',
        artifact: Buffer.from(
          JSON.stringify({
            protocol: 'dsh-evolve-le/agent-debugger/v4',
            stage: request.stage,
            output: { findings: [] },
          }),
        ),
        receipt: {
          routeId: 'fixture',
          routeHash: 'sha256:' + 'a'.repeat(64),
          inputSha256: 'sha256:' + 'b'.repeat(64),
          status: 'ok',
          responseSha256: 'sha256:' + 'c'.repeat(64),
          promptTokens: 10,
          completionTokens: 10,
          costUsdMicros: 1,
          modelReportedUsage: true,
          attempts: [],
        },
      }
    },
  }
  await synchronizeDiagnostics({
    controller,
    store: await openObjectStore(join(root, 'objects')),
    config,
    attributor,
    wallAllowed: () => true,
  })
  console.log(
    JSON.stringify({
      observations: Object.values(controller.state.observations),
      evidence: controller.state.evidence,
      budget: controller.state.budget,
    }),
  )
} finally {
  await controller.close()
}
