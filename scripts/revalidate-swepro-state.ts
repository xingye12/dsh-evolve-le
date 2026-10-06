/** Post-hoc State-rule ablation of frozen outputs. No controller writes or model calls. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { adaptTrajectory } from '../packages/dsh-evolve-le/src/attribution/offline-evaluation.js'
import {
  validateInstanceState,
  selectCriticalFailure,
  type FailureReport,
  type TraceBundle,
  type CitationPolicy,
  type StatePolicy,
} from '../packages/dsh-evolve-le/src/attribution/trajdebug.js'
import {
  canonicalHash,
  canonicalJson,
  sha256Hex,
} from '../packages/dsh-evolve-le/src/state/canonical.js'
import {
  objectPath,
  openObjectStore,
  type ObjectRef,
} from '../packages/dsh-evolve-le/src/state/object-store.js'
import { validateDiagnosticArtifact } from '../packages/dsh-evolve-le/src/attribution/schemas.js'

type CapturedState = {
  payload: { instances: { instanceId: string }[]; contextIncomplete: boolean }
  output: { states: { instanceId: string; resolution: string }[] }
}
/** Keep the original Detect pool fixed; only interpret its recorded State replies. */
export function revalidateCapturedStates(
  original: FailureReport,
  bundle: TraceBundle,
  captures: CapturedState[],
  options: { statePolicy: StatePolicy; citationPolicy: CitationPolicy },
): FailureReport {
  const report = structuredClone(original)
  report.runId = 'swepro86-state-rule-revalidation-20261005-v1'
  report.suggestions = []
  for (const instance of report.instances)
    Object.assign(instance, {
      resolution: 'unknown',
      terminalConnection: 'unknown',
      terminalEvidence: null,
      fixEvidence: null,
      impactEvidence: null,
      wastedSteps: [],
      explanation: 'No recorded state.',
    })
  const covered = new Set<string>()
  for (const capture of captures) {
    const expected = new Set(capture.payload.instances.map((i) => i.instanceId))
    const seen = new Set<string>()
    for (const raw of capture.output.states) {
      if (!expected.has(raw.instanceId) || seen.has(raw.instanceId) || covered.has(raw.instanceId))
        throw Error('recorded instance identity mismatch')
      seen.add(raw.instanceId)
      covered.add(raw.instanceId)
      const instance = report.instances.find((i) => i.instanceId === raw.instanceId)
      if (!instance) throw Error('recorded state outside original Detect pool')
      const origin = report.findings.find(
        (f) => instance.findingIds.includes(f.findingId) && f.step === instance.originStep,
      )
      if (!origin) throw Error('missing original finding')
      try {
        Object.assign(
          instance,
          validateInstanceState(raw, bundle, origin, {
            ...options,
            contextIncomplete: capture.payload.contextIncomplete,
          }),
        )
      } catch (error) {
        instance.explanation = String(error)
      }
    }
    if (seen.size !== expected.size) throw Error('missing recorded instance state')
  }
  if (covered.size !== report.instances.length)
    throw Error('missing recorded states for original instances')
  selectCriticalFailure(report)
  return report
}

async function readRef(root: string, ref: ObjectRef): Promise<Buffer> {
  const bytes = await readFile(objectPath(join(root, 'objects'), ref.digest))
  if (bytes.length !== ref.size || sha256Hex(bytes) !== ref.digest)
    throw Error('source object digest mismatch')
  return bytes
}

async function main() {
  const { values } = parseArgs({
    options: {
      original: { type: 'string', default: 'evidence/swepro-attribution/v4-64k-20261005-v1' },
      supplement: {
        type: 'string',
        default: 'evidence/swepro-attribution/v4-64k-20261005-tail-v1',
      },
      out: { type: 'string', default: 'evidence/debugger-state-rules' },
    },
  })
  const roots = [resolve(values.original!), resolve(values.supplement!)]
  const out = resolve(values.out!)
  if (roots.some((root) => out === root || out.startsWith(root + '/')))
    throw Error('output must not be in a historical run')
  const auditPath = join(roots[1]!, 'combined-audit.json')
  const auditBytes = await readFile(auditPath)
  const audit = JSON.parse(auditBytes.toString()) as {
    rows: { id: string; goldStep: number; reportRef: ObjectRef }[]
  }
  if (audit.rows.length !== 86 || new Set(audit.rows.map((r) => r.id)).size !== 86)
    throw Error('expected frozen 86-case population')
  const manifests = await Promise.all(
    roots.map(async (root) => {
      const ref = JSON.parse(await readFile(join(root, 'manifest-ref.json'), 'utf8')) as ObjectRef
      return {
        ref,
        value: JSON.parse((await readRef(root, ref)).toString()) as {
          sourceRefs: ObjectRef[]
          population: { id: string; inputDigest: string; goldStep: number; sourceDigest: string }[]
        },
      }
    }),
  )
  await mkdir(out, { recursive: true })
  const store = await openObjectStore(join(out, 'objects'))
  const policies = {
    'strict-replay': { statePolicy: 'strict', citationPolicy: 'strict' },
    'citation-only': { statePolicy: 'strict', citationPolicy: 'advisory' },
    'model-judgment': { statePolicy: 'model-judgment', citationPolicy: 'advisory' },
  } as const
  const totals = Object.fromEntries(
    Object.keys(policies).map((key) => [
      key,
      {
        resolutions: { active: 0, fixed: 0, unknown: 0 },
        answered: 0,
        correct: 0,
        instancesWithIssues: 0,
      },
    ]),
  )
  const historical = { resolutions: { active: 0, fixed: 0, unknown: 0 }, answered: 0, correct: 0 }
  const rawResolutions: Record<string, number> = {}
  const rows = []
  let stateCalls = 0,
    findings = 0,
    strictLifecycleMatches = true
  for (const row of audit.rows) {
    const sourceIndex = manifests[1]!.value.population.findIndex((i) => i.id === row.id)
    const rootIndex = sourceIndex >= 0 ? 1 : 0
    const root = roots[rootIndex]!
    const manifest = manifests[rootIndex]!.value
    const populationIndex = manifest.population.findIndex((i) => i.id === row.id)
    const population = manifest.population[populationIndex]!
    if (!population || population.goldStep !== row.goldStep)
      throw Error('case/gold identity mismatch')
    const sourceRef = manifest.sourceRefs[populationIndex]!
    const sourceBytes = await readRef(root, sourceRef)
    const item = adaptTrajectory(JSON.parse(sourceBytes.toString()), row.id, sourceBytes)
    const original = JSON.parse((await readRef(root, row.reportRef)).toString()) as FailureReport
    if (
      sourceRef.digest !== population.sourceDigest ||
      item.inputDigest !== population.inputDigest ||
      original.inputDigest !== 'sha256:' + item.inputDigest ||
      item.goldStep !== population.goldStep
    )
      throw Error('source/input identity mismatch')
    const captures: CapturedState[] = []
    const stageRefs: ObjectRef[] = []
    for (const stage of original.stages.filter((s) => s.stage === 'state')) {
      if (!stage.refs || stage.refs.length !== 2)
        throw Error('missing recorded State request/output')
      const request = JSON.parse((await readRef(root, stage.refs[0]!)).toString())
      const response = JSON.parse((await readRef(root, stage.refs[1]!)).toString())
      if (
        request.stage !== 'state' ||
        canonicalHash(request.payload) !== stage.payload.digest?.toString().replace(/^sha256:/, '')
      )
        throw Error('State input digest mismatch')
      if (!Array.isArray(response.output?.states)) throw Error('missing raw State response')
      captures.push({ payload: request.payload, output: response.output })
      stageRefs.push(...stage.refs)
      stateCalls++
      for (const s of response.output.states)
        rawResolutions[s.resolution] = (rawResolutions[s.resolution] ?? 0) + 1
    }
    findings += original.findings.length
    for (const i of original.instances) historical.resolutions[i.resolution]++
    if (original.criticalFailure) historical.answered++
    if (original.criticalFailure?.originStep === item.goldStep) historical.correct++
    const comparisons: Record<string, unknown> = {}
    let reportRef: ObjectRef | null = null
    for (const [name, options] of Object.entries(policies)) {
      const report = revalidateCapturedStates(original, item.bundle, captures, options)
      const counts = { active: 0, fixed: 0, unknown: 0 }
      for (const i of report.instances) counts[i.resolution]++
      const tally = totals[name]!
      for (const key of ['active', 'fixed', 'unknown'] as const)
        tally.resolutions[key] += counts[key]
      const issues = report.instances.filter((i) => i.evidenceIssues?.length).length
      tally.instancesWithIssues += issues
      if (report.criticalFailure) tally.answered++
      if (report.criticalFailure?.originStep === item.goldStep) tally.correct++
      comparisons[name] = {
        resolutions: counts,
        predictedStep: report.criticalFailure?.originStep ?? null,
        instancesWithIssues: issues,
      }
      if (name === 'strict-replay')
        strictLifecycleMatches &&= report.instances.every(
          (i, index) =>
            i.resolution === original.instances[index]!.resolution &&
            i.terminalConnection === original.instances[index]!.terminalConnection,
        )
      if (name === 'model-judgment') {
        validateDiagnosticArtifact('failure-report', report)
        reportRef = await store.put(
          Buffer.from(canonicalJson({ sourceReportRef: row.reportRef, stageRefs, report }) + '\n'),
          {
            mediaType: 'application/vnd.dsh-evolve-le.posthoc-state-report+json',
            label: 'CONTROLLER_INTERNAL',
          },
        )
      }
    }
    rows.push({
      id: row.id,
      goldStep: item.goldStep,
      sourceRoot: root,
      sourceReportRef: row.reportRef,
      reportRef,
      comparisons,
    })
  }
  if (
    !strictLifecycleMatches ||
    canonicalJson(totals['strict-replay']!.resolutions) !== canonicalJson(historical.resolutions)
  )
    throw Error('strict replay differs from recorded lifecycle')
  const sourcePaths = [
    'scripts/revalidate-swepro-state.ts',
    'packages/dsh-evolve-le/src/attribution/trajdebug.ts',
    'schemas/failure-report.schema.json',
  ]
  const sourceIdentity = Object.fromEntries(
    await Promise.all(sourcePaths.map(async (p) => [p, sha256Hex(await readFile(p))])),
  )
  const result = {
    protocol: 'dsh-evolve-le/swepro-state-rule-ablation/v1',
    sourceIdentity,
    sourceManifestRefs: manifests.map((m) => m.ref),
    sourceAuditDigest: sha256Hex(auditBytes),
    total: 86,
    findings,
    stateCalls,
    rawResolutions,
    historical,
    policies,
    results: totals,
    strictLifecycleMatches,
    modelCalls: 0,
    costUsdMicros: 0,
    note: 'Post-hoc rule ablation. Original Detect pool fixed. New Detect candidates have no recorded State and are excluded. Not a new live full-pipeline accuracy evaluation.',
    rows,
  }
  const ref = await store.put(Buffer.from(canonicalJson(result) + '\n'), {
    mediaType: 'application/json',
    label: 'CONTROLLER_INTERNAL',
  })
  await writeFile(join(out, 'comparison.json'), JSON.stringify(result, null, 2) + '\n')
  await writeFile(join(out, 'comparison-ref.json'), JSON.stringify(ref, null, 2) + '\n')
  const table = [
    '| Rules | active | fixed | unknown | Roots / 86 | Exact step matches / 86 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(totals).map(
      ([name, value]) =>
        `| ${name} | ${value.resolutions.active} | ${value.resolutions.fixed} | ${value.resolutions.unknown} | ${value.answered} | ${value.correct} |`,
    ),
  ]
  await writeFile(
    join(out, 'comparison.md'),
    [
      '# Post-hoc State rule comparison',
      '',
      result.note,
      '',
      `Original model states: ${JSON.stringify(rawResolutions)}. Paid calls: 0. Strict lifecycle replay matches: ${strictLifecycleMatches}.`,
      '',
      ...table,
      '',
      'A retained model judgment is not verified causal truth. Evidence issues are retained per instance. Historical runs are read only.',
      '',
    ].join('\n'),
  )
  console.log(
    JSON.stringify(
      {
        total: result.total,
        stateCalls,
        rawResolutions,
        historical,
        results: totals,
        strictLifecycleMatches,
        comparisonRef: ref,
      },
      null,
      2,
    ),
  )
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
