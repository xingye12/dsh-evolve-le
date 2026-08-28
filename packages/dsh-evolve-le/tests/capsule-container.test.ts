/**
 * Packed-capsule container E2E (Gate 1-2 acceptance, specs/07 §3-4, specs/02
 * §12): the capsule tar.gz — and nothing else — is mounted into a fresh,
 * network-disabled container; the entrypoint extracts exactly the way
 * Harbor's inline ACP binary distribution does (`tar -xf`), verifies
 * SHA256SUMS, then boots through the capsule's own `dsh-evolve-le-acp`
 * wrapper with the task workspace as cwd. The host-side driver speaks the
 * same wire protocol the pipeline's mockReplay stage does.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildCandidate, type BuildResult } from '../src/builder/pipeline.js'
import { runAcpSession } from '../src/acp/driver.js'

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
// The default proves boot on a clean current node; pointing this at the real
// task image (e.g. alexgshaw/extract-elf:20251031, node 18) proves the capsule
// boots on the benchmark's own runtime, not only on our reference.
const NODE_IMAGE = process.env['CAPSULE_CONTAINER_IMAGE'] ?? 'node:24-alpine'

const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

describe('packed capsule boots in a fresh offline container', () => {
  let build: BuildResult
  let payloadDir: string
  let containerNodeVersion: string

  beforeAll(async () => {
    let serverVersion: string
    try {
      ;({ stdout: serverVersion } = await exec('docker', [
        'info',
        '--format',
        '{{.ServerVersion}}',
      ]))
    } catch (error) {
      throw new Error(
        `docker is not available; the Gate 1 container acceptance cannot run here: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    void serverVersion
    await exec('docker', ['pull', NODE_IMAGE])
    // --entrypoint sh: the probe must not depend on the image's own entrypoint.
    const { stdout } = await exec('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      NODE_IMAGE,
      '-c',
      'node --version',
    ])
    containerNodeVersion = stdout.trim()
    build = await buildCandidate({
      sourceDir: join(repoRoot, 'packages/candidate-baseline'),
      workRoot: await freshScratch('dsh-evolve-acp-'),
    })
    expect(build.outcome).toBe('admitted')
    payloadDir = await freshScratch('dsh-evolve-payload-')
    await writeFile(
      join(payloadDir, 'capsule.tar.gz'),
      await readFile(build.artifacts.capsuleArchive),
    )
  }, 600_000)

  it('extracts, verifies SHA256SUMS, and serves ACP initialize/session/prompt', async () => {
    // Host-side pre-extraction verification (specs/02 §12): the archive
    // digest must equal the one the build manifest recorded.
    const archiveBytes = await readFile(build.artifacts.capsuleArchive)
    expect(createHash('sha256').update(archiveBytes).digest('hex')).toBe(
      build.capsule?.archiveSha256,
    )

    // Mirrors Harbor's inline binary install: extract into a directory, then
    // run the wrapper from the task workspace so the entrypoint must resolve
    // its own directory, never the cwd (specs/01 §5.3).
    const entrypoint = [
      'set -e',
      'mkdir /capsule',
      // The task workspace stands in for the trial cwd; images that do not
      // ship one still need it to exist for `-w` below.
      'mkdir -p /workspace',
      'tar -C /capsule -xf /payload/capsule.tar.gz',
      // Post-extraction verification; stdout stays reserved for the protocol.
      'cd /capsule',
      'sha256sum -c SHA256SUMS > /dev/null',
      'cd /workspace',
      'exec /capsule/dsh-evolve-le-acp',
    ].join('; ')

    const acp = await runAcpSession(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-i',
        '-w',
        '/workspace',
        '-v',
        `${payloadDir}:/payload:ro`,
        NODE_IMAGE,
        'sh',
        '-c',
        entrypoint,
      ],
      { timeoutMs: 120_000 },
    )

    const chunks = acp.updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')

    expect(acp.timedOut, `timed out: ${acp.stderr.slice(-400)}`).toBe(false)
    expect(acp.exitCode, `stderr: ${acp.stderr.slice(-400)}`).toBe(0)
    expect(acp.initialize.protocolVersion).toBe(1)
    expect(acp.sessionId).not.toBe('')
    expect(acp.stopReason).toBe('end_turn')
    expect(chunks.some((text) => text.includes('[candidate:identity]'))).toBe(true)
    expect(chunks.some((text) => text.startsWith('[dsh-evolve-le replay]'))).toBe(true)
    expect(acp.report?.quiescent).toBe(true)
    expect(acp.report?.sections.afterUnload).toEqual([])
  }, 180_000)

  it('container holds only the payload mount and a real node', async () => {
    // Nothing but the read-only payload directory is mounted; the capsule is
    // the whole runtime. The node version is recorded for the evidence
    // document; overriding the image (task-image boot proof) changes it.
    const { stdout } = await exec('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'sh',
      '-v',
      `${payloadDir}:/payload:ro`,
      NODE_IMAGE,
      '-c',
      'ls /payload && node --version',
    ])
    const [listing, version] = stdout.trim().split('\n')
    expect(listing).toBe('capsule.tar.gz')
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(containerNodeVersion).toBe(version)
  }, 120_000)
})
