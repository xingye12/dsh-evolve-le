/** Complete wholly uncalled wall-clock skips under a new identity; never retry paid stages. */
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Controller } from '../packages/dsh-evolve-le/src/controller/controller.js'
import { FakeProvider } from '../packages/dsh-evolve-le/src/controller/provider.js'
import {
  openObjectStore,
  type ObjectRef,
} from '../packages/dsh-evolve-le/src/state/object-store.js'
import { canonicalHash, sha256Hex } from '../packages/dsh-evolve-le/src/state/canonical.js'
import {
  adaptTrajectory,
  scoreEvaluation,
  type Prediction,
} from '../packages/dsh-evolve-le/src/attribution/offline-evaluation.js'
import {
  runOfflineEvaluation,
  type EvaluationProfile,
} from '../packages/dsh-evolve-le/src/attribution/offline-runner.js'
import { remoteAgentDebugger } from '../packages/dsh-evolve-le/src/attribution/agent-debugger.js'

export function selectUncalledTail(original: readonly Prediction[], actions: readonly string[]) {
  const result: string[] = []
  for (const p of original) {
    if (p.method !== 'v4') throw Error('v4 only')
    if (p.status !== 'budget-skipped') continue
    if (
      p.calls ||
      p.costUsdMicros ||
      actions.some((id) => id.startsWith('offline-v4-' + p.id + '-'))
    )
      throw Error('partially paid budget skip; refusing repayment')
    result.push(p.id)
  }
  return result
}

export function mergeTail(
  original: readonly Prediction[],
  tail: readonly Prediction[],
): Prediction[] {
  const expected = original
    .filter((p) => p.status === 'budget-skipped')
    .map((p) => p.id)
    .sort()
  if (
    canonicalHash(tail.map((p) => p.id).sort()) !== canonicalHash(expected) ||
    tail.some((p) => p.method !== 'v4')
  )
    throw Error('supplement population mismatch')
  const byId = new Map(tail.map((p) => [p.id, p]))
  return original.map((p) => byId.get(p.id) ?? p)
}

async function main() {
  const { values } = parseArgs({
    options: {
      predecessor: { type: 'string' },
      out: { type: 'string' },
      mode: { type: 'string', default: 'prepare' },
      'credential-file': { type: 'string' },
    },
  })
  if (!values.predecessor || !values.out || !['prepare', 'live', 'score'].includes(values.mode!))
    throw Error('expected --predecessor ROOT --out ROOT --mode prepare|live|score')
  const predecessorRoot = resolve(values.predecessor),
    root = resolve(values.out)
  if (predecessorRoot === root) throw Error('successor requires a fresh root')
  const oldStore = await openObjectStore(join(predecessorRoot, 'objects'))
  const manifestRef = JSON.parse(
    await readFile(join(predecessorRoot, 'manifest-ref.json'), 'utf8'),
  ) as ObjectRef
  const manifest = JSON.parse((await oldStore.read(manifestRef)).toString()) as {
    profile: EvaluationProfile
    methods: string[]
    population: { id: string; inputDigest: string; goldStep: number; sourceDigest: string }[]
  }
  if (manifest.methods.join() !== 'v4' || manifest.population.length !== 86)
    throw Error('expected original 86-case v4 manifest')
  const repository = resolve(import.meta.dirname, '..')
  for (const [path, digest] of Object.entries(manifest.profile.sourceIdentity)) {
    if (
      !path.startsWith('packages/') &&
      !path.startsWith('scripts/') &&
      !['pnpm-lock.yaml', 'provenance.lock.json'].includes(path)
    )
      continue
    if (sha256Hex(await readFile(join(repository, path))) !== digest)
      throw Error('frozen scoring source changed')
  }
  const old = await Controller.open(
    join(predecessorRoot, 'controller'),
    join(predecessorRoot, 'objects'),
    {
      runId: manifest.profile.runId,
      budgetLimits: {
        usd: manifest.profile.totalUsdMicros,
        'attribution-calls': 86 * manifest.profile.perCaseCalls,
        'attribution-tokens': 86 * manifest.profile.perCaseTokens,
      },
    },
    new FakeProvider(),
  )
  const state = old.state
  await old.close()
  const refs = state.evidence!
  const original: Prediction[] = []
  const items = []
  for (const entry of manifest.population) {
    const sourceRef = refs['offline/source/' + entry.id]!
    const sourceBytes = await oldStore.read(sourceRef)
    const item = adaptTrajectory(JSON.parse(sourceBytes.toString()), entry.id, sourceBytes)
    if (
      item.inputDigest !== entry.inputDigest ||
      item.goldStep !== entry.goldStep ||
      sourceRef.digest !== entry.sourceDigest
    )
      throw Error('original input/gold identity changed')
    items.push(item)
    original.push(
      JSON.parse((await oldStore.read(refs['offline/prediction/v4/' + entry.id]!)).toString()),
    )
  }
  const selectedIds = selectUncalledTail(original, Object.keys(state.actions))
  if (!selectedIds.length) throw Error('no wholly uncalled population to complete')
  for (const id of selectedIds) {
    const report = JSON.parse((await oldStore.read(refs['offline/report/v4/' + id]!)).toString())
    if (
      !report.stages.length ||
      report.stages.some((s: { reason?: string }) => s.reason !== 'run-wall-clock')
    )
      throw Error('only uncalled wall-clock skips may be supplemented')
  }
  const oldCost = state.budget.usd?.spent ?? 0
  const metricsRef = refs['offline/metrics/' + canonicalHash(original)]!
  if (!metricsRef || oldCost >= manifest.profile.totalUsdMicros)
    throw Error('no remaining shared budget')
  const profile: EvaluationProfile = {
    ...manifest.profile,
    runId: manifest.profile.runId + '-tail-v1',
    totalUsdMicros: manifest.profile.totalUsdMicros - oldCost,
    sourceIdentity: {
      ...manifest.profile.sourceIdentity,
      'scripts/complete-swepro-v4.ts': sha256Hex(await readFile(fileURLToPath(import.meta.url))),
      predecessorManifestDigest: manifestRef.digest,
      predecessorMetricsDigest: metricsRef.digest,
      completionPopulationDigest: canonicalHash(selectedIds),
    },
  }
  const store = await openObjectStore(join(root, 'objects'))
  const importRef = async (ref: ObjectRef) =>
    store.put(await oldStore.read(ref), { mediaType: ref.mediaType, label: ref.label })
  await importRef(manifestRef)
  await importRef(metricsRef)
  await writeFile(
    join(root, 'predecessor-manifest-ref.json'),
    JSON.stringify(manifestRef, null, 2) + '\n',
  )
  const selected = items.filter((i) => selectedIds.includes(i.id))
  const sourceRefs = []
  for (const item of selected) sourceRefs.push(await importRef(refs['offline/source/' + item.id]!))
  let execute: Parameters<typeof runOfflineEvaluation>[0]['execute']
  if (values.mode === 'live') {
    if (!values['credential-file']) throw Error('external credential required')
    const info = await stat(values['credential-file'])
    if (!info.isFile() || info.mode & 0o077) throw Error('owner-only credential required')
    const credential = (await readFile(values['credential-file'], 'utf8')).trim()
    if (!credential) throw Error('empty credential')
    const client = remoteAgentDebugger({
      plan: profile.plan,
      credential,
      requestTimeoutMs: profile.requestTimeoutMs,
    })
    execute = {
      stage: (r) => client.stageWithReceipt!(r),
      baseline: async () => {
        throw Error('baseline excluded')
      },
    }
  }
  const result = await runOfflineEvaluation({
    root,
    profile,
    items: selected,
    sourceRefs,
    ...(execute ? { execute } : {}),
    onProgress: (s) => console.log(JSON.stringify(s)),
  })
  await writeFile(
    join(root, 'manifest-ref.json'),
    JSON.stringify(result.manifestRef, null, 2) + '\n',
  )
  await writeFile(join(root, 'metrics.json'), JSON.stringify(result.summary, null, 2) + '\n')
  await writeFile(
    join(root, 'predictions.jsonl'),
    result.predictions.map((p) => JSON.stringify(p)).join('\n') + '\n',
  )
  if (!result.summary.complete) {
    console.log(
      JSON.stringify({
        mode: values.mode,
        supplementaryCases: selected.length,
        complete: false,
        metricsRef: result.metricsRef,
      }),
    )
    return
  }
  const merged = mergeTail(original, result.predictions)
  const combined = {
    ...scoreEvaluation(items, merged, profile.bootstrapSamples, ['v4']),
    runType: 'offline-localization-wall-clock-completion',
    lineage: {
      predecessorRunId: manifest.profile.runId,
      predecessorRoot,
      predecessorManifestRef: manifestRef,
      predecessorMetricsRef: metricsRef,
      supplementRunId: profile.runId,
      supplementManifestRef: result.manifestRef,
      supplementMetricsRef: result.metricsRef,
      supplementaryIds: selectedIds,
      budgetUsdMicros: manifest.profile.totalUsdMicros,
      predecessorCostUsdMicros: oldCost,
      supplementCostUsdMicros: result.summary.methods.v4.costUsdMicros,
      note: 'Original six-hour batch retained; wholly uncalled cases completed in a fresh six-hour successor. No paid case or stage rerun.',
    },
  }
  if (
    combined.methods.v4.costUsdMicros > manifest.profile.totalUsdMicros ||
    combined.methods.v4.costUsdMicros !== oldCost + result.summary.methods.v4.costUsdMicros
  )
    throw Error('shared budget reconciliation failed')
  const combinedRef = await store.put(Buffer.from(JSON.stringify(combined) + '\n'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  const controller = await Controller.open(
    join(root, 'controller'),
    join(root, 'objects'),
    {
      runId: profile.runId,
      budgetLimits: {
        usd: profile.totalUsdMicros,
        'attribution-calls': selected.length * profile.perCaseCalls,
        'attribution-tokens': selected.length * profile.perCaseTokens,
      },
    },
    new FakeProvider(),
  )
  try {
    await controller.publishEvidence(
      'offline/combined-metrics/' + canonicalHash(merged),
      combinedRef,
    )
  } finally {
    await controller.close()
  }
  await writeFile(join(root, 'combined-metrics.json'), JSON.stringify(combined, null, 2) + '\n')
  await writeFile(
    join(root, 'combined-metrics-ref.json'),
    JSON.stringify(combinedRef, null, 2) + '\n',
  )
  await writeFile(
    join(root, 'combined-predictions.jsonl'),
    merged.map((p) => JSON.stringify(p)).join('\n') + '\n',
  )
  console.log(
    JSON.stringify({
      mode: values.mode,
      complete: true,
      supplementaryCases: selected.length,
      metricsRef: result.metricsRef,
      combinedRef,
      v4: combined.methods.v4,
    }),
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
