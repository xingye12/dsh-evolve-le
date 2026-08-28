/**
 * Local content-addressed HTTPS artifact endpoint (Gate 2, specs/07 §4;
 * CLAUDE.md rule 2): Harbor's inline ACP binary distribution requires an
 * `https://` archive URL and downloads it inside the task container with
 * strict-TLS curl. This module serves the capsule tar.gz over HTTPS on the
 * docker bridge gateway, so any task container can reach it while nothing
 * is exposed beyond the host. Files are served ONLY under their own sha256
 * name (`/<sha256>.tar.gz`) and the digest is verified at registration, so
 * the URL itself is the integrity claim Harbor then re-checks via
 * `checksum`. Certificates are a throwaway local CA — never a credential
 * (rule 8) — whose only privilege is to be trusted by the job's CA bundle
 * mount.
 * @module @dsh-evolve-le/tb-provider/artifact-server
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerOptions } from 'node:https'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface LocalCa {
  caCertPath: string
  serverCertPath: string
  serverKeyPath: string
}

/** Generate a throwaway local CA + server cert with an IP SAN, via openssl. */
export async function generateLocalCa(options: {
  dir: string
  ip: string
  days?: number
}): Promise<LocalCa> {
  const { dir, ip } = options
  const days = options.days ?? 30
  const caKey = join(dir, 'ca.key')
  const caCertPath = join(dir, 'ca.crt')
  const serverKeyPath = join(dir, 'server.key')
  const csr = join(dir, 'server.csr')
  const serverCertPath = join(dir, 'server.crt')
  const ext = join(dir, 'san.ext')

  await exec('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caCertPath,
    '-subj',
    '/CN=dsh-evolve-le local artifact CA',
    '-days',
    String(days),
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ])
  await exec('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    serverKeyPath,
    '-out',
    csr,
    '-subj',
    `/CN=${ip}`,
  ])
  await writeFile(ext, `subjectAltName=IP:${ip}\n`, 'utf8')
  await exec('openssl', [
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    caCertPath,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    serverCertPath,
    '-days',
    String(days),
    '-extfile',
    ext,
  ])
  return { caCertPath, serverCertPath, serverKeyPath }
}

/** Concatenate the system CA bundle and the local CA into one bundle file. */
export async function buildAugmentedCaBundle(options: {
  dir: string
  localCaCertPath: string
  systemBundlePath?: string
}): Promise<string> {
  const system = options.systemBundlePath ?? '/etc/ssl/certs/ca-certificates.crt'
  const systemText = await readFile(system, 'utf8').catch(() => '')
  const localText = await readFile(options.localCaCertPath, 'utf8')
  const bundlePath = join(options.dir, 'ca-bundle.crt')
  await writeFile(bundlePath, `${systemText}\n${localText}\n`, 'utf8')
  return bundlePath
}

export interface ArtifactServer {
  url: string
  port: number
  /** Registered artifact URLs by sha256. */
  urls: Map<string, string>
  close: () => Promise<void>
}

/**
 * Start the HTTPS endpoint. Every file in `artifactsDir` named
 * `<64-hex>.tar.gz` is verified (sha256 == name) and served at
 * `https://<host>:<port>/<sha256>.tar.gz`. Port 0 picks an ephemeral port.
 */
export async function startArtifactServer(options: {
  host: string
  port: number
  artifactsDir: string
  tls: { certPath: string; keyPath: string }
}): Promise<ArtifactServer> {
  const urls = new Map<string, string>()
  for (const name of await readdir(options.artifactsDir)) {
    if (!/^[0-9a-f]{64}\.tar\.gz$/.test(name)) continue
    const content = await readFile(join(options.artifactsDir, name))
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== name.slice(0, 64)) {
      throw new Error(`artifact-server: ${name} content digest mismatch (${digest})`)
    }
  }

  const tls: ServerOptions = {
    cert: await readFile(options.tls.certPath),
    key: await readFile(options.tls.keyPath),
    minVersion: 'TLSv1.2',
  }
  const server: Server = createServer(tls, (req, res) => {
    const match = /^\/([0-9a-f]{64})\.tar\.gz$/.exec(req.url ?? '')
    if (req.method !== 'GET' || match === null) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found\n')
      return
    }
    const digest = match[1] ?? ''
    const file = join(options.artifactsDir, `${digest}.tar.gz`)
    stat(file)
      .then((stats) => {
        if (!stats.isFile()) throw new Error('not a file')
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': stats.size,
        })
        void readFile(file).then((content) => res.end(content))
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found\n')
      })
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolvePromise())
  })
  const port = serverAddressPort(server)
  for (const name of await readdir(options.artifactsDir)) {
    if (!/^[0-9a-f]{64}\.tar\.gz$/.test(name)) continue
    urls.set(name.slice(0, 64), `https://${options.host}:${port}/${name}`)
  }
  return {
    url: `https://${options.host}:${port}`,
    port,
    urls,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error === undefined ? resolvePromise() : reject(error)))
      }),
  }
}

function serverAddressPort(server: Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error(`artifact-server: unexpected address ${String(address)}`)
  }
  return address.port
}
