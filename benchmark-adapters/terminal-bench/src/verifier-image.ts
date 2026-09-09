/**
 * Offline verifier-runtime preparation for real Harbor solver runs.
 *
 * Terminal-Bench task images are immutable, but a few upstream verifier
 * scripts bootstrap pytest with `curl ... astral.sh | sh` and `uvx` after the
 * container has started.  That is outside the image-prefetch boundary and
 * makes a cached image depend on flaky GitHub egress.  This module creates a
 * run-scoped task copy and a content-addressed derived image instead:
 * Python 3.13 plus the exact verifier requirements are installed once during
 * preparation, while the copied verifier invokes the already-installed
 * pytest directly.  The upstream checkout is never modified.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseDockerImage } from './image-cache.js'

const execFile = promisify(execFileCallback)

export const VERIFIER_IMAGE_PROTOCOL = 'dsh-evolve-le/verifier-image/v4'
// Build Python 3.13 against the oldest glibc used by the frozen TB task
// images.  A bullseye-built runtime runs on newer Debian/Ubuntu bases, while
// the previous bookworm runtime required GLIBC_2.32+ and could not launch in
// qemu-startup's bullseye image.
const PYTHON_RUNTIME_IMAGE = 'python:3.13-slim-bullseye'
/** Frozen ACP Python runner location consumed by Harbor's installed ACP agent. */
export const ACP_RUNTIME_VENV_PATH = '/opt/harbor-acp-venv'
export const ACP_RUNTIME_PACKAGE = 'agent-client-protocol'
/**
 * Harbor 0.21.0 unconditionally runs its ACP dependency bootstrap before it
 * notices the already-provisioned venv.  The derived task image contains all
 * of those dependencies, so this narrow wrapper makes only Harbor's exact
 * fixed apt invocations no-ops, and only under Harbor's noninteractive root
 * environment.  Other apt-get calls delegate to the real binary unchanged.
 */
export const HARBOR_ACP_APT_SHIM_PATH = '/usr/local/sbin/apt-get'
export function harborAcpAptShim(): string {
  return `#!/bin/sh
# dsh-evolve-le: Harbor installed ACP bootstrap is already in this image.
case "$*" in
  'update -qq'|'install -y python3 python3-pip python3-venv curl ca-certificates tar unzip bzip2 xz-utils')
    if [ "\${DEBIAN_FRONTEND:-}" = "noninteractive" ]; then exit 0; fi
    ;;
esac
exec /usr/bin/apt-get "$@"
`
}
/** Packages Harbor's fixed ACP bootstrap needs before extracting the capsule. */
const ACP_BOOTSTRAP_SYSTEM_PACKAGES = [
  'python3',
  'python3-pip',
  'python3-venv',
  'curl',
  'ca-certificates',
  'tar',
  'unzip',
  'bzip2',
  'xz-utils',
]
/**
 * A few frozen TB base images ship their original Debian snapshot URLs as
 * commented lines next to now-stale live mirrors.  Prefer that immutable
 * snapshot during preparation.  The image digest is then frozen in the
 * receipt; signature verification remains enabled.  Never do this at trial
 * time.
 */
export function preparedAptInstallCommand(packages: readonly string[]): string {
  if (packages.length === 0) throw new Error('verifier-image: no apt packages to install')
  return `RUN if grep -q '^# deb http://snapshot.debian.org/' /etc/apt/sources.list; then sed -i -e 's|^# deb http://snapshot.debian.org/|deb http://snapshot.debian.org/|' -e '\\|^deb http://deb.debian.org/|d' /etc/apt/sources.list; fi && apt-get -o Acquire::Check-Valid-Until=false update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.join(' ')} && rm -rf /var/lib/apt/lists/*`
}
const ACP_BOOTSTRAP_IMAGE_CONTRACT = `v4\n${ACP_BOOTSTRAP_SYSTEM_PACKAGES.join('\n')}\n${preparedAptInstallCommand(ACP_BOOTSTRAP_SYSTEM_PACKAGES)}\n${harborAcpAptShim()}`

export interface VerifierImageRecord {
  task: string
  baseRef: string
  baseImageId: string
  derivedRef: string
  derivedImageId: string
  verifierSha256: string
  requirements: string[]
  systemRequirements: string[]
  gitSources: VerifierGitSource[]
}

export interface VerifierGitSource {
  sourceId: string
  url: string
  branch: string
}

export interface VerifierImageReceipt {
  protocol: typeof VERIFIER_IMAGE_PROTOCOL
  runtimeImageRef: string
  runtimeImageId: string
  acpRuntime: {
    package: typeof ACP_RUNTIME_PACKAGE
    venvPath: typeof ACP_RUNTIME_VENV_PATH
  }
  runtimeRequirements: string[]
  tasks: VerifierImageRecord[]
}

export interface VerifierImageCommandRunner {
  (bin: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }>
}

const defaultRunner: VerifierImageCommandRunner = async (bin, args) => {
  const result = await execFile(bin, [...args], { maxBuffer: 32 * 1024 * 1024 })
  return { stdout: result.stdout, stderr: result.stderr }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function imageIdFromInspect(stdout: string, ref: string): string {
  const parsed = JSON.parse(stdout) as Array<{ Id?: unknown }>
  const id = parsed[0]?.Id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`verifier-image: docker inspect returned no image id for ${ref}`)
  }
  return id
}

async function inspectImage(
  dockerBin: string,
  ref: string,
  run: VerifierImageCommandRunner,
): Promise<string | null> {
  try {
    return imageIdFromInspect((await run(dockerBin, ['image', 'inspect', ref])).stdout, ref)
  } catch {
    return null
  }
}

function packageTokens(text: string): string[] {
  const packages = new Set<string>()
  for (const match of text.matchAll(/(?:^|\s)([A-Za-z0-9][A-Za-z0-9_.-]*==[^\s\\]+)/gm)) {
    const value = match[1]
    if (value === undefined) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9_.+!-]*$/.test(value)) {
      throw new Error(`verifier-image: unsupported pinned Python requirement ${value}`)
    }
    packages.add(value)
  }
  return [...packages].sort()
}

/** Extract pinned Python packages from the two bootstrap forms in TB tasks. */
export function verifierRequirements(testScript: string): string[] {
  if (testScript.includes('git+')) {
    throw new Error(
      'verifier-image: verifier uses a git package source; prepare that artifact explicitly',
    )
  }
  const requirements = packageTokens(testScript)
  if (testScript.includes('uvx') && !requirements.some((value) => value.startsWith('pytest=='))) {
    throw new Error('verifier-image: uvx verifier has no pinned pytest requirement')
  }
  if (
    testScript.includes('uvx') &&
    !requirements.some((value) => value.startsWith('pytest-json-ctrf=='))
  ) {
    throw new Error('verifier-image: uvx verifier has no pinned pytest-json-ctrf requirement')
  }
  return requirements
}

/** Extract literal Debian packages from verifier-side apt bootstrap lines. */
export function verifierSystemRequirements(testScript: string): string[] {
  const packages = new Set<string>()
  let sawInstall = false
  for (const rawLine of testScript.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!/(^|&&|;)\s*(?:DEBIAN_FRONTEND=\S+\s+)?apt(?:-get)?\s+install\b/.test(line)) {
      continue
    }
    sawInstall = true
    const match = /(?:^|&&|;)\s*(?:DEBIAN_FRONTEND=\S+\s+)?apt(?:-get)?\s+install\b([^;&]*)/.exec(
      line,
    )
    if (match === null || match[1] === undefined) {
      throw new Error('verifier-image: unsupported apt install bootstrap')
    }
    for (const token of match[1].trim().split(/\s+/)) {
      if (token === '' || token.startsWith('-')) continue
      if (!/^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/.test(token)) {
        throw new Error(`verifier-image: unsupported apt package token ${token}`)
      }
      packages.add(token)
    }
  }
  if (sawInstall && packages.size === 0) {
    throw new Error('verifier-image: apt install bootstrap has no literal packages')
  }
  return [...packages].sort()
}

/**
 * Replace the fixed TB verifier form `git clone ... temp_dir` with a copy from
 * a source frozen into the derived image. The source is fetched during image
 * preparation, never by the verifier process.
 */
export function rewriteVerifierGitClones(testSource: string): {
  content: string
  sources: VerifierGitSource[]
} {
  const sources: VerifierGitSource[] = []
  const content = testSource.replace(
    /git_cmd = \[\s*"git",\s*"clone",\s*"--depth",\s*"1",\s*"--branch",\s*"([^"\n]+)",\s*"(https:\/\/[^"\n]+)",\s*temp_dir,\s*\]/g,
    (_match, branchValue: string, urlValue: string) => {
      if (
        !/^[A-Za-z0-9._/-]+$/.test(branchValue) ||
        !/^https:\/\/[A-Za-z0-9._/?#=&:+-]+$/.test(urlValue)
      ) {
        throw new Error('verifier-image: unsupported git verifier source')
      }
      const sourceId = digest(`${urlValue}\n${branchValue}\n`).slice(0, 20)
      const source = { sourceId, url: urlValue, branch: branchValue }
      if (!sources.some((item) => item.sourceId === sourceId)) sources.push(source)
      return `git_cmd = ["cp", "-a", "/opt/dsh-evolve-le/verifier-sources/${sourceId}/.", temp_dir]`
    },
  )
  // Other occurrences can be part of the task assertion itself (for example,
  // a test that intentionally clones from a local git fixture). Only the
  // recognized verifier bootstrap form above is rewritten here; callers must
  // inspect the task entrypoint separately if it performs an external clone.
  return { content, sources }
}

/**
 * Remove only dependency bootstrap commands; the actual verifier assertions
 * and reward-file protocol stay byte-for-byte semantically unchanged.
 */
export function rewriteVerifierOffline(testScript: string): string {
  let output = testScript
  output = output.replace(
    /^\s*(?:DEBIAN_FRONTEND=\S+\s+)?apt(?:-get)?\s+(?:update|install\b[^\n]*)[^\n]*\n/gm,
    '# dsh-evolve-le: system verifier dependencies are preinstalled in the frozen image.\n',
  )
  output = output.replace(
    /^\s*curl -LsSf https:\/\/astral\.sh\/uv\/[^\n]+\| sh\s*\n/gm,
    '# dsh-evolve-le: uv is preinstalled in the frozen verifier image; no network bootstrap.\n',
  )
  output = output.replace(
    /^\s*source \$HOME\/\.local\/bin\/env\s*\n/gm,
    '# dsh-evolve-le: verifier environment is already prepared.\n',
  )
  output = output.replace(/^uvx \\\n(?:[ \t]+[^\n]+\\\n)+[ \t]*pytest /gm, 'python3 -m pytest ')
  output = output.replace(
    /^\s*(?:uv )?pip install [^\n]+\n/gm,
    '# dsh-evolve-le: verifier Python dependencies are preinstalled in the frozen image.\n',
  )
  if (
    output === testScript ||
    output.includes('uvx') ||
    output.includes('astral.sh/uv') ||
    /(^|\n)\s*(?:uv )?pip install /.test(output) ||
    /(^|\n)\s*(?:DEBIAN_FRONTEND=\S+\s+)?apt(?:-get)?\s+(?:update|install)\b/.test(output)
  ) {
    throw new Error(
      'verifier-image: unsupported verifier bootstrap; refusing to silently run with network dependencies',
    )
  }
  return output
}

async function verifierTextFiles(
  root: string,
): Promise<Array<{ relativePath: string; content: string }>> {
  const files: Array<{ relativePath: string; content: string }> = []
  const walk = async (relative: string): Promise<void> => {
    const absolute = join(root, relative)
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const child = relative === '' ? entry.name : join(relative, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (/\.(?:py|pyx|sh|txt)$/.test(entry.name)) {
        files.push({ relativePath: child, content: await readFile(join(root, child), 'utf8') })
      }
    }
  }
  await walk('')
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
}

function replaceTaskImage(taskToml: string, image: string): string {
  const lines = taskToml.split(/\r?\n/)
  let section = ''
  let replaced = false
  const out = lines.map((line) => {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (sectionMatch !== null) section = sectionMatch[1] ?? ''
    if (section === 'environment' && /^\s*docker_image\s*=/.test(line)) {
      replaced = true
      return `docker_image = "${image}"`
    }
    return line
  })
  if (!replaced) throw new Error('verifier-image: task.toml has no [environment].docker_image')
  return out.join('\n')
}

export async function prepareOfflineVerifierTasks(input: {
  sourceTasksRoot: string
  outputTasksRoot: string
  /** Optional frozen subset (e.g. DEV_OBSERVED) to prepare before launch. */
  taskAllowlist?: readonly string[]
  dockerBin?: string
  run?: VerifierImageCommandRunner
}): Promise<{ tasksRoot: string; receipt: VerifierImageReceipt }> {
  const dockerBin = input.dockerBin ?? 'docker'
  const run = input.run ?? defaultRunner
  await mkdir(input.outputTasksRoot, { recursive: true })
  const names = (await readdir(input.sourceTasksRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const allowlist = input.taskAllowlist === undefined ? null : new Set(input.taskAllowlist)

  const staged: Array<{
    task: string
    sourceToml: string
    baseRef: string
    requirements: string[]
    systemRequirements: string[]
    gitSources: VerifierGitSource[]
    rewrittenFiles: Array<{ relativePath: string; content: string }>
    rewrittenTest: string
  }> = []
  for (const task of names) {
    const sourceDir = join(input.sourceTasksRoot, task)
    if (allowlist !== null && !allowlist.has(task)) {
      await cp(sourceDir, join(input.outputTasksRoot, task), { recursive: true })
      continue
    }
    const taskToml = await readFile(join(sourceDir, 'task.toml'), 'utf8')
    const testPath = join(sourceDir, 'tests', 'test.sh')
    const testScript = await readFile(testPath, 'utf8')
    const verifierFiles = await verifierTextFiles(join(sourceDir, 'tests'))
    const rewrittenFiles: Array<{ relativePath: string; content: string }> = []
    const gitSources: VerifierGitSource[] = []
    for (const file of verifierFiles) {
      const rewritten = rewriteVerifierGitClones(file.content)
      for (const source of rewritten.sources) {
        if (!gitSources.some((item) => item.sourceId === source.sourceId)) gitSources.push(source)
      }
      if (rewritten.content !== file.content) {
        rewrittenFiles.push({ relativePath: file.relativePath, content: rewritten.content })
      }
    }
    const hasBootstrap =
      testScript.includes('uvx') ||
      testScript.includes('pip install') ||
      /(^|\n)\s*(?:DEBIAN_FRONTEND=\S+\s+)?apt(?:-get)?\s+(?:update|install)\b/m.test(testScript)
    // Allowlisted tasks are all staged, including tasks whose verifier already
    // has no bootstrap commands.  Harbor's ACP runner is injected through the
    // derived image for every eligible task, so a run cannot silently fall
    // back to a base image that would bootstrap at trial time.
    const rewrittenTest = hasBootstrap ? rewriteVerifierOffline(testScript) : testScript
    const systemRequirements = new Set(verifierSystemRequirements(testScript))
    if (gitSources.length > 0) systemRequirements.add('git')
    staged.push({
      task,
      sourceToml: taskToml,
      baseRef: parseDockerImage(taskToml),
      requirements: verifierRequirements(testScript),
      systemRequirements: [...systemRequirements].sort(),
      gitSources,
      rewrittenFiles,
      rewrittenTest,
    })
  }

  // Keep the shared layer small: task-specific verifier requirements are
  // installed in each derived image below.  Aggregating every task's ML stack
  // here would make a single heavyweight (for example torch) dependency block
  // ACP runtime preparation for otherwise unrelated tasks.
  const runtimeRequirements: string[] = []
  const runtimeKey = digest(
    `${PYTHON_RUNTIME_IMAGE}\n${runtimeRequirements.join('\n')}\nacp:${ACP_RUNTIME_PACKAGE}\n`,
  )
  const runtimeImageRef = `dsh-evolve-le/verifier-runtime:${runtimeKey.slice(0, 20)}`
  if ((await inspectImage(dockerBin, PYTHON_RUNTIME_IMAGE, run)) === null) {
    await run(dockerBin, ['pull', PYTHON_RUNTIME_IMAGE])
  }
  let runtimeImageId = await inspectImage(dockerBin, runtimeImageRef, run)
  if (runtimeImageId === null) {
    const context = `/tmp/dsh-verifier-runtime-${runtimeKey.slice(0, 16)}`
    await mkdir(context, { recursive: true })
    const requirementLine =
      runtimeRequirements.length > 0
        ? `RUN python -m pip install --disable-pip-version-check --no-cache-dir ${runtimeRequirements.join(' ')}`
        : ''
    await writeFile(
      join(context, 'Dockerfile'),
      [
        `FROM ${PYTHON_RUNTIME_IMAGE}`,
        requirementLine,
        `RUN python -m venv ${ACP_RUNTIME_VENV_PATH} && ${ACP_RUNTIME_VENV_PATH}/bin/pip install --disable-pip-version-check --no-cache-dir ${ACP_RUNTIME_PACKAGE}`,
        `ENV DSH_ACP_RUNTIME_READY=1 DSH_ACP_RUNTIME_VENV=${ACP_RUNTIME_VENV_PATH}`,
        'ENV DSH_OFFLINE_VERIFIER=1 UV_OFFLINE=1 UV_PYTHON_DOWNLOADS=never',
        `LABEL org.dsh-evolve-le.verifier-runtime="${runtimeKey}"`,
        '',
      ].join('\n'),
      'utf8',
    )
    await run(dockerBin, ['build', '--pull=false', '-t', runtimeImageRef, context])
    runtimeImageId = await inspectImage(dockerBin, runtimeImageRef, run)
    if (runtimeImageId === null)
      throw new Error('verifier-image: runtime image missing after build')
  }

  const tasks: VerifierImageRecord[] = []
  for (const item of staged) {
    if ((await inspectImage(dockerBin, item.baseRef, run)) === null) {
      // The derived image build is the preparation step; pull the exact base
      // tag once if the host cache did not already contain it. The resulting
      // derived image ID is what the run receipt freezes.
      await run(dockerBin, ['pull', item.baseRef])
    }
    const taskKey = digest(
      `${ACP_BOOTSTRAP_IMAGE_CONTRACT}\n${runtimeImageId}\n${item.baseRef}\n${item.requirements.join('\n')}\n${item.systemRequirements.join('\n')}\n${item.gitSources
        .map((source) => `${source.url}\n${source.branch}`)
        .join('\n')}\n${item.rewrittenTest}\n${item.rewrittenFiles
        .map((file) => `${file.relativePath}\n${file.content}`)
        .join('\n')}`,
    )
    const derivedRef = `dsh-evolve-le/verifier-task-${item.task}:${taskKey.slice(0, 20)}`
    let derivedImageId = await inspectImage(dockerBin, derivedRef, run)
    if (derivedImageId === null) {
      const context = `/tmp/dsh-verifier-task-${taskKey.slice(0, 16)}`
      await mkdir(context, { recursive: true })
      // The task image is where Harbor executes its installed ACP setup.  Put
      // every fixed bootstrap prerequisite here during trusted preparation;
      // a network outage during a paid trial must not decide its outcome.
      await writeFile(join(context, 'dsh-harbor-acp-apt-get'), harborAcpAptShim(), 'utf8')
      await writeFile(
        join(context, 'Dockerfile'),
        [
          `FROM ${item.baseRef} AS dsh_task_base`,
          `FROM ${runtimeImageRef} AS dsh_verifier_runtime`,
          ...(item.requirements.length > 0
            ? [
                'FROM dsh_verifier_runtime AS dsh_task_runtime',
                `RUN python -m pip install --disable-pip-version-check --no-cache-dir ${item.requirements.join(' ')}`,
              ]
            : []),
          'FROM dsh_task_base',
          // Harbor's binary ACP setup always asks apt for this fixed list.
          // Install it once in the derived image, before the shim below.
          preparedAptInstallCommand(ACP_BOOTSTRAP_SYSTEM_PACKAGES),
          ...(item.systemRequirements.length > 0
            ? [preparedAptInstallCommand(item.systemRequirements)]
            : []),
          ...item.gitSources.map(
            (source) =>
              `RUN mkdir -p /opt/dsh-evolve-le/verifier-sources/${source.sourceId} && git clone --depth 1 --branch ${source.branch} ${source.url} /opt/dsh-evolve-le/verifier-sources/${source.sourceId}`,
          ),
          `COPY --from=${item.requirements.length > 0 ? 'dsh_task_runtime' : 'dsh_verifier_runtime'} /usr/local /usr/local`,
          `COPY --from=dsh_verifier_runtime ${ACP_RUNTIME_VENV_PATH} ${ACP_RUNTIME_VENV_PATH}`,
          // Do not mask task-agent package management: this shim recognizes
          // only Harbor's exact pre-agent bootstrap commands and delegates all
          // other calls to /usr/bin/apt-get.
          'COPY dsh-harbor-acp-apt-get /usr/local/sbin/apt-get',
          'RUN if test -x /usr/bin/apt-get; then chmod 0755 /usr/local/sbin/apt-get; else rm -f /usr/local/sbin/apt-get; fi',
          'ENV PATH=/usr/local/sbin:${PATH}',
          `ENV DSH_ACP_RUNTIME_READY=1 DSH_ACP_RUNTIME_VENV=${ACP_RUNTIME_VENV_PATH}`,
          'ENV DSH_OFFLINE_VERIFIER=1 UV_OFFLINE=1 UV_PYTHON_DOWNLOADS=never',
          `LABEL org.dsh-evolve-le.verifier-task="${item.task}"`,
          '',
        ].join('\n'),
        'utf8',
      )
      await run(dockerBin, ['build', '--pull=false', '-t', derivedRef, context])
      derivedImageId = await inspectImage(dockerBin, derivedRef, run)
      if (derivedImageId === null) {
        throw new Error(`verifier-image: derived image missing after build for ${item.task}`)
      }
    }
    const outputDir = join(input.outputTasksRoot, item.task)
    await cp(join(input.sourceTasksRoot, item.task), outputDir, { recursive: true })
    await writeFile(
      join(outputDir, 'task.toml'),
      replaceTaskImage(item.sourceToml, derivedRef),
      'utf8',
    )
    await writeFile(join(outputDir, 'tests', 'test.sh'), item.rewrittenTest, 'utf8')
    for (const file of item.rewrittenFiles) {
      await writeFile(join(outputDir, 'tests', file.relativePath), file.content, 'utf8')
    }
    tasks.push({
      task: item.task,
      baseRef: item.baseRef,
      baseImageId:
        (await inspectImage(dockerBin, item.baseRef, run)) ??
        (() => {
          throw new Error(
            `verifier-image: base image ${item.baseRef} disappeared during preparation`,
          )
        })(),
      derivedRef,
      derivedImageId,
      verifierSha256: digest(item.rewrittenTest),
      requirements: item.requirements,
      systemRequirements: item.systemRequirements,
      gitSources: item.gitSources,
    })
  }

  const receipt: VerifierImageReceipt = {
    protocol: VERIFIER_IMAGE_PROTOCOL,
    runtimeImageRef,
    runtimeImageId,
    acpRuntime: {
      package: ACP_RUNTIME_PACKAGE,
      venvPath: ACP_RUNTIME_VENV_PATH,
    },
    runtimeRequirements,
    tasks,
  }
  await writeFile(
    join(input.outputTasksRoot, 'verifier-image-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  )
  return { tasksRoot: input.outputTasksRoot, receipt }
}
