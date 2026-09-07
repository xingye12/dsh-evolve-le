/**
 * Shared bootable two-mode tree-v2 fixture for the candidate-test boundary
 * (ADR-038/ADR-039). The parent is a self-contained migration root
 * (parent: null, both modes target) in the exact SDK pattern the live
 * baseline uses: src/index.ts mounts src/strategy.ts through ctx.plugin,
 * and each mode registers one prompt section whose TEXT carries the mode.
 *
 * The files are plain strings so tests can stage merged parent+child views
 * without touching the workspace tree.
 */

import { mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from '../../src/schema.js'

/**
 * Populate a dependency root that serves the staged trees: every entry of
 * the repo root's node_modules (vitest for spec imports), with the workspace
 * @-scopes replaced by the baseline package's (candidate-sdk + cordis, which
 * pnpm does not hoist to the root).
 */
export async function buildDependencyRoot(root: string): Promise<void> {
  const nodeModules = join(root, 'node_modules')
  await mkdir(nodeModules, { recursive: true })
  const repoNodeModules = join(repoRoot, 'node_modules')
  for (const entry of await readdir(repoNodeModules)) {
    await symlink(join(repoNodeModules, entry), join(nodeModules, entry), 'dir')
  }
  const baselineNodeModules = join(repoRoot, 'packages/candidate-baseline/node_modules')
  for (const scope of ['@deepseek-ai', '@dsh-evolve-le']) {
    await rm(join(nodeModules, scope), { recursive: true, force: true })
    await symlink(join(baselineNodeModules, scope), join(nodeModules, scope), 'dir')
  }
}

export const FIXED_FILES = {
  'package.json': `{ "name": "candidate-runner-fixture", "private": true }\n`,
  'cordis.patch.yml': `name: candidate-runner-fixture\nservices: {}\n`,
}

/** Compact two-mode component in the exact SDK pattern of the live baseline. */
export const PARENT_INDEX = `import type { Context } from '@deepseek-ai/cordis'
import { strategyPlugin } from './strategy.js'

export const name = 'fixture-candidate'

export interface Config {
  candidateId: string
  mode: 'solve' | 'propose'
}

export function apply(ctx: Context, config: Config): void {
  ctx.plugin(strategyPlugin, config)
}
`

export const PARENT_STRATEGY = `import type { Context } from '@deepseek-ai/cordis'
import { defineCandidate } from '@dsh-evolve-le/candidate-sdk'

interface Config {
  candidateId: string
  mode: 'solve' | 'propose'
}

const candidate = defineCandidate<Config>({
  solve: {
    promptSection: (config) => ({
      name: 'candidate:identity',
      order: 100,
      text: 'PARENT SOLVE TEXT for candidate ' + config.candidateId + ' in solve mode.',
    }),
    tools: () => [],
    skills: () => [],
  },
  propose: {
    promptSection: (config) => ({
      name: 'candidate:proposal-policy',
      order: 100,
      text: 'PARENT PROPOSE TEXT for candidate ' + config.candidateId + ' in propose mode.',
    }),
    tools: () => [],
    skills: () => [],
  },
})

export function strategyPlugin(ctx: Context, config: Config): void {
  candidate.register(ctx, config)
}
`

/** The child folds a mode-specific directive into each section's TEXT only. */
export const CHILD_STRATEGY = PARENT_STRATEGY.replace(
  "'PARENT SOLVE TEXT",
  "'PARENT SOLVE TEXT — CHILD SOLVE DIRECTIVE",
).replace(
  "'PARENT PROPOSE TEXT",
  "'PARENT PROPOSE TEXT — CHILD PROPOSE DIRECTIVE",
)

export const PARENT_SPEC = `import { describe, expect, it } from 'vitest'
import { createHarness } from '@dsh-evolve-le/candidate-sdk/testkit'
import { apply, type Config } from '../src/index.js'

const config = (mode: Config['mode']): Config => ({
  candidateId: 'c_fixtureparent0000000000000000000',
  mode,
})

const mount = (mode: Config['mode']) => {
  const harness = createHarness()
  const ctx = harness.ctx as unknown as {
    plugin: (plugin: (ctx: unknown, config: Config) => void, config: Config) => void
  }
  ctx.plugin = (plugin, pluginConfig) => {
    plugin(harness.ctx, pluginConfig)
  }
  apply(harness.ctx, config(mode))
  return harness
}

describe('fixture parent baseline', () => {
  it('registers exactly one section per mode', () => {
    for (const mode of ['solve', 'propose'] as const) {
      expect(mount(mode).sections()).toHaveLength(1)
    }
  })
})
`

export function candidateJson(
  modeContract: {
    targetModes: string[]
    preservedModes: string[]
  },
  modeComponents?: Record<string, string[]>,
): string {
  return `${JSON.stringify(
    {
      $schema: 'https://dsh-evolve-le.local/schema/tree-v2/candidate-intent/v2',
      schemaVersion: 2,
      protocol: 'dsh-self-evolving-candidate-tree-v2',
      kind: 'candidate-intent',
      candidate: { name: '@dsh-evolve-le/candidate-runner-fixture', version: '1.0.0', entry: 'src/index.ts' },
      parent: null,
      modeContract,
      runtime: {
        modeComponents: modeComponents ?? {
          solve: ['src/index.ts', 'src/strategy.ts'],
          propose: ['src/index.ts', 'src/strategy.ts'],
        },
        modeSurfaces: {
          solve: {
            promptSections: [{ name: 'candidate:identity', order: 100 }],
            newToolNames: [],
            newSkillNames: [],
            agentEventNames: [],
            sessionEventNames: [],
            workflowNames: [],
          },
          propose: {
            promptSections: [{ name: 'candidate:proposal-policy', order: 100 }],
            newToolNames: [],
            newSkillNames: [],
            agentEventNames: [],
            sessionEventNames: [],
            workflowNames: [],
          },
        },
        capabilities: ['system-prompt'],
      },
      tests: { command: 'vitest run', mechanism: ['tests/candidate.spec.ts'], preservation: [] },
      receiptDigest: `sha256:${'a'.repeat(64)}`,
    },
    null,
    2,
  )}\n`
}

export const TARGET_BOTH = { targetModes: ['solve', 'propose'], preservedModes: [] }

/** The complete parent view: fixed files + manifest + production + spec. */
export function parentFiles(
  overrides: { candidateJson?: string; strategy?: string } = {},
): Record<string, string> {
  return {
    ...FIXED_FILES,
    'candidate.json': overrides.candidateJson ?? candidateJson(TARGET_BOTH),
    'src/index.ts': PARENT_INDEX,
    'src/strategy.ts': overrides.strategy ?? PARENT_STRATEGY,
    'tests/candidate.spec.ts': PARENT_SPEC,
  }
}

/** The complete child view; identical to the parent unless overridden. */
export function childFiles(overrides: {
  candidateJson?: string
  strategy?: string
  index?: string
  omitStrategy?: boolean
}): Record<string, string> {
  return {
    ...FIXED_FILES,
    'candidate.json': overrides.candidateJson ?? candidateJson(TARGET_BOTH),
    'src/index.ts': overrides.index ?? PARENT_INDEX,
    ...(overrides.omitStrategy === true ? {} : { 'src/strategy.ts': overrides.strategy ?? PARENT_STRATEGY }),
    'tests/candidate.spec.ts': PARENT_SPEC,
  }
}
