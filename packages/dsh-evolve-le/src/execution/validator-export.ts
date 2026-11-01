/** Static external verification only: never import or execute exported candidate code. */
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { canonicalJson, sha256Hex } from '../state/canonical.js'
import { validateRef, type ObjectRef, type ObjectStore } from '../state/object-store.js'
import {
  buildCanonicalTar,
  candidateIdFromDigest,
  type CanonicalSource,
  type CanonicalFile,
} from '../candidate/canonical.js'
import { validateManifest } from '../schema.js'
import { STAGE_ORDER, type BuildResult } from '../builder/pipeline.js'
import { capsuleRunnerFiles, ACP_ENTRYPOINT, bootConfig } from '../builder/capsule.js'
import { generatedTsConfig } from '../builder/compile.js'
import { NODE_RUNTIME_BINARY_SHA256 } from '../builder/pinned-runtime.js'
import { nativeDshClosurePresent } from '../dsh/native-composition.js'
import { captureBoundedTree, readCapturedTree } from './snapshot.js'
import { readCapabilityFile } from './files.js'
import { assertExact, ExecutionError } from './types.js'
export interface ValidatorExport {
  protocol: 'dsh-evolve-le/validator-export/v1'
  executionId: string
  sourceDigest: string
  candidateId: string
  status: 'ARTIFACTS_VERIFIED'
  diagnostic: ObjectRef
  buildManifest: ObjectRef
  capsuleInventory: ObjectRef
  capsuleTar: ObjectRef
  capsuleArchive: ObjectRef
  bundleTar: ObjectRef
}
function treeDigest(files: readonly CanonicalFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    hash.update(
      `${file.path}\0file\0${file.mode & 0o111 ? '1' : '0'}\0${sha256Hex(file.content)}\n`,
    )
  return hash.digest('hex')
}
function same(actual: unknown, expected: unknown, context: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new ExecutionError(`validator export ${context} mismatch`)
}
export async function verifyValidatorExport(options: {
  /** The caller must prove the process domain empty before invoking export. */
  executionId: string
  workspaceRoot: string
  workRoot: string
  source: CanonicalSource
  dependencyClosureSha256: string
  runnerSourceDir: string
  store: ObjectStore
  limits: { bytes: number; inodes: number; fileBytes: number; diagnosticBytes: number }
}): Promise<{ receipt: ObjectRef; value: ValidatorExport; artifacts: ObjectRef[] }> {
  const { store } = options
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(options.executionId) ||
    !/^[a-f0-9]{64}$/.test(options.dependencyClosureSha256)
  )
    throw new ExecutionError('invalid validator export identity')
  const diagnosticBytes = await readCapabilityFile(
    options.workRoot,
    'validator-result.json',
    options.limits.diagnosticBytes,
  )
  const diagnostic: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(diagnosticBytes),
  )
  assertExact(diagnostic, ['protocol', 'sourceDigest', 'result'])
  const sourceDigest = `sha256:${options.source.sha256}`,
    candidateId = candidateIdFromDigest(options.source.sha256)
  same(diagnostic.protocol, 'dsh-evolve-le/validator-result/v1', 'protocol')
  same(diagnostic.sourceDigest, sourceDigest, 'source')
  if (sha256Hex(buildCanonicalTar(options.source.files)) !== options.source.sha256)
    throw new ExecutionError('trusted validator source is inconsistent')
  const result = diagnostic.result as BuildResult
  if (!result || result.outcome !== 'admitted' || result.rejection !== undefined)
    throw new ExecutionError('validator did not report complete admission stages')
  same(result.sourceDigest, sourceDigest, 'result source')
  same(result.candidateId, candidateId, 'candidate id')
  const manifestBytes = await readCapabilityFile(
    options.workspaceRoot,
    'build/build-manifest.json',
    options.limits.diagnosticBytes,
  )
  const manifest: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
  )
  const checked = validateManifest('build', manifest)
  if (!checked.ok) throw new ExecutionError('invalid validator build manifest')
  same(result.manifest, manifest, 'build manifest')
  same(result.receipts, checked.value.receipts, 'stage receipts')
  for (const stage of STAGE_ORDER)
    if (result.receipts?.[stage]?.status !== 'pass')
      throw new ExecutionError(`validator stage incomplete: ${stage}`)
  same(checked.value.candidateId, candidateId, 'manifest candidate')
  same(
    (checked.value.identity as { sourceDigest: string }).sourceDigest,
    sourceDigest,
    'manifest source',
  )
  same(checked.value.outcome, 'admitted', 'manifest outcome')
  same(
    (checked.value.fingerprints as { dependencyClosureSha256: string }).dependencyClosureSha256,
    options.dependencyClosureSha256,
    'manifest dependency closure',
  )
  same(
    (checked.value.fingerprints as { tsconfigSha256: string }).tsconfigSha256,
    sha256Hex(Buffer.from(JSON.stringify(generatedTsConfig(), null, 2) + '\n')),
    'generated compiler config',
  )
  same(checked.value.bundle, result.bundle, 'bundle report')
  same(checked.value.capsule, result.capsule, 'capsule report')
  const tree = await captureBoundedTree({
    root: join(options.workspaceRoot, 'build/capsule'),
    store,
    limits: options.limits,
  })
  const files: CanonicalFile[] = []
  for (const file of tree.files)
    files.push({ path: file.path, mode: file.mode, content: await store.read(file.content) })
  const index = new Map(files.map((f) => [f.path, f])),
    get = (path: string): CanonicalFile => {
      const file = index.get(path)
      if (!file) throw new ExecutionError(`validator capsule missing ${path}`)
      return file
    },
    subtree = (prefix: string) =>
      files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
  const fixed = new Set([
    'manifest.json',
    'provenance.json',
    'sbom.spdx.json',
    'SHA256SUMS',
    'cordis.yml',
    'dsh-evolve-le-acp',
    'runtime/node',
    'runtime/install-manifest.json',
    'runtime/system-prompt-stub.mjs',
    'runtime/candidate-workflow-stub.mjs',
  ])
  for (const file of files)
    if (
      !fixed.has(file.path) &&
      !['candidate/', 'node_modules/', 'runner/'].some((p) => file.path.startsWith(p))
    )
      throw new ExecutionError('unexpected capsule payload path')
  if (get('runtime/node').mode !== 0o755 || get('dsh-evolve-le-acp').mode !== 0o755)
    throw new ExecutionError('capsule executable mode mismatch')
  const capsuleManifest: unknown = JSON.parse(get('manifest.json').content.toString('utf8'))
  const capsuleCheck = validateManifest('capsule', capsuleManifest)
  if (!capsuleCheck.ok) throw new ExecutionError('invalid exported capsule manifest')
  const cm = capsuleCheck.value
  same(cm.identity, { candidateId, sourceDigest }, 'capsule identity')
  const tar = buildCanonicalTar(files),
    tarBytes = await readCapabilityFile(
      options.workspaceRoot,
      'build/capsule.tar',
      options.limits.bytes,
    ),
    archiveBytes = await readCapabilityFile(
      options.workspaceRoot,
      'build/capsule.tar.gz',
      options.limits.bytes,
    )
  same(sha256Hex(tar), sha256Hex(tarBytes), 'canonical capsule tar')
  same(sha256Hex(gzipSync(tar, { level: 6 })), sha256Hex(archiveBytes), 'capsule archive')
  same(sha256Hex(tarBytes), result.capsule?.tarSha256, 'capsule tar hash')
  same(sha256Hex(archiveBytes), result.capsule?.archiveSha256, 'capsule archive hash')
  same(sha256Hex(get('sbom.spdx.json').content), result.capsule?.sbomSha256, 'SBOM')
  same(sha256Hex(get('provenance.json').content), result.capsule?.provenanceSha256, 'provenance')
  const covered = files.filter(
      (f) => !['SHA256SUMS', 'manifest.json', 'provenance.json'].includes(f.path),
    ),
    sums = covered.map((f) => `${sha256Hex(f.content)}  ${f.path}`).join('\n') + '\n'
  same(get('SHA256SUMS').content.toString('utf8'), sums, 'payload checksums')
  const sumsDigest = sha256Hex(Buffer.from(sums))
  same(
    cm.contents,
    {
      fileCount: covered.length,
      bytes: covered.reduce((n, f) => n + f.content.length, 0),
      sha256SumsDigest: sumsDigest,
    },
    'payload inventory',
  )
  same((cm.sbom as { sha256: string }).sha256, result.capsule?.sbomSha256, 'manifest SBOM')
  same(sha256Hex(get('runtime/node').content), NODE_RUNTIME_BINARY_SHA256, 'pinned Node runtime')
  const runner = subtree('runner/'),
    expectedRunner = await capsuleRunnerFiles(options.runnerSourceDir)
  same(treeDigest(runner), treeDigest(expectedRunner), 'trusted runner')
  same((cm.runner as { digest: string }).digest, treeDigest(expectedRunner), 'runner manifest')
  const bundleFiles = subtree('candidate/'),
    bundleTar = buildCanonicalTar(bundleFiles)
  same(sha256Hex(bundleTar), result.bundle?.tarSha256, 'bundle hash')
  same(sha256Hex(get('candidate/lib/index.js').content), result.bundle?.entrySha256, 'bundle entry')
  same(bundleFiles.length, result.bundle?.fileCount, 'bundle file count')
  same(
    bundleFiles.reduce((n, f) => n + f.content.length, 0),
    result.bundle?.bytes,
    'bundle bytes',
  )
  same((cm.candidate as { digest: string }).digest, sha256Hex(bundleTar), 'capsule candidate')
  for (const name of ['package.json', 'candidate.json', 'cordis.patch.yml']) {
    const source = options.source.files.find((f) => f.path === name)
    if (!source || !get(`candidate/${name}`).content.equals(source.content))
      throw new ExecutionError('validator metadata differs from frozen source')
  }
  const pkg = JSON.parse(get('candidate/package.json').content.toString('utf8')) as { name: string }
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name) || ['.', '..'].includes(pkg.name))
    throw new ExecutionError('invalid exported candidate package name')
  const installed = subtree(`node_modules/${pkg.name}/`)
  same(treeDigest(installed), treeDigest(bundleFiles), 'installed candidate')
  const dependencies = subtree('node_modules/').filter((f) => !f.path.startsWith(pkg.name + '/'))
  same(treeDigest(dependencies), options.dependencyClosureSha256, 'frozen dependency closure')
  const installBytes = get('runtime/install-manifest.json').content,
    install = JSON.parse(installBytes.toString('utf8')) as {
      packages: Array<{ name: string; version: string; digest: string }>
    }
  if (!Array.isArray(install.packages) || install.packages.length > 160)
    throw new ExecutionError('invalid exported install manifest')
  const names = new Set<string>()
  for (const entry of install.packages) {
    if (!entry || typeof entry.name !== 'string' || names.has(entry.name))
      throw new ExecutionError('invalid install package')
    names.add(entry.name)
    const packageFiles = subtree(`node_modules/${entry.name}/`)
    if (!packageFiles.length) throw new ExecutionError('missing installed package')
    same(treeDigest(packageFiles), entry.digest, 'install package digest')
    const manifest = JSON.parse(
      get(`node_modules/${entry.name}/package.json`).content.toString('utf8'),
    ) as { name: string; version: string }
    same(manifest.name, entry.name, 'install package name')
    same(manifest.version, entry.version, 'install package version')
  }
  for (const f of subtree('node_modules/')) {
    const parts = f.path.split('/'),
      name = parts[0]!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
    if (!names.has(name)) throw new ExecutionError('unlisted installed package')
  }
  same((cm.runtime as { digest: string }).digest, sha256Hex(installBytes), 'runtime manifest')
  const provenance = JSON.parse(get('provenance.json').content.toString('utf8')) as Record<
    string,
    unknown
  >
  same(provenance.identity, { candidateId, sourceDigest }, 'provenance identity')
  same(provenance.bundleTarSha256, sha256Hex(bundleTar), 'provenance bundle')
  same(provenance.sha256SumsDigest, sumsDigest, 'provenance checksums')
  same(get('dsh-evolve-le-acp').content.toString('utf8'), ACP_ENTRYPOINT, 'ACP entrypoint')
  same(
    get('cordis.yml').content.toString('utf8'),
    bootConfig(
      pkg.name,
      candidateId,
      'solve',
      nativeDshClosurePresent(install.packages) ? {} : undefined,
    ),
    'composition',
  )
  for (const [target, source] of [
    ['system-prompt-stub.mjs', 'system-prompt-stub.js'],
    ['candidate-workflow-stub.mjs', 'candidate-workflow-stub.js'],
  ])
    same(
      sha256Hex(get(`runtime/${target}`).content),
      sha256Hex(await readFile(join(options.runnerSourceDir, 'probe', source!))),
      'trusted runtime stub',
    )
  const put = (bytes: Buffer, mediaType: string) =>
    store.put(bytes, { mediaType, label: 'CONTROLLER_INTERNAL' })
  const value: ValidatorExport = {
    protocol: 'dsh-evolve-le/validator-export/v1',
    executionId: options.executionId,
    sourceDigest,
    candidateId,
    status: 'ARTIFACTS_VERIFIED',
    diagnostic: await put(diagnosticBytes, 'application/json'),
    buildManifest: await put(manifestBytes, 'application/json'),
    capsuleInventory: await put(
      Buffer.from(canonicalJson(tree)),
      'application/vnd.dsh-evolve-le.artifact-inventory+json',
    ),
    capsuleTar: await put(tarBytes, 'application/x-tar'),
    capsuleArchive: await put(archiveBytes, 'application/gzip'),
    bundleTar: await put(bundleTar, 'application/x-tar'),
  }
  const receipt = await put(
    Buffer.from(canonicalJson(value)),
    'application/vnd.dsh-evolve-le.validator-export+json',
  )
  const artifacts = [
    receipt,
    ...tree.files.map((f) => f.content),
    value.diagnostic,
    value.buildManifest,
    value.capsuleInventory,
    value.capsuleTar,
    value.capsuleArchive,
    value.bundleTar,
  ]
  await store.scrub(artifacts)
  return { receipt, value, artifacts }
}

/** Reopen only with caller-supplied identity; this receipt is not Archive admission. */
export async function readValidatorExport(
  store: ObjectStore,
  receipt: ObjectRef,
  expected: {
    executionId: string
    sourceDigest: string
  },
): Promise<ValidatorExport> {
  const value = JSON.parse((await store.read(receipt)).toString('utf8')) as unknown
  assertExact(value, [
    'protocol',
    'executionId',
    'sourceDigest',
    'candidateId',
    'status',
    'diagnostic',
    'buildManifest',
    'capsuleInventory',
    'capsuleTar',
    'capsuleArchive',
    'bundleTar',
  ])
  if (
    value.protocol !== 'dsh-evolve-le/validator-export/v1' ||
    value.status !== 'ARTIFACTS_VERIFIED' ||
    value.executionId !== expected.executionId ||
    value.sourceDigest !== expected.sourceDigest ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.sourceDigest) ||
    value.candidateId !== candidateIdFromDigest(expected.sourceDigest.slice(7))
  )
    throw new ExecutionError('validator export receipt binding mismatch')
  for (const key of [
    'diagnostic',
    'buildManifest',
    'capsuleInventory',
    'capsuleTar',
    'capsuleArchive',
    'bundleTar',
  ]) {
    validateRef(value[key])
    if (value[key].label !== 'CONTROLLER_INTERNAL')
      throw new ExecutionError('invalid validator export artifact label')
    await store.verify(value[key])
  }
  const result = value as unknown as ValidatorExport
  const inventory = await readCapturedTree(store, result.capsuleInventory)
  const files: CanonicalFile[] = []
  for (const file of inventory.files)
    files.push({ path: file.path, mode: file.mode, content: await store.read(file.content) })
  const tar = buildCanonicalTar(files)
  same(sha256Hex(tar), result.capsuleTar.digest, 'persisted capsule tar')
  same(
    sha256Hex(gzipSync(tar, { level: 6 })),
    result.capsuleArchive.digest,
    'persisted capsule archive',
  )
  const bundle = files
    .filter((f) => f.path.startsWith('candidate/'))
    .map((f) => ({ ...f, path: f.path.slice(10) }))
  same(sha256Hex(buildCanonicalTar(bundle)), result.bundleTar.digest, 'persisted candidate bundle')
  const build: unknown = JSON.parse((await store.read(result.buildManifest)).toString('utf8'))
  const checked = validateManifest('build', build)
  if (!checked.ok) throw new ExecutionError('invalid persisted build manifest')
  same(checked.value.candidateId, result.candidateId, 'persisted candidate id')
  same(
    (checked.value.identity as { sourceDigest: string }).sourceDigest,
    result.sourceDigest,
    'persisted source',
  )
  same(
    (checked.value.capsule as { tarSha256: string }).tarSha256,
    result.capsuleTar.digest,
    'persisted capsule manifest',
  )
  same(
    (checked.value.bundle as { tarSha256: string }).tarSha256,
    result.bundleTar.digest,
    'persisted bundle manifest',
  )
  if (checked.value.outcome !== 'admitted')
    throw new ExecutionError('persisted build is not complete')
  for (const stage of STAGE_ORDER)
    if ((checked.value.receipts as BuildResult['receipts'])[stage]?.status !== 'pass')
      throw new ExecutionError('persisted validator stage missing')
  return result
}
