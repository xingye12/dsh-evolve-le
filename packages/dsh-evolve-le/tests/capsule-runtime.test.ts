/**
 * Pinned-runtime contract tests (Gate 8 defect fix, specs/02 §12):
 * Terminal-Bench 2.1 task images are per-task and almost none ship `node`
 * (only the extract-elf image does), so a capsule that execs a PATH `node`
 * dies with `exec: node: not found` before the first ACP byte — every trial
 * becomes an infrastructure failure that masquerades as a capability FAIL.
 * The capsule therefore carries its own content-addressed runtime, the ACP
 * entrypoint execs it by self-directory path, and the builder fails closed
 * when the pinned tarball is missing or fails verification.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { ACP_ENTRYPOINT } from '../src/builder/capsule.js'
import {
  materializeNodeRuntime,
  NODE_RUNTIME_BINARY_SHA256,
  NODE_RUNTIME_TARBALL_MEMBER,
  NODE_RUNTIME_TARBALL_NAME,
  NODE_RUNTIME_VERSION,
  pinnedNodeRuntimeTarballPath,
} from '../src/builder/pinned-runtime.js'

const exec = promisify(execFile)
// from packages/dsh-evolve-le/tests/ back to the repository root
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const LOCKED_TARBALL_SHA256 = '41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df'

const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

describe('ACP entrypoint is self-contained (specs/01 §5.3, specs/02 §12)', () => {
  it('execs the capsule-bundled runtime by self-directory path', () => {
    expect(ACP_ENTRYPOINT).toContain('exec "$DIR/runtime/node"')
  })

  it('never depends on a PATH node inside the task container', () => {
    // The defect this guards against: `exec node …` resolves through the task
    // image's PATH and dies on the 88/89 node-less TB images.
    expect(ACP_ENTRYPOINT).not.toMatch(/(^|\n)\s*exec\s+node(\s|$)/)
  })

  it('still resolves its own directory, never the task cwd', () => {
    expect(ACP_ENTRYPOINT).toContain('DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)')
  })
})

describe('materializeNodeRuntime fails closed (CLAUDE.md rule 8)', () => {
  it('rejects a missing pinned tarball with the setup instruction', async () => {
    const workDir = await freshScratch('dsh-runtime-missing-')
    await expect(
      materializeNodeRuntime({ workDir, referencesDir: join(workDir, 'no-references') }),
    ).rejects.toThrow(/setup:source/)
  })

  it('rejects a tarball whose digest does not match the lock', async () => {
    const referencesDir = await freshScratch('dsh-runtime-corrupt-')
    await writeFile(
      join(referencesDir, NODE_RUNTIME_TARBALL_NAME),
      'not the pinned runtime',
      'utf8',
    )
    const workDir = await freshScratch('dsh-runtime-work-')
    await expect(materializeNodeRuntime({ workDir, referencesDir })).rejects.toThrow(
      /sha256 .* != recorded/,
    )
  })

  it('extracts the member, verifies it and stages it executable', async () => {
    // A synthetic tarball with the pinned member layout: the verification
    // logic is digest-driven, so any bytes with the declared digests prove
    // the mechanics without the 30 MB reference.
    const content = Buffer.from('#!/bin/sh\ni am the pinned runtime stand-in\n', 'utf8')
    const binarySha256 = createHash('sha256').update(content).digest('hex')
    const staging = await freshScratch('dsh-runtime-stage-')
    await mkdir(dirname(join(staging, NODE_RUNTIME_TARBALL_MEMBER)), { recursive: true })
    await writeFile(join(staging, NODE_RUNTIME_TARBALL_MEMBER), content)
    await chmod(join(staging, NODE_RUNTIME_TARBALL_MEMBER), 0o755)
    const tarball = join(staging, 'runtime.tar.xz')
    await exec('tar', ['-cJf', tarball, '-C', staging, NODE_RUNTIME_TARBALL_MEMBER])
    const tarballSha256 = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex')

    const workDir = await freshScratch('dsh-runtime-ok-')
    const runtime = await materializeNodeRuntime({
      workDir,
      referencesDir: staging,
      tarballName: 'runtime.tar.xz',
      tarballSha256,
      binarySha256,
    })
    expect(runtime.version).toBe(NODE_RUNTIME_VERSION)
    expect(runtime.sha256).toBe(binarySha256)
    expect(runtime.path.startsWith(workDir)).toBe(true)
    const stats = await stat(runtime.path)
    expect(stats.isFile()).toBe(true)
    expect(stats.mode & 0o111).not.toBe(0)
    // The staged member is exactly the verified bytes, not whatever else the
    // tarball may have carried.
    expect((await readFile(runtime.path)).equals(content)).toBe(true)
  })
})

describe('the real pinned reference (present after pnpm setup:source)', () => {
  const referencePresent = existsSync(pinnedNodeRuntimeTarballPath(repoRoot))

  it.skipIf(!referencePresent)(
    'materializes the locked runtime and it executes the pinned version',
    async () => {
      const runtime = await materializeNodeRuntime({
        workDir: await freshScratch('dsh-runtime-real-'),
        referencesDir: join(repoRoot, '.references'),
      })
      expect(runtime.sha256).toBe(NODE_RUNTIME_BINARY_SHA256)
      const { stdout } = await exec(runtime.path, ['--version'])
      expect(stdout.trim()).toBe(NODE_RUNTIME_VERSION)
    },
    120_000,
  )

  it.skipIf(!referencePresent)('the lock reference digest matches the staged tarball', async () => {
    const digest = createHash('sha256')
      .update(await readFile(pinnedNodeRuntimeTarballPath(repoRoot)))
      .digest('hex')
    expect(digest).toBe(LOCKED_TARBALL_SHA256)
  })
})
