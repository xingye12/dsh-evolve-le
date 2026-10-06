/** Offline benchmark effects use the existing trusted attribution saga and object store. */
import { Controller } from '../controller/controller.js'
import { FakeProvider } from '../controller/provider.js'
import { openObjectStore, type ObjectRef } from '../state/object-store.js'
import { canonicalHash } from '../state/canonical.js'
import { diagnoseTrace, PROFILE, type StageRequest, type StageResult } from './trajdebug.js'
import type { AttributionAttempt, AttributionUsageReceipt } from './agent-debugger.js'
import type { RemoteRoutePlan } from '../proposer/remote-gateway.js'
import { remoteRoutePlanHash } from '../proposer/remote-gateway.js'
import {
  METHODS,
  baselineInput,
  validateBaseline,
  scoreEvaluation,
  EVALUATION_PROTOCOL,
  type EvaluationItem,
  type EvaluationMethod,
  type Prediction,
} from './offline-evaluation.js'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { repoRoot } from '../schema.js'

const validateProfile = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(
    readFileSync(join(repoRoot, 'schemas/offline-evaluation-profile.schema.json'), 'utf8'),
  ),
)

export interface EvaluationProfile {
  methods?: readonly EvaluationMethod[]
  runId: string
  totalUsdMicros: number
  totalWallSeconds: number
  maxInputBytes: number
  requestTimeoutMs: number
  perCaseCalls: number
  perCaseTokens: number
  perCaseUsdMicros: number
  bootstrapSamples: number
  plan: RemoteRoutePlan
  sourceIdentity: Record<string, string>
}
export interface EvaluationExecutor {
  stage(request: StageRequest): Promise<AttributionAttempt>
  baseline(payload: ReturnType<typeof baselineInput>): Promise<AttributionAttempt>
}
export async function runOfflineEvaluation(options: {
  root: string
  profile: EvaluationProfile
  items: readonly EvaluationItem[]
  sourceRefs?: readonly ObjectRef[]
  execute?: EvaluationExecutor
  onProgress?: (summary: {
    finished: number
    total: number
    method: EvaluationMethod
    status: string
    spentUsdMicros: number
  }) => void
  faultHook?: (name: string, actionId: string) => Promise<void>
}) {
  const { root, profile, items } = options
  const selectedMethods = profile.methods ?? METHODS
  if (!validateProfile(profile))
    throw Error(`invalid offline profile: ${JSON.stringify(validateProfile.errors)}`)
  if (!items.length || new Set(items.map((i) => i.taskId)).size !== items.length)
    throw Error('invalid frozen task population')
  for (const amount of [
    profile.totalUsdMicros,
    profile.totalWallSeconds,
    profile.maxInputBytes,
    profile.requestTimeoutMs,
    profile.perCaseCalls,
    profile.perCaseTokens,
    profile.perCaseUsdMicros,
    profile.bootstrapSamples,
  ])
    if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('invalid evaluation envelope')
  if (profile.plan.retry.maxAttempts !== 1 || profile.plan.retry.backoffMs.length)
    throw Error('offline evaluation forbids retries')
  const store = await openObjectStore(join(root, 'objects'))
  const controller = await Controller.open(
    join(root, 'controller'),
    join(root, 'objects'),
    {
      runId: profile.runId,
      budgetLimits: {
        usd: profile.totalUsdMicros,
        'attribution-calls': items.length * selectedMethods.length * profile.perCaseCalls,
        'attribution-tokens': items.length * selectedMethods.length * profile.perCaseTokens,
      },
      ...(options.faultHook
        ? { onBoundary: (point: string, id: string | null) => options.faultHook!(point, id ?? '') }
        : {}),
    },
    new FakeProvider(),
  )
  const put = async (
    key: string,
    value: unknown,
    label: 'DEV_OBSERVED' | 'CONTROLLER_INTERNAL' = 'DEV_OBSERVED',
  ) => {
    const ref = await store.put(
      Buffer.from(
        JSON.stringify(value, (_key, child: unknown) => {
          if (child && typeof child === 'object' && !Array.isArray(child))
            return Object.fromEntries(
              Object.entries(child).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
            )
          return child
        }) + '\n',
      ),
      {
        mediaType: 'application/json',
        label,
      },
    )
    await controller.publishEvidence(key, ref)
    return ref
  }
  try {
    const manifest = {
      protocol: EVALUATION_PROTOCOL,
      profile,
      methods: selectedMethods,
      recover: 'excluded-from-localization',
      debuggerProfile: PROFILE,
      sourceRefs: options.sourceRefs ?? [],
      population: items.map((i) => ({
        id: i.id,
        taskId: i.taskId,
        sourceDigest: i.sourceDigest,
        inputDigest: i.inputDigest,
        events: i.bundle.events.length,
        goldStep: i.goldStep,
        goldModule: i.goldModule,
      })),
    }
    const manifestRef = await put('offline/manifest', manifest, 'CONTROLLER_INTERNAL')
    if (options.sourceRefs) {
      if (options.sourceRefs.length !== items.length) throw Error('source snapshot count mismatch')
      for (const [index, ref] of options.sourceRefs.entries()) {
        if (ref.digest !== items[index]!.sourceDigest || ref.label !== 'CONTROLLER_INTERNAL')
          throw Error('source snapshot identity mismatch')
        await controller.publishEvidence(`offline/source/${items[index]!.id}`, ref)
      }
    }
    if (controller.state.phase === 'DRAFT')
      await controller.changePhase(
        'PREFLIGHT',
        'offline localization benchmark; no task execution or evolution',
      )
    const predictions: Prediction[] = []
    for (const [itemIndex, item] of items.entries()) {
      const order: EvaluationMethod[] =
        itemIndex % 2 === 0 ? ['single-pass', 'v4'] : ['v4', 'single-pass']
      await put(`offline/input/${item.id}`, item.bundle)
      for (const method of order.filter((m) => selectedMethods.includes(m))) {
        const key = `offline/prediction/${method}/${item.id}`
        const previous = controller.state.evidence?.[key]
        if (previous) {
          predictions.push(JSON.parse((await store.read(previous)).toString()) as Prediction)
          continue
        }
        if (!options.execute) continue
        const prefix = `offline-${method}-${item.id}-`
        const calls: StageResult[] = []
        const call = async (
          stage: string,
          window: number,
          payload: Record<string, unknown>,
          execute: () => Promise<AttributionAttempt>,
        ): Promise<StageResult> => {
          const actionId = prefix + stage + '-' + window
          const inputRef = await put(`offline/request/${actionId}`, {
            protocol: EVALUATION_PROTOCOL,
            stage,
            window,
            payload,
          })
          const saved = controller.state.evidence?.[`offline/stage/${actionId}`]
          if (saved) {
            const result = JSON.parse((await store.read(saved)).toString()) as StageResult
            if (typeof result.output === 'string') result.output = JSON.parse(result.output)
            calls.push(result)
            return result
          }
          const ownActions = Object.entries(controller.state.actions).filter(([id]) =>
            id.startsWith(prefix),
          )
          const ownSpent = (dimension: 'usd' | 'attribution-tokens') =>
            ownActions.reduce(
              (sum, [id]) =>
                sum +
                (controller.state.budgetByAction[id]?.[dimension]?.spent ?? 0) +
                (controller.state.budgetByAction[id]?.[dimension]?.reserved ?? 0),
              0,
            )
          // UTF-8 bytes bound prompt tokens conservatively, including prompt/wrapper overhead.
          const tokens =
            Buffer.byteLength(JSON.stringify(payload)) + 8192 + profile.plan.maxOutputTokens
          const usd = Math.max(
            1,
            Math.ceil(
              (tokens - profile.plan.maxOutputTokens) * profile.plan.inputUsdPerMTok +
                profile.plan.maxOutputTokens * profile.plan.outputUsdPerMTok,
            ),
          )
          const estimate = [
            { dimension: 'usd' as const, amount: usd },
            { dimension: 'attribution-calls' as const, amount: 1 },
            { dimension: 'attribution-tokens' as const, amount: tokens },
          ]
          const limits = {
            usd: profile.totalUsdMicros,
            'attribution-calls': items.length * selectedMethods.length * profile.perCaseCalls,
            'attribution-tokens': items.length * selectedMethods.length * profile.perCaseTokens,
          }
          const existing = controller.state.actions[actionId]
          const reason =
            Buffer.byteLength(JSON.stringify(payload)) + 4096 > profile.maxInputBytes
              ? 'input-envelope'
              : ownActions.length >= profile.perCaseCalls ||
                  ownSpent('usd') + usd > profile.perCaseUsdMicros ||
                  ownSpent('attribution-tokens') + tokens > profile.perCaseTokens
                ? 'per-case-budget'
                : estimate.some(
                      (e) =>
                        (controller.state.budget[e.dimension]?.spent ?? 0) +
                          (controller.state.budget[e.dimension]?.reserved ?? 0) +
                          e.amount >
                        limits[e.dimension],
                    )
                  ? 'run-budget'
                  : Date.now() -
                        Date.parse(controller.startedAt ?? new Date().toISOString()) +
                        profile.requestTimeoutMs >
                      profile.totalWallSeconds * 1000
                    ? 'run-wall-clock'
                    : null
          let result: StageResult
          if (!existing && reason)
            result = { status: 'budget-skipped', output: null, reason, refs: [inputRef], actionId }
          else {
            const outcome = await controller.runAttribution({
              actionId,
              request: {
                protocol: EVALUATION_PROTOCOL,
                method,
                itemId: item.id,
                inputDigest: item.inputDigest,
                payloadDigest: canonicalHash(payload),
                routeHash: remoteRoutePlanHash(profile.plan),
              },
              estimate,
              execute,
            })
            const receipt = outcome.receipt
              ? (JSON.parse(
                  (await store.read(outcome.receipt)).toString(),
                ) as AttributionUsageReceipt)
              : null
            result = {
              status: outcome.attribution ? 'completed' : 'call-failed',
              output: outcome.attribution
                ? JSON.parse((await store.read(outcome.attribution)).toString()).output
                : null,
              refs: [inputRef, ...(outcome.attribution ? [outcome.attribution] : [])],
              actionId,
              ...(receipt
                ? {
                    usage: {
                      promptTokens: receipt.promptTokens,
                      completionTokens: receipt.completionTokens,
                      costUsdMicros: receipt.costUsdMicros,
                    },
                  }
                : {}),
              ...(outcome.failureReason ? { reason: outcome.failureReason } : {}),
            }
          }
          // Raw untrusted model JSON may contain floats; encode it separately from canonical journal payloads.
          const disk = {
            ...result,
            output: result.output === null ? null : JSON.stringify(result.output),
          }
          await put(`offline/stage/${actionId}`, disk)
          calls.push(result)
          return result
        }
        const started = Date.now()
        let step: number | null = null,
          module: string | null = null,
          status = 'completed',
          detectedSteps: number[] = []
        if (method === 'v4') {
          const report = await diagnoseTrace(
            {
              runId: profile.runId,
              candidateId: 'offline-unmodified',
              actionId: prefix + 'trace',
              opaqueTaskId: item.taskId,
              attempt: 1,
              split: 'dev-observed',
              inputDigest: 'sha256:' + item.inputDigest,
              bundle: item.bundle,
              citationPolicy: PROFILE.citationPolicy,
              statePolicy: PROFILE.statePolicy,
              trajectoryPolicy: PROFILE.trajectoryPolicy,
              maxInputBytes: profile.maxInputBytes,
            },
            async (request) =>
              request.stage === 'recover'
                ? {
                    status: 'completed',
                    output: { suggestions: [] },
                    reason: 'recover-excluded-from-localization',
                  }
                : call(request.stage, request.window, request.payload, () =>
                    options.execute!.stage(request),
                  ),
          )
          await put(`offline/report/${method}/${item.id}`, report)
          step = report.criticalFailure?.originStep ?? null
          module = report.criticalFailure?.module ?? null
          status = report.executionStatus
          detectedSteps = report.findings.map((f) => f.step)
        } else {
          try {
            const payload = baselineInput(item.bundle, profile.maxInputBytes)
            const result = await call('baseline', 0, payload, () =>
              options.execute!.baseline(payload),
            )
            status = result.status
            if (result.status === 'completed') {
              try {
                const chosen = validateBaseline(
                  typeof result.output === 'string' ? JSON.parse(result.output) : result.output,
                  item.bundle,
                )
                step = chosen.step
                module = chosen.module
              } catch {
                status = 'invalid-output'
              }
            }
          } catch (error) {
            if (String(error).includes('envelope')) status = 'budget-skipped'
            else throw error
          }
        }
        const own = Object.keys(controller.state.actions).filter((id) => id.startsWith(prefix))
        const costUsdMicros = own.reduce(
          (sum, id) => sum + (controller.state.budgetByAction[id]?.usd?.spent ?? 0),
          0,
        )
        const prediction: Prediction = {
          id: item.id,
          method,
          predictedStep: step,
          module,
          status,
          detectedSteps: [...new Set(detectedSteps)].sort((a, b) => a - b),
          costUsdMicros,
          durationMs: Date.now() - started,
          calls: own.length,
        }
        await put(key, prediction)
        predictions.push(prediction)
        options.onProgress?.({
          finished: predictions.length,
          total: items.length * selectedMethods.length,
          method,
          status,
          spentUsdMicros: controller.state.budget.usd?.spent ?? 0,
        })
      }
    }
    const metrics = scoreEvaluation(items, predictions, profile.bootstrapSamples, selectedMethods)
    const summary = {
      ...metrics,
      manifestRef,
      accounting: {
        budget: controller.state.budget,
        modelActions: Object.keys(controller.state.actions).length,
      },
      comparisonStatus: !metrics.complete
        ? 'INCOMPLETE'
        : predictions.some((p) => p.status === 'budget-skipped')
          ? 'BUDGET_LIMITED'
          : 'ALL_CASES_RECORDED',
      runType: 'offline-localization',
    }
    const metricsRef = await put(
      `offline/metrics/${canonicalHash(predictions)}`,
      summary,
      'CONTROLLER_INTERNAL',
    )
    return { summary, metricsRef, predictions, manifestRef }
  } finally {
    await controller.close()
  }
}
