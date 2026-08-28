/**
 * Artifact endpoint tests (Gate 2, specs/07 §4): the local HTTPS endpoint
 * must serve exactly the content-addressed archive Harbor's inline binary
 * distribution downloads, under strict TLS that the augmented CA bundle
 * trusts, and refuse everything else. Host-side here; container
 * reachability through the docker bridge is proven by the E2E.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildAugmentedCaBundle,
  generateLocalCa,
  startArtifactServer,
} from '../src/artifact-server.js'

const execFileAsync = promisify(execFile)
const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

describe('local HTTPS artifact endpoint', () => {
  it('serves the content-addressed archive under a locally-trusted cert', async () => {
    const dir = await freshScratch('dsh-artifact-')
    const artifactsDir = join(dir, 'artifacts')
    await mkdir(artifactsDir)
    const content = Buffer.from('capsule-archive-bytes')
    const digest = createHash('sha256').update(content).digest('hex')
    await writeFile(join(artifactsDir, `${digest}.tar.gz`), content)

    const tlsDir = join(dir, 'tls')
    await mkdir(tlsDir)
    const tls = await generateLocalCa({ dir: tlsDir, ip: '127.0.0.1' })
    const bundle = await buildAugmentedCaBundle({
      dir: tlsDir,
      localCaCertPath: tls.caCertPath,
    })

    const server = await startArtifactServer({
      host: '127.0.0.1',
      port: 0,
      artifactsDir,
      tls: { certPath: tls.serverCertPath, keyPath: tls.serverKeyPath },
    })
    try {
      const url = server.urls.get(digest)
      expect(url).toBeDefined()
      // Strict TLS with the augmented bundle only — no insecure fallback.
      const { stdout: hash } = await execFileAsync('sh', [
        '-c',
        `curl -fsSL --cacert ${bundle} ${url} | sha256sum`,
      ])
      expect(hash.split(' ')[0]).toBe(digest)
      // Unknown digests and non-GET paths are refused.
      const { stdout: bad } = await execFileAsync('sh', [
        '-c',
        `curl -s -o /dev/null -w '%{http_code}' --cacert ${bundle} ${server.url}/${'0'.repeat(64)}.tar.gz || true`,
      ])
      expect(bad.trim()).toBe('404')
    } finally {
      await server.close()
    }
  })

  it('refuses to start over an artifact whose name lies about its digest', async () => {
    const dir = await freshScratch('dsh-artifact-bad-')
    const artifactsDir = join(dir, 'artifacts')
    await mkdir(artifactsDir)
    await writeFile(join(artifactsDir, `${'0'.repeat(64)}.tar.gz`), Buffer.from('not zeros'))
    const tlsDir = join(dir, 'tls')
    await mkdir(tlsDir)
    const tls = await generateLocalCa({ dir: tlsDir, ip: '127.0.0.1' })
    await expect(
      startArtifactServer({
        host: '127.0.0.1',
        port: 0,
        artifactsDir,
        tls: { certPath: tls.serverCertPath, keyPath: tls.serverKeyPath },
      }),
    ).rejects.toThrow(/digest mismatch/)
  })

  it('emits a CA bundle that actually contains the local CA', async () => {
    const dir = await freshScratch('dsh-artifact-ca-')
    const tls = await generateLocalCa({ dir, ip: '127.0.0.1' })
    const bundle = await buildAugmentedCaBundle({ dir, localCaCertPath: tls.caCertPath })
    const text = await readFile(bundle, 'utf8')
    expect(text).toContain(await readFile(tls.caCertPath, 'utf8'))
  })
})
