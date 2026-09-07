import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IMAGE_PREFETCH_PROTOCOL,
  parseDockerImage,
  prefetchTaskImages,
  taskImageRefs,
  type ImageCommandRunner,
} from '../src/index.js'

function fakeDocker(): { run: ImageCommandRunner; pulls: string[] } {
  const images = new Map<string, string>()
  const pulls: string[] = []
  const run: ImageCommandRunner = async (_bin, args) => {
    const ref = args.at(-1) as string
    if (args[0] === 'image' && args[1] === 'inspect') {
      const id = images.get(ref)
      if (id === undefined) throw new Error('missing image')
      return { stdout: JSON.stringify([{ Id: id, RepoDigests: [`${ref}@${id}`] }]), stderr: '' }
    }
    if (args[0] === 'pull') {
      pulls.push(ref)
      images.set(ref, `sha256:${ref.replace(/[^a-z0-9]/gi, '')}`)
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected docker args: ${args.join(' ')}`)
  }
  return { run, pulls }
}

describe('real-solver Docker image prefetch', () => {
  it('parses the Harbor environment image and freezes sorted unique refs', async () => {
    expect(parseDockerImage("[environment]\ndocker_image = 'ubuntu:22.04'")).toBe('ubuntu:22.04')
    const root = await mkdtemp(join(tmpdir(), 'dsh-image-cache-'))
    for (const [name, image] of [
      ['b', 'acme/b:1'],
      ['a', 'acme/a:1'],
      ['c', 'acme/a:1'],
    ]) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, 'task.toml'), `[environment]\ndocker_image = "${image}"\n`)
    }
    await expect(taskImageRefs(root)).resolves.toEqual(['acme/a:1', 'acme/b:1'])
  })

  it('pulls missing images once and verifies the receipt on resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-image-cache-'))
    const tasks = join(root, 'tasks')
    await mkdir(join(tasks, 'one'), { recursive: true })
    await writeFile(join(tasks, 'one', 'task.toml'), '[environment]\ndocker_image = "acme/one:1"\n')
    const receiptPath = join(root, 'image-prefetch.json')
    const docker = fakeDocker()
    const first = await prefetchTaskImages({
      runId: 'run-1',
      tasksRoot: tasks,
      receiptPath,
      run: docker.run,
    })
    expect(first.protocol).toBe(IMAGE_PREFETCH_PROTOCOL)
    expect(docker.pulls).toEqual(['acme/one:1'])
    const second = await prefetchTaskImages({
      runId: 'run-1',
      tasksRoot: tasks,
      receiptPath,
      run: docker.run,
    })
    expect(second.images[0]?.action).toBe('pulled')
    expect(docker.pulls).toEqual(['acme/one:1'])
    expect(JSON.parse(await readFile(receiptPath, 'utf8')).runId).toBe('run-1')
  })
})
