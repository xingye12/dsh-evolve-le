/**
 * Machine-verifiable provenance check for the pinned upstreams, references,
 * toolchain, and @deepseek-ai package pins. Prints one JSON document and exits
 * 0 on pass, 1 on any failure (fail closed: a missing, unreadable, or drifted
 * input is a failure, never a warning).
 *
 * Usage: `pnpm provenance:check` (full) or `pnpm upstream:check`
 * (`--upstreams-only`: upstream verification only, for the CI
 * "upstream worktrees unchanged" gate).
 * @module scripts/check-provenance
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { loadLock, repoRoot, type ProvenanceLock } from './lib/lock.ts'
import { computeTreeDigest } from './lib/upstream.ts'

const exec = promisify(execFile)

/** One executed verification with a stable identifier. */
interface CheckResult {
  id: string
  status: 'pass' | 'fail'
  detail: string
}

const results: CheckResult[] = []

function record(id: string, status: 'pass' | 'fail', detail: string): void {
  results.push({ id, status, detail })
}

async function check(id: string, run: () => Promise<string> | string): Promise<void> {
  try {
    record(id, 'pass', await run())
  } catch (error) {
    record(id, 'fail', error instanceof Error ? error.message : String(error))
  }
}

function fail(message: string): never {
  throw new Error(message)
}

/** Version string of a CLI (exact major.minor.patch match expected). */
async function cliVersion(command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, { timeout: 30_000 })
  const match = stdout.match(/(\d+\.\d+\.\d+)/)
  return match?.[1] ?? fail(`${command} reported no version: ${stdout.trim()}`)
}

/** Verify one upstream directory against its pin (git checkout or snapshot). */
async function checkUpstream(lock: ProvenanceLock, name: string): Promise<string> {
  const pin = lock.upstreams[name]
  if (pin === undefined) fail(`no pin recorded for upstream ${name}`)
  const dir = resolve(repoRoot, pin.path)
  if (!existsSync(dir)) fail(`${pin.path} is missing; run \`pnpm setup:source\``)

  if (existsSync(resolve(dir, '.git'))) {
    const { stdout: head } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])
    if (head.trim() !== pin.commit) fail(`${pin.path}: HEAD ${head.trim()} != pinned ${pin.commit}`)
    const { stdout: status } = await exec('git', ['-C', dir, 'status', '--porcelain'])
    if (status.trim() !== '') fail(`${pin.path}: working tree dirty (read-only pin edited)`)
    return `git checkout at ${pin.commit.slice(0, 7)}, tree clean`
  }

  const snapshot = pin.snapshot
  if (snapshot === undefined) {
    fail(`${pin.path} is not a git checkout and no snapshot digest is recorded`)
  }
  if (!snapshot.url.endsWith(`/tar.gz/${pin.commit}`)) {
    fail(`${pin.path}: snapshot url does not address the pinned commit`)
  }
  const { digest, fileCount } = await computeTreeDigest(dir)
  if (digest !== snapshot.treeDigest.value || fileCount !== snapshot.fileCount) {
    fail(
      `${pin.path}: snapshot digest mismatch (expected ${snapshot.treeDigest.value} over ${snapshot.fileCount} files, got ${digest} over ${fileCount} files); local tree drifted from the materialized pin`,
    )
  }
  return `SHA-addressed snapshot verified by tree digest (${fileCount} files); tarball sha256 ${snapshot.tarballSha256.slice(0, 12)}…`
}

/** Every check except upstreams (schema, toolchain, dsh packages, references). */
async function checkEverythingElse(lock: ProvenanceLock): Promise<void> {
  await check('lock/schema', () => 'validates against schemas/provenance.lock.schema.json')

  await check('toolchain/versions', async () => {
    const actual: Record<string, string> = {
      node: process.version,
      pnpm: await cliVersion('pnpm', ['--version']),
      python: await cliVersion('python3', ['--version']),
      uv: await cliVersion('uv', ['--version']),
      docker: await cliVersion('docker', ['--version']),
    }
    const mismatched = Object.entries(actual)
      .filter(([key, value]) => value !== lock.toolchain[key])
      .map(
        ([key, value]) => `${key}: recorded ${lock.toolchain[key] ?? '<missing>'}, actual ${value}`,
      )
    if (mismatched.length > 0) {
      fail(
        `toolchain drift (update provenance.lock.json deliberately, never silently):\n${mismatched.join('\n')}`,
      )
    }
    return 'node/pnpm/python/uv/docker match the recorded versions'
  })

  await check('dsh-packages/versions', async () => {
    // Build the checkout's name→version map from vendor/* and packages/*/*
    // manifests, then require every pinned @deepseek-ai/* version to match.
    const seen = new Map<string, string>()
    const { glob } = await import('node:fs/promises')
    const checkoutRoot = resolve(repoRoot, 'deepseek-harness')
    for (const pattern of ['vendor/*/package.json', 'packages/*/*/package.json']) {
      for (const manifestPath of await Array.fromAsync(glob(pattern, { cwd: checkoutRoot }))) {
        const manifest = JSON.parse(
          await readFile(resolve(checkoutRoot, manifestPath), 'utf8'),
        ) as { name?: string; version?: string }
        if (manifest.name === undefined || manifest.version === undefined) continue
        seen.set(manifest.name, manifest.version)
      }
    }
    const mismatched: string[] = []
    for (const [name, version] of Object.entries(lock.dshPackages)) {
      if (name === 'note') continue
      const checkoutVersion = seen.get(name)
      if (checkoutVersion === undefined)
        mismatched.push(`${name}: not found in the deepseek-harness checkout`)
      else if (checkoutVersion !== version)
        mismatched.push(`${name}: lock ${version} != checkout ${checkoutVersion}`)
    }
    if (mismatched.length > 0) fail(mismatched.join('\n'))
    return `${Object.keys(lock.dshPackages).length - 1} pinned @deepseek-ai/* versions match the checkout manifests`
  })

  await check('references/content', async () => {
    const problems: string[] = []
    for (const [name, ref] of Object.entries(lock.references)) {
      const path = resolve(repoRoot, ref.path)
      if (!existsSync(path)) {
        problems.push(`${name}: ${ref.path} missing; run \`pnpm setup:source\``)
        continue
      }
      const digest = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
      if (digest !== ref.value) problems.push(`${name}: sha256 ${digest} != recorded ${ref.value}`)
    }
    if (problems.length > 0) fail(problems.join('\n'))
    return `${Object.keys(lock.references).length} content-addressed references verified`
  })
}

async function main(argv: string[]): Promise<number> {
  const upstreamsOnly = argv.includes('--upstreams-only')
  let lock: ProvenanceLock
  try {
    lock = await loadLock()
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ status: 'fail', checks: [{ id: 'lock/schema', status: 'fail', detail: String(error) }] }, null, 2)}\n`,
    )
    return 1
  }

  for (const name of Object.keys(lock.upstreams)) {
    await check(`upstream/${name}`, () => checkUpstream(lock, name))
  }
  if (!upstreamsOnly) await checkEverythingElse(lock)

  const failed = results.filter((result) => result.status === 'fail')
  const upstreamModes: Record<string, string> = {}
  for (const result of results) {
    if (!result.id.startsWith('upstream/')) continue
    upstreamModes[result.id.slice('upstream/'.length)] =
      result.status === 'pass' ? 'verified' : 'failed'
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        status: failed.length === 0 ? 'pass' : 'fail',
        upstreams: upstreamModes,
        checks: results,
      },
      null,
      2,
    )}\n`,
  )
  return failed.length === 0 ? 0 : 1
}

process.exitCode = await main(process.argv.slice(2))
