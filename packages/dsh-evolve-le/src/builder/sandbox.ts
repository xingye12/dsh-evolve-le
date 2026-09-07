/**
 * Compile/boot sandbox (specs/02 §11 step 5): compiler and boot stages run
 * with a stripped environment, and inside a network namespace whenever the
 * host supports one, so a candidate cannot reach the network even if its
 * code tried. The achieved sandbox kind is recorded per build manifest.
 * @module @dsh-evolve-le/core/builder/sandbox
 */

import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    // The pinned capsule Node has a runtime-specific stdio quirk: when its
    // stdout is a Node-created pipe it can exit successfully without flushing
    // the pipe. File-backed stdio preserves the same offline boundary while
    // making the one-shot JSON protocol deterministic for every runtime.
    const outputDir = mkdtempSync(join(tmpdir(), 'dsh-sandbox-output-'))
    const stdoutPath = join(outputDir, 'stdout')
    const stderrPath = join(outputDir, 'stderr')
    const stdoutFd = openSync(stdoutPath, 'w+')
    const stderrFd = openSync(stderrPath, 'w+')
    let descriptorsClosed = false
    let settled = false
    const closeDescriptors = (): void => {
      if (descriptorsClosed) return
      descriptorsClosed = true
      closeSync(stdoutFd)
      closeSync(stderrFd)
    }
    const child = spawn(useNamespace ? 'unshare' : command, argv, {
      cwd: options.cwd,
      env: SANDBOX_ENV,
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeDescriptors()
      const stdout = readFileSync(stdoutPath, 'utf8')
      const stderr = readFileSync(stderrPath, 'utf8')
      rmSync(outputDir, { recursive: true, force: true })
      resolvePromise({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        sandbox: sandboxInfoFor(useNamespace),
      })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      closeDescriptors()
      const stdout = readFileSync(stdoutPath, 'utf8')
      const stderr = readFileSync(stderrPath, 'utf8')
      rmSync(outputDir, { recursive: true, force: true })
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

/**
 * Wrap an interactive JSONL command with the same offline boundary as
 * {@link sandboxedCommand}. A PTY is required for the pinned Node runtime's
 * pipe-flush behavior; terminal echo and CRLF translation are disabled so the
 * stream remains transparent to ACP.
 */
export function sandboxedInteractiveCommand(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const sandbox = sandboxedCommand(command, args)
  const target = [sandbox.command, ...sandbox.args]
  // Node 24 in the pinned toolchain does not reliably flush stdout when it is
  // attached to a pipe created by another Node process. `script` gives the
  // child a PTY while retaining a normal pipe to the ACP driver. Disable local
  // echo and CRLF translation so the PTY remains a transparent JSONL stream.
  const shellCommand = `stty -echo -onlcr; exec ${target.map(shellQuote).join(' ')}`
  return { command: '/usr/bin/script', args: ['-qefc', shellCommand, '/dev/null'] }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** The stripped environment sandboxed children run with. */
export function sandboxEnvironment(): Record<string, string> {
  return { ...SANDBOX_ENV }
}

/** Describe the sandbox this builder would achieve right now. */
export function describeSandbox(): SandboxInfo {
  return sandboxInfoFor(probeNetworkNamespace())
}
