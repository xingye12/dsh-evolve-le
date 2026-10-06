/** Prepare/run/resume the preregistered 86-task localization evaluation. */
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import {
  adaptTrajectory,
  BASELINE_PROMPT,
} from '../packages/dsh-evolve-le/src/attribution/offline-evaluation.js'
import {
  runOfflineEvaluation,
  type EvaluationProfile,
} from '../packages/dsh-evolve-le/src/attribution/offline-runner.js'
import {
  remoteAgentDebugger,
  type AttributionAttempt,
} from '../packages/dsh-evolve-le/src/attribution/agent-debugger.js'
import { upstreamChatCompletion } from '../packages/dsh-evolve-le/src/proposer/upstream.js'
import { remoteRoutePlanHash } from '../packages/dsh-evolve-le/src/proposer/remote-gateway.js'
import { sha256Hex } from '../packages/dsh-evolve-le/src/state/canonical.js'
import { openObjectStore } from '../packages/dsh-evolve-le/src/state/object-store.js'

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    out: { type: 'string' },
    mode: { type: 'string', default: 'prepare' },
    'credential-file': { type: 'string' },
  },
})
if (!values.config || !values.out || !['prepare', 'live', 'score'].includes(values.mode!))
  throw Error('Usage: --config PATH --out ROOT --mode prepare|live|score [--credential-file PATH]')
const config = JSON.parse(await readFile(resolve(values.config), 'utf8')) as {
  datasetRoot: string
  profile: EvaluationProfile
}
const datasetRoot = resolve(config.datasetRoot),
  root = resolve(values.out),
  repository = resolve(import.meta.dirname, '..')
const sourceIdentity: Record<string, string> = { ...config.profile.sourceIdentity }
async function sourceFiles(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await sourceFiles(path)
    else if (entry.name.endsWith('.ts'))
      sourceIdentity[relative(repository, path)] = sha256Hex(await readFile(path))
  }
}
await sourceFiles(join(repository, 'packages/dsh-evolve-le/src'))
for (const path of [
  'scripts/evaluate-swepro-attribution.ts',
  'pnpm-lock.yaml',
  'provenance.lock.json',
])
  sourceIdentity[path] = sha256Hex(await readFile(join(repository, path)))
const profile = { ...config.profile, sourceIdentity }
const files = (await readdir(datasetRoot)).filter((f) => f.endsWith('.json')).sort()
if (files.length !== 86)
  throw Error(`Formal population must contain exactly 86 JSON trajectories, got ${files.length}`)
await mkdir(root, { recursive: true })
const store = await openObjectStore(join(root, 'objects'))
const sourceRefs = []
const items = []
for (const filename of files) {
  const bytes = await readFile(join(datasetRoot, filename))
  const raw = JSON.parse(bytes.toString())
  const metadata = raw.metadata as Record<string, unknown>
  const extra = metadata.extra as Record<string, unknown> | undefined
  if (extra?.language !== 'en' || extra.source_benchmark !== 'swebenchpro')
    throw Error('Formal profile requires English SWE-Bench Pro release metadata')
  items.push(adaptTrajectory(raw, 'case-' + String(items.length + 1).padStart(3, '0'), bytes))
  sourceRefs.push(
    await store.put(bytes, {
      mediaType: 'application/vnd.trajdebug.unified-trajectory+json',
      label: 'CONTROLLER_INTERNAL',
    }),
  )
}
let execute: Parameters<typeof runOfflineEvaluation>[0]['execute']
if (values.mode === 'live') {
  if (!values['credential-file']) throw Error('Live mode requires an external credential file')
  const credentialPath = resolve(values['credential-file'])
  const info = await stat(credentialPath)
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw Error('Credential must be an owner-only regular file')
  const credential = (await readFile(credentialPath, 'utf8')).trim()
  if (!credential) throw Error('Empty credential')
  const debuggerClient = remoteAgentDebugger({
    plan: profile.plan,
    credential,
    requestTimeoutMs: profile.requestTimeoutMs,
  })
  execute = {
    stage: (request) => debuggerClient.stageWithReceipt!(request),
    async baseline(payload): Promise<AttributionAttempt> {
      const userText = JSON.stringify(payload)
      const response = await upstreamChatCompletion({
        plan: profile.plan,
        credential,
        sections: [{ name: 'single-pass-contract', order: 0, text: BASELINE_PROMPT }],
        userText,
        requestTimeoutMs: profile.requestTimeoutMs,
        retryTotalBudgetMs: profile.requestTimeoutMs,
      })
      const receipt = {
        routeId: profile.plan.routeId,
        routeHash: 'sha256:' + remoteRoutePlanHash(profile.plan),
        inputSha256: 'sha256:' + sha256Hex(userText),
        status: response.ok ? ('ok' as const) : ('error' as const),
        responseSha256: response.ok
          ? 'sha256:' + sha256Hex(response.content)
          : (response.responseSha256 ?? null),
        promptTokens: response.promptTokens ?? null,
        completionTokens: response.completionTokens ?? null,
        costUsdMicros: response.costUsdMicros ?? null,
        modelReportedUsage: response.modelReportedUsage ?? null,
        attempts: response.attempts,
      }
      if (!response.ok) return { outcome: 'error', receipt: { ...receipt, error: response.error } }
      try {
        return {
          outcome: 'ok',
          artifact: Buffer.from(JSON.stringify({ output: JSON.parse(response.content) }) + '\n'),
          receipt,
        }
      } catch {
        return {
          outcome: 'error',
          receipt: { ...receipt, status: 'error', error: 'invalid JSON response' },
        }
      }
    },
  }
}
const result = await runOfflineEvaluation({
  root,
  profile,
  items,
  sourceRefs,
  ...(execute ? { execute } : {}),
  onProgress: (summary) => console.log(JSON.stringify(summary)),
})
// Convenience files are rebuildable views; authoritative refs are journaled and content-addressed.
await writeFile(join(root, 'metrics.json'), JSON.stringify(result.summary, null, 2) + '\n')
await writeFile(
  join(root, 'predictions.jsonl'),
  result.predictions.map((p) => JSON.stringify(p)).join('\n') +
    (result.predictions.length ? '\n' : ''),
)
await writeFile(join(root, 'manifest-ref.json'), JSON.stringify(result.manifestRef, null, 2) + '\n')
const percent = (value: number | null) => (value === null ? 'N/A' : `${(value * 100).toFixed(2)}%`)
const rows = result.summary.selectedMethods.map((method) => {
  const m = result.summary.methods[method as 'single-pass' | 'v4']
  return `| ${method} | ${m.correct}/${m.total} | ${percent(m.accuracy)} | ${percent(m.answerAccuracy)} | ${percent(m.coverage)} | $${(m.costUsdMicros / 1000000).toFixed(4)} |`
})
await writeFile(
  join(root, 'summary.md'),
  [
    '# SWE-Bench Pro attribution evaluation',
    '',
    `Run: ${profile.runId}. Status: ${result.summary.complete ? 'all cases recorded; inspect call statuses' : 'incomplete; no final model accuracy claim'}.`,
    '',
    '| Method | Exact matches | Exact accuracy | Answered accuracy | Coverage | Accounted cost |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    result.summary.comparison
      ? `Paired difference (v4 − single-pass): ${percent(result.summary.comparison.delta)}. 95% bootstrap interval: ${result.summary.comparison.pairedBootstrap95.map((x) => percent(x)).join(' to ')}.`
      : 'Single-method run; no v4 comparison was performed.',
    '',
    'See metrics.json for length strata, intervals and failure/skip counts. An incomplete preparation view contains missing predictions; its zeros are not measured model performance.',
    '',
    'This measures public critical-step annotation agreement. Causal explanation review, repair efficacy and Terminal-Bench success remain unmeasured.',
    '',
  ].join('\n'),
)
console.log(
  JSON.stringify({
    mode: values.mode,
    complete: result.summary.complete,
    metricsRef: result.metricsRef,
    methods: result.summary.methods,
    comparison: result.summary.comparison,
  }),
)
