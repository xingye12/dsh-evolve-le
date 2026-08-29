/**
 * Build the v0.1 release-candidate artifacts and run the release-gate scans
 * (specs/07 §9): source tarball, sha256 checksums, SPDX SBOM, dependency
 * license scan, secret/leak scan and UTF-8 validation — all computed over the
 * COMMITTED tree (the tarball is `git archive HEAD`), so what is scanned is
 * exactly what is shipped.
 *
 * Outputs (gitignored, content-addressed by checksums into evidence):
 *   release/dsh-evolve-le-<version>-src.tar.gz   source tarball (tracked files)
 *   release/checksums.sha256                      every release artifact
 *   release/sbom.spdx.json                        SPDX 2.3 SBOM
 *   release/report.json                           scan results (machine doc)
 *
 * Fails closed (exit 1) on: a dependency license outside the OSI allowlist,
 * a secret-pattern hit in shipped sources, or any non-UTF-8 tracked file.
 *
 * Usage: node --import tsx/esm scripts/make-release.ts
 * @module scripts/make-release
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { repoRoot } from './lib/lock.ts'

const exec = promisify(execFile)

/** OSI/permissive licenses permitted in the shipped dependency graph. */
const LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'MPL-2.0',
  'Unlicense',
  'CC0-1.0',
  'CC-BY-4.0',
  'Python-2.0',
  'PostgreSQL',
])

/**
 * Concrete credential/key patterns. Deliberately NO raw-entropy rule: this
 * repository legitimately contains thousands of sha256 digests, and a
 * high-entropy heuristic would only add noise. What must never ship is a
 * real token shape — those have distinctive prefixes.
 */
const SECRET_PATTERNS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9-]{32,}\b/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  {
    id: 'password-assignment',
    pattern: /\b(?:password|passwd|secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
]

/** Paths inside the tarball that are exempt from the password-assignment heuristic. */
const SECRET_EXEMPT: ReadonlyArray<(path: string) => boolean> = [
  (path) => path.startsWith('evidence/'), // recorded run docs (config URLs, not creds)
  (path) => path.endsWith('package-lock.json') || path.endsWith('pnpm-lock.yaml'),
]

interface ScanFile {
  path: string
  bytes: number
}

async function main(): Promise<void> {
  const releaseDir = resolve(repoRoot, 'release')
  const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
  }
  const version = manifest['version']
  if (version === undefined || version === '' || version === '0.0.0') {
    throw new Error('root package.json has no release version (expected e.g. 0.1.0-rc.1)')
  }
  // Artifact/SBOM name is the product (GitHub repo) name, not the workspace
  // root manifest's internal package name.
  const pkgName = 'dsh-evolve-le'
  const { stdout: headOut } = await exec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
  const commit = headOut.trim()
  const { stdout: describeOut } = await exec('git', ['log', '-1', '--format=%cI', 'HEAD'], {
    cwd: repoRoot,
  })
  const commitDate = describeOut.trim()

  await rm(releaseDir, { recursive: true, force: true })
  await mkdir(releaseDir, { recursive: true })
  const tarball = join(releaseDir, `${pkgName}-${version}-src.tar.gz`)

  // ---- source tarball: the COMMITTED tree -------------------------------
  await exec('git', ['archive', '--format=tar.gz', '-o', tarball, 'HEAD'], { cwd: repoRoot })
  const tarBytes = await readFile(tarball)
  const tarSha = createHash('sha256').update(tarBytes).digest('hex')
  const tarSize = tarBytes.byteLength

  // ---- extract and inventory --------------------------------------------
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-release-'))
  await exec('tar', ['-xzf', tarball, '-C', scratch])
  const files: ScanFile[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, rel)
      else if (entry.isFile()) {
        const { size } = await readFile(path).then((buf) => ({ size: buf.byteLength }))
        files.push({ path: rel, bytes: size })
      }
    }
  }
  await walk(scratch, '')
  const textFiles = files.filter((file) => isProbablyText(file.path))

  // ---- UTF-8 validation over every shipped text file ---------------------
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const invalidUtf8: string[] = []
  for (const file of textFiles) {
    const buf = await readFile(join(scratch, file.path))
    try {
      decoder.decode(buf)
    } catch {
      invalidUtf8.push(file.path)
    }
  }

  // ---- secret/leak scan ---------------------------------------------------
  const secretHits: Array<{ pattern: string; path: string; line: number }> = []
  for (const file of textFiles) {
    const text = await readFile(join(scratch, file.path), 'utf8')
    const exempt = SECRET_EXEMPT.some((rule) => rule(file.path))
    const lines = text.split('\n')
    for (const { id, pattern } of SECRET_PATTERNS) {
      // The password-assignment heuristic is skipped for documented doc dirs;
      // token-shape patterns (keys) apply everywhere unconditionally.
      if (exempt && id === 'password-assignment') continue
      for (const [index, line] of lines.entries()) {
        if (pattern.test(line)) {
          secretHits.push({ pattern: id, path: file.path, line: index + 1 })
        }
      }
    }
  }

  // ---- dependency license scan + SBOM -------------------------------------
  const depLicenses = await collectDependencyLicenses()
  const unlicensed = depLicenses.filter((dep) => dep.license === null)
  const disallowed = depLicenses.filter(
    (dep) => dep.license !== null && !LICENSE_ALLOWLIST.has(dep.license),
  )
  const workspacePackages = [
    'packages/dsh-evolve-le',
    'packages/cli',
    'packages/candidate-sdk',
    'packages/candidate-baseline',
    'benchmark-adapters/terminal-bench',
  ]
  const sbom = buildSbom({
    pkgName,
    version,
    commit,
    commitDate,
    files,
    workspacePackages,
    depLicenses,
  })
  await writeFile(join(releaseDir, 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`)

  // ---- checksums over every artifact ---------------------------------------
  const checksumLines: string[] = []
  for (const name of (await readdir(releaseDir)).sort()) {
    const digest = createHash('sha256')
      .update(await readFile(join(releaseDir, name)))
      .digest('hex')
    checksumLines.push(`${digest}  ${name}`)
  }
  const checksumsPath = join(releaseDir, 'checksums.sha256')
  await writeFile(checksumsPath, `${checksumLines.join('\n')}\n`)
  const checksumsSha = createHash('sha256')
    .update(await readFile(checksumsPath))
    .digest('hex')

  const report = {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/release/v1',
    generatedAt: new Date().toISOString(),
    name: pkgName,
    version,
    sourceCommit: commit,
    sourceCommitDate: commitDate,
    tarball: {
      file: `${pkgName}-${version}-src.tar.gz`,
      sha256: tarSha,
      bytes: tarSize,
      fileCount: files.length,
      textFileCount: textFiles.length,
    },
    utf8: { checked: textFiles.length, invalid: invalidUtf8 },
    secrets: { patterns: SECRET_PATTERNS.map((p) => p.id), hits: secretHits },
    licenses: {
      allowlist: [...LICENSE_ALLOWLIST].sort(),
      dependencyCount: depLicenses.length,
      unlicensed: unlicensed.map((dep) => `${dep.name}@${dep.version}`),
      disallowed: disallowed.map((dep) => `${dep.name}@${dep.version}=${dep.license}`),
      byLicense: tallyByLicense(depLicenses),
    },
    sbom: { file: 'sbom.spdx.json', packages: sbom.packages.length },
    checksums: { file: 'checksums.sha256', sha256: checksumsSha },
  }
  await writeFile(join(releaseDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  await rm(scratch, { recursive: true, force: true })

  const failures: string[] = []
  if (invalidUtf8.length > 0)
    failures.push(`non-UTF-8 files: ${invalidUtf8.slice(0, 5).join(', ')}`)
  if (secretHits.length > 0) {
    failures.push(
      `secret-pattern hits: ${secretHits
        .slice(0, 5)
        .map((hit) => `${hit.pattern}@${hit.path}:${String(hit.line)}`)
        .join(', ')}`,
    )
  }
  if (unlicensed.length > 0) failures.push(`deps without license: ${unlicensed.length}`)
  if (disallowed.length > 0) failures.push(`non-allowlisted licenses: ${disallowed.length}`)
  if (failures.length > 0) {
    console.error(`release scans FAILED: ${failures.join(' | ')}`)
    process.exit(1)
  }
  console.log(
    `release: ${pkgName}-${version} @ ${commit.slice(0, 12)} — ${String(files.length)} files, ` +
      `${String(depLicenses.length)} deps (all allowlisted), 0 secret hits, UTF-8 clean`,
  )
}

function isProbablyText(path: string): boolean {
  return (
    /\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|ya?ml|toml|txt|sh|html|css|map|editorconfig|prettierrc|oxlintrc|gitignore|npmrc|example|env|lock|schema)$/.test(
      path,
    ) ||
    /(?:^|\/)\.(?:gitignore|prettierignore|prettierrc|oxlintrc|npmrc|zcode)/.test(path) ||
    /(?:^|\/)(?:CHANGELOG|LICENSE|NOTICE|README)(?:\.[^/]+)?$/.test(path)
  )
}

interface DepLicense {
  name: string
  version: string
  license: string | null
}

/** name@version → license from the pnpm store; no lockfile parsing needed. */
async function collectDependencyLicenses(): Promise<DepLicense[]> {
  const storeRoot = join(repoRoot, 'node_modules', '.pnpm')
  if (!existsSync(storeRoot)) throw new Error('node_modules/.pnpm missing; run pnpm install first')
  const seen = new Map<string, DepLicense>()
  for (const entry of await readdir(storeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const nm = join(storeRoot, entry.name, 'node_modules')
    for (const scope of await readdir(nm, { withFileTypes: true }).catch(() => [])) {
      if (!scope.isDirectory()) continue
      if (scope.name.startsWith('@')) {
        for (const pkg of await readdir(join(nm, scope.name), { withFileTypes: true }).catch(
          () => [],
        )) {
          if (!pkg.isDirectory()) continue
          await record(join(nm, scope.name, pkg.name), `${scope.name}/${pkg.name}`)
        }
      } else {
        await record(join(nm, scope.name), scope.name)
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name !== b.name ? 1 : 0))

  async function record(pkgDir: string, name: string): Promise<void> {
    const manifestPath = join(pkgDir, 'package.json')
    if (!existsSync(manifestPath)) return
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      name?: string
      version?: string
      license?: string | { type?: string }
      private?: boolean
    }
    if (manifest['name'] !== name || manifest['private'] === true) return
    const key = `${name}@${String(manifest['version'])}`
    if (seen.has(key)) return
    const raw = manifest['license']
    const license = typeof raw === 'string' ? raw : (raw?.['type'] ?? null)
    seen.set(key, {
      name,
      version: String(manifest['version']),
      license: license === '' ? null : license,
    })
  }
}

function tallyByLicense(deps: readonly DepLicense[]): Record<string, number> {
  const tally: Record<string, number> = {}
  for (const dep of deps) {
    const key = dep.license ?? 'UNLICENSED'
    tally[key] = (tally[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : 1)))
}

function buildSbom(input: {
  pkgName: string
  version: string
  commit: string
  commitDate: string
  files: readonly ScanFile[]
  workspacePackages: readonly string[]
  depLicenses: readonly DepLicense[]
}): {
  spdxVersion: string
  dataLicense: string
  SPDXID: string
  name: string
  documentNamespace: string
  creationInfo: { created: string; creators: string[] }
  packages: Array<Record<string, unknown>>
} {
  const created = new Date().toISOString()
  const documentNamespace = `https://github.com/xingye12/dsh-evolve-le/spdx/${input.version}/${input.commit}`
  const packages: Array<Record<string, unknown>> = [
    {
      name: input.pkgName,
      SPDXID: 'SPDXRef-Package-Root',
      versionInfo: input.version,
      downloadLocation: 'git+https://github.com/xingye12/dsh-evolve-le.git',
      filesAnalyzed: false,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      copyrightText: 'NOASSERTION',
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: `pkg:github/xingye12/dsh-evolve-le@${input.commit}`,
        },
      ],
    },
    ...input.workspacePackages.map((dir) => ({
      name: dir,
      SPDXID: `SPDXRef-Package-${dir.replace(/[^A-Za-z0-9]/g, '-')}`,
      versionInfo: input.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      copyrightText: 'NOASSERTION',
    })),
    ...input.depLicenses.map((dep, index) => ({
      name: dep.name,
      SPDXID: `SPDXRef-Package-Dep-${String(index).padStart(4, '0')}`,
      versionInfo: dep.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: dep.license ?? 'NOASSERTION',
      licenseDeclared: dep.license ?? 'NOASSERTION',
      copyrightText: 'NOASSERTION',
    })),
  ]
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${input.pkgName}-${input.version}`,
    documentNamespace,
    creationInfo: { created, creators: ['Tool: dsh-evolve-le-make-release'] },
    packages,
  }
}

await main()
