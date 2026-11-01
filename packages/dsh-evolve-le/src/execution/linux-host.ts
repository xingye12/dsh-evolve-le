/** Linux implementation of mounts/cgroups/export. Requires a delegated v2 host. */
import { spawn } from 'node:child_process'
import { mkdir, readFile, lstat, writeFile, rmdir, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { canonicalHash, canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { type ObjectRef, type ObjectStore } from '../state/object-store.js'
import { captureSourceSnapshot, readSourceSnapshot } from './snapshot.js'
import { publishCanonical, readCanonicalFile } from './evidence.js'
import { verifyValidatorExport, readValidatorExport } from './validator-export.js'
import { readCapabilityFile } from './files.js'
import { buildCanonicalTar, type CanonicalSource } from '../candidate/canonical.js'
import { sha256Hex } from '../state/canonical.js'
import {
  verifyExecutionInputs,
  executionInputArtifacts,
  materializeExecutionInputs,
} from './input-manifest.js'
import { readSubmission } from './submission.js'
import { parseCgroupSample, type CgroupSample } from './resources.js'
import {
  executionName,
  ExecutionError,
  type ExecutionSpec,
  type ExecutionOutcome,
} from './types.js'
import type { ExecutionHost } from './docker-executor.js'
import { DockerApiError, type DockerEngine } from './docker-engine.js'
import type { DockerSecurity } from './docker-policy.js'

export interface ActionLifecycle {
  /** External capability checks must fence even already-open socket clients. */
  quiesce(executionId: string): Promise<void>
  resume(executionId: string): Promise<void>
  revoke(executionId: string): Promise<void>
  cancelChildren(executionId: string): Promise<void>
  close(executionId: string): Promise<void>
  artifacts(executionId: string): Promise<ObjectRef[]>
}
async function runMount(argv: string[]): Promise<void> {
  const command = argv[0]!,
    args = argv.slice(1)
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new ExecutionError('mount operation timed out; reconcile registered mount'))
    }, 10000)
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString('utf8')).slice(-2048)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveRun()
      else reject(new ExecutionError(`mount operation failed (${code}): ${stderr}`))
    })
  })
}
interface OwnedMount {
  target: string
  dev: number
  ino: number
  executionMode: 'exec' | 'noexec'
  mountId: string
  bytes: number
  inodes: number
}
function unescapeMount(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  )
}
async function mountInfo(
  path: string,
): Promise<{ id: string; fs: string; options: string } | null> {
  for (const line of (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n')) {
    const parts = line.split(' ')
    if (unescapeMount(parts[4] ?? '') !== path) continue
    const separator = parts.indexOf('-')
    return {
      id: parts[0]!,
      fs: parts[separator + 1]!,
      options: `${parts[5]},${parts[separator + 3]}`,
    }
  }
  return null
}
async function noSymlinks(path: string): Promise<void> {
  const absolute = resolve(path)
  if (absolute !== path) throw new ExecutionError('noncanonical host path')
  let current = '/'
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part)
    const s = await lstat(current)
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new ExecutionError('symlink/non-directory in host path')
  }
}
/** Execution permission is an explicit frozen validator profile, never an implicit fallback. */
export function executionTmpfsMode(
  spec: ExecutionSpec,
  area: 'workspace' | 'work',
  policy: unknown,
): 'exec' | 'noexec' {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy))
    throw new ExecutionError('invalid tmpfs execution profile')
  const profile = (policy as { workspaceExecution?: unknown }).workspaceExecution
  if (spec.kind === 'proposal') {
    if (profile !== undefined)
      throw new ExecutionError('validator exec profile cannot apply to proposal')
    return 'noexec'
  }
  if (profile !== 'validator-exec/v1')
    throw new ExecutionError('missing frozen validator workspace execution profile')
  return area === 'workspace' ? 'exec' : 'noexec'
}
export class LinuxExecutionHost implements ExecutionHost {
  constructor(
    private readonly options: {
      generationOnly?: true
      root: string
      cgroupRoot: string
      store: ObjectStore
      engine: DockerEngine
      security: DockerSecurity
      inputManifest?: ObjectRef
      actions: ActionLifecycle
      validator?: {
        sourceSnapshot: ObjectRef
        dependencyClosureSha256: string
        runnerSourceDir: string
      }
    },
  ) {}
  private get local(): boolean {
    return this.options.security.profile === 'local-generation/v1'
  }
  private path(spec: ExecutionSpec): string {
    return join(this.options.root, executionName(spec))
  }
  private cgroup(spec: ExecutionSpec): string {
    return join(this.options.cgroupRoot, executionName(spec))
  }
  private async facts(value: unknown): Promise<ObjectRef> {
    return this.options.store.put(Buffer.from(canonicalJson(value)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
  }
  async verifyInputs(spec: ExecutionSpec): Promise<ObjectRef> {
    if (!this.options.inputManifest)
      throw new ExecutionError('frozen execution input manifest is required')
    return verifyExecutionInputs(this.options.store, this.options.inputManifest, spec)
  }
  async preflight(spec: ExecutionSpec): Promise<ObjectRef> {
    if (process.platform !== 'linux' || process.getuid?.() !== 0)
      throw new ExecutionError('Linux mount executor requires trusted root supervisor')
    await noSymlinks(this.options.root)
    if (!this.local) await noSymlinks(this.options.cgroupRoot)
    const rootStat = await lstat(this.options.root)
    if (rootStat.uid !== 0 || (rootStat.mode & 0o022) !== 0)
      throw new ExecutionError('executor root must be root-owned and not group/world writable')
    let controllers: string[] = []
    if (!this.local) {
      if ((await statfs(this.options.cgroupRoot)).type !== 0x63677270)
        throw new ExecutionError('delegated resource root is not cgroup v2')
      controllers = (await readFile(join(this.options.cgroupRoot, 'cgroup.controllers'), 'utf8'))
        .trim()
        .split(/\s+/)
      const subtree = (
        await readFile(join(this.options.cgroupRoot, 'cgroup.subtree_control'), 'utf8')
      )
        .trim()
        .split(/\s+/)
      for (const controller of ['cpu', 'memory', 'pids'])
        if (!controllers.includes(controller) || !subtree.includes(controller))
          throw new ExecutionError(`missing delegated cgroup ${controller}`)
      const profiles = await readFile('/sys/kernel/security/apparmor/profiles', 'utf8').catch(
        () => {
          throw new ExecutionError('AppArmor not available')
        },
      )
      if (!profiles.split('\n').includes(`${this.options.security.apparmorProfile} (enforce)`))
        throw new ExecutionError('required AppArmor profile is not loaded in enforce mode')
    } else if (!this.options.generationOnly || spec.kind !== 'proposal') {
      throw new ExecutionError('local profile requires generation-only proposal')
    }
    const policy = parseCanonicalJson(
      (await this.options.store.read(spec.policy)).toString('utf8'),
    ) as { seccompJson?: unknown; apparmorProfile?: unknown; profile?: unknown }
    if (
      policy.profile !== this.options.security.profile ||
      policy.seccompJson !== this.options.security.seccompJson ||
      policy.apparmorProfile !== this.options.security.apparmorProfile
    )
      throw new ExecutionError('security policy differs from frozen spec')
    executionTmpfsMode(spec, 'workspace', policy)
    const expected = {
      '/input': 'input',
      '/gateway': 'ipc',
      '/workspace': 'workspace',
      '/work': 'work',
      '/dependencies': 'dependencies',
      '/toolchain': 'toolchain',
    }
    for (const mount of spec.mounts)
      if (mount.source !== join(this.path(spec), expected[mount.target]))
        throw new ExecutionError('mount not in exclusive registered action directory')
    if (
      !this.options.inputManifest ||
      !spec.inputs.some((ref) => canonicalJson(ref) === canonicalJson(this.options.inputManifest))
    )
      throw new ExecutionError(
        'frozen execution input manifest must be bound before resource admission',
      )
    return this.facts({
      kernel: (await readFile('/proc/sys/kernel/osrelease', 'utf8')).trim(),
      cgroupRoot: this.options.cgroupRoot,
      controllers,
      profile: this.local ? 'local-generation/v1' : this.options.security.apparmorProfile,
      resourceAccounting: this.local ? 'docker-hard-limits+wall-clock' : 'delegated-cgroup-v2',
      specDigest: canonicalHash(spec),
    })
  }
  async prepare(spec: ExecutionSpec): Promise<ObjectRef> {
    const root = this.path(spec)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await noSymlinks(root)
    await publishCanonical(join(root, 'host-intent.json'), {
      specDigest: canonicalHash(spec),
      executionId: spec.executionId,
    })
    // DockerExecutor has reserved this execution before calling host.prepare.
    if (!this.options.inputManifest)
      throw new ExecutionError('missing frozen execution input manifest')
    await materializeExecutionInputs(this.options.store, this.options.inputManifest, root)
    const inputVerification = await this.verifyInputs(spec)
    for (const mount of spec.mounts) {
      if (!['/workspace', '/work'].includes(mount.target)) await noSymlinks(mount.source)
    }
    const cgroup = this.cgroup(spec)
    if (!this.local) {
      await mkdir(cgroup)
      // A retained parent survives deletion of Docker's child cgroup.
      await writeFile(join(cgroup, 'cpu.max'), `${spec.limits.cpuMillis * 100} 100000`)
      await writeFile(join(cgroup, 'memory.max'), String(spec.limits.memoryBytes))
      await writeFile(join(cgroup, 'memory.swap.max'), '0')
      await writeFile(join(cgroup, 'pids.max'), String(spec.limits.pids))
      await writeFile(join(cgroup, 'cgroup.subtree_control'), '+cpu +memory +pids')
    }
    const policy = parseCanonicalJson((await this.options.store.read(spec.policy)).toString('utf8'))
    const mounts: OwnedMount[] = []
    for (const name of ['workspace', 'work'] as const) {
      const target = join(root, name),
        limit = spec.limits[name],
        executionMode = executionTmpfsMode(spec, name, policy)
      await mkdir(target, { mode: 0o700 })
      await publishCanonical(join(root, `${name}-mount-intent.json`), {
        target,
        executionMode,
        ...limit,
      })
      if (await mountInfo(target)) throw new ExecutionError('refusing to reuse an existing mount')
      await runMount([
        '/usr/bin/mount',
        '-t',
        'tmpfs',
        '-o',
        `size=${limit.bytes},nr_inodes=${limit.inodes},nosuid,nodev,${executionMode},mode=0750,uid=65532,gid=65532`,
        'tmpfs',
        target,
      ])
      const info = await mountInfo(target),
        stat = await lstat(target)
      if (
        !info ||
        info.fs !== 'tmpfs' ||
        !info.options.includes('nosuid') ||
        !info.options.includes('nodev') ||
        info.options.includes('noexec') !== (executionMode === 'noexec')
      )
        throw new ExecutionError('tmpfs policy not achieved')
      const owned: OwnedMount = {
        target,
        dev: stat.dev,
        ino: stat.ino,
        mountId: info.id,
        executionMode,
        ...limit,
      }
      await publishCanonical(join(root, `${name}-mount.json`), owned)
      mounts.push(owned)
    }
    return this.facts({
      specDigest: canonicalHash(spec),
      inputVerification,
      mounts,
      cgroup: this.local ? null : cgroup,
    })
  }
  async sample(spec: ExecutionSpec): Promise<CgroupSample> {
    if (this.local) {
      // Resource caps are enforced by Docker; local profile does not claim cumulative CPU accounting.
      let state: { Running?: boolean; Paused?: boolean; OOMKilled?: boolean } = {}
      try {
        const actual = await this.options.engine.json<{ State: typeof state }>(
          'GET',
          `/containers/${executionName(spec)}/json`,
        )
        state = actual.State
      } catch (error) {
        if (!(error instanceof DockerApiError && error.status === 404)) throw error
      }
      return {
        accounting: 'docker-hard-limits+wall-clock',
        cpuTimeUs: 0,
        memoryPeakBytes: 0,
        oom: state.OOMKilled ? 1 : 0,
        oomKill: state.OOMKilled ? 1 : 0,
        pidsCurrent: state.Running ? 1 : 0,
        pidsMaxEvents: 0,
        populated: !!state.Running,
        frozen: !!state.Paused,
        ioStat: '',
      }
    }
    const root = this.cgroup(spec),
      files: Record<string, string> = {}
    for (const name of [
      'cpu.stat',
      'memory.peak',
      'memory.events',
      'pids.current',
      'pids.events',
      'cgroup.events',
      'io.stat',
    ])
      files[name] = await readFile(join(root, name), 'utf8')
    return parseCgroupSample(files)
  }
  async quiesceSnapshot(spec: ExecutionSpec, child: string): Promise<ObjectRef> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(child))
      throw new ExecutionError('invalid child selector')
    const root = this.path(spec),
      container = executionName(spec)
    await publishCanonical(join(root, `snapshot-intent-${child}-${Date.now()}.json`), {
      child,
      specDigest: canonicalHash(spec),
    })
    await this.options.actions.quiesce(spec.executionId)
    let paused = false
    try {
      await this.options.engine.request('POST', `/containers/${container}/pause`)
      paused = true
      const actual = await this.options.engine.json('GET', `/containers/${container}/json`)
      if (!(actual.State as { Paused: boolean }).Paused)
        throw new ExecutionError('Docker pause not observed')
      if (Date.now() >= Date.parse(spec.deadlineUtc))
        throw new ExecutionError('snapshot deadline expired')
      const ref = await captureSourceSnapshot({
        root: join(root, 'workspace', child),
        spec,
        store: this.options.store,
        child,
      })
      await readSourceSnapshot(this.options.store, ref)
      return ref
    } finally {
      // On unknown pause failure, caller must fail/cancel the execution, never accept a snapshot.
      if (paused) {
        await this.options.engine.request('POST', `/containers/${container}/unpause`)
        await this.options.actions.resume(spec.executionId)
      }
    }
  }
  revoke(spec: ExecutionSpec): Promise<void> {
    return this.options.actions.revoke(spec.executionId)
  }
  cancelChildren(spec: ExecutionSpec): Promise<void> {
    return this.options.actions.cancelChildren(spec.executionId)
  }
  closeSockets(spec: ExecutionSpec): Promise<void> {
    return this.options.actions.close(spec.executionId)
  }
  async export(
    spec: ExecutionSpec,
    outcome: ExecutionOutcome,
  ): Promise<{ artifacts: ObjectRef[]; outcome: ExecutionOutcome; failureReason?: string }> {
    const artifacts = await this.options.actions.artifacts(spec.executionId)
    if (this.options.inputManifest)
      artifacts.push(
        ...(await executionInputArtifacts(this.options.store, this.options.inputManifest)),
      )
    const finalResource = await this.sample(spec)
    if (finalResource.populated || finalResource.pidsCurrent !== 0)
      throw new ExecutionError('export requires an empty process domain')
    artifacts.push(await this.facts({ finalResource }))
    if (spec.kind !== 'proposal') {
      for (const name of ['validator-result.json', 'validator-failure.json']) {
        try {
          const raw = await readCapabilityFile(
            join(this.path(spec), 'work'),
            name,
            spec.limits.outputBytes,
          )
          const ref = await this.options.store.put(raw, {
            mediaType: 'application/vnd.dsh-evolve-le.worker-diagnostic+json',
            label: 'DEV_OBSERVED',
          })
          artifacts.push(ref, await this.facts({ source: 'worker-reported', name, content: ref }))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            artifacts.push(
              await this.facts({
                source: 'executor-observed',
                name,
                error: 'diagnostic unavailable or over limit',
              }),
            )
        }
      }
      if (outcome !== 'SUCCEEDED') return { artifacts, outcome }
      const input = this.options.validator
      if (!input)
        return {
          artifacts,
          outcome: 'INCOMPLETE',
          failureReason: 'validator frozen input is unavailable',
        }
      try {
        if (!spec.inputs.some((ref) => canonicalJson(ref) === canonicalJson(input.sourceSnapshot)))
          throw new ExecutionError('validator source snapshot absent from frozen spec inputs')
        const snapshot = await readSourceSnapshot(this.options.store, input.sourceSnapshot)
        if (snapshot.executionId !== spec.parentExecutionId)
          throw new ExecutionError('validator source belongs to another proposal execution')
        const files: CanonicalSource['files'] = []
        for (const file of snapshot.files)
          files.push({
            path: file.path,
            mode: file.mode,
            content: await this.options.store.read(file.content),
          })
        const tar = buildCanonicalTar(files),
          source: CanonicalSource = {
            files,
            tar,
            sha256: sha256Hex(tar),
            bytes: snapshot.totalBytes,
          }
        const verified = await verifyValidatorExport({
          executionId: spec.executionId,
          workspaceRoot: join(this.path(spec), 'workspace'),
          workRoot: join(this.path(spec), 'work'),
          source,
          dependencyClosureSha256: input.dependencyClosureSha256,
          runnerSourceDir: input.runnerSourceDir,
          store: this.options.store,
          limits: {
            bytes: spec.limits.workspace.bytes,
            inodes: spec.limits.workspace.inodes,
            fileBytes: spec.limits.fileBytes,
            diagnosticBytes: spec.limits.outputBytes,
          },
        })
        await readValidatorExport(this.options.store, verified.receipt, {
          executionId: spec.executionId,
          sourceDigest: `sha256:${source.sha256}`,
        })
        await publishCanonical(join(this.path(spec), 'validator-export.json'), verified.receipt)
        artifacts.push(
          input.sourceSnapshot,
          ...snapshot.files.map((f) => f.content),
          ...verified.artifacts,
        )
        return { artifacts, outcome }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'validator export verification failed'
        artifacts.push(
          await this.facts({
            source: 'executor-observed',
            event: 'validator-export-rejected',
            reason,
          }),
        )
        return { artifacts, outcome: 'FAILED', failureReason: reason }
      }
    }
    // Submission is written by the trusted action broker, never by the worker.
    const submitted = await readSubmission({
      root: this.path(spec),
      ...(this.options.generationOnly ? { generationOnly: true as const } : {}),
      spec,
      store: this.options.store,
    })
    if (!submitted)
      return {
        artifacts,
        outcome: outcome === 'SUCCEEDED' ? 'INCOMPLETE' : outcome,
        failureReason: 'no trusted submission receipt',
      }
    artifacts.push(...submitted.artifacts)
    return { artifacts, outcome }
  }
  async cleanup(spec: ExecutionSpec): Promise<ObjectRef> {
    const root = this.path(spec)
    for (const name of ['workspace', 'work']) {
      const marker = join(root, `${name}-mount.json`)
      let owned: OwnedMount
      try {
        owned = (await readCanonicalFile(marker)) as OwnedMount
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (await mountInfo(join(root, name)))
            throw new ExecutionError(
              'mount effect lacks ownership receipt; reconcile before cleanup',
            )
          continue
        }
        throw error
      }
      if (owned.target !== join(root, name)) throw new ExecutionError('owned mount path mismatch')
      const current = await mountInfo(owned.target)
      if (current) {
        const stat = await lstat(owned.target)
        if (
          current.id !== owned.mountId ||
          stat.dev !== owned.dev ||
          stat.ino !== owned.ino ||
          current.fs !== 'tmpfs'
        )
          throw new ExecutionError('owned mount identity mismatch')
        await runMount(['/usr/bin/umount', owned.target])
      }
      await rmdir(owned.target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    if (!this.local) {
      const group = this.cgroup(spec)
      const stat = await lstat(group).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (stat) {
        if ((await this.sample(spec)).populated) throw new ExecutionError('cgroup still populated')
        await rmdir(group)
      }
    }
    return this.facts({
      executionId: spec.executionId,
      specDigest: canonicalHash(spec),
      resourceAccounting: this.local ? 'docker-hard-limits+wall-clock' : 'delegated-cgroup-v2',
      mountsRemoved: true,
      cgroupRemoved: !this.local,
    })
  }
}
