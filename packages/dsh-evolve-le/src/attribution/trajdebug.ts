/** Trusted, development-only TrajDebug orchestration. Model outputs are hypotheses. */
import { canonicalHash, canonicalJson } from '../state/canonical.js'
import type { Observation } from '../state/reducer.js'
import type { ObjectRef } from '../state/object-store.js'

export const TRAJDEBUG_PROTOCOL = 'dsh-evolve-le/agent-debugger/v4'
export const REPORT_MEDIA = 'application/vnd.dsh-evolve-le.failure-report+json'
export const OVERVIEW_MEDIA = 'application/vnd.dsh-evolve-le.candidate-error-overview+json'
export type CitationPolicy = 'strict' | 'advisory'
export type TrajectoryPolicy = 'windowed' | 'full-trajectory'
export type StatePolicy = 'strict' | 'model-judgment'
export const PROFILE = {
  maxEvents: 60,
  maxFieldChars: 3000,
  maxFindings: 8,
  maxInstances: 12,
  concurrency: 1,
  citationPolicy: 'advisory',
  statePolicy: 'model-judgment',
  trajectoryPolicy: 'full-trajectory',
} as const
export interface TraceEvent {
  eventId: string
  source: 'atif' | 'acp'
  sourceIndex: number
  actor: string
  kind: string
  data: unknown
  agentId: string | null
}
export interface TraceBundle {
  events: TraceEvent[]
  tests: unknown[]
  terminal: { agentParticipation?: string }
  coverage?: unknown
}
export interface ReportInput {
  runId: string
  candidateId: string
  actionId: string
  opaqueTaskId: string
  attempt: number
  split: 'dev-observed'
  inputDigest: string
  bundle: TraceBundle
  maxInputBytes?: number
  citationPolicy?: CitationPolicy
  statePolicy?: StatePolicy
  trajectoryPolicy?: TrajectoryPolicy
  originalEvidence?: {
    normalizedTrialDigest: string
    trajectoryDigest: string | null
    diagnosticTraceDigest: string | null
  }
}
export type StageStatus = 'completed' | 'call-failed' | 'budget-skipped'
export interface StageRequest {
  stage: 'detect' | 'state' | 'recover'
  window: number
  payload: Record<string, unknown>
}
export interface StageResult {
  status: StageStatus
  output: unknown
  refs?: ObjectRef[]
  actionId?: string
  usage?: {
    promptTokens: number | null
    completionTokens: number | null
    costUsdMicros: number | null
  }
  reason?: string
}
export type StageCall = (request: StageRequest) => Promise<StageResult>
interface Anchor {
  source: 'events' | 'tests'
  index: number
  field: string | null
  start: number | null
  end: number | null
  quote: string
  actualQuote: string | null
  /** Absence retains the legacy matched-anchor representation. */
  matchStatus?: 'unmatched'
  eventId: string | null
}
interface Finding {
  findingId: string
  eventId: string
  source: string
  step: number
  conflictWith: string
  failureMode: string
  module: string
  wrongContentQuote: Anchor
  referenceQuote: Anchor
}
interface Instance {
  instanceId: string
  findingIds: string[]
  originStep: number
  resolution: 'fixed' | 'active' | 'unknown'
  terminalConnection: 'semantic' | 'irreversible' | 'budget-debt' | 'none' | 'unknown'
  terminalEvidence: Anchor | null
  fixEvidence: Anchor | null
  impactEvidence: Anchor | null
  wastedSteps: Anchor[]
  explanation: string
  evidenceIssues?: string[]
}
interface Suggestion {
  surface: string
  mechanism: string
  hypothesis: string
  mechanismTest: string
  preservationTest: string
  evidenceFindingIds: string[]
}
export interface FailureReport {
  protocol: 'dsh-evolve-le/failure-report/v1'
  debuggerProtocol: typeof TRAJDEBUG_PROTOCOL
  runId: string
  candidateId: string
  actionId: string
  opaqueTaskId: string
  attempt: number
  split: 'dev-observed'
  inputDigest: string
  originalEvidence: {
    normalizedTrialDigest: string
    trajectoryDigest: string | null
    diagnosticTraceDigest: string | null
  } | null
  terminal: TraceBundle['terminal']
  executionStatus: StageStatus | 'partial' | 'unanalyzable'
  evidenceSufficiency: 'supported' | 'insufficient'
  findings: Finding[]
  rejectedFindings: { value: unknown; reason: string }[]
  instances: Instance[]
  criticalFailure: {
    instanceId: string
    findingId: string
    originStep: number
    module: string
  } | null
  suggestions: Suggestion[]
  stages: (StageRequest & StageResult)[]
  coverage: {
    input: unknown
    omissions: unknown[]
    contextIncomplete: boolean
    reason: string | null
  }
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw Error('expected object')
  return value as Record<string, unknown>
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error('expected array')
  return value
}
function str(value: unknown, max = 3000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('invalid text')
  return value
}
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
function strings(value: unknown, path = ''): { field: string; text: string }[] {
  if (typeof value === 'string') return [{ field: path, text: value }]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`),
  )
}
function matchQuote(text: string, quote: string): { start: number; end: number } | null {
  const exact = text.indexOf(quote)
  if (exact >= 0) return { start: exact, end: exact + quote.length }
  const parts = norm(quote)
    .split(' ')
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const match = new RegExp(parts.join('\\s+'), 'u').exec(text)
  return match ? { start: match.index, end: match.index + match[0].length } : null
}
function quoteAnchor(
  bundle: TraceBundle,
  source: 'events' | 'tests',
  index: number,
  quote: string,
  policy: CitationPolicy = 'strict',
): Anchor {
  const entry = bundle[source][index]
  if (entry === undefined) throw Error('missing evidence index')
  // Only actual content fields, never serialized JSON metadata, event IDs or keys.
  const content = source === 'events' ? bundle.events[index]!.data : entry
  for (const leaf of strings(content)) {
    if (
      /(?:^|\/)(?:event[_-]?id|tool[_-]?call[_-]?id|source[_-]?call[_-]?id|agent[_-]?(?:name|id))$/i.test(
        leaf.field,
      )
    )
      continue
    const match = matchQuote(leaf.text, quote)
    if (match)
      return {
        source,
        index,
        field: leaf.field,
        ...match,
        quote,
        actualQuote: leaf.text.slice(match.start, match.end),
        eventId: source === 'events' ? bundle.events[index]!.eventId : null,
      }
  }
  if (policy === 'strict') throw Error('quote absent from evidence content')
  // A model-supplied excerpt is a claim, not a verified span. Never invent offsets.
  return {
    source,
    index,
    quote,
    field: null,
    start: null,
    end: null,
    actualQuote: null,
    matchStatus: 'unmatched',
    eventId: source === 'events' ? bundle.events[index]!.eventId : null,
  }
}
export function stateAnchor(
  raw: unknown,
  bundle: TraceBundle,
  policy: CitationPolicy = 'strict',
): Anchor {
  const a = record(raw)
  if (a.source !== 'events' && a.source !== 'tests') throw Error('invalid evidence source')
  if (!Number.isSafeInteger(a.index) || Number(a.index) < 0) throw Error('invalid evidence index')
  return quoteAnchor(bundle, a.source, Number(a.index), str(a.quote), policy)
}
export function validateFinding(
  raw: unknown,
  bundle: TraceBundle,
  allowed: ReadonlySet<string>,
  id: string,
  policy: CitationPolicy = 'strict',
): Finding {
  const f = record(raw)
  const eventId = str(f.eventId)
  if (!allowed.has(eventId)) throw Error('wrong event outside detection window')
  const i = bundle.events.findIndex((e) => e.eventId === eventId)
  const j = bundle.events.findIndex((e) => e.eventId === f.referenceEventId)
  const wrong = bundle.events[i]
  const ref = bundle.events[j]
  if (!wrong || !ref) throw Error('unknown event')
  if (wrong.source !== ref.source || ref.sourceIndex > wrong.sourceIndex)
    throw Error('future or cross-source reference has no established availability')
  const axis = str(f.conflictWith)
  if (axis !== 'self' && ref.sourceIndex >= wrong.sourceIndex)
    throw Error('reference not established before blamed action')
  if (!['task', 'context', 'self', 'env'].includes(axis)) throw Error('invalid conflict axis')
  if (axis === 'task' && !/system|user|prompt|instruction/.test(ref.kind))
    throw Error('task reference is not captured input')
  const wrongAnchor = quoteAnchor(bundle, 'events', i, str(f.wrongContentQuote), policy)
  const referenceAnchor = quoteAnchor(bundle, 'events', j, str(f.referenceQuote), policy)
  if (
    axis === 'self' &&
    (ref.actor !== 'agent' || /\/(observation|results)(\/|$)/.test(referenceAnchor.field ?? ''))
  )
    throw Error('self reference is not agent content')
  if (
    axis === 'context' &&
    !['tool', 'runtime'].includes(ref.actor) &&
    !/\/(observation|results)(\/|$)/.test(referenceAnchor.field ?? '')
  )
    throw Error('context reference is not an observation')
  if (axis === 'env' && !['tool', 'runtime'].includes(wrong.actor))
    throw Error('environment finding blames agent action')
  if (axis !== 'env' && wrong.actor !== 'agent')
    throw Error('finding does not blame an agent commitment')
  if (
    !['plan', 'reason', 'act', 'obs', 'verify', 'environment', 'unknown'].includes(String(f.module))
  )
    throw Error('invalid root module')
  return {
    findingId: id,
    eventId,
    source: wrong.source,
    step: wrong.sourceIndex,
    conflictWith: axis,
    failureMode: str(f.failureMode, policy === 'strict' ? 100 : Infinity),
    module: str(f.module, 100),
    wrongContentQuote: wrongAnchor,
    referenceQuote: referenceAnchor,
  }
}
export function clusterFindings(findings: readonly Finding[]): Instance[] {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    const reference =
      f.referenceQuote.actualQuote === null
        ? `unmatched:${f.referenceQuote.eventId}:${norm(f.referenceQuote.quote).toLowerCase()}`
        : norm(f.referenceQuote.actualQuote).toLowerCase()
    const key = f.conflictWith + '|' + reference
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => ({
      instanceId: 'i-' + canonicalHash(key).slice(0, 20),
      findingIds: group.map((f) => f.findingId).sort(),
      originStep: Math.min(...group.map((f) => f.step)),
      resolution: 'unknown',
      terminalConnection: 'unknown',
      terminalEvidence: null,
      fixEvidence: null,
      impactEvidence: null,
      wastedSteps: [],
      explanation: 'No validated instance state.',
    }))
}
function project(
  value: unknown,
  omissions: unknown[],
  path = '',
  cap: number = PROFILE.maxFieldChars,
): unknown {
  if (typeof value === 'string' && value.length > cap) {
    const half = Math.floor(cap / 2)
    omissions.push({ field: path, start: half, end: value.length - half })
    return value.slice(0, half) + '\n<omitted>\n' + value.slice(-half)
  }
  if (Array.isArray(value)) return value.map((v, i) => project(v, omissions, `${path}/${i}`, cap))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, project(v, omissions, `${path}/${k}`, cap)]),
    )
  return value
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
/** Keep valid model judgments; incomplete support is an audit issue in the new profile. */
export function validateInstanceState(
  raw: unknown,
  bundle: TraceBundle,
  origin: { step: number; source: string },
  options: { statePolicy: StatePolicy; citationPolicy: CitationPolicy; contextIncomplete: boolean },
): Pick<
  Instance,
  | 'resolution'
  | 'terminalConnection'
  | 'terminalEvidence'
  | 'fixEvidence'
  | 'impactEvidence'
  | 'wastedSteps'
  | 'explanation'
  | 'evidenceIssues'
> {
  const s = record(raw)
  if (
    !['active', 'fixed', 'unknown'].includes(String(s.resolution)) ||
    !['semantic', 'irreversible', 'budget-debt', 'none', 'unknown'].includes(
      String(s.terminalConnection),
    )
  )
    throw Error('invalid lifecycle state')
  const advisory = options.statePolicy === 'model-judgment'
  const issues: string[] = []
  const anchor = (value: unknown, field: string): Anchor | null => {
    if (value == null) return null
    try {
      const result = stateAnchor(value, bundle, options.citationPolicy)
      if (result.matchStatus === 'unmatched') issues.push(`${field}: quote-unmatched`)
      return result
    } catch (error) {
      if (!advisory) throw error
      issues.push(`${field}: ${String(error)}`)
      return null
    }
  }
  const terminal = anchor(s.terminalEvidence, 'terminalEvidence')
  const impact = anchor(s.impactEvidence, 'impactEvidence')
  const fixed = anchor(s.fixEvidence, 'fixEvidence')
  let wasted: Anchor[] = []
  try {
    wasted = list(s.wastedSteps ?? []).flatMap((a, i) => {
      const parsed = anchor(a, `wastedSteps/${i}`)
      return parsed ? [parsed] : []
    })
  } catch (error) {
    if (!advisory) throw error
    issues.push(`wastedSteps: ${String(error)}`)
  }
  const later = (a: Anchor) =>
    a.source === 'events' &&
    bundle.events[a.index]!.source === origin.source &&
    bundle.events[a.index]!.sourceIndex > origin.step
  if (!advisory) {
    if (
      s.resolution === 'fixed' &&
      s.terminalConnection === 'irreversible' &&
      (impact === null || impact.source !== 'events')
    )
      throw Error('fixed irreversible cause requires impact evidence')
    if (
      s.resolution === 'fixed' &&
      s.terminalConnection === 'irreversible' &&
      (impact === null || !later(impact))
    )
      throw Error('fixed irreversible cause requires subsequent impact evidence')
    if (s.resolution === 'fixed' && (fixed === null || !later(fixed)))
      throw Error('fixed state requires subsequent repair quote')
    if (
      !['none', 'unknown'].includes(String(s.terminalConnection)) &&
      (terminal === null ||
        (terminal.source === 'events' &&
          (!later(terminal) ||
            bundle.events[terminal.index]!.sourceIndex !==
              Math.max(
                ...bundle.events
                  .filter((e) => e.source === origin.source)
                  .map((e) => e.sourceIndex),
              ))))
    )
      throw Error('connection requires subsequent or terminal evidence')
    if (
      s.terminalConnection === 'budget-debt' &&
      (wasted.length === 0 || wasted.some((a) => !later(a)))
    )
      throw Error('budget debt requires specific subsequent wasted steps')
  } else {
    if (options.contextIncomplete) issues.push('context-incomplete')
    if (s.resolution === 'fixed' && fixed === null) issues.push('repair-evidence-missing')
    if (s.resolution === 'fixed' && fixed !== null && !later(fixed))
      issues.push('repair-order-unverified')
    if (!['none', 'unknown'].includes(String(s.terminalConnection)) && terminal === null)
      issues.push('terminal-evidence-missing')
    if (
      terminal?.source === 'events' &&
      (bundle.events[terminal.index]!.source !== origin.source ||
        bundle.events[terminal.index]!.sourceIndex < origin.step)
    )
      issues.push('terminal-order-unverified')
    if (s.resolution === 'fixed' && s.terminalConnection === 'irreversible') {
      if (impact === null) issues.push('impact-evidence-missing')
      else if (!later(impact)) issues.push('impact-order-unverified')
    }
    if (s.terminalConnection === 'budget-debt') {
      if (wasted.length === 0) issues.push('wasted-step-evidence-missing')
      if (wasted.some((a) => !later(a))) issues.push('wasted-step-order-unverified')
    }
  }
  let resolution = s.resolution as Instance['resolution']
  let explanation = str(s.explanation, advisory ? Infinity : 3000)
  if (!advisory && options.contextIncomplete && resolution === 'active') {
    resolution = 'unknown'
    explanation += ' (Repair context incomplete.)'
  }
  return {
    resolution,
    terminalConnection: s.terminalConnection as Instance['terminalConnection'],
    terminalEvidence: terminal,
    fixEvidence: fixed,
    impactEvidence: impact,
    wastedSteps: wasted,
    explanation,
    ...(advisory ? { evidenceIssues: issues } : {}),
  }
}

/** Deterministic selection; evidence support and model lifecycle judgments are separate. */
export function selectCriticalFailure(report: FailureReport): Instance | undefined {
  report.criticalFailure = null
  report.evidenceSufficiency = 'insufficient'
  const eligible = report.instances
    .filter(
      (i) =>
        i.resolution !== 'unknown' &&
        !['none', 'unknown'].includes(i.terminalConnection) &&
        (i.resolution !== 'fixed' ||
          ['irreversible', 'budget-debt'].includes(i.terminalConnection)),
    )
    .sort((a, b) => a.originStep - b.originStep || a.instanceId.localeCompare(b.instanceId))
  const eligibleSources = new Set(
    eligible.flatMap((i) =>
      report.findings.filter((f) => i.findingIds.includes(f.findingId)).map((f) => f.source),
    ),
  )
  const chosen = eligibleSources.size <= 1 ? eligible[0] : undefined
  if (eligibleSources.size > 1) report.coverage.reason = 'incomparable-source-origins'
  if (chosen) {
    const f = report.findings
      .filter((f) => chosen.findingIds.includes(f.findingId))
      .sort((a, b) => a.step - b.step || a.findingId.localeCompare(b.findingId))[0]!
    report.criticalFailure = {
      instanceId: chosen.instanceId,
      findingId: f.findingId,
      originStep: f.step,
      module: f.module,
    }
    const anchors = [
      ...report.findings
        .filter((f) => chosen.findingIds.includes(f.findingId))
        .flatMap((f) => [f.wrongContentQuote, f.referenceQuote]),
      chosen.terminalEvidence,
      chosen.fixEvidence,
      chosen.impactEvidence,
      ...chosen.wastedSteps,
    ]
    report.evidenceSufficiency =
      (chosen.evidenceIssues?.length ?? 0) > 0 ||
      anchors.some((a) => a?.matchStatus === 'unmatched')
        ? 'insufficient'
        : 'supported'
  }
  return chosen
}

/** Full evidence stays immutable; only the model's view is cropped. */
export async function diagnoseTrace(input: ReportInput, call: StageCall): Promise<FailureReport> {
  const citationPolicy = input.citationPolicy ?? PROFILE.citationPolicy
  const fullTrajectory = (input.trajectoryPolicy ?? PROFILE.trajectoryPolicy) === 'full-trajectory'
  const bundle = {
    ...input.bundle,
    events: input.bundle.events.map((e, index) => ({ ...e, index })),
  }
  const report: FailureReport = {
    protocol: 'dsh-evolve-le/failure-report/v1',
    debuggerProtocol: TRAJDEBUG_PROTOCOL,
    runId: input.runId,
    candidateId: input.candidateId,
    actionId: input.actionId,
    opaqueTaskId: input.opaqueTaskId,
    attempt: input.attempt,
    split: input.split,
    inputDigest: input.inputDigest,
    originalEvidence: input.originalEvidence ?? null,
    terminal: bundle.terminal,
    executionStatus: 'completed',
    evidenceSufficiency: 'insufficient',
    findings: [],
    rejectedFindings: [],
    instances: [],
    criticalFailure: null,
    suggestions: [],
    stages: [],
    coverage: {
      input: bundle.coverage ?? null,
      omissions: [],
      contextIncomplete: false,
      reason: null,
    },
  }
  if (bundle.terminal.agentParticipation === 'never-initialized' || bundle.events.length === 0) {
    report.executionStatus = 'unanalyzable'
    report.coverage.reason =
      bundle.terminal.agentParticipation === 'never-initialized'
        ? 'never-initialized'
        : 'missing-trace'
    return report
  }
  if (new Set(bundle.events.map((e) => e.eventId)).size !== bundle.events.length) {
    report.executionStatus = 'unanalyzable'
    report.coverage.reason = 'duplicate-event-id'
    return report
  }
  const max = input.maxInputBytes ?? 524288
  const run = async (request: StageRequest): Promise<unknown> => {
    // Budget callback owns network failures and durable replay. Do not swallow crash injection.
    const result =
      bytes(request) > max
        ? { status: 'budget-skipped' as const, output: null, reason: 'input-envelope' }
        : await call(request)
    report.stages.push({
      ...request,
      payload: {
        digest: 'sha256:' + canonicalHash(request.payload),
        contextIncomplete: request.payload['contextIncomplete'] ?? null,
      },
      ...result,
      output:
        result.output === null
          ? null
          : result.refs?.length
            ? '<see stage artifacts>'
            : JSON.stringify(result.output),
    })
    return result.status === 'completed' ? result.output : null
  }
  if (fullTrajectory) {
    const payload = {
      events: bundle.events,
      references: [],
      tests: bundle.tests,
      terminal: bundle.terminal,
      coverage: bundle.coverage ?? null,
      taskInputStatus: bundle.events.some((e) => /system|user|prompt|instruction/.test(e.kind))
        ? 'captured'
        : 'unknown',
      trajectoryPolicy: 'full-trajectory',
      maxFindings: PROFILE.maxFindings,
    }
    const output = await run({ stage: 'detect', window: 0, payload })
    if (output !== null) {
      try {
        const raw = list(record(output).findings)
        if (raw.length > PROFILE.maxFindings) throw Error('too many findings')
        raw.forEach((value, index) => {
          try {
            report.findings.push(
              validateFinding(
                value,
                bundle,
                new Set(bundle.events.map((e) => e.eventId)),
                `f-0-${index}`,
                citationPolicy,
              ),
            )
          } catch (error) {
            report.rejectedFindings.push({ value: JSON.stringify(value), reason: String(error) })
          }
        })
      } catch (error) {
        report.stages[report.stages.length - 1]!.status = 'call-failed'
        report.stages[report.stages.length - 1]!.reason = String(error)
      }
    }
  } else {
    let window = 0
    for (const source of ['atif', 'acp'] as const) {
      const ordered = bundle.events
        .filter((e) => e.source === source)
        .sort((a, b) => a.sourceIndex - b.sourceIndex || a.eventId.localeCompare(b.eventId))
      for (let start = 0; start < ordered.length;) {
        let count = Math.min(PROFILE.maxEvents, ordered.length - start)
        const prior = ordered
          .slice(0, start)
          .filter((e) => /system|user|prompt|instruction/.test(e.kind))
          .concat(ordered.slice(Math.max(0, start - 4), start))
        let omissions: unknown[] = []
        let payload: Record<string, unknown> = {}
        for (;;) {
          omissions = []
          payload = {
            events: project(ordered.slice(start, start + count), omissions, 'events'),
            references: project(prior, omissions, 'references'),
            taskInputStatus: [...prior, ...ordered.slice(start, start + count)].some((e) =>
              /system|user|prompt|instruction/.test(e.kind),
            )
              ? 'captured'
              : 'unknown',
            maxFindings: PROFILE.maxFindings,
          }
          if (bytes({ stage: 'detect', window, payload }) <= max || count === 1) break
          count = Math.ceil(count / 2)
        }
        report.coverage.omissions.push(...omissions.map((o) => ({ window, ...record(o) })))
        if (start > 4)
          report.coverage.omissions.push({
            window,
            source,
            referenceContext: 'task-inputs-and-last-four-only',
            priorEvents: start,
          })
        const output = await run({ stage: 'detect', window, payload })
        if (output !== null) {
          try {
            const raw = list(record(output).findings)
            if (raw.length > PROFILE.maxFindings) throw Error('too many findings')
            raw.forEach((value, index) => {
              try {
                report.findings.push(
                  validateFinding(
                    value,
                    bundle,
                    new Set(ordered.slice(start, start + count).map((e) => e.eventId)),
                    `f-${window}-${index}`,
                    citationPolicy,
                  ),
                )
              } catch (error) {
                report.rejectedFindings.push({
                  value: JSON.stringify(value),
                  reason: String(error),
                })
              }
            })
          } catch (error) {
            report.stages[report.stages.length - 1]!.status = 'call-failed'
            report.stages[report.stages.length - 1]!.reason = String(error)
          }
        }
        start += count
        window++
      }
    }
  }
  report.instances = clusterFindings(report.findings)
  for (let start = 0; start < report.instances.length; start += PROFILE.maxInstances) {
    const instances = report.instances.slice(start, start + PROFILE.maxInstances)
    const omissions: unknown[] = []
    const fullContext = { events: bundle.events, tests: bundle.tests, terminal: bundle.terminal }
    let context: unknown = fullTrajectory ? fullContext : project(fullContext, omissions, 'state')
    let payload: Record<string, unknown> = {
      instances,
      findings: report.findings.filter((f) =>
        instances.some((i) => i.findingIds.includes(f.findingId)),
      ),
      context,
      contextIncomplete: omissions.length > 0,
    }
    if (omissions.length > 0) report.coverage.contextIncomplete = true
    if (!fullTrajectory && bytes({ stage: 'state', window: start, payload }) > max) {
      const ids = new Set(
        (payload.findings as Finding[]).flatMap((f) => [f.eventId, f.referenceQuote.eventId]),
      )
      context = project(
        {
          events: bundle.events.filter(
            (e) =>
              ids.has(e.eventId) ||
              bundle.events.slice(-12).includes(e) ||
              (e.sourceIndex >= Math.min(...(payload.findings as Finding[]).map((f) => f.step)) &&
                /repair|fix|correct|test|verify/i.test(JSON.stringify(e.data))),
          ),
          tests: bundle.tests,
          terminal: bundle.terminal,
        },
        omissions,
        'state',
      )
      payload = { ...payload, context, contextIncomplete: true }
      report.coverage.contextIncomplete = true
    }
    report.coverage.omissions.push(...omissions)
    const output = await run({
      stage: 'state',
      window: Math.floor(start / PROFILE.maxInstances),
      payload,
    })
    if (output !== null) {
      try {
        const states = list(record(output).states)
        const seen = new Set<string>()
        for (const raw of states) {
          const s = record(raw)
          const id = str(s.instanceId)
          const instance = instances.find((i) => i.instanceId === id)
          if (!instance || seen.has(id)) throw Error('unknown/duplicate instance')
          seen.add(id)
          try {
            const origin = report.findings.find(
              (f) => instance.findingIds.includes(f.findingId) && f.step === instance.originStep,
            )!
            Object.assign(
              instance,
              validateInstanceState(s, bundle, origin, {
                citationPolicy,
                statePolicy: input.statePolicy ?? PROFILE.statePolicy,
                contextIncomplete: payload.contextIncomplete === true,
              }),
            )
          } catch (error) {
            instance.explanation = String(error)
            report.stages[report.stages.length - 1]!.status = 'call-failed'
            report.stages[report.stages.length - 1]!.reason = String(error)
          }
        }
        if (instances.some((i) => !seen.has(i.instanceId))) {
          report.stages[report.stages.length - 1]!.status = 'call-failed'
          report.stages[report.stages.length - 1]!.reason = 'missing-instance-states'
        }
      } catch (error) {
        report.stages[report.stages.length - 1]!.status = 'call-failed'
        report.stages[report.stages.length - 1]!.reason = String(error)
      }
    }
  }
  const chosen = selectCriticalFailure(report)
  if (chosen) {
    const output = await run({
      stage: 'recover',
      window: 0,
      payload: {
        criticalFailure: report.criticalFailure,
        instance: chosen,
        findings: report.findings.filter((f) => chosen.findingIds.includes(f.findingId)),
      },
    })
    if (output !== null)
      try {
        report.suggestions = list(record(output).suggestions).map((raw) => {
          const s = record(raw)
          const surface = str(s.surface)
          if (!['workflow', 'tools', 'skills', 'system-prompt'].includes(surface))
            throw Error('invalid harness surface')
          const ids = list(s.evidenceFindingIds).map((i) => str(i))
          if (ids.length === 0 || ids.some((id) => !chosen.findingIds.includes(id)))
            throw Error('recover cites unknown evidence')
          return {
            surface,
            mechanism: str(s.mechanism),
            hypothesis: str(s.hypothesis),
            mechanismTest: str(s.mechanismTest),
            preservationTest: str(s.preservationTest),
            evidenceFindingIds: ids,
          }
        })
      } catch (error) {
        report.stages[report.stages.length - 1]!.status = 'call-failed'
        report.stages[report.stages.length - 1]!.reason = String(error)
      }
  }
  const statuses = report.stages.map((s) => s.status)
  report.executionStatus = statuses.every((s) => s === 'completed')
    ? 'completed'
    : statuses.some((s) => s === 'completed')
      ? 'partial'
      : statuses.includes('call-failed')
        ? 'call-failed'
        : 'budget-skipped'
  return report
}
export function searchVisible(o: Observation): boolean {
  return (
    o.split === 'dev-observed' &&
    !/^(tourn-|tournament-|topup-|top-up-|sealed-|full-)/.test(o.actionId)
  )
}
export interface ReportLink {
  report: FailureReport
  ref: ObjectRef
}
export function candidateOverview(
  runId: string,
  candidateId: string,
  all: readonly Observation[],
  reports: readonly ReportLink[],
) {
  const observations = all
    .filter((o) => o.candidateId === candidateId && searchVisible(o))
    .sort((a, b) => a.actionId.localeCompare(b.actionId))
  const own = reports
    .filter(
      (r) =>
        r.report.candidateId === candidateId &&
        observations.some((o) => o.actionId === r.report.actionId),
    )
    .sort((a, b) => a.report.actionId.localeCompare(b.report.actionId))
  const groups = new Map<string, Set<string>>()
  for (const { report } of own)
    for (const f of report.findings) {
      const matched = report.suggestions.filter((s) => s.evidenceFindingIds.includes(f.findingId))
      const surfaces = matched.length ? matched.map((s) => s.surface) : ['unknown']
      for (const surface of surfaces) {
        const key = canonicalJson([
          f.failureMode,
          report.criticalFailure?.module ?? 'unknown',
          surface,
        ])
        const set = groups.get(key) ?? new Set<string>()
        set.add(report.actionId)
        groups.set(key, set)
      }
    }
  const distribution = (keys: (report: FailureReport) => string[]) => {
    const counts = new Map<string, Set<string>>()
    for (const { report } of own)
      for (const key of new Set(keys(report))) {
        const ids = counts.get(key) ?? new Set<string>()
        ids.add(report.actionId)
        counts.set(key, ids)
      }
    return [...counts]
      .map(([key, ids]) => ({ key, failedTrials: ids.size }))
      .sort((a, b) => b.failedTrials - a.failedTrials || a.key.localeCompare(b.key))
  }
  const successes = observations.filter((o) => o.outcome === 'success').length
  return {
    protocol: 'dsh-evolve-le/candidate-error-overview/v1',
    runId,
    candidateId,
    observationWatermark: 'sha256:' + canonicalHash(observations),
    totalTrials: observations.length,
    distinctTasks: new Set(observations.map((o) => o.opaqueTaskId)).size,
    successfulTrials: successes,
    failedTrials: observations.length - successes,
    successRatePermille: observations.length
      ? Math.round((1000 * successes) / observations.length)
      : null,
    groupCountsOverlap: true,
    failurePatterns: distribution((r) =>
      r.findings.length ? r.findings.map((f) => f.failureMode) : ['unknown'],
    ),
    rootModules: distribution((r) => [r.criticalFailure?.module ?? 'unknown']),
    suggestedSurfaces: distribution((r) =>
      r.suggestions.length ? r.suggestions.map((s) => s.surface) : ['unknown'],
    ),
    failures: observations
      .filter((o) => o.outcome !== 'success')
      .map((o) => {
        const r = own.find((r) => r.report.actionId === o.actionId)
        return {
          actionId: o.actionId,
          reportDigest: r ? 'sha256:' + r.ref.digest : null,
          executionStatus: r?.report.executionStatus ?? 'pending',
          evidenceSufficiency: r?.report.evidenceSufficiency ?? 'insufficient',
        }
      }),
    groups: [...groups]
      .map(([key, ids]) => ({
        key,
        failedTrials: ids.size,
        representativeActionIds: [...ids].sort(),
      }))
      .sort((a, b) => b.failedTrials - a.failedTrials || a.key.localeCompare(b.key)),
    infrastructureFailures: own.filter(
      (r) =>
        r.report.coverage.reason === 'never-initialized' ||
        observations.some((o) => o.actionId === r.report.actionId && o.outcome === 'missing'),
    ).length,
    unknown: own.filter((r) => r.report.criticalFailure === null).length,
    insufficientEvidence: own.filter((r) => r.report.evidenceSufficiency === 'insufficient').length,
    diagnosticFailures: own.filter((r) =>
      ['call-failed', 'partial'].includes(r.report.executionStatus),
    ).length,
    budgetSkipped: own.filter((r) => r.report.executionStatus === 'budget-skipped').length,
    unanalyzable: own.filter((r) => r.report.executionStatus === 'unanalyzable').length,
  }
}
export function renderOverview(o: ReturnType<typeof candidateOverview>): string {
  return [
    `# Candidate ${o.candidateId} error overview`,
    `Trials: ${o.totalTrials}; distinct tasks: ${o.distinctTasks}.`,
    `Succeeded: ${o.successfulTrials}; failed: ${o.failedTrials}. Trial success rate: ${o.successRatePermille === null ? 'unknown' : (o.successRatePermille / 10).toFixed(1) + '%'}.`,
    `Groups overlap; percentages must not be added. Unknown roots: ${o.unknown}; insufficient: ${o.insufficientEvidence}; diagnostic failures: ${o.diagnosticFailures}; budget skipped: ${o.budgetSkipped}; unanalyzable: ${o.unanalyzable}; infrastructure failures: ${o.infrastructureFailures}.`,
    `## Distributions`,
    `Failure patterns: ${JSON.stringify(o.failurePatterns)}; root modules: ${JSON.stringify(o.rootModules)}; suggested surfaces: ${JSON.stringify(o.suggestedSurfaces)}. Counts are distinct failed trials.`,
    `## Priority groups`,
    ...o.groups.map(
      (g) =>
        `- ${g.key}: ${g.failedTrials} distinct failed trials (${o.failedTrials ? Math.round((1000 * g.failedTrials) / o.failedTrials) / 10 : 0}%). Evidence: ${g.representativeActionIds.join(', ')}`,
    ),
    `## Failure reports`,
    ...o.failures.map(
      (f) =>
        `- ${f.actionId}: ${f.executionStatus}, ${f.evidenceSufficiency}; ${f.reportDigest ? `[report](./${f.reportDigest.slice(7)})` : 'pending'}`,
    ),
    '',
  ].join('\n\n')
}
