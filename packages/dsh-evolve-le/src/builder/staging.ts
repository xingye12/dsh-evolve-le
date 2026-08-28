/**
 * Builder staging (specs/02 §11 ¶“Pipeline 入口必须只冻结一次候选输入”):
 * the proposer's declared package entries are copied once into a builder-
 * owned staging area, captured to canonical form from there, and every later
 * stage — schema, scan, compile, tests, capsule — consumes only the frozen
 * staging tree, never the proposer's working directory. The offline dependency
 * closure is assembled from TCB pins, not from any proposer-controlled file.
 * @module @dsh-evolve-le/core/builder/staging
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  captureCanonicalSource,
  type CanonicalFile,
  type CanonicalSource,
} from '../candidate/canonical.js'
import { computeTreeDigest } from '../digest.js'
import { repoRoot } from '../schema.js'
import { PACKAGE_PINS } from './pins.js'

/**
 * Entries a proposer may declare as candidate source. Everything else in the
 * working directory (lib/, node_modules/, logs) is structurally excluded —
 * capture cannot even see it.
 */
export const DECLARED_SOURCE_ENTRIES = [
  'package.json',
  'candidate.json',
  'cordis.patch.yml',
  'tsconfig.json', // identity material only; the compiler never consumes it
  'src',
  'tests',
] as const

/** Copy the declared entries from the proposer directory into the staging source slot. */
export async function stageDeclaredSource(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  const present = new Set(await readdir(sourceDir))
  for (const entry of DECLARED_SOURCE_ENTRIES) {
    if (!present.has(entry)) continue
    const from = join(sourceDir, entry)
    const stats = await lstat(from)
    if (stats.isSymbolicLink()) {
      throw new Error(`declared source entry ${entry} is a symbolic link; refusing to stage`)
    }
    if (stats.isDirectory()) {
      await cp(from, join(targetDir, entry), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      })
    } else {
      await cp(from, join(targetDir, entry))
    }
  }
}

/** Capture the canonical source from the staging copy and freeze it read-only. */
export async function captureStagedSource(
  stagedSourceDir: string,
  treeDir: string,
): Promise<CanonicalSource> {
  const source = await captureCanonicalSource(stagedSourceDir)
  await materializeTree(source.files, treeDir)
  return source
}

/** Write canonical files into `targetDir`; file bytes are read-only (0444/0555). */
export async function materializeTree(files: CanonicalFile[], targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true })
  // The root must exist even when every file sits at the top level (a tree
  // with no subdirectories would otherwise fail to write its first file).
  await mkdir(targetDir, { recursive: true })
  const dirs = new Set<string>()
  for (const file of files) {
    const at = file.path.lastIndexOf('/')
    if (at > 0) dirs.add(file.path.slice(0, at))
  }
  // Directories stay writable so the builder can assemble the dependency
  // closure next to the frozen files; the canonical file bytes do not.
  for (const dir of [...dirs].sort()) {
    await mkdir(join(targetDir, dir), { recursive: true })
  }
  for (const file of files) {
    const readOnly = (file.mode & 0o111) !== 0 ? 0o555 : 0o444
    await writeFile(join(targetDir, file.path), file.content, { mode: readOnly })
  }
}

/**
 * Assemble the flat offline dependency closure at `<targetDir>/node_modules`
 * from the TCB pins, following runtime `dependencies` transitively: the
 * closure must actually satisfy every import the capsule runner can hit, or
 * boots fail closed. Root pins are verified against the pinned versions;
 * transitive packages are recorded at their resolved versions. Nested
 * node_modules directories inside packages are skipped (flat layout).
 */
export async function assembleOfflineNodeModules(
  targetDir: string,
): Promise<{ digest: string; fileCount: number; packages: { name: string; version: string }[] }> {
  const root = join(targetDir, 'node_modules')
  await rm(root, { recursive: true, force: true })
  const packages: { name: string; version: string }[] = []
  const assembled = new Set<string>()
  interface WorkItem {
    name: string
    expectedVersion?: string
    fromDir: string
  }
  const worklist: WorkItem[] = PACKAGE_PINS.map((pin) => ({
    name: pin.name,
    expectedVersion: pin.version,
    fromDir: join(repoRoot, pin.resolveFrom),
  }))

  while (worklist.length > 0) {
    const item = worklist.shift()!
    if (assembled.has(item.name)) continue
    if (packages.length > 80) {
      throw new Error(
        `dependency closure exceeds 80 packages at ${item.name}; refusing to assemble`,
      )
    }
    const pinDir = await resolvePackageDirectory(item.fromDir, item.name)
    const manifest = JSON.parse(await readFile(join(pinDir, 'package.json'), 'utf8')) as {
      name?: string
      version?: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    if (manifest.name !== item.name) {
      throw new Error(`closure drift for ${item.name}: resolved ${manifest.name}`)
    }
    if (item.expectedVersion !== undefined && manifest.version !== item.expectedVersion) {
      throw new Error(
        `pin drift for ${item.name}: resolved ${manifest.version}, pinned ${item.expectedVersion}`,
      )
    }
    assembled.add(item.name)
    await copyPackageFlat(pinDir, join(root, ...item.name.split('/')))
    packages.push({ name: item.name, version: manifest.version ?? '?' })
    // Runtime dependencies, plus non-optional peers (pnpm auto-installs them
    // and code imports them unconditionally — the ACP SDK's zod, for one).
    // Optional peers are skipped; if code did import one, the capsule boot
    // fails closed rather than shipping a broken closure.
    const required = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.entries(manifest.peerDependencies ?? {})
        .filter(([name, _range]) => manifest.peerDependenciesMeta?.[name]?.optional !== true)
        .map(([name, _range]) => name),
    ])
    for (const depName of required) {
      if (!assembled.has(depName)) {
        worklist.push({ name: depName, fromDir: pinDir })
      }
    }
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : 1))
  const { digest, fileCount } = await computeTreeDigest(root)
  return { digest, fileCount, packages }
}

/**
 * Resolve the on-disk root directory of `name` as seen from `fromDir`, using
 * Node's own resolution (so pnpm's per-dependent links pick the version the
 * dependent actually declares). Packages whose `exports` map does not expose
 * `./package.json` are located by resolving their entry and walking up to the
 * package root; the manifest name is verified either way.
 */
async function resolvePackageDirectory(fromDir: string, name: string): Promise<string> {
  const require = createRequire(join(fromDir, 'package.json'))
  try {
    return dirname(require.resolve(`${name}/package.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
  let dir = dirname(require.resolve(name))
  for (;;) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
      if (manifest.name === name) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`could not locate package root for ${name} from ${fromDir}`)
}

/** Copy a package directory flat, skipping symlinks and nested node_modules. */
async function copyPackageFlat(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const from = join(source, entry.name)
    if (entry.isDirectory()) {
      await copyPackageFlat(from, join(dest, entry.name))
    } else if (entry.isFile()) {
      await cp(from, join(dest, entry.name), { verbatimSymlinks: true })
    }
    // Symlinks inside pinned packages are skipped deliberately: their
    // relative targets only hold inside the pnpm store layout, and none of
    // the pinned packages need them at runtime.
  }
}
