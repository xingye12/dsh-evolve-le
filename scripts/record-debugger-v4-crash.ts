/** Durable audit artifact for local debugger saga faults; all model responses are fixtures. */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  openObjectStore,
  type ObjectRef,
} from '../packages/dsh-evolve-le/src/state/object-store.js'
import { canonicalJson, canonicalHash } from '../packages/dsh-evolve-le/src/state/canonical.js'
const exec = promisify(execFile)
const output = resolve(process.argv[2] ?? 'evidence/debugger-v4/crash-matrix')
const child = resolve('packages/dsh-evolve-le/tests/fixtures/debugger-fault-child.ts')
const boundaries = [
  'action-committed:eval-1',
  'intent-durable:attrib-v4-eval-1-detect-0',
  'launch-receipt-durable:attrib-v4-eval-1-detect-0',
  'terminal-observed:attrib-v4-eval-1-detect-0',
  'action-committed:attrib-v4-eval-1-detect-0',
  'artifact-stored:debugger-v4/report/eval-1',
  'action-committed:debugger-v4/report/eval-1',
  'artifact-stored:overview-parent',
  'action-committed:overview-parent',
]
await mkdir(output, { recursive: true })
const results = []
for (const [index, boundary] of boundaries.entries()) {
  const root = join(output, `case-${index + 1}`)
  let signal: string | null = null
  try {
    await exec(process.execPath, ['--import', 'tsx/esm', child, root, boundary], { timeout: 60000 })
  } catch (error) {
    signal = (error as { signal?: string }).signal ?? null
  }
  const args = ['--import', 'tsx/esm', child, root]
  const first = JSON.parse((await exec(process.execPath, args, { timeout: 60000 })).stdout) as {
    observations: unknown[]
    evidence: Record<string, ObjectRef>
    budget: unknown
  }
  const calls = await readFile(join(root, 'calls.jsonl'), 'utf8')
  const replay = JSON.parse((await exec(process.execPath, args, { timeout: 60000 })).stdout)
  const store = await openObjectStore(join(root, 'objects'))
  await store.scrub(Object.values(first.evidence))
  const passed =
    signal === 'SIGKILL' &&
    first.observations.length === 2 &&
    Object.keys(first.evidence).filter((k) => k.startsWith('debugger-v4/report/')).length === 2 &&
    calls.trim().split('\n').length <= 2 &&
    (await readFile(join(root, 'calls.jsonl'), 'utf8')) === calls &&
    canonicalHash(first) === canonicalHash(replay)
  await writeFile(join(root, 'result.json'), canonicalJson(first) + '\n')
  results.push({
    boundary,
    killed: signal === 'SIGKILL',
    passed,
    fixtureRequests: calls.trim().split('\n').length,
    root: `case-${index + 1}`,
    resultDigest: 'sha256:' + canonicalHash(first),
  })
}
const receipt = {
  protocol: 'dsh-evolve-le/debugger-v4-crash-matrix/v1',
  liveModelCalls: 0,
  allPassed: results.every((r) => r.passed),
  cases: results,
}
await writeFile(join(output, 'receipt.json'), canonicalJson(receipt) + '\n')
console.log(JSON.stringify(receipt))
if (!receipt.allPassed) process.exitCode = 1
