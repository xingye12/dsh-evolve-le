/** External foreground shell. Any uncertain outcome destroys the entire domain. */
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { canonicalHash, canonicalJson } from '../state/canonical.js'
import type { ObjectRef, ObjectStore } from '../state/object-store.js'
import { decodeDockerStream, type DockerEngine } from './docker-engine.js'
import { managedShellEnvironment } from './shell-environment.js'
import { ExecutionError, SHELL_PROTOCOL, executionName, type ExecutionSpec } from './types.js'
export interface ShellRequest {
  dshEnv?: unknown
  command: string
  cwd: string
  timeoutMs: number
  invocationId: string
}
export interface ShellResult {
  exitCode: number
  stdout: ObjectRef
  stderr: ObjectRef
  receipt: ObjectRef
}
interface ProcessIdentity {
  pid: number
  startTime: string
}
export class ContainerShell {
  constructor(
    private readonly options: {
      engine: DockerEngine
      store: ObjectStore
      abort: (reason: string) => Promise<void>
    },
  ) {}
  private async census(container: string): Promise<ProcessIdentity[]> {
    const top = await this.options.engine.json<{ Titles: string[]; Processes: string[][] }>(
      'GET',
      `/containers/${container}/top?ps_args=${encodeURIComponent('-eo pid')}`,
    )
    const column = top.Titles.indexOf('PID')
    if (column < 0) throw new ExecutionError('Docker process census lacks PID')
    const identities: ProcessIdentity[] = []
    for (const row of top.Processes) {
      const raw = row[column]
      if (raw === undefined || !/^\d+$/.test(raw))
        throw new ExecutionError('invalid Docker process PID')
      const pid = Number(raw)
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      const parts = stat.slice(end + 2).split(' ')
      if (end < 0 || !parts[19] || !/^\d+$/.test(parts[19]))
        throw new ExecutionError('invalid process start time')
      identities.push({ pid, startTime: parts[19] })
    }
    return identities.sort((a, b) => a.pid - b.pid)
  }
  async run(spec: ExecutionSpec, request: ShellRequest): Promise<ShellResult> {
    if (
      typeof request.command !== 'string' ||
      !request.command.trim() ||
      Buffer.byteLength(request.command) > 65536 ||
      request.command.includes('\0') ||
      typeof request.cwd !== 'string' ||
      posix.normalize(request.cwd) !== request.cwd ||
      !(request.cwd === '/workspace' || request.cwd.startsWith('/workspace/')) ||
      request.cwd.includes('\0') ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(request.invocationId)
    )
      throw new ExecutionError('invalid foreground shell request')
    const timeoutMs = Math.min(
      request.timeoutMs,
      spec.limits.shellTimeoutMs,
      Date.parse(spec.deadlineUtc) - Date.now(),
    )
    if (timeoutMs <= 0) throw new ExecutionError('shell action deadline expired')
    const container = executionName(spec)
    const before = await this.census(container)
    if (!before.length) throw new ExecutionError('shell requires a live proposal domain')
    try {
      const created = await this.options.engine.json<{ Id: string }>(
        'POST',
        `/containers/${container}/exec`,
        {
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: false,
          Tty: false,
          Privileged: false,
          User: '65532:65532',
          WorkingDir: request.cwd,
          Cmd: [
            '/usr/bin/env',
            '-i',
            'HOME=/work/home',
            'TMPDIR=/tmp',
            'PATH=/usr/bin:/bin',
            'LANG=C.UTF-8',
            'TZ=UTC',
            ...Object.entries(managedShellEnvironment(request.dshEnv)).map(
              ([key, value]) => `${key}=${value}`,
            ),
            '/bin/bash',
            '--noprofile',
            '--norc',
            '-c',
            request.command,
          ],
        },
      )
      const response = await this.options.engine.request(
        'POST',
        `/exec/${created.Id}/start`,
        { Detach: false, Tty: false },
        { timeoutMs, maxBytes: spec.limits.outputBytes * 2 + 8192 },
      )
      const actual = await this.options.engine.json<{
        Running: boolean
        ExitCode: number | null
        ContainerID: string
      }>('GET', `/exec/${created.Id}/json`)
      if (actual.Running || !Number.isSafeInteger(actual.ExitCode))
        throw new ExecutionError('shell exit not proven')
      await this.options.engine.request('POST', `/containers/${container}/pause`)
      const state = await this.options.engine.json<{ State: { Paused: boolean } }>(
        'GET',
        `/containers/${container}/json`,
      )
      if (!state.State.Paused) throw new ExecutionError('shell descendant census not frozen')
      const after = await this.census(container)
      if (canonicalJson(before) !== canonicalJson(after))
        throw new ExecutionError('shell descendants or changed process identities remain')
      const output = decodeDockerStream(response.body, spec.limits.outputBytes)
      const stdout = await this.options.store.put(output.stdout, {
        mediaType: 'text/plain; charset=utf-8',
        label: 'DEV_OBSERVED',
      })
      const stderr = await this.options.store.put(output.stderr, {
        mediaType: 'text/plain; charset=utf-8',
        label: 'DEV_OBSERVED',
      })
      const receipt = await this.options.store.put(
        Buffer.from(
          canonicalJson({
            protocol: SHELL_PROTOCOL,
            specDigest: canonicalHash(spec),
            executionId: spec.executionId,
            invocationId: request.invocationId,
            argsDigest: canonicalHash(request),
            execId: created.Id,
            exitCode: actual.ExitCode,
            timeoutMs,
            stdout,
            stderr,
            processCensus: after,
            source: 'executor-observed',
          }),
        ),
        {
          mediaType: 'application/vnd.dsh-evolve-le.shell-receipt+json',
          label: 'CONTROLLER_INTERNAL',
        },
      )
      await this.options.engine.request('POST', `/containers/${container}/unpause`)
      return { exitCode: actual.ExitCode!, stdout, stderr, receipt }
    } catch (error) {
      // abort() must unpause (if necessary), revoke, kill and verify the whole domain.
      await this.options.abort(error instanceof Error ? error.message : 'shell execution failed')
      throw error
    }
  }
}
