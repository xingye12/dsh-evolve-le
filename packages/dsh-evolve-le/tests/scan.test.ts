/**
 * Policy scanner contract tests (Gate 1). Every adversarial fixture under
 * tests/fixtures/scan/cases/ must produce at least one finding with the
 * expected rule, and the golden tree must scan clean. This is the admission
 * pipeline's static defense line (specs/02 §8–9); it is deliberately strict —
 * unknown constructs reject rather than pass silently.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { captureCanonicalSource } from '../src/candidate/canonical.js'
import { defaultScanPolicy, scanCanonicalSource } from '../src/candidate/scan.js'

const casesDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/scan/cases')

async function scanCase(name: string) {
  const source = await captureCanonicalSource(resolve(casesDir, name))
  return scanCanonicalSource(source, defaultScanPolicy())
}

describe('golden scans clean', () => {
  it('produces no findings for the well-formed candidate', async () => {
    const report = await scanCase('golden')
    expect(report.findings).toEqual([])
    expect(report.clean).toBe(true)
  })
})

describe('adversarial fixtures reject with the expected rule', () => {
  const expectations: [caseName: string, rule: string][] = [
    ['dynamic-import', 'import/dynamic'],
    ['require-call', 'import/require'],
    ['eval-call', 'dangerous/eval'],
    ['function-constructor', 'dangerous/function-constructor'],
    ['node-fs', 'import/node-builtin'],
    ['node-builtin-bare', 'import/node-builtin'],
    ['unknown-package', 'import/not-allowed'],
    ['traversal-import', 'import/traversal'],
    ['unresolved-relative', 'import/unresolved'],
    ['default-export', 'export/default'],
    ['leaked-timer', 'leak/timer'],
    ['process-access', 'dangerous/process'],
    ['task-literal', 'task/fingerprint'],
    ['verifier-path', 'task/verifier-path'],
    ['secret-literal', 'secret/openai-key'],
    ['native-binary', 'package/native-binary'],
    ['install-script', 'package/lifecycle-script'],
    ['loose-dep-range', 'dependency/not-exact'],
    ['unknown-dep', 'dependency/not-allowed'],
    ['patch-override', 'patch/not-insert'],
    ['missing-entry', 'entry/missing'],
  ]

  for (const [caseName, rule] of expectations) {
    it(`${caseName} → ${rule}`, async () => {
      const report = await scanCase(caseName)
      expect(report.clean).toBe(false)
      const rules = report.findings.map((finding) => finding.rule)
      expect(rules).toContain(rule)
    })
  }
})

describe('findings are auditable', () => {
  it('carry file, line and detail for every violation', async () => {
    const report = await scanCase('eval-call')
    for (const finding of report.findings) {
      expect(finding.path.length).toBeGreaterThan(0)
      expect(finding.line).toBeGreaterThanOrEqual(1)
      expect(finding.detail.length).toBeGreaterThan(0)
    }
    const evalFinding = report.findings.find((finding) => finding.rule === 'dangerous/eval')
    expect(evalFinding?.line).toBeGreaterThan(5)
  })

  it('flags a node builtin even when it is type-only', async () => {
    const report = await scanCase('node-fs')
    expect(report.findings.some((finding) => finding.rule === 'import/node-builtin')).toBe(true)
  })

  it('rejects a workflow branch on a state field the runtime never supplies', async () => {
    const source = await captureCanonicalSource(resolve(casesDir, 'golden'))
    const mutated = {
      ...source,
      files: source.files.map((file) =>
        file.path === 'src/index.ts'
          ? {
              ...file,
              content: Buffer.from(
                `${file.content.toString('utf8')}\nconst impossible = input.deliverableReady\n`,
                'utf8',
              ),
            }
          : file,
      ),
    }
    const report = scanCanonicalSource(mutated, defaultScanPolicy())
    expect(report.findings.map((finding) => finding.rule)).toContain('workflow/unavailable-state')
  })
})
