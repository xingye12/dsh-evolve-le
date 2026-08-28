/**
 * Upstream contract tests (Gate 2, specs/07 §4): validate the provider's
 * generated artifacts against the REAL pinned upstream — the materialized
 * terminal-bench-2-1 tarball for the task inventory, and the installed
 * harbor 0.21.0 validators (pydantic) for the JobConfig YAML and the inline
 * ACP registry entry. These are the drift tripwires CLAUDE.md rule 10 asks
 * for: interfaces bind to fixed-version source, and these tests run that
 * source's own validation rather than a copied API list.
 *
 * Fails closed when prerequisites are missing (run `pnpm setup:source` and
 * `uv tool install --force .references/harbor-src` first) — the same
 * convention as the Gate 1 container E2E.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAcpRegistryEntry, buildJobConfig, buildTaskInventory } from '../src/index.js'

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const TARBALL = join(repoRoot, '.references/terminal-bench-2-1-7131e43.tar.gz')
const HARBOR_PYTHON = join(homedir(), '.local/share/uv/tools/harbor/bin/python')
const ARCHIVE_URL = 'https://172.17.0.1:8443/artifacts/capsule.tar.gz'
/** Stand-in capsule digest for contract validation (no build needed). */
const CAPSULE_SHA = 'a'.repeat(64)

let scratch = ''
afterAll(async () => {
  if (scratch !== '') await rm(scratch, { recursive: true, force: true })
})

describe('pinned terminal-bench 2.1 upstream', () => {
  let tasksRoot = ''

  beforeAll(async () => {
    if (!existsSync(TARBALL)) {
      throw new Error(
        `pinned tarball missing at ${TARBALL}; run \`pnpm setup:source\` before this suite`,
      )
    }
    if (!existsSync(HARBOR_PYTHON)) {
      throw new Error(
        `harbor 0.21.0 python env missing at ${HARBOR_PYTHON}; run \`uv tool install --force .references/harbor-src\``,
      )
    }
    scratch = await mkdtemp(join(tmpdir(), 'dsh-tb21-'))
    await exec('tar', ['-xzf', TARBALL, '-C', scratch])
    tasksRoot = join(scratch, 'terminal-bench-2-1-7131e4375048a0e408a8fb404b5f499d726b695b/tasks')
  }, 120_000)

  it('inventories the full pinned task set deterministically', async () => {
    const first = await buildTaskInventory(tasksRoot)
    const second = await buildTaskInventory(tasksRoot)
    expect(first.tasks.length).toBeGreaterThanOrEqual(80)
    expect(first.tasks.map((task) => task.handle)).toContain('extract-elf')
    expect(first.inventorySha256).toBe(second.inventorySha256)
    // The Gate 2 E2E task must be present with a stable digest.
    const extractElf = first.tasks.find((task) => task.handle === 'extract-elf')
    expect(extractElf?.fileCount).toBeGreaterThan(0)
  })

  it('produces a JobConfig the installed harbor validates, with the inline registry entry', async () => {
    const inventory = await buildTaskInventory(tasksRoot)
    const extractElf = inventory.tasks.find((task) => task.handle === 'extract-elf')
    if (extractElf === undefined) throw new Error('extract-elf missing from pinned set')

    const entry = buildAcpRegistryEntry({
      capsuleArchiveSha256: CAPSULE_SHA,
      archiveUrl: ARCHIVE_URL,
    })
    const plan = buildJobConfig({
      jobName: 'dsh-upstream-contract',
      jobsDir: join(scratch, 'jobs'),
      taskPaths: [extractElf.path],
      registryEntry: entry,
      attempts: 1,
      concurrentTrials: 1,
    })
    const configPath = join(scratch, 'job-config.yaml')
    const entryPath = join(scratch, 'registry-entry.json')
    await writeFile(configPath, plan.yaml, 'utf8')
    await writeFile(entryPath, JSON.stringify(entry), 'utf8')

    // Run harbor's own pydantic validators over both artifacts.
    const checker = `
import json, sys, yaml
from harbor.models.job.config import JobConfig
from harbor.agents.installed.acp import AcpRegistryEntry, AcpBinaryTarget

config = JobConfig.model_validate(yaml.safe_load(open(${JSON.stringify(configPath)})))
agent = config.agents[0]
assert agent.name == 'acp', agent.name
assert agent.model_name is None, agent.model_name
kwargs = agent.kwargs
entry = AcpRegistryEntry.model_validate(kwargs['registry_entry'])
target = entry.distribution.binary['linux-x86_64']
AcpBinaryTarget.model_validate(target.model_dump())
assert target.archive.startswith('https://')
assert target.cmd, target.cmd
assert len(config.tasks) == 1 and config.tasks[0].path.name == 'extract-elf'
assert config.n_attempts == 1
assert config.environment.type == 'docker'
print('harbor-validated')
`
    const { stdout } = await exec(HARBOR_PYTHON, ['-c', checker])
    expect(stdout.trim()).toBe('harbor-validated')
  }, 60_000)
})
