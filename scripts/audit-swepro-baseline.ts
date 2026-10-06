/** Read-only scoring audit after a baseline-only run; never calls a model. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Controller } from '../packages/dsh-evolve-le/src/controller/controller.js'
import { FakeProvider } from '../packages/dsh-evolve-le/src/controller/provider.js'
import { openObjectStore } from '../packages/dsh-evolve-le/src/state/object-store.js'
import {
  sha256Hex,
  canonicalJson,
  canonicalHash,
} from '../packages/dsh-evolve-le/src/state/canonical.js'
import {
  validateBaseline,
  adaptTrajectory,
  type Prediction,
} from '../packages/dsh-evolve-le/src/attribution/offline-evaluation.js'
import type { EvaluationProfile } from '../packages/dsh-evolve-le/src/attribution/offline-runner.js'
import type { TraceBundle } from '../packages/dsh-evolve-le/src/attribution/trajdebug.js'

const root = resolve(process.argv[2]!)
const store = await openObjectStore(join(root, 'objects'))
const ref = JSON.parse(await readFile(join(root, 'manifest-ref.json'), 'utf8'))
const manifest = JSON.parse((await store.read(ref)).toString()) as {
  profile: EvaluationProfile
  methods: string[]
  population: { id: string; goldStep: number; inputDigest: string; sourceDigest: string }[]
}
if (
  manifest.methods.length !== 1 ||
  manifest.methods[0] !== 'single-pass' ||
  manifest.population.length !== 86
)
  throw Error('expected frozen 86-case baseline-only manifest')
const repository = resolve(import.meta.dirname, '..')
for (const [path, digest] of Object.entries(manifest.profile.sourceIdentity)) {
  if (
    !path.startsWith('packages/') &&
    !path.startsWith('scripts/') &&
    !['pnpm-lock.yaml', 'provenance.lock.json'].includes(path)
  )
    continue
  if (sha256Hex(await readFile(join(repository, path))) !== digest)
    throw Error('scoring source identity changed')
}
const { profile } = manifest
const controller = await Controller.open(
  join(root, 'controller'),
  join(root, 'objects'),
  {
    runId: profile.runId,
    budgetLimits: {
      usd: profile.totalUsdMicros,
      'attribution-calls': 86 * profile.perCaseCalls,
      'attribution-tokens': 86 * profile.perCaseTokens,
    },
  },
  new FakeProvider(),
)
try {
  const rows = []
  const rejectionReasons: Record<string, number> = {}
  const callFailureReasons: Record<string, number> = {}
  const statuses: Record<string, number> = {}
  let failedCallsAtOutputLimit = 0
  let correct = 0,
    answered = 0,
    cost = 0,
    rawCorrect = 0,
    rawAnswered = 0
  const predictions: Prediction[] = []
  for (const item of manifest.population) {
    const refs = controller.state.evidence!
    const predictionRef = refs[`offline/prediction/single-pass/${item.id}`]
    if (!predictionRef) throw Error('incomplete baseline population')
    const prediction = JSON.parse((await store.read(predictionRef)).toString()) as Prediction
    predictions.push(prediction)
    const inputRef = refs[`offline/input/${item.id}`]!
    const inputBytes = await store.read(inputRef)
    const bundle = JSON.parse(inputBytes.toString()) as TraceBundle
    await store.verify(refs[`offline/source/${item.id}`]!)
    if (refs[`offline/source/${item.id}`]!.digest !== item.sourceDigest)
      throw Error('source digest mismatch')
    const sourceBytes = await store.read(refs[`offline/source/${item.id}`]!)
    const adapted = adaptTrajectory(JSON.parse(sourceBytes.toString()), item.id, sourceBytes)
    if (
      adapted.inputDigest !== item.inputDigest ||
      adapted.goldStep !== item.goldStep ||
      canonicalJson(adapted.bundle) !== canonicalJson(bundle)
    )
      throw Error('input or gold digest mismatch')
    const stageRef = refs[`offline/stage/offline-single-pass-${item.id}-baseline-0`]
    let rejection: string | null = null,
      rawStep: number | null = null
    if (stageRef) {
      const stage = JSON.parse((await store.read(stageRef)).toString())
      if (stage.status === 'call-failed') {
        const reason = typeof stage.reason === 'string' ? stage.reason : 'unknown'
        callFailureReasons[reason] = (callFailureReasons[reason] ?? 0) + 1
        if (stage.usage?.completionTokens === profile.plan.maxOutputTokens)
          failedCallsAtOutputLimit++
      }
      if (stage.output !== null) {
        const output = typeof stage.output === 'string' ? JSON.parse(stage.output) : stage.output
        const candidate = bundle.events.find(
          (e) => e.eventId === output?.finding?.eventId && e.actor === 'agent',
        )
        rawStep = candidate?.sourceIndex ?? null
        try {
          const checked = validateBaseline(output, bundle)
          if (checked.step !== prediction.predictedStep)
            throw Error('prediction disagrees with frozen validator')
        } catch (error) {
          rejection = error instanceof Error ? error.message : String(error)
          if (prediction.status !== 'invalid-output') throw Error('unexpected validator failure')
        }
      }
    }
    if (rejection) rejectionReasons[rejection] = (rejectionReasons[rejection] ?? 0) + 1
    statuses[prediction.status] = (statuses[prediction.status] ?? 0) + 1
    if (prediction.predictedStep !== null) answered++
    if (prediction.predictedStep === item.goldStep) correct++
    if (rawStep !== null) rawAnswered++
    if (rawStep === item.goldStep) rawCorrect++
    cost += prediction.costUsdMicros
    rows.push({
      id: item.id,
      goldStep: item.goldStep,
      predictedStep: prediction.predictedStep,
      status: prediction.status,
      rejection,
      rawStep,
      predictionRef,
      inputRef,
      stageRef: stageRef ?? null,
    })
  }
  if (Object.keys(controller.state.actions).some((id) => !id.startsWith('offline-single-pass-')))
    throw Error('non-baseline model action detected')
  if (cost !== (controller.state.budget.usd?.spent ?? 0) || cost > profile.totalUsdMicros)
    throw Error('cost reconciliation failed')
  const metricsRef = controller.state.evidence![`offline/metrics/${canonicalHash(predictions)}`]
  if (!metricsRef) throw Error('missing authoritative final metrics')
  const metrics = JSON.parse((await store.read(metricsRef)).toString())
  if (
    metrics.methods['single-pass'].correct !== correct ||
    metrics.methods['single-pass'].answered !== answered ||
    !metrics.complete ||
    metrics.comparison !== null
  )
    throw Error('metrics do not reconcile')
  const audit = {
    protocol: 'dsh-evolve-le/swepro-baseline-audit/v1',
    runId: profile.runId,
    manifestRef: ref,
    metricsRef,
    scriptDigest: sha256Hex(await readFile(new URL(import.meta.url))),
    total: 86,
    correct,
    answered,
    statuses,
    rejectionReasons,
    callFailureReasons,
    failedCallsAtOutputLimit,
    costUsdMicros: cost,
    modelActions: Object.keys(controller.state.actions).length,
    exploratoryRawStepAgreement: {
      correct: rawCorrect,
      answered: rawAnswered,
      total: 86,
      note: 'Post-hoc diagnostic only; bypasses quotation validation and does not replace preregistered accuracy.',
    },
    rows,
  }
  const auditRef = await store.put(Buffer.from(JSON.stringify(audit) + '\n'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  await controller.publishEvidence('offline/baseline-audit/v1', auditRef)
  await writeFile(join(root, 'baseline-audit.json'), JSON.stringify(audit, null, 2) + '\n', {
    flag: 'wx',
  })
  await writeFile(join(root, 'baseline-audit-ref.json'), JSON.stringify(auditRef, null, 2) + '\n', {
    flag: 'wx',
  })
  console.log(
    JSON.stringify({
      total: 86,
      correct,
      answered,
      statuses,
      rejectionReasons,
      callFailureReasons,
      failedCallsAtOutputLimit,
      costUsdMicros: cost,
      modelActions: audit.modelActions,
      auditRef,
    }),
  )
} finally {
  await controller.close()
}
