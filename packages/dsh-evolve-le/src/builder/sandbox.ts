/**
 * Compile/boot sandbox (specs/02 §11 step 5): compiler and boot stages run
 * with a stripped environment, and inside a network namespace whenever the
 * host supports one, so a candidate cannot reach the network even if its
 * code tried. The achieved sandbox kind is recorded per build manifest.
 * @module @dsh-evolve-le/core/builder/sandbox
 */

import { spawn, spawnSync } from 'node:child_process'

/** Sandbox kind actually achieved for a run. */
export interface SandboxInfo {
  kind: 'namespace' | 'host-restricted'
  detail: string
}

let namespaceSupport: boolean | undefined

/** True when `unshare --net` works on this host (probed once per process). */
export function probeNetworkNamespace(): boolean {
  if (namespaceSupport === undefined) {
    const probe = spawnSync('unshare', ['--net', 'true'], { timeout: 10_000 })
    namespaceSupport = probe.status === 0
  }
  return namespaceSupport
}

/** Minimal, deterministic environment for sandboxed children. */
const SANDBOX_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  LANG: 'C',
  LC_ALL: 'C',
  TZ: 'UTC',
  SOURCE_DATE_EPOCH: '0',
}

export interface SandboxedRun {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  sandbox: SandboxInfo
}

/**
 * Run a command offline with a clean environment. When the host supports
 * network namespaces the child additionally runs under `unshare --net`;
 * otherwise the run is honest about being host-restricted (still offline by
 * environment stripping, never by trust).
 */
export function runSandboxed(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<SandboxedRun> {
  const useNamespace = probeNetworkNamespace()
  const argv = useNamespace ? ['--net', command, ...args] : args
  return new Promise((resolvePromise) => {
    const child = spawn(useNamespace ? 'unshare' : command, argv, {
      cwd: options.cwd,
      env: SANDBOX_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        sandbox: sandboxInfoFor(useNamespace),
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({
        code,
        stdout,
        stderr,
        timedOut,
        sandbox: sandboxInfoFor(useNamespace),
      })
    })
  })
}

function sandboxInfoFor(useNamespace: boolean): SandboxInfo {
  return useNamespace
    ? { kind: 'namespace', detail: 'unshare --net (network namespace, no interfaces)' }
    : {
        kind: 'host-restricted',
        detail: 'stripped environment, no proxy/registry vars; namespace unavailable',
      }
}

/**
 * Wrap a command for offline execution exactly the way {@link runSandboxed}
 * would, for callers that need interactive stdio with the same guarantees.
 */
export function sandboxedCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  return probeNetworkNamespace()
    ? { command: 'unshare', args: ['--net', command, ...args] }
    : { command, args }
}

/** The stripped environment sandboxed children run with. */
export function sandboxEnvironment(): Record<string, string> {
  return { ...SANDBOX_ENV }
}

/** Describe the sandbox this builder would achieve right now. */
export function describeSandbox(): SandboxInfo {
  return sandboxInfoFor(probeNetworkNamespace())
}
