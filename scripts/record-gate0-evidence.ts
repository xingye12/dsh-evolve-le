/**
 * Record the Gate 0 loader-spike evidence: run the built spike bin under plain
 * Node against the positive and negative fixture compositions and write the
 * machine-readable reports (with environment metadata) to
 * `evidence/gate0/loader-spike.json`. This is the auditable runtime artifact
 * backing the Gate 0 acceptance claims in `PROJECT_STATUS.md`.
 * @module scripts/record-gate0-evidence
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

interface SpikeRun {
  fixture: string
  exitCode: number | null
  timedOut: boolean
  report: unknown
  stderr: string
}

async function runSpike(fixturePath: string): Promise<SpikeRun> {
  const bin = resolve(repoRoot, 'packages/dsh-evolve-le/lib/bin/loader-spike.js')
  if (!existsSync(bin))
    throw new Error(`loader-spike bin missing: run \`pnpm build\` first (${bin})`)
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, fixturePath], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return {
      fixture: fixturePath,
      exitCode: 0,
      timedOut: false,
      report: JSON.parse(stdout),
      stderr,
    }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; killed?: boolean; code?: number }
    return {
      fixture: fixturePath,
      exitCode: failure.code ?? null,
      timedOut: failure.killed === true,
      report: failure.stdout ? JSON.parse(failure.stdout) : null,
      stderr: failure.stderr ?? '',
    }
  }
}

async function gitHead(): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { timeout: 10_000 })
    return stdout.trim()
  } catch {
    return 'unknown (not a git checkout)'
  }
}

async function main(): Promise<number> {
  const fixtures = resolve(repoRoot, 'packages/dsh-evolve-le/tests/fixtures')
  const runs = [
    await runSpike(resolve(fixtures, 'cordis.baseline.yml')),
    await runSpike(resolve(fixtures, 'cordis.negative.yml')),
    await runSpike(resolve(fixtures, 'cordis.twin.yml')),
  ]
  const evidence = {
    gate: 'gate0',
    kind: 'loader-spike',
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      repositoryHead: await gitHead(),
    },
    acceptance: {
      baselineQuiescent:
        runs[0]?.exitCode === 0 &&
        (runs[0]?.report as { quiescent?: boolean } | null)?.quiescent === true,
      negativeRejected:
        runs[1]?.exitCode === 2 &&
        typeof (runs[1]?.report as { error?: string } | null)?.error === 'string' &&
        ((runs[1]?.report as { error?: string } | null)?.error ?? '').includes(
          'cannot get property "dshEvolveProbe" without inject',
        ),
      controlActivated:
        runs[2]?.exitCode === 0 &&
        (runs[2]?.report as { quiescent?: boolean } | null)?.quiescent === true,
    },
    runs,
  }
  const target = resolve(repoRoot, 'evidence/gate0/loader-spike.json')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`evidence written: ${target}`)
  const acceptance = evidence.acceptance
  const allAccepted = Object.values(acceptance).every((value) => value === true)
  console.log(
    `acceptance: baselineQuiescent=${String(acceptance.baselineQuiescent)} negativeRejected=${String(acceptance.negativeRejected)} controlActivated=${String(acceptance.controlActivated)}`,
  )
  return allAccepted ? 0 : 1
}

process.exitCode = await main()
