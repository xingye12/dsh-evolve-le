/** Argument/config freezing only; Loader and actual Docker evidence live in core E2E. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect, vi } from 'vitest'
vi.mock('@dsh-evolve-le/core', async (original) => ({
  ...(await original<typeof import('@dsh-evolve-le/core')>()),
  runPreflight: async () => [],
}))
import { runCli } from '../src/cli.js'
it('init freezes the explicit Docker profile and disables proposer request retries without launching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-docker-profile-'))
  try {
    const tasks = join(root, 'tasks')
    await mkdir(tasks)
    for (let n = 0; n < 89; n++) {
      const p = join(tasks, `task-${n}`)
      await mkdir(p)
      await writeFile(join(p, 'task.toml'), '[task]\nname = "synthetic"\n')
    }
    const profile = {
      backend: 'docker-local/v1',
      hostRoot: '/tmp/dsh-generation',
      image: {
        reference: `example.test/proposal@sha256:${'a'.repeat(64)}`,
        id: `sha256:${'b'.repeat(64)}`,
        platform: 'linux/amd64',
      },
    }
    const file = join(root, 'profile.json')
    await writeFile(file, JSON.stringify(profile))
    let out = ''
    let error = ''
    const code = await runCli(
      [
        'init',
        '--runs-root',
        join(root, 'runs'),
        '--run-id',
        'docker-profile',
        '--master-seed',
        'docker-profile-unit-seed',
        '--tasks-root',
        tasks,
        '--baseline-source',
        join(root, 'baseline'),
        '--jobs-root',
        join(root, 'jobs'),
        '--native-dsh-catalog-root',
        join(root, 'catalog'),
        '--native-dsh-closure-sha256',
        'a'.repeat(64),
        '--proposer-route',
        'deepseek/zen-compatible',
        '--model-base-url',
        'https://model.example/v1',
        '--model-name',
        'fixed',
        '--model-temperature',
        '0',
        '--credential-file',
        join(root, 'private.key'),
        '--proposal-docker-profile',
        file,
      ],
      { stdout: (s) => (out += s), stderr: (s) => (error += s) },
    )
    expect(code, error).toBe(0)
    const config = JSON.parse(
      await readFile(join(root, 'runs/docker-profile/run.config.json'), 'utf8'),
    )
    expect(config.proposalSandbox).toEqual(profile)
    expect(config.modelRoutes.find((r: any) => r.id === config.proposerRoute).retry).toEqual({
      maxAttempts: 1,
      backoffMs: [],
    })
    expect(JSON.parse(out).configHash).toMatch(/^sha256:/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
