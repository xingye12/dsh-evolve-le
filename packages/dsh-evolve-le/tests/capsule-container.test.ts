/**
 * Packed-capsule container E2E (Gate 1 acceptance, specs/07 §3, specs/02
 * §12): the capsule tar — and nothing else — is mounted into a fresh,
 * network-disabled container; the entrypoint verifies SHA256SUMS after
 * extraction, then serves the ACP round through the real Cordis Loader with
 * no source checkout, no network, and no model. The host-side driver speaks
 * the same wire protocol the pipeline's mockReplay stage does.
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
const NODE_IMAGE = 'node:24-alpine'

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
    const { stdout } = await exec('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      NODE_IMAGE,
      'node',
      '--version',
    ])
    containerNodeVersion = stdout.trim()
    build = await buildCandidate({
      sourceDir: join(repoRoot, 'packages/candidate-baseline'),
      workRoot: await freshScratch('dsh-evolve-acp-'),
    })
    expect(build.outcome).toBe('admitted')
    payloadDir = await freshScratch('dsh-evolve-payload-')
    await writeFile(join(payloadDir, 'capsule.tar'), await readFile(build.artifacts.capsuleTar))
  }, 600_000)

  it('extracts, verifies SHA256SUMS, and serves ACP initialize/session/prompt', async () => {
    // Host-side pre-extraction verification (specs/02 §12): the tar digest
    // must equal the one the build manifest recorded.
    const tarBytes = await readFile(build.artifacts.capsuleTar)
    expect(createHash('sha256').update(tarBytes).digest('hex')).toBe(build.capsule?.tarSha256)

    const entrypoint = [
      'set -e',
      'mkdir /capsule',
      'cd /capsule',
      'tar -xf /payload/capsule.tar',
      // Post-extraction verification; stdout stays reserved for the protocol.
      'sha256sum -c SHA256SUMS > /dev/null',
      'exec node runner/bin/acp-boot.js cordis.yml',
    ].join('; ')

    const acp = await runAcpSession(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-i',
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
    expect(acp.report?.quiescent).toBe(true)
    expect(acp.report?.sections.afterUnload).toEqual([])
  }, 180_000)

  it('container holds only the payload mount and a matching node major', async () => {
    // Nothing but the read-only payload directory is mounted; the capsule is
    // the whole runtime. The node major is recorded for the evidence
    // document rather than pinned to a patch release.
    const { stdout } = await exec('docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${payloadDir}:/payload:ro`,
      NODE_IMAGE,
      'sh',
      '-c',
      'ls /payload',
    ])
    expect(stdout.trim()).toBe('capsule.tar')
    expect(containerNodeVersion).toMatch(/^v24\./)
  }, 120_000)
})
