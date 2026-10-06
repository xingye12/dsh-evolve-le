import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const boundaries = [
  'intent-durable:offline-single-pass-case-001-baseline-0',
  'launch-receipt-durable:offline-single-pass-case-001-baseline-0',
  'action-committed:offline-v4-case-001-detect-0',
  'action-committed:offline-v4-case-001-state-0',
  'artifact-stored:offline/report/v4/case-001',
  'action-committed:offline/prediction/v4/case-001',
]
async function run(root: string, boundary?: string) {
  return new Promise<{ code: number | null; signal: string | null }>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        resolve('packages/dsh-evolve-le/tests/fixtures/offline-fault-child.ts'),
        root,
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
      else resolveResult({ code, signal })
    })
  })
}
for (const boundary of boundaries)
  it(`offline SIGKILL replay: ${boundary}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'offline-kill-'))
    try {
      expect((await run(root, boundary)).signal).toBe('SIGKILL')
      expect((await run(root)).code).toBe(0)
      const first = await readFile(join(root, 'fixture-result.json'), 'utf8')
      const calls = await readFile(join(root, 'fixture-calls.jsonl'), 'utf8')
      const names = calls
        .trim()
        .split('\n')
        .map((s) => (JSON.parse(s) as { name: string }).name)
      expect(new Set(names).size).toBe(names.length)
      expect(JSON.parse(first).summary.complete).toBe(true)
      expect(JSON.parse(first).summary.methods.v4.correct).toBe(1)
      expect((await run(root)).code).toBe(0)
      expect(await readFile(join(root, 'fixture-calls.jsonl'), 'utf8')).toBe(calls)
      expect(JSON.parse(await readFile(join(root, 'fixture-result.json'), 'utf8'))).toEqual(
        JSON.parse(first),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30000)
