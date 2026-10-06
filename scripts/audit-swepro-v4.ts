/** Revalidate retained v4 stages locally; never execute a model request. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Controller } from '../packages/dsh-evolve-le/src/controller/controller.js'
import { FakeProvider } from '../packages/dsh-evolve-le/src/controller/provider.js'
import {
  openObjectStore,
  type ObjectRef,
} from '../packages/dsh-evolve-le/src/state/object-store.js'
import {
  canonicalHash,
  canonicalJson,
  sha256Hex,
} from '../packages/dsh-evolve-le/src/state/canonical.js'
import {
  adaptTrajectory,
  type Prediction,
} from '../packages/dsh-evolve-le/src/attribution/offline-evaluation.js'
import {
  diagnoseTrace,
  type FailureReport,
  type StageResult,
} from '../packages/dsh-evolve-le/src/attribution/trajdebug.js'
import type { EvaluationProfile } from '../packages/dsh-evolve-le/src/attribution/offline-runner.js'
import { remoteRoutePlanHash } from '../packages/dsh-evolve-le/src/proposer/remote-gateway.js'

const root = resolve(process.argv[2]!)
const store = await openObjectStore(join(root, 'objects'))
const manifestRef = JSON.parse(await readFile(join(root, 'manifest-ref.json'), 'utf8')) as ObjectRef
const manifest = JSON.parse((await store.read(manifestRef)).toString()) as {
  profile: EvaluationProfile
  debuggerProfile?: {
    citationPolicy?: 'strict' | 'advisory'
    statePolicy?: 'strict' | 'model-judgment'
    trajectoryPolicy?: 'windowed' | 'full-trajectory'
  }
  methods: string[]
  population: {
    id: string
    taskId: string
    goldStep: number
    inputDigest: string
    sourceDigest: string
  }[]
}
if (manifest.methods.length !== 1 || manifest.methods[0] !== 'v4')
  throw Error('expected v4-only manifest')
const total = manifest.population.length
if (total !== 86) {
  const predecessorRef = JSON.parse(
    await readFile(join(root, 'predecessor-manifest-ref.json'), 'utf8'),
  ) as ObjectRef
  const predecessor = JSON.parse((await store.read(predecessorRef)).toString()) as typeof manifest
  if (
    !total ||
    predecessorRef.digest !== manifest.profile.sourceIdentity.predecessorManifestDigest ||
    predecessor.methods.join() !== 'v4' ||
    predecessor.population.length !== 86 ||
    remoteRoutePlanHash(manifest.profile.plan) !== remoteRoutePlanHash(predecessor.profile.plan) ||
    canonicalHash(manifest.population.map((p) => p.id)) !==
      manifest.profile.sourceIdentity.completionPopulationDigest ||
    manifest.population.some(
      (p) =>
        canonicalJson(p) !== canonicalJson(predecessor.population.find((old) => old.id === p.id)),
    )
  )
    throw Error('supplement is not bound to the original frozen population and route')
}
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
      'attribution-calls': total * profile.perCaseCalls,
      'attribution-tokens': total * profile.perCaseTokens,
    },
  },
  new FakeProvider(),
)
try {
  const statuses: Record<string, number> = {}
  const stageStatuses: Record<string, number> = {}
  const rejectionReasons: Record<string, number> = {}
  const stateReasons: Record<string, number> = {}
  const lifecycle: Record<string, number> = {}
  const rawStateResolutions: Record<string, number> = {}
  const nonFinalTerminalTrials = new Set<string>()
  const forcedUnknownTrials = new Set<string>()
  let nonFinalTerminalEntries = 0,
    forcedUnknownInstances = 0
  const callFailureReasons: Record<string, number> = {}
  const predictions: Prediction[] = []
  const rows = []
  const increment = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1
  }
  let correct = 0,
    answered = 0,
    detected = 0,
    cost = 0,
    findings = 0,
    rejected = 0,
    contextIncomplete = 0,
    failedCallsAtOutputLimit = 0
  const refs = controller.state.evidence!
  for (const item of manifest.population) {
    const predictionRef = refs[`offline/prediction/v4/${item.id}`]
    const reportRef = refs[`offline/report/v4/${item.id}`]
    if (!predictionRef || !reportRef) throw Error('incomplete v4 population')
    const prediction = JSON.parse((await store.read(predictionRef)).toString()) as Prediction
    const report = JSON.parse((await store.read(reportRef)).toString()) as FailureReport
    const sourceRef = refs[`offline/source/${item.id}`]!
    const sourceBytes = await store.read(sourceRef)
    const adapted = adaptTrajectory(JSON.parse(sourceBytes.toString()), item.id, sourceBytes)
    const bundle = JSON.parse((await store.read(refs[`offline/input/${item.id}`]!)).toString())
    if (
      sourceRef.digest !== item.sourceDigest ||
      adapted.goldStep !== item.goldStep ||
      adapted.inputDigest !== item.inputDigest ||
      canonicalJson(bundle) !== canonicalJson(adapted.bundle)
    )
      throw Error('input or gold digest mismatch')
    const prefix = `offline-v4-${item.id}-`
    const replay = await diagnoseTrace(
      {
        runId: profile.runId,
        candidateId: 'offline-unmodified',
        actionId: prefix + 'trace',
        opaqueTaskId: item.taskId,
        attempt: 1,
        split: 'dev-observed',
        inputDigest: 'sha256:' + item.inputDigest,
        bundle,
        citationPolicy: manifest.debuggerProfile?.citationPolicy ?? 'strict',
        statePolicy: manifest.debuggerProfile?.statePolicy ?? 'strict',
        trajectoryPolicy: manifest.debuggerProfile?.trajectoryPolicy ?? 'windowed',
        maxInputBytes: profile.maxInputBytes,
      },
      async (request) => {
        if (request.stage === 'recover')
          return {
            status: 'completed',
            output: { suggestions: [] },
            reason: 'recover-excluded-from-localization',
          }
        const actionId = prefix + request.stage + '-' + request.window
        const requestRef = refs[`offline/request/${actionId}`]
        const stageRef = refs[`offline/stage/${actionId}`]
        if (!requestRef || !stageRef) throw Error('missing recorded stage')
        const captured = JSON.parse((await store.read(requestRef)).toString())
        if (canonicalHash(captured.payload) !== canonicalHash(request.payload))
          throw Error('stage request changed on replay')
        const result = JSON.parse((await store.read(stageRef)).toString()) as StageResult
        increment(stageStatuses, `${request.stage}/${result.status}`)
        if (result.status === 'call-failed') {
          increment(callFailureReasons, result.reason ?? 'unknown')
          if (result.usage?.completionTokens === profile.plan.maxOutputTokens)
            failedCallsAtOutputLimit++
        }
        if (typeof result.output === 'string') result.output = JSON.parse(result.output)
        if (request.stage === 'state') {
          const output = result.output as {
            states?: {
              resolution?: unknown
              terminalConnection?: unknown
              terminalEvidence?: { source?: unknown; index?: unknown } | null
            }[]
          } | null
          if (Array.isArray(output?.states))
            for (const state of output.states) {
              if (!state || typeof state !== 'object') continue
              increment(rawStateResolutions, String(state.resolution))
              if (
                ['semantic', 'irreversible', 'budget-debt'].includes(
                  String(state.terminalConnection),
                ) &&
                state.terminalEvidence?.source === 'events' &&
                Number.isSafeInteger(state.terminalEvidence.index) &&
                state.terminalEvidence.index !== bundle.events.length - 1
              ) {
                nonFinalTerminalEntries++
                nonFinalTerminalTrials.add(item.id)
              }
            }
        }
        return result
      },
    )
    if (canonicalJson(replay) !== canonicalJson(report)) throw Error('report replay differs')
    if (
      prediction.predictedStep !== (report.criticalFailure?.originStep ?? null) ||
      prediction.module !== (report.criticalFailure?.module ?? null) ||
      prediction.status !== report.executionStatus ||
      canonicalJson(prediction.detectedSteps) !==
        canonicalJson([...new Set(report.findings.map((f) => f.step))].sort((a, b) => a - b))
    )
      throw Error('prediction differs from validated report')
    predictions.push(prediction)
    increment(statuses, prediction.status)
    if (prediction.predictedStep !== null) answered++
    if (prediction.predictedStep === item.goldStep) correct++
    if (prediction.detectedSteps.includes(item.goldStep)) detected++
    findings += report.findings.length
    rejected += report.rejectedFindings.length
    if (report.coverage.contextIncomplete) contextIncomplete++
    for (const f of report.rejectedFindings) increment(rejectionReasons, f.reason)
    for (const i of report.instances) {
      increment(lifecycle, `${i.resolution}/${i.terminalConnection}`)
      if (i.resolution === 'unknown' && i.explanation.endsWith(' (Repair context incomplete.)')) {
        forcedUnknownInstances++
        forcedUnknownTrials.add(item.id)
      }
    }
    for (const stage of report.stages)
      if (stage.stage === 'state' && stage.reason) increment(stateReasons, stage.reason)
    cost += prediction.costUsdMicros
    rows.push({
      id: item.id,
      goldStep: item.goldStep,
      predictedStep: prediction.predictedStep,
      status: prediction.status,
      detectedGold: prediction.detectedSteps.includes(item.goldStep),
      findings: report.findings.length,
      rejectedFindings: report.rejectedFindings.length,
      instances: report.instances.length,
      contextIncomplete: report.coverage.contextIncomplete,
      predictionRef,
      reportRef,
    })
  }
  if (
    Object.keys(controller.state.actions).some(
      (id) => !/^offline-v4-case-\d{3}-(detect|state)-\d+$/.test(id),
    )
  )
    throw Error('unexpected paid action outside localization stages')
  if (cost !== controller.state.budget.usd?.spent || cost > profile.totalUsdMicros)
    throw Error('cost reconciliation failed')
  const metricsRef = refs[`offline/metrics/${canonicalHash(predictions)}`]
  if (!metricsRef) throw Error('missing authoritative final metrics')
  const metrics = JSON.parse((await store.read(metricsRef)).toString())
  if (
    !metrics.complete ||
    metrics.comparison !== null ||
    metrics.methods.v4.correct !== correct ||
    metrics.methods.v4.answered !== answered ||
    metrics.methods.v4.detected !== detected
  )
    throw Error('metrics do not reconcile')
  const audit = {
    protocol: 'dsh-evolve-le/swepro-v4-audit/v1',
    runId: profile.runId,
    manifestRef,
    metricsRef,
    scriptDigest: sha256Hex(await readFile(new URL(import.meta.url))),
    total,
    correct,
    answered,
    detected,
    statuses,
    stageStatuses,
    findings,
    rejected,
    rejectionReasons,
    stateReasons,
    lifecycle,
    rawStateResolutions,
    nonFinalTerminalEvidence: {
      entries: nonFinalTerminalEntries,
      trials: nonFinalTerminalTrials.size,
      note: 'Post-hoc audit of raw State causal connections anchored to a non-final event; not a localization metric.',
    },
    forcedUnknownDueCropping: {
      instances: forcedUnknownInstances,
      trials: forcedUnknownTrials.size,
    },
    contextIncomplete,
    callFailureReasons,
    failedCallsAtOutputLimit,
    costUsdMicros: cost,
    modelActions: Object.keys(controller.state.actions).length,
    paidRecoverCalls: 0,
    reportReplaySame: true,
    rows,
  }
  const auditRef = await store.put(Buffer.from(JSON.stringify(audit) + '\n'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  await controller.publishEvidence('offline/v4-audit/v1', auditRef)
  await writeFile(join(root, 'v4-audit.json'), JSON.stringify(audit, null, 2) + '\n', {
    flag: 'wx',
  })
  await writeFile(join(root, 'v4-audit-ref.json'), JSON.stringify(auditRef, null, 2) + '\n', {
    flag: 'wx',
  })
  console.log(JSON.stringify({ ...audit, rows: undefined, auditRef }))
} finally {
  await controller.close()
}
