/** Retain the offline evaluator's real SIGKILL/replay fixture artifacts; no model network. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256Hex } from '../packages/dsh-evolve-le/src/state/canonical.js'
const root = resolve(process.argv[2] ?? 'evidence/swepro-attribution/crash-matrix')
const boundaries = [
  'intent-durable:offline-single-pass-case-001-baseline-0',
  'launch-receipt-durable:offline-single-pass-case-001-baseline-0',
  'action-committed:offline-v4-case-001-detect-0',
  'action-committed:offline-v4-case-001-state-0',
  'artifact-stored:offline/report/v4/case-001',
  'action-committed:offline/prediction/v4/case-001',
]
async function run(caseRoot: string, boundary?: string) {
  return new Promise<string | null>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        resolve('packages/dsh-evolve-le/tests/fixtures/offline-fault-child.ts'),
        caseRoot,
        ...(boundary ? [boundary] : []),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.on('data', (b) => {
      stderr += String(b)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGKILL') reject(Error(stderr))
      else resolveResult(signal)
    })
  })
}
await mkdir(root, { recursive: true })
const cases = []
for (const [index, boundary] of boundaries.entries()) {
  const caseRoot = join(root, `case-${index + 1}`)
  await mkdir(caseRoot)
  if ((await run(caseRoot, boundary)) !== 'SIGKILL') throw Error('expected SIGKILL')
  await run(caseRoot)
  const first = JSON.parse(await readFile(join(caseRoot, 'fixture-result.json'), 'utf8'))
  const calls = await readFile(join(caseRoot, 'fixture-calls.jsonl'), 'utf8')
  const names = calls
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s).name)
  await run(caseRoot)
  const second = JSON.parse(await readFile(join(caseRoot, 'fixture-result.json'), 'utf8'))
  const passed =
    first.metricsRef.digest === second.metricsRef.digest &&
    new Set(names).size === names.length &&
    calls === (await readFile(join(caseRoot, 'fixture-calls.jsonl'), 'utf8')) &&
    second.summary.complete &&
    second.summary.methods.v4.correct === 1
  if (!passed) throw Error('crash replay invariant failed')
  cases.push({
    boundary,
    root: `case-${index + 1}`,
    passed,
    fixtureRequests: names.length,
    metricsDigest: first.metricsRef.digest,
    callsDigest: sha256Hex(calls),
  })
}
await writeFile(
  join(root, 'receipt.json'),
  JSON.stringify(
    {
      protocol: 'dsh-evolve-le/offline-attribution-crash/v1',
      allPassed: true,
      cases,
      liveModelCalls: 0,
      accuracyClaim: false,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
)
console.log(JSON.stringify({ cases: cases.length, allPassed: true, liveModelCalls: 0 }))
