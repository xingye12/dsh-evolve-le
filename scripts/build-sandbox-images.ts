/** Trusted offline image builder. No candidate, evidence, credential or upstream checkout in context. */
import { cp, mkdir, readFile, writeFile, chmod, realpath, rm, symlink } from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { computeTreeDigest } from '../packages/dsh-evolve-le/src/digest.js'
import { NODE_RUNTIME_TARBALL_NAME } from '../packages/dsh-evolve-le/src/builder/pinned-runtime.js'
const exec = promisify(execFile)
const base = process.argv[2],
  destination = process.argv[3]
if (!base || !/@sha256:[a-f0-9]{64}$/.test(base) || !destination)
  throw Error(
    'usage: build-sandbox-images <base-repository@sha256:digest> <new-artifact-directory> [proposal|validator|all]',
  )
const selected = process.argv[4] ?? 'all'
if (!['proposal', 'validator', 'all'].includes(selected))
  throw Error('image kind must be proposal, validator or all')
const kinds: Array<'proposal' | 'validator'> =
  selected === 'all' ? ['proposal', 'validator'] : [selected as 'proposal' | 'validator']
const output = resolve(destination)
await mkdir(output, { recursive: false })
const images = []
for (const kind of kinds) {
  const context = join(output, kind),
    root = join(context, 'root')
  await mkdir(join(root, 'opt/executor'), { recursive: true })
  await cp('docker/executor/Dockerfile', join(context, 'Dockerfile'))
  await cp('docker/executor/entrypoint', join(root, 'opt/executor/entrypoint'))
  await chmod(join(root, 'opt/executor/entrypoint'), 0o555)
  // The executor image contains fixed bash/coreutils from its pinned OS and rg.
  await mkdir(join(root, 'usr/bin'), { recursive: true })
  const rgPath = (await exec('which', ['rg'])).stdout.trim()
  await cp(rgPath, join(root, 'usr/bin/rg'))
  const xzPath = (await exec('which', ['xz'])).stdout.trim()
  await cp(xzPath, join(root, 'usr/bin/xz'))
  if (kind === 'validator') {
    await cp('node_modules', join(root, 'node_modules'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter(sourcePath) {
        const top = relative(resolve('node_modules'), resolve(sourcePath)).split('/')[0]
        const rel = relative(resolve('node_modules'), resolve(sourcePath))
        return (
          ![
            '.vite',
            '.vite-temp',
            '.vitest',
            '.cache',
            '.modules.yaml',
            '.package-map.json',
            '.pnpm-workspace-state-v1.json',
          ].includes(top ?? '') && rel !== '.pnpm/lock.yaml'
        )
      },
    })
    const core = JSON.parse(await readFile('packages/dsh-evolve-le/package.json', 'utf8')) as {
      dependencies: Record<string, string>
    }
    for (const name of Object.keys(core.dependencies)) {
      const actual = await realpath(join('packages/dsh-evolve-le/node_modules', name))
      if (!actual.startsWith(resolve('node_modules') + '/'))
        throw Error('core dependency is outside the locked package store')
      const target = join(root, 'node_modules', name)
      await mkdir(dirname(target), { recursive: true })
      await rm(target, { force: true, recursive: true })
      await symlink(relative(resolve('node_modules'), actual), target)
    }
    await cp('schemas', join(root, 'schemas'), { recursive: true })
    await cp('package.json', join(root, 'package.json'))
    for (const pkg of ['dsh-evolve-le', 'candidate-sdk']) {
      await mkdir(join(root, 'packages', pkg), { recursive: true })
      await cp(join('packages', pkg, 'package.json'), join(root, 'packages', pkg, 'package.json'))
      await cp(join('packages', pkg, 'lib'), join(root, 'packages', pkg, 'lib'), {
        recursive: true,
      })
    }
    await mkdir(join(root, '.references'))
    await cp(
      join('.references', NODE_RUNTIME_TARBALL_NAME),
      join(root, '.references', NODE_RUNTIME_TARBALL_NAME),
    )
  }
  const tree = await computeTreeDigest(root),
    tag = `dsh-evolve-le/${kind}-executor:build-${tree.digest.slice(0, 16)}`
  const metadata = join(context, 'metadata.json')
  await exec(
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--network',
      'none',
      '--build-arg',
      `BASE_IMAGE=${base}`,
      '--file',
      join(context, 'Dockerfile'),
      '--tag',
      tag,
      '--metadata-file',
      metadata,
      '--load',
      context,
    ],
    { maxBuffer: 8 * 1024 * 1024, timeout: 300000 },
  )
  const inspected = JSON.parse(
    (await exec('docker', ['image', 'inspect', tag], { maxBuffer: 4 * 1024 * 1024 })).stdout,
  )[0]
  const digest = JSON.parse(await readFile(metadata, 'utf8'))['containerimage.digest']
  const reference = `dsh-evolve-le/${kind}-executor@${digest}`
  // A tag alone never suffices. Confirm digest-only resolution on this Engine.
  const resolved = JSON.parse(
    (await exec('docker', ['image', 'inspect', reference], { maxBuffer: 4 * 1024 * 1024 })).stdout,
  )[0]
  if (resolved.Id !== inspected.Id)
    throw Error('built image digest lookup differs from loaded image')
  images.push({
    kind,
    reference,
    id: inspected.Id,
    platform: 'linux/amd64',
    contextDigest: tree.digest,
    base,
    metadata: JSON.parse(await readFile(metadata, 'utf8')),
  })
}
await writeFile(
  join(output, 'images.json'),
  JSON.stringify({ protocol: 'dsh-evolve-le/executor-images/v1', images }, null, 2) + '\n',
  { flag: 'wx' },
)
process.stdout.write(JSON.stringify({ artifactRoot: output, images }, null, 2) + '\n')
