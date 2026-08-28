/**
 * Host-side ACP session driver (Gate 1): speaks the Agent Client Protocol to
 * a capsule runner — `node runner/bin/acp-boot.js <config>` directly, or any
 * `docker run -i` argv wrapping it — over child stdio, using the same
 * `@agentclientprotocol/sdk` connection the locked DSH bridge uses. One
 * round: `initialize` → `session/new` → `session/prompt`, collecting
 * `session/update` notifications, then close stdin and read the runner's
 * final report line from stderr.
 * @module @dsh-evolve-le/core/acp/driver
 */

import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from '@agentclientprotocol/sdk'

/** Everything the driver observed in one ACP round. */
export interface AcpSessionResult {
  exitCode: number | null
  timedOut: boolean
  initialize: { protocolVersion: number }
  sessionId: string
  stopReason: string
  updates: { sessionUpdate: string; content?: { type?: string; text?: string } }[]
  report?: {
    config: string
    sections: { afterBoot: string[]; afterUnload: string[] }
    quiescent: boolean
    timings: { bootMs: number; unloadMs: number }
    error?: string
  }
  stderr: string
}

const REPORT_PREFIX = 'dsh-evolve-le-runner-report:'

/**
 * Run one ACP round against a runner command. `argv[0]` is the executable
 * (e.g. `process.execPath` or `docker`), `argv` its arguments; the child's
 * stdout must speak ACP ndjson and its stderr must end with the runner
 * report line.
 */
export async function runAcpSession(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<AcpSessionResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderrChunks: string[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'))
  })

  const updates: AcpSessionResult['updates'] = []
  const client: Client = {
    async requestPermission() {
      throw new Error('acp driver: permission requests are not part of the replay round')
    },
    async sessionUpdate(params) {
      updates.push(params.update as AcpSessionResult['updates'][number])
    },
  }
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)),
  )

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const round = (async () => {
    const initialize = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'dsh-evolve-le-acp-driver', version: '0.0.1' },
      clientCapabilities: {},
    })
    const session = await connection.newSession({
      cwd: '/capsule',
      mcpServers: [],
    })
    const prompt = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'identity check' }],
    })
    return { initialize, session, prompt }
  })()

  const closed = new Promise<{ code: number | null }>((resolveClosed) => {
    child.on('close', (code) => resolveClosed({ code }))
  })
  const outcome = await Promise.race([
    round.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }),
    ),
    closed.then((info) => ({ ok: false as const, info })),
  ])
  if (outcome.ok) {
    child.stdin!.end()
  } else if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
  const closeInfo = await closed
  clearTimeout(timer)

  const stderr = stderrChunks.join('')
  const reportLine = stderr
    .split('\n')
    .filter((line) => line.startsWith(REPORT_PREFIX))
    .at(-1)
  const report =
    reportLine === undefined
      ? undefined
      : (JSON.parse(reportLine.slice(REPORT_PREFIX.length)) as AcpSessionResult['report'])
  return {
    exitCode: closeInfo.code,
    timedOut,
    ...(outcome.ok
      ? {
          initialize: { protocolVersion: outcome.value.initialize.protocolVersion as number },
          sessionId: outcome.value.session.sessionId,
          stopReason: outcome.value.prompt.stopReason,
        }
      : {
          initialize: { protocolVersion: -1 },
          sessionId: '',
          stopReason: `driver round incomplete: ${'reason' in outcome ? outcome.reason : ''} ${stderr.slice(-500)}`,
        }),
    updates,
    ...(report === undefined ? {} : { report }),
    stderr: stderr.slice(-2000),
  }
}
