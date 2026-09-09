/**
 * Candidate policy scanner (specs/02 §8–9, §11 step 4): AST-based import and
 * dependency enforcement over an already-captured canonical source. Every
 * finding is a rejection — there are no warnings, because admission is a
 * safety gate, not a score. The scanner reads the frozen canonical bytes; it
 * never touches the proposer's working tree. This reduces attack surface; it
 * is not a proof of benign intent — secrets and the verifier stay outside the
 * candidate process regardless (specs/02 §8, §13).
 * @module @dsh-evolve-le/core/candidate/scan
 */

import { parseSync } from 'oxc-parser'
import yaml from 'js-yaml'
import type { CanonicalSource } from './canonical.js'

/** Credential shapes that must never appear in candidate source. */
const SECRET_PATTERNS: { rule: string; pattern: RegExp }[] = [
  { rule: 'secret/openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { rule: 'secret/github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { rule: 'secret/aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'secret/private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'secret/bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]{32,}/ },
]

/** Lifecycle scripts a candidate bundle must not rely on. */
const FORBIDDEN_SCRIPT_KEYS = [
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
] as const

/** Timer/microtask globals that would escape candidate Fiber ownership. */
const LEAKY_GLOBALS = new Set(['setInterval', 'setTimeout', 'setImmediate', 'queueMicrotask'])

/** Fields invented by earlier proposer outputs but absent from the v2 contract. */
const UNAVAILABLE_SOLVE_POLICY_FIELDS = new Set([
  'artifactChanged',
  'artifactExecuted',
  'artifactWritten',
  'consecutiveFailures',
  'deliverableReady',
  'finishing',
  'lastCommand',
  'lastOutputSeen',
  'outputSeen',
  'repeatedProbe',
  'repeats',
  'verificationPending',
])

/** Node builtin module names (importable without the `node:` prefix). */
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'test',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
])

/** One policy violation. All violations reject. */
export interface ScanFinding {
  rule: string
  path: string
  line: number
  detail: string
}

/** TCB-provided policy; the proposer cannot influence any field. */
export interface ScanPolicy {
  /** Exact `name -> version` allowlist for package.json dependencies. */
  allowedPackages: Record<string, string>
  /** Bare specifiers candidate code may import (beyond relative paths). */
  importAllowlist: string[]
  /** Extra bare specifiers allowed only inside candidate-owned test files. */
  testImportAllowlist: string[]
  /** `node:` builtins candidates may import; default-empty (specs/02 §8). */
  allowedNodeBuiltins: string[]
  /** Registered benchmark task identifiers treated as fingerprints. */
  taskFingerprints: string[]
  /** Path fragments tied to the benchmark's verifier/test layout. */
  verifierPathFragments: string[]
}

/** Policy used by tests and the Gate 1 builder (TCB-owned constants). */
export function defaultScanPolicy(overrides?: Partial<ScanPolicy>): ScanPolicy {
  return {
    allowedPackages: {
      '@deepseek-ai/cordis': '4.0.1',
      '@deepseek-ai/schemastery': '3.18.1',
      '@dsh-evolve-le/candidate-sdk': '0.0.1',
    },
    importAllowlist: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@dsh-evolve-le/candidate-sdk',
    ],
    testImportAllowlist: ['vitest', '@dsh-evolve-le/candidate-sdk/testkit'],
    allowedNodeBuiltins: [],
    taskFingerprints: ['extract-elf'],
    verifierPathFragments: ['test_outputs.py', 'tests/test_outputs', '/solution/', 'task.yaml'],
    ...overrides,
  }
}

export interface ScanReport {
  clean: boolean
  findings: ScanFinding[]
}

type AddFinding = (rule: string, path: string, line: number, detail: string) => void

/** Node-reference shape used by the generic AST walk. */
type AstNode = { type?: string; [key: string]: unknown }

function offsetToLine(source: string, offset: unknown): number {
  if (typeof offset !== 'number') return 1
  let line = 1
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * Scan a captured canonical source against a policy. Structural files
 * (package.json, cordis.patch.yml) are validated for shape; every `.ts`/`.js`
 * module is parsed with oxc-parser and walked for import/eval/leak rules; all
 * files are additionally byte-scanned for task fingerprints, verifier path
 * fragments, credential shapes and native binaries.
 */
export function scanCanonicalSource(source: CanonicalSource, policy: ScanPolicy): ScanReport {
  const findings: ScanFinding[] = []
  const add: AddFinding = (rule, path, line, detail) => {
    findings.push({ rule, path, line, detail })
  }
  const paths = new Set(source.files.map((file) => file.path))

  const manifest = source.files.find((file) => file.path === 'package.json')
  if (manifest === undefined) {
    add('package/missing', '<root>', 0, 'candidate source must contain package.json')
  } else {
    scanPackageJson(manifest.content.toString('utf8'), manifest.path, policy, add)
  }

  const patch = source.files.find((file) => file.path === 'cordis.patch.yml')
  if (patch === undefined) {
    add('patch/missing', '<root>', 0, 'candidate source must contain cordis.patch.yml')
  } else {
    scanPatchYml(patch.content.toString('utf8'), patch.path, add)
  }

  if (!paths.has('candidate.json')) {
    add('manifest/missing', '<root>', 0, 'candidate source must contain candidate.json')
  }
  if (!paths.has('src/index.ts')) {
    add('entry/missing', 'src/index.ts', 0, 'candidate entry must be src/index.ts')
  }

  for (const file of source.files) {
    if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(file.path)) {
      scanModule(file.path, file.content.toString('utf8'), policy, paths, add)
    }
  }
  for (const file of source.files) {
    scanRawBytes(file.path, file.content, policy, add)
  }

  return { clean: findings.length === 0, findings }
}

function scanPackageJson(text: string, path: string, policy: ScanPolicy, add: AddFinding): void {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    add('package/unparseable', path, 1, 'package.json is not valid JSON')
    return
  }
  const scripts = (parsed.scripts ?? {}) as Record<string, unknown>
  for (const key of FORBIDDEN_SCRIPT_KEYS) {
    if (typeof scripts[key] === 'string' && scripts[key] !== '') {
      add('package/lifecycle-script', path, 1, `forbidden lifecycle script "${key}"`)
    }
  }
  if (parsed.bin !== undefined) {
    add('package/bin', path, 1, 'candidate bundles must not declare bin entries')
  }
  const dsh = parsed.dsh as Record<string, unknown> | undefined
  if (dsh === undefined || typeof dsh !== 'object' || dsh.bundle === undefined) {
    add(
      'package/not-bundle',
      path,
      1,
      'package.json must declare dsh.bundle (candidates are bundles, never profiles)',
    )
  } else {
    const bundle = dsh.bundle as Record<string, unknown>
    if (bundle.patch !== './cordis.patch.yml') {
      add('package/bundle-patch', path, 1, 'dsh.bundle.patch must be ./cordis.patch.yml')
    }
    if (bundle.profile !== undefined) {
      add('package/profile', path, 1, 'candidates must not declare dsh.profile')
    }
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = parsed[field] as Record<string, string> | undefined
    if (deps === undefined) continue
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string') {
        add('dependency/invalid', path, 1, `${name} in ${field} has a non-string range`)
        continue
      }
      // Reject every non-exact form: semver ranges, tags, git/file/http specs
      // and npm: aliases. Only bare `x.y.z` survives.
      if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(range)) {
        add('dependency/not-exact', path, 1, `${name}: "${range}" is not an exact pinned version`)
        continue
      }
      const allowed = policy.allowedPackages[name]
      if (allowed === undefined) {
        add('dependency/not-allowed', path, 1, `${name} is not in the run allowlist`)
      } else if (allowed !== range) {
        add(
          'dependency/version-mismatch',
          path,
          1,
          `${name}: pinned ${range}, allowlist ${allowed}`,
        )
      }
    }
  }
}

function scanPatchYml(text: string, path: string, add: AddFinding): void {
  let parsed: unknown
  try {
    parsed = yaml.load(text)
  } catch {
    add('patch/unparseable', path, 1, 'cordis.patch.yml is not valid YAML')
    return
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    add('patch/shape', path, 1, 'cordis.patch.yml must be exactly one insert patch entry')
    return
  }
  const entry = parsed[0] as Record<string, unknown>
  const keys = Object.keys(entry)
  if (keys.length !== 1 || keys[0] !== 'insert') {
    add(
      'patch/not-insert',
      path,
      1,
      `cordis.patch.yml must only insert (got keys: ${keys.join(',')})`,
    )
    return
  }
  const rows = entry.insert
  if (!Array.isArray(rows) || rows.length !== 1) {
    add('patch/rows', path, 1, 'cordis.patch.yml must insert exactly one row')
    return
  }
  const row = rows[0] as Record<string, unknown>
  if (row.id !== 'self-evolving-candidate') {
    add(
      'patch/row-id',
      path,
      1,
      `candidate row id must be self-evolving-candidate (got ${String(row.id)})`,
    )
  }
  if (typeof row.name !== 'string' || row.name.length === 0) {
    add('patch/row-name', path, 1, 'candidate row must declare a package name')
  }
}

/** Resolve a relative specifier against the importing file's directory. */
function resolveRelative(
  fromPath: string,
  specifier: string,
): { traversal: boolean; resolved: string } {
  const parts = fromPath.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') {
      if (parts.length === 0) return { traversal: true, resolved: '' }
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return { traversal: false, resolved: parts.join('/') }
}

function scanModule(
  path: string,
  text: string,
  policy: ScanPolicy,
  paths: Set<string>,
  add: AddFinding,
): void {
  let program: AstNode
  try {
    program = parseSync(path, text, { lang: 'ts', sourceType: 'module' })
      .program as unknown as AstNode
  } catch (error) {
    add('module/unparseable', path, 1, error instanceof Error ? error.message : String(error))
    return
  }

  // Candidate-owned tests (tests/**) may additionally import the test runner
  // and the SDK testkit; production modules under src/** may not.
  const extraImports = path.startsWith('tests/') ? policy.testImportAllowlist : []

  const checkSpecifier = (specifier: string, node: AstNode, ruleBase: string): void => {
    const line = offsetToLine(text, node.start)
    if (specifier.startsWith('.')) {
      const { traversal, resolved } = resolveRelative(path, specifier)
      if (traversal) {
        add(
          `${ruleBase}/traversal`,
          path,
          line,
          `relative import escapes the candidate root: ${specifier}`,
        )
        return
      }
      const candidates = [
        resolved,
        `${resolved}.ts`,
        `${resolved}.tsx`,
        `${resolved}.js`,
        `${resolved}/index.ts`,
        `${resolved}/index.js`,
      ]
      // TS ESM convention: `./x.js` in source resolves to `x.ts` on disk.
      if (resolved.endsWith('.js')) {
        const stem = resolved.slice(0, -3)
        candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`)
      }
      if (!candidates.some((candidate) => paths.has(candidate))) {
        add(
          `${ruleBase}/unresolved`,
          path,
          line,
          `relative import not present in canonical tree: ${specifier}`,
        )
      }
      return
    }
    if (
      specifier.startsWith('node:') ||
      NODE_BUILTINS.has(specifier) ||
      /^[a-z][a-z0-9+.-]*:/.test(specifier)
    ) {
      const builtin = specifier.replace(/^node:/, '')
      if (!policy.allowedNodeBuiltins.includes(builtin)) {
        add('import/node-builtin', path, line, `node/builtin import not allowed: ${specifier}`)
      }
      return
    }
    if (!policy.importAllowlist.includes(specifier) && !extraImports.includes(specifier)) {
      add('import/not-allowed', path, line, `bare import not in allowlist: ${specifier}`)
    }
  }

  const scanLiteral = (value: string, line: number): void => {
    scanText(value, path, line, policy, add)
  }

  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const current = node as AstNode
    switch (current.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const sourceNode = current.source as AstNode | null | undefined
        if (sourceNode != null && typeof sourceNode.value === 'string') {
          checkSpecifier(sourceNode.value, sourceNode, 'import')
        }
        break
      }
      case 'ImportExpression': {
        const sourceNode = current.source as AstNode | undefined
        add(
          'import/dynamic',
          path,
          offsetToLine(text, current.start),
          'dynamic import() is forbidden',
        )
        if (sourceNode != null && typeof sourceNode.value === 'string') {
          checkSpecifier(sourceNode.value, sourceNode, 'import')
        }
        break
      }
      case 'ExportDefaultDeclaration': {
        add(
          'export/default',
          path,
          offsetToLine(text, current.start),
          'default export breaks Loader unwrap of named plugin metadata (postmortem 0001)',
        )
        break
      }
      case 'CallExpression': {
        const callee = current.callee as AstNode | undefined
        if (callee?.type === 'Identifier') {
          if (callee.name === 'require') {
            add(
              'import/require',
              path,
              offsetToLine(text, current.start),
              'require() is forbidden in candidate code',
            )
          } else if (callee.name === 'eval') {
            add('dangerous/eval', path, offsetToLine(text, current.start), 'eval() is forbidden')
          } else if (LEAKY_GLOBALS.has(String(callee.name))) {
            add(
              'leak/timer',
              path,
              offsetToLine(text, current.start),
              `bare ${callee.name}() escapes candidate Fiber ownership; use ctx timers/effects`,
            )
          } else if (callee.name === 'process') {
            add(
              'dangerous/process',
              path,
              offsetToLine(text, current.start),
              'direct process access is forbidden',
            )
          }
        }
        break
      }
      case 'MemberExpression': {
        const property = current.property as AstNode | undefined
        const object = current.object as AstNode | undefined
        if (property?.type === 'Identifier' && property.name === 'require') {
          add(
            'import/require',
            path,
            offsetToLine(text, current.start),
            'module.require() is forbidden',
          )
        }
        if (object?.type === 'Identifier' && object.name === 'process') {
          add(
            'dangerous/process',
            path,
            offsetToLine(text, current.start),
            'direct process.* access is forbidden; candidates never touch process state',
          )
        }
        if (
          property?.type === 'Identifier' &&
          UNAVAILABLE_SOLVE_POLICY_FIELDS.has(String(property.name))
        ) {
          add(
            'workflow/unavailable-state',
            path,
            offsetToLine(text, current.start),
            `candidate workflow references unavailable runtime field "${String(property.name)}"; use only the documented v2 observation`,
          )
        }
        break
      }
      case 'NewExpression': {
        const callee = current.callee as AstNode | undefined
        if (
          callee?.type === 'Identifier' &&
          (callee.name === 'Function' || callee.name === 'AsyncFunction' || callee.name === 'eval')
        ) {
          add(
            'dangerous/function-constructor',
            path,
            offsetToLine(text, current.start),
            'new Function(...) and friends are forbidden',
          )
        }
        break
      }
      case 'ImportAttribute': {
        const valueNode = current.value as AstNode | undefined
        if (valueNode != null && typeof valueNode.value === 'string') {
          scanLiteral(valueNode.value, offsetToLine(text, valueNode.start))
        }
        break
      }
      default:
        break
    }
    if (current.type === 'Literal' && typeof current.value === 'string') {
      scanLiteral(current.value, offsetToLine(text, current.start))
    }
    if (current.type === 'TemplateElement') {
      const cooked = (current as { value?: { cooked?: unknown } }).value?.cooked
      if (typeof cooked === 'string') scanLiteral(cooked, offsetToLine(text, current.start))
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'range') continue
      walk(value)
    }
  }

  walk(program)
}

/** Byte-level scan applied to every canonical file regardless of extension. */
function scanText(
  text: string,
  path: string,
  line: number,
  policy: ScanPolicy,
  add: AddFinding,
): void {
  for (const task of policy.taskFingerprints) {
    if (text.includes(task)) {
      add(
        'task/fingerprint',
        path,
        line,
        `literal matches registered benchmark task identifier: ${task}`,
      )
    }
  }
  for (const fragment of policy.verifierPathFragments) {
    if (text.includes(fragment)) {
      add(
        'task/verifier-path',
        path,
        line,
        `literal matches benchmark verifier/test path fragment: ${fragment}`,
      )
    }
  }
  for (const secret of SECRET_PATTERNS) {
    if (secret.pattern.test(text)) {
      add(secret.rule, path, line, 'credential-shaped literal in candidate source')
    }
  }
}

function scanRawBytes(path: string, content: Buffer, policy: ScanPolicy, add: AddFinding): void {
  scanText(content.toString('utf8'), path, 1, policy, add)
  if (
    content.length >= 4 &&
    content[0] === 0x7f &&
    content[1] === 0x45 &&
    content[2] === 0x4c &&
    content[3] === 0x46
  ) {
    add('package/native-binary', path, 1, 'ELF binary in candidate source')
  }
  if (
    content.length >= 4 &&
    content[0] === 0x00 &&
    content[1] === 0x61 &&
    content[2] === 0x73 &&
    content[3] === 0x6d
  ) {
    add('package/wasm', path, 1, 'WebAssembly module in candidate source')
  }
}
