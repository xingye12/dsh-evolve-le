/**
 * TCB-owned build pins (specs/02 §11 step 5): every package the builder may
 * place into a staging tree or capsule runtime, at exactly one version each,
 * resolved from the repo's own locked install. Nothing here is proposer-
 * controllable, and the assembled dependency closure is content-addressed
 * into the build manifest.
 * @module @dsh-evolve-le/core/builder/pins
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { repoRoot } from '../schema.js'

const execFileAsync = promisify(execFile)

/** One pinned package: name, exact version, and the workspace package whose install resolves it. */
export interface PackagePin {
  name: string
  version: string
  /** Workspace package directory that declares this dependency. */
  resolveFrom: string
  /** True when the package ships into the capsule runtime closure. */
  runtime: boolean
}

/**
 * Pins used for staging compilation and the capsule runtime. The Cordis
 * loader plugins are host-side (the runner boots them); schemastery and the
 * candidate SDK are candidate-facing; cordis/cosmokit are shared.
 */
export const PACKAGE_PINS: PackagePin[] = [
  {
    name: '@deepseek-ai/cordis',
    version: '4.0.1',
    resolveFrom: 'packages/dsh-evolve-le',
    runtime: true,
  },
  {
    name: '@deepseek-ai/cosmokit',
    version: '1.8.2',
    resolveFrom: 'packages/dsh-evolve-le',
    runtime: true,
  },
  {
    name: '@deepseek-ai/cordis-plugin-loader',
    version: '1.0.2',
    resolveFrom: 'packages/dsh-evolve-le',
    runtime: true,
  },
  {
    name: '@deepseek-ai/cordis-plugin-include',
    version: '1.0.6',
    resolveFrom: 'packages/dsh-evolve-le',
    runtime: true,
  },
  {
    name: '@deepseek-ai/cordis-plugin-group',
    version: '1.0.1',
    resolveFrom: 'packages/dsh-evolve-le',
    runtime: true,
  },
  {
    name: '@deepseek-ai/schemastery',
    version: '3.18.1',
    resolveFrom: 'packages/candidate-baseline',
    runtime: true,
  },
  {
    name: '@dsh-evolve-le/candidate-sdk',
    version: '0.0.1',
    resolveFrom: 'packages/candidate-baseline',
    runtime: true,
  },
  {
    // The ACP wire SDK at the exact version the locked upstream
    // @deepseek-ai/dsh-acp@0.1.0-rc.5 depends on (provenance.lock dshPackages):
    // the capsule runner speaks the same Agent Client Protocol surface as the
    // DSH production stack, without staging the unpublished dsh-app spine.
    name: '@agentclientprotocol/sdk',
    version: '0.25.1',
    resolveFrom: 'packages/dsh-evolve-le',
    runtime: true,
  },
]

/** Resolve a pin to its on-disk package directory inside the repo install. */
export function resolvePinDirectory(pin: PackagePin): string {
  const anchored = createRequire(join(repoRoot, pin.resolveFrom, 'package.json'))
  const packageJsonPath = anchored.resolve(`${pin.name}/package.json`)
  return join(packageJsonPath, '..')
}

/** Toolchain fingerprints recorded in every build manifest. */
export async function toolchainFingerprints(): Promise<{
  node: string
  pnpm: string
  typescript: string
  typescriptBin: string
}> {
  const typescriptDir = resolvePinDirectory({
    name: 'typescript',
    version: '',
    resolveFrom: '.',
    runtime: false,
  })
  const tsPackage = JSON.parse(await readFile(join(typescriptDir, 'package.json'), 'utf8')) as {
    version: string
  }
  const { stdout } = await execFileAsync('pnpm', ['--version'])
  return {
    node: process.version,
    pnpm: stdout.trim(),
    typescript: tsPackage.version,
    typescriptBin: join(typescriptDir, 'bin/tsc'),
  }
}
