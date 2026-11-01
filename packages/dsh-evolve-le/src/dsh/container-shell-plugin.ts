/** Standard Cordis service composition; all effects execute in the external broker. */
import type { Context } from '@deepseek-ai/cordis'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { callActionRpc } from '../execution/rpc.js'
import { managedShellEnvironment } from '../execution/shell-environment.js'
import { ExecutionError } from '../execution/types.js'

export const name = 'proposal-container-shell'
export const inject: string[] = []
export interface Config {
  socketPath: string
  executionId: string
  timeoutMs: number
  outputBytes: number
}
interface Request {
  dshEnv?: unknown
  command: string
  workdir?: string
  timeoutMs?: number
  signal?: AbortSignal
  stdin?: string
  env?: Record<string, string>
  sandboxPolicy?: unknown
}
interface Resolved {
  dshEnv: Record<string, string>
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal
}
/** The exact superclass is late-bound from the pinned capsule, not controller dependencies. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (
    !config.socketPath.startsWith('/') ||
    !config.executionId ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs <= 0 ||
    !Number.isSafeInteger(config.outputBytes) ||
    config.outputBytes <= 0
  )
    throw new ExecutionError('invalid container shell configuration')
  const load = (specifier: string): Promise<unknown> => import(specifier)
  const module = (await load('@deepseek-ai/dsh-shell')) as {
    ShellExecutor: new (ctx: Context) => object
  }
  if (typeof module.ShellExecutor !== 'function')
    throw new ExecutionError('pinned DSH shell service unavailable')
  class ProposalShell extends module.ShellExecutor {
    // Per-call escalation is intentionally absent. The OS domain is externally frozen.
    get sandboxMode(): undefined {
      return undefined
    }
    resolve(request: Request): Resolved {
      if (
        typeof request.command !== 'string' ||
        !request.command.trim() ||
        request.env !== undefined ||
        request.stdin !== undefined ||
        request.sandboxPolicy !== undefined
      )
        throw new ExecutionError('unsupported container shell request')
      const workdir = request.workdir ?? '/workspace'
      if (
        posix.normalize(workdir) !== workdir ||
        !(workdir === '/workspace' || workdir.startsWith('/workspace/'))
      )
        throw new ExecutionError('shell cwd outside workspace')
      const timeout = request.timeoutMs ?? config.timeoutMs
      if (!Number.isSafeInteger(timeout) || timeout <= 0)
        throw new ExecutionError('invalid shell timeout')
      return {
        command: request.command,
        workdir,
        timeoutMs: Math.min(timeout, config.timeoutMs),
        stdoutMaxBytes: config.outputBytes,
        dshEnv: managedShellEnvironment(request.dshEnv),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }
    }
    async run(spec: Resolved): Promise<unknown> {
      const value = (await callActionRpc({
        socketPath: config.socketPath,
        executionId: config.executionId,
        invocationId: `shell-${randomUUID()}`,
        method: 'shell',
        args: {
          command: spec.command,
          cwd: spec.workdir,
          timeoutMs: spec.timeoutMs,
          dshEnv: spec.dshEnv,
        },
        timeoutMs: spec.timeoutMs + 30000,
        maxFrameBytes: config.outputBytes * 2 + 8192,
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      })) as { exitCode?: unknown; stdout?: unknown; stderr?: unknown; receiptDigest?: unknown }
      if (
        !Number.isSafeInteger(value.exitCode) ||
        typeof value.stdout !== 'string' ||
        typeof value.stderr !== 'string' ||
        typeof value.receiptDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.receiptDigest)
      )
        throw new ExecutionError('invalid external shell receipt')
      return {
        exitCode: value.exitCode,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: value.stdout, truncated: false },
        stderr: { text: value.stderr, truncated: false },
      }
    }
    start(): never {
      throw new ExecutionError('background shell is disabled')
    }
  }
  // Loading a real ShellExecutor subclass registers ctx.shell with normal Cordis ownership.
  ctx.plugin(ProposalShell)
}
