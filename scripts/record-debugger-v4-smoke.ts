/** Project one retained real Harbor development trial; no paid diagnosis is launched. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { diagnosticTraceBundle } from '../benchmark-adapters/terminal-bench/src/diagnostic-bundle.js'
import type { RunArtifact } from '../benchmark-adapters/terminal-bench/src/normalize.js'
import { Controller } from '../packages/dsh-evolve-le/src/controller/controller.js'
import { FakeProvider } from '../packages/dsh-evolve-le/src/controller/provider.js'
import { openObjectStore } from '../packages/dsh-evolve-le/src/state/object-store.js'
import { defaultRunConfig } from '../packages/dsh-evolve-le/src/config/run-config.js'
import { canonicalJson } from '../packages/dsh-evolve-le/src/state/canonical.js'
import {
  synchronizeDiagnostics,
  hydrateBundle,
  reportKey,
} from '../packages/dsh-evolve-le/src/attribution/lifecycle.js'
const smoke = resolve(process.argv[2] ?? 'evidence/debugger-v4/harbor-smoke')
const output = resolve(process.argv[3] ?? 'evidence/debugger-v4/harbor-diagnostic-projection')
await mkdir(output, { recursive: true })
const normalized = JSON.parse(
  await readFile(join(smoke, 'normalized-main.json'), 'utf8'),
) as RunArtifact
const trial = normalized.trials[0]!
const diagnostic = await diagnosticTraceBundle({
  trial,
  trialDir: join(smoke, 'jobs', normalized.jobName, trial.trialName),
})
const config = defaultRunConfig({
  runId: 'debugger-v4-harbor-projection',
  tasksRoot: 'not-opened',
  baselineSourceDir: 'not-opened',
  agentDebuggerRoute: 'deepseek/zen-compatible',
  overrides: { attributionCalls: 1, attributionTokens: 1000000 },
})
const provider = new FakeProvider({
  outcome: 'failure',
  costUsdMicros: 0,
  durationMs: 0,
  trajectory: Buffer.from(JSON.stringify({ trial })),
  diagnosticBundle: diagnostic,
})
const controller = await Controller.open(
  join(output, 'controller'),
  join(output, 'objects'),
  {
    runId: config.runId,
    budgetLimits: {
      'task-trials': 1,
      usd: 500000000,
      'attribution-calls': 1,
      'attribution-tokens': 1000000,
      'wall-clock-seconds': 100000,
    },
  },
  provider,
)
const candidateId = 'c_' + normalized.identity.capsuleArchiveSha256.slice(0, 24)
try {
  if (controller.state.phase === 'DRAFT') {
    await controller.changePhase('PREFLIGHT', 'real Harbor projection smoke; no model')
    await controller.registerCandidate({
      candidateId,
      sourceHash: 'sha256:' + normalized.identity.capsuleArchiveSha256,
      parentCandidateId: null,
      proposalActionId: null,
    })
  }
  await controller.runEvaluation({
    actionId: 'eval-extract-elf',
    candidateId,
    opaqueTaskId: trial.identity.handle,
    attempt: 1,
    split: 'dev-observed',
    waveId: null,
    estimate: [{ dimension: 'task-trials', amount: 1 }],
  })
  const store = await openObjectStore(join(output, 'objects'))
  await synchronizeDiagnostics({ controller, store, config, wallAllowed: () => true })
  const artifacts = controller.state.actions['eval-extract-elf']!.artifacts
  const traceRef = artifacts.find(
    (r) => r.mediaType === 'application/vnd.dsh-evolve-le.diagnostic-trace-bundle+json',
  )!
  const bundle = await hydrateBundle(store, traceRef, artifacts)
  const ref = controller.state.evidence![reportKey('eval-extract-elf')]!
  const report = JSON.parse((await store.read(ref)).toString()) as {
    executionStatus: string
    stages: unknown[]
  }
  const receipt = {
    protocol: 'dsh-evolve-le/debugger-v4-smoke/v1',
    rawJob: normalized.jobName,
    normalizedArtifactDigest: 'sha256:' + normalized.artifactSha256,
    liveModelCalls: 0,
    diagnosisQualityClaim: false,
    reportRef: ref,
    evidence: controller.state.evidence,
    events: bundle.events.length,
    shards: artifacts.filter(
      (r) => r.mediaType === 'application/vnd.dsh-evolve-le.diagnostic-trace-shard+json',
    ).length,
    stages: report.stages.length,
    executionStatus: report.executionStatus,
    budget: controller.state.budget,
  }
  await writeFile(join(output, 'receipt.json'), canonicalJson(receipt) + '\n')
  console.log(
    JSON.stringify({
      events: receipt.events,
      shards: receipt.shards,
      stages: receipt.stages,
      executionStatus: receipt.executionStatus,
      liveModelCalls: 0,
    }),
  )
} finally {
  await controller.close()
}
