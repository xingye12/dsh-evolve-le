import { canonicalHash, canonicalJson } from '../state/canonical.js'
import { DIAGNOSTIC_TRACE_MEDIA_TYPE, type Controller } from '../controller/controller.js'
import type { RunConfig } from '../config/run-config.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import type { DurableFailureAttributor, FailureAttributor } from './agent-debugger.js'
import {
  candidateOverview,
  diagnoseTrace,
  OVERVIEW_MEDIA,
  REPORT_MEDIA,
  renderOverview,
  searchVisible,
  TRAJDEBUG_PROTOCOL,
  type FailureReport,
  type ReportLink,
  type StageCall,
  type TraceBundle,
} from './trajdebug.js'
import { validateDiagnosticArtifact } from './schemas.js'

export const reportKey = (actionId: string) => `debugger-v4/report/${actionId}`
export const overviewPrefix = (candidateId: string) => `debugger-v4/overview/${candidateId}/`
export async function hydrateBundle(
  store: ObjectStore,
  ref: ObjectRef,
  allowed: readonly ObjectRef[],
): Promise<TraceBundle> {
  const doc = JSON.parse((await store.read(ref)).toString('utf8')) as TraceBundle & {
    protocol: string
    shards?: ObjectRef[]
    eventDirectory?: unknown[]
  }
  if (doc.protocol !== 'dsh-evolve-le/diagnostic-trace-bundle/v3')
    throw Error('incompatible diagnostic trace protocol')
  if (doc.shards) {
    doc.events = []
    for (const shard of doc.shards) {
      if (
        !allowed.some((r) => canonicalJson(r) === canonicalJson(shard)) ||
        shard.label !== 'DEV_OBSERVED'
      )
        throw Error('trace shard outside trial evidence')
      const part = JSON.parse((await store.read(shard)).toString('utf8')) as {
        events: TraceBundle['events']
      }
      doc.events.push(...part.events)
    }
    const directory = doc.events.map((e) => {
      const r = e as unknown as Record<string, unknown>
      return { eventId: e.eventId, source: e.source, sourceIndex: e.sourceIndex, index: r['index'] }
    })
    if (canonicalHash(directory) !== canonicalHash(doc.eventDirectory))
      throw Error('trace directory mismatch')
  }
  if (!Array.isArray(doc.events) || !Array.isArray(doc.tests) || !doc.terminal)
    throw Error('invalid trace bundle')
  if (
    doc.events.some(
      (e, index) =>
        !e ||
        !['atif', 'acp'].includes(e.source) ||
        !Number.isSafeInteger(e.sourceIndex) ||
        e.sourceIndex < 0 ||
        typeof e.eventId !== 'string' ||
        typeof e.kind !== 'string' ||
        (e as unknown as Record<string, unknown>)['index'] !== index,
    )
  )
    throw Error('invalid trace event directory')
  if (new Set(doc.events.map((e) => `${e.source}:${e.sourceIndex}`)).size !== doc.events.length)
    throw Error('duplicate source index')
  return doc
}
/** Called at committed wave boundaries and before a resumed search decision. */
export async function synchronizeDiagnostics(options: {
  controller: Controller
  store: ObjectStore
  config: RunConfig
  attributor?: FailureAttributor
  wallAllowed: () => boolean
}): Promise<void> {
  const { controller, store, config } = options
  const envelope = config.agentDebugger
  if (envelope?.protocol !== 'v4') return
  const observations = Object.values(controller.state.observations)
    .filter(searchVisible)
    .sort((a, b) => a.actionId.localeCompare(b.actionId))
  const publish = async (
    key: string,
    document: unknown,
    mediaType: string,
    kind: 'failure-report' | 'candidate-error-overview',
  ) => {
    validateDiagnosticArtifact(kind, document)
    const ref = await store.put(Buffer.from(canonicalJson(document) + '\n'), {
      mediaType,
      label: 'DEV_OBSERVED',
    })
    await controller.publishEvidence(key, ref)
    return ref
  }
  for (const o of observations) {
    if (o.outcome === 'success' || controller.state.evidence?.[reportKey(o.actionId)]) continue
    const artifacts = controller.state.actions[o.actionId]?.artifacts ?? []
    const diagnostic = artifacts.find(
      (a) => a.mediaType === DIAGNOSTIC_TRACE_MEDIA_TYPE && a.label === 'DEV_OBSERVED',
    )
    let bundle: TraceBundle = {
      events: [],
      tests: [],
      terminal: {},
      coverage: { reason: 'missing-diagnostic' },
    }
    if (diagnostic)
      try {
        bundle = await hydrateBundle(store, diagnostic, artifacts)
      } catch (error) {
        bundle.coverage = { reason: 'corrupt-diagnostic', error: String(error) }
      }
    const normalized = await store.put(Buffer.from(canonicalJson(o) + '\n'), {
      mediaType: 'application/vnd.dsh-evolve-le.normalized-trial+json',
      label: 'DEV_OBSERVED',
    })
    const inputDigest = diagnostic ? 'sha256:' + diagnostic.digest : 'sha256:' + canonicalHash(o)
    const durable = options.attributor as Partial<DurableFailureAttributor> | undefined
    const call: StageCall = async (request) => {
      const actionId = `attrib-v4-${o.actionId}-${request.stage}-${request.window}`
      const inputRef = await store.put(
        Buffer.from(
          canonicalJson({
            protocol: 'dsh-evolve-le/agent-debugger-input/v4',
            trialActionId: o.actionId,
            candidateId: o.candidateId,
            ...request,
          }) + '\n',
        ),
        {
          mediaType: 'application/vnd.dsh-evolve-le.debugger-stage-input+json',
          label: 'DEV_OBSERVED',
        },
      )
      await controller.publishEvidence(`debugger-v4/input/${actionId}`, inputRef)
      const existing = controller.state.actions[actionId]
      const skipped = controller.state.evidence?.[`debugger-v4/skipped/${actionId}`]
      if (skipped)
        return JSON.parse((await store.read(skipped)).toString('utf8')) as Awaited<
          ReturnType<StageCall>
        >
      const route = config.modelRoutes.find((r) => r.id === envelope.route)
      const inputTokens = envelope.maxInputBytes // Conservative UTF-8 byte bound, including contract overhead.
      const tokens = inputTokens + envelope.maxOutputTokens
      const usd = route
        ? Math.max(
            1,
            Math.ceil(
              (inputTokens * route.inputUsdMicrosPerMTok) / 1000000 +
                (envelope.maxOutputTokens * route.outputUsdMicrosPerMTok) / 1000000,
            ),
          )
        : 1
      const estimate = [
        { dimension: 'attribution-calls' as const, amount: 1 },
        { dimension: 'attribution-tokens' as const, amount: tokens },
        { dimension: 'usd' as const, amount: usd },
        {
          dimension: 'wall-clock-seconds' as const,
          amount: Math.ceil(envelope.requestTimeoutMs / 1000),
        },
      ]
      const limits = {
        'attribution-calls': config.budget.attributionCalls ?? 0,
        'attribution-tokens': config.budget.attributionTokens ?? 0,
        usd: config.budget.usd,
        'wall-clock-seconds': config.budget.wallClockMinutes * 60,
      }
      const available = estimate.every((e) => {
        const total = controller.state.budget[e.dimension]
        return (total?.spent ?? 0) + (total?.reserved ?? 0) + e.amount <= limits[e.dimension]
      })
      if (
        !existing &&
        (!available || !options.wallAllowed() || !route || !durable?.stageWithReceipt)
      ) {
        const result = {
          status: 'budget-skipped' as const,
          output: null,
          refs: [inputRef],
          reason: !durable?.stageWithReceipt
            ? 'debugger-unavailable'
            : !available
              ? 'attribution-budget'
              : 'wall-clock-budget',
        }
        const ref = await store.put(Buffer.from(canonicalJson(result) + '\n'), {
          mediaType: 'application/vnd.dsh-evolve-le.debugger-stage-status+json',
          label: 'DEV_OBSERVED',
        })
        await controller.publishEvidence(`debugger-v4/skipped/${actionId}`, ref)
        return result
      }
      const result = await controller.runAttribution({
        actionId,
        request: {
          protocol: TRAJDEBUG_PROTOCOL,
          trialActionId: o.actionId,
          inputDigest,
          stage: request.stage,
          window: request.window,
          payloadDigest: 'sha256:' + canonicalHash(request.payload),
          route: envelope.route,
        },
        estimate,
        execute: () => durable!.stageWithReceipt!(request),
      })
      const usage = result.receipt
        ? (JSON.parse((await store.read(result.receipt)).toString('utf8')) as {
            promptTokens: number | null
            completionTokens: number | null
            costUsdMicros: number | null
          })
        : null
      const stageMeta = {
        actionId,
        refs: [inputRef],
        ...(usage
          ? {
              usage: {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                costUsdMicros: usage.costUsdMicros,
              },
            }
          : {}),
      }
      if (!result.attribution)
        return {
          status: 'call-failed',
          output: null,
          reason: result.failureReason ?? 'uncertain-request',
          ...stageMeta,
        }
      // Usage receipt is internal; never include it in proposer exports.
      try {
        const output = JSON.parse((await store.read(result.attribution)).toString('utf8')) as {
          stage: string
          output: unknown
        }
        validateDiagnosticArtifact('agent-debugger', output)
        if (output.stage !== request.stage) throw Error('stage identity mismatch')
        return {
          status: 'completed',
          output: output.output,
          ...stageMeta,
          refs: [inputRef, result.attribution],
        }
      } catch (error) {
        return {
          status: 'call-failed',
          output: null,
          reason: String(error),
          ...stageMeta,
          refs: [inputRef, result.attribution],
        }
      }
    }
    const report = await diagnoseTrace(
      {
        runId: config.runId,
        candidateId: o.candidateId,
        actionId: o.actionId,
        opaqueTaskId: o.opaqueTaskId,
        attempt: o.attempt,
        split: 'dev-observed',
        inputDigest,
        originalEvidence: {
          normalizedTrialDigest: 'sha256:' + normalized.digest,
          trajectoryDigest: artifacts[0] ? 'sha256:' + artifacts[0].digest : null,
          diagnosticTraceDigest: diagnostic ? 'sha256:' + diagnostic.digest : null,
        },
        bundle,
        maxInputBytes: Math.max(1, envelope.maxInputBytes - 8192),
      },
      call,
    )
    await publish(reportKey(o.actionId), report, REPORT_MEDIA, 'failure-report')
  }
  const links: ReportLink[] = []
  for (const o of observations) {
    const ref = controller.state.evidence?.[reportKey(o.actionId)]
    if (ref) {
      const report = JSON.parse((await store.read(ref)).toString('utf8')) as FailureReport
      validateDiagnosticArtifact('failure-report', report)
      if (
        report.actionId !== o.actionId ||
        report.candidateId !== o.candidateId ||
        report.runId !== config.runId
      )
        throw Error('report ownership mismatch')
      links.push({ report, ref })
    }
  }
  for (const candidateId of Object.keys(controller.state.candidates).sort()) {
    const overview = candidateOverview(config.runId, candidateId, observations, links)
    const key = overviewPrefix(candidateId) + overview.observationWatermark
    await publish(key, overview, OVERVIEW_MEDIA, 'candidate-error-overview')
    const markdown = await store.put(Buffer.from(renderOverview(overview)), {
      mediaType: 'text/markdown',
      label: 'DEV_OBSERVED',
    })
    await controller.publishEvidence(key + '/markdown', markdown)
  }
}
