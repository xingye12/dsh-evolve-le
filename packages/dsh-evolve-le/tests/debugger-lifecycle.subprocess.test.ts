import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect } from 'vitest'
import { openObjectStore, type ObjectRef } from '../src/state/object-store.js'
const exec = promisify(execFile)
const child = resolve('packages/dsh-evolve-le/tests/fixtures/debugger-fault-child.ts')
describe('debugger report and overview crash/replay (real SIGKILL)', () => {
  for (const boundary of [
    'action-committed:eval-1',
    'intent-durable:attrib-v4-eval-1-detect-0',
    'launch-receipt-durable:attrib-v4-eval-1-detect-0',
    'terminal-observed:attrib-v4-eval-1-detect-0',
    'action-committed:attrib-v4-eval-1-detect-0',
    'action-committed:debugger-v4/report/eval-1',
    'artifact-stored:debugger-v4/report/eval-1',
    'artifact-stored:overview-parent',
    'action-committed:overview-parent',
  ]) {
    it(
      boundary,
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'dsh-debugger-crash-'))
        try {
          await expect(
            exec(process.execPath, ['--import', 'tsx/esm', child, root, boundary], {
              timeout: 30000,
            }),
          ).rejects.toMatchObject({ signal: 'SIGKILL' })
          const { stdout } = await exec(process.execPath, ['--import', 'tsx/esm', child, root], {
            timeout: 30000,
          })
          const result = JSON.parse(stdout) as {
            observations: unknown[]
            evidence: Record<string, ObjectRef>
          }
          expect(result.observations).toHaveLength(2)
          expect(
            Object.keys(result.evidence).filter((k) => k.startsWith('debugger-v4/report/')),
          ).toHaveLength(2)
          const store = await openObjectStore(join(root, 'objects'))
          for (const candidate of ['parent', 'sibling', 'empty']) {
            const key = Object.keys(result.evidence).find(
              (k) => k.startsWith(`debugger-v4/overview/${candidate}/`) && !k.endsWith('/markdown'),
            )!
            const overview = JSON.parse((await store.read(result.evidence[key]!)).toString())
            expect(overview.candidateId).toBe(candidate)
            expect(overview.totalTrials).toBe(candidate === 'empty' ? 0 : 1)
            expect(overview.failures).toHaveLength(candidate === 'empty' ? 0 : 1)
          }
          const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
          expect(calls.length).toBeLessThanOrEqual(2)
          const repeated = await exec(process.execPath, ['--import', 'tsx/esm', child, root], {
            timeout: 30000,
          })
          expect(JSON.parse(repeated.stdout)).toEqual(result)
          expect((await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')).toEqual(
            calls,
          )
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
      60000,
    )
  }
  it('persists budget-exhausted failures without dropping reports or paying again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debugger-budget-'))
    try {
      const { stdout } = await exec(
        process.execPath,
        ['--import', 'tsx/esm', child, root, 'none', '1'],
        { timeout: 30000 },
      )
      const result = JSON.parse(stdout) as {
        evidence: Record<string, ObjectRef>
        budget: Record<string, { spent: number }>
      }
      expect(result.budget['attribution-calls']?.spent).toBe(1)
      const store = await openObjectStore(join(root, 'objects'))
      const siblingRef = result.evidence['debugger-v4/report/eval-2']!
      const report = JSON.parse((await store.read(siblingRef)).toString())
      expect(report.executionStatus).toBe('budget-skipped')
      expect(report.stages[0].reason).toBe('attribution-budget')
      expect(report.candidateId).toBe('sibling')
      const calls = await readFile(join(root, 'calls.jsonl'), 'utf8')
      await exec(process.execPath, ['--import', 'tsx/esm', child, root, 'none', '1'], {
        timeout: 30000,
      })
      expect(await readFile(join(root, 'calls.jsonl'), 'utf8')).toBe(calls)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
