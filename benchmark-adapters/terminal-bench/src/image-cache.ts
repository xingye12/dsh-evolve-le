/**
 * Docker image warm-up for real Harbor solver runs. Harbor task images are
 * shared through the host Docker daemon; this receipt makes the warm-up
 * content-addressed and lets resume verify that a tag was not silently moved.
 */
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const IMAGE_PREFETCH_PROTOCOL = 'dsh-evolve-le/image-prefetch/v1'

export interface ImagePrefetchRecord {
  ref: string
  action: 'cached' | 'pulled'
  imageId: string
  repoDigests: string[]
}

export interface ImagePrefetchReceipt {
  protocol: typeof IMAGE_PREFETCH_PROTOCOL
  runId: string
  images: ImagePrefetchRecord[]
  createdAt: string
}

export interface ImageCommandRunner {
  (bin: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
}

const defaultRunner: ImageCommandRunner = async (bin, args) => {
  const result = await execFile(bin, [...args], { maxBuffer: 8 * 1024 * 1024 })
  return { stdout: result.stdout, stderr: result.stderr }
}

/** Harbor's task TOML has a single docker_image field under [environment]. */
export function parseDockerImage(taskToml: string): string {
  let section = ''
  for (const rawLine of taskToml.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1] ?? ''
      continue
    }
    if (section !== 'environment') continue
    const imageMatch = /^docker_image\s*=\s*(["'])(.+)\1$/.exec(line)
    if (imageMatch !== null && imageMatch[2] !== undefined && imageMatch[2].length > 0) {
      return imageMatch[2]
    }
  }
  throw new Error('image-prefetch: task.toml has no [environment].docker_image')
}

/** Resolve sorted, unique task image refs from a materialized task root. */
export async function taskImageRefs(tasksRoot: string, handles?: readonly string[]): Promise<string[]> {
  const entries = await readdir(tasksRoot, { withFileTypes: true })
  const refs = new Set<string>()
  const allowlist = handles === undefined ? null : new Set(handles)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (allowlist !== null && !allowlist.has(entry.name)) continue
    const path = join(tasksRoot, entry.name, 'task.toml')
    refs.add(parseDockerImage(await readFile(path, 'utf8')))
  }
  const images = [...refs].sort()
  if (images.length === 0) throw new Error(`image-prefetch: no task images under ${tasksRoot}`)
  return images
}

async function inspectImage(
  dockerBin: string,
  ref: string,
  run: ImageCommandRunner,
): Promise<{ imageId: string; repoDigests: string[] } | null> {
  try {
    const { stdout } = await run(dockerBin, ['image', 'inspect', ref])
    const parsed = JSON.parse(stdout) as Array<{ Id?: unknown; RepoDigests?: unknown }>
    const first = parsed[0]
    if (first === undefined || typeof first.Id !== 'string' || first.Id.length === 0) {
      throw new Error(`image-prefetch: docker inspect returned no image id for ${ref}`)
    }
    const repoDigests = Array.isArray(first.RepoDigests)
      ? first.RepoDigests.filter((value): value is string => typeof value === 'string').sort()
      : []
    return { imageId: first.Id, repoDigests }
  } catch {
    return null
  }
}

/**
 * Pull each missing image once, then freeze image IDs in a receipt. An
 * existing receipt is verification-only: a missing or changed image fails
 * closed instead of pulling a different tag into a resumed run.
 */
export async function prefetchTaskImages(input: {
  runId: string
  tasksRoot: string
  handles?: readonly string[]
  receiptPath: string
  dockerBin?: string
  run?: ImageCommandRunner
  images?: readonly string[]
}): Promise<ImagePrefetchReceipt> {
  const dockerBin = input.dockerBin ?? 'docker'
  const run = input.run ?? defaultRunner
  const images = [
    ...(input.images ?? (await taskImageRefs(input.tasksRoot, input.handles))),
  ].sort()
  const existing = await readFile(input.receiptPath, 'utf8').catch(() => undefined)
  if (existing !== undefined) {
    const receipt = JSON.parse(existing) as ImagePrefetchReceipt
    if (receipt.protocol !== IMAGE_PREFETCH_PROTOCOL || receipt.runId !== input.runId) {
      throw new Error(`image-prefetch: receipt ${input.receiptPath} does not match this run`)
    }
    const recorded = receipt.images.map((image) => image.ref).sort()
    if (JSON.stringify(recorded) !== JSON.stringify(images)) {
      throw new Error(`image-prefetch: receipt image set differs from the frozen task set`)
    }
    for (const image of receipt.images) {
      const current = await inspectImage(dockerBin, image.ref, run)
      if (current === null || current.imageId !== image.imageId) {
        throw new Error(`image-prefetch: cached image ${image.ref} is missing or changed`)
      }
    }
    return receipt
  }

  const records: ImagePrefetchRecord[] = []
  for (const ref of images) {
    let inspected = await inspectImage(dockerBin, ref, run)
    let action: ImagePrefetchRecord['action'] = 'cached'
    if (inspected === null) {
      await run(dockerBin, ['pull', ref])
      inspected = await inspectImage(dockerBin, ref, run)
      action = 'pulled'
    }
    if (inspected === null) throw new Error(`image-prefetch: ${ref} unavailable after pull`)
    records.push({ ref, action, ...inspected })
  }
  const receipt: ImagePrefetchReceipt = {
    protocol: IMAGE_PREFETCH_PROTOCOL,
    runId: input.runId,
    images: records,
    createdAt: new Date().toISOString(),
  }
  await mkdir(dirname(input.receiptPath), { recursive: true })
  const staging = `${input.receiptPath}.staging`
  await writeFile(staging, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  await rename(staging, input.receiptPath)
  return receipt
}
