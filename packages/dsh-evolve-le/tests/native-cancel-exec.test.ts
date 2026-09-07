/**
 * Native cancel-exec E2E (ADR-030, specs/07 §3): the cancel path task #4's
 * live-solve E2E does NOT cover — session/cancel landing while a TOOL, not
 * the model request, is in flight. Drive the native branch of acp-boot over
 * real stdio with the real Cordis Loader + pinned upstream spine closure +
 * real HTTPS solve gateway; the scripted upstream's first reply is a
 * solve_exec tool call for a long-running command, and the test cancels
 * while the terminal runs. Asserts, end to end over the wire:
 *
 *   - the upstream AgentLoop's per-step abort signal reaches the tool's
 *     execute (exec.signal — executeToolCalls threads the step signal into
 *     every ToolExecutionInput), so the abort listener in native-solve-tools
 *     fires killOnce();
 *   - killOnce() crosses the ACP stdio transport exactly once — the client's
 *     killTerminal handler runs once even though the aborted branch awaits
 *     killOnce() again (the memoized kill promise);
 *   - the killed terminal actually exits (SIGKILL observed via
 *     waitForTerminalExit), the prompt settles with stopReason 'cancelled'
 *     (the loop's turn/end record), and the capsule unloads quiescent.
 *
 * Skips loudly when the content-addressed spine closure cache is absent —
 * same precondition as the native live-solve E2E.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import { openSolveGateway, type SolveGateway } from '../src/solver/gateway.js'
import { NATIVE_DSH_PACKAGE_PINS } from '../src/dsh/native-composition.js'
import type { RemoteRoutePlan } from '../src/proposer/remote-gateway.js'

const exec = promisify(execFile)

const acpBootPath = fileURLToPath(new URL('../lib/bin/acp-boot.js', import.meta.url))
const REPORT_PREFIX = 'dsh-evolve-le-runner-report:'

/** Builder closure cache layout: <root>/node_modules/<pkg>. */
const CLOSURE_CANDIDATES = [
  process.env['DSH_NATIVE_CLOSURE_ROOT'],
  '/tmp/dsh-native-closure-calc',
].filter((value): value is string => value !== undefined)

function findClosureRoot(): string | undefined {
  return CLOSURE_CANDIDATES.find((root) =>
    NATIVE_DSH_PACKAGE_PINS.every(([name]) =>
      existsSync(join(root, 'node_modules', ...name.split('/'), 'package.json')),
    ),
  )
}

const closureRoot = findClosureRoot()
const describeNative = closureRoot === undefined ? describe.skip : describe

interface RunnerReport {
  config: string
  sections: { afterBoot: string[]; afterUnload: string[] }
  quiescent: boolean
  timings: { bootMs: number; unloadMs: number }
  error?: string
}

const PLAN: Omit<RemoteRoutePlan, 'baseUrl'> = {
  routeId: 'deepseek/zen-compatible',
  model: 'deepseek-v4-flash',
  temperature: 0,
  maxOutputTokens: 512,
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
}

const workRoots: string[] = []

afterAll(async () => {
  await Promise.all(workRoots.map((root) => rm(root, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  workRoots.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Test client: terminal surface with kill/wait instrumentation. The cancel
// assertions read `killedTerminals` (exactly-once kill over the wire) and
// `exitStatuses` (the killed process really died).
// ---------------------------------------------------------------------------

interface TerminalState {
  child: ReturnType<typeof spawn>
  output: string
  exitStatus: { exitCode: number | null; signal: string | null } | null
  exited: Promise<{ exitCode: number | null; signal: string | null }>
}

class CancelExecTestClient implements Client {
  readonly terminalCalls: { command: string; args: string[]; cwd: string | null | undefined }[] = []
  readonly killedTerminals: string[] = []
  readonly releasedTerminals: string[] = []
  readonly exitStatuses = new Map<string, { exitCode: number | null; signal: string | null }>()
  readonly updates: { sessionUpdate: string }[] = []
  private readonly terminals = new Map<string, TerminalState>()
  private nextTerminalId = 0

  async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('cancel-exec test client: permission requests are not part of the round')
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params.update as { sessionUpdate: string })
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await writeFile(params.path, params.content, 'utf8')
    return {}
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return { content: await readFile(params.path, 'utf8') }
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.terminalCalls.push({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd,
    })
    const id = `t${String(this.nextTerminalId)}`
    this.nextTerminalId += 1
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const state: TerminalState = {
      child,
      output: '',
      exitStatus: null,
      exited: new Promise((resolveExit) => {
        child.on('exit', (code, signal) => {
          state.exitStatus = { exitCode: code, signal: signal ?? null }
          this.exitStatuses.set(id, { exitCode: code, signal: signal ?? null })
          resolveExit({ exitCode: code, signal: signal ?? null })
        })
      }),
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      state.output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      state.output += chunk.toString('utf8')
    })
    this.terminals.set(id, state)
    return { terminalId: id }
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const state = this.require(params.terminalId)
    await new Promise<void>((resolveTick) => setImmediate(resolveTick))
    return { output: state.output, exitStatus: state.exitStatus, truncated: false }
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    const state = this.require(params.terminalId)
    const exit = await state.exited
    return { exitCode: exit.exitCode, signal: exit.signal }
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    this.killedTerminals.push(params.terminalId)
    this.require(params.terminalId).child.kill('SIGKILL')
    return {}
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    this.releasedTerminals.push(params.terminalId)
    const state = this.terminals.get(params.terminalId)
    if (state !== undefined && state.exitStatus === null) state.child.kill('SIGKILL')
    this.terminals.delete(params.terminalId)
    return {}
  }

  private require(terminalId: string): TerminalState {
    const state = this.terminals.get(terminalId)
    if (state === undefined) {
      throw new Error(`cancel-exec test client: unknown terminal ${terminalId}`)
    }
    return state
  }
}

// ---------------------------------------------------------------------------
// Scripted upstream: one solve_exec tool call for a command that outlives the
// test unless killed, then (unreachable) text. The cancel must land while the
// terminal runs — the second reply is a fallback the round never reaches.
// ---------------------------------------------------------------------------

class ScriptedExecUpstream {
  readonly requests: Array<{ auth: string | undefined }> = []
  private readonly server: Server

  constructor(command: string, args: string[]) {
    this.server = createHttpServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        this.requests.push({ auth: req.headers['authorization'] })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_exec_0',
                      type: 'function',
                      function: {
                        name: 'solve_exec',
                        arguments: JSON.stringify({ command, args }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 41, completion_tokens: 7 },
          }),
        )
      })
    })
  }

  listen(): Promise<string> {
    return new Promise((resolveListen) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo
        resolveListen(`http://127.0.0.1:${String(address.port)}/v1`)
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolveClose) => this.server.close(() => resolveClose()))
  }
}

// ---------------------------------------------------------------------------
// Fixture: composition wiring the pinned spine closure into the Loader.
// ---------------------------------------------------------------------------

async function buildNativeComposition(dir: string, closure: string): Promise<string> {
  // Same anchoring as the native live-solve E2E: symlink the closure's
  // node_modules beside the composition and anchor bare specifiers at the
  // closure tree via DSH_BOOT_BARE_MODULE_BASE_URL.
  await symlink(join(closure, 'node_modules'), join(dir, 'node_modules'), 'dir')
  const configPath = join(dir, 'cordis.yml')
  await writeFile(
    configPath,
    [
      '# native cancel-exec E2E composition (real upstream spine, hermetic)',
      '- id: native-agent-spine',
      "  name: '@deepseek-ai/dsh-agent-spine-demo'",
      '  config:',
      `    dshHome: ${join(dir, 'dsh-home')}`,
      '    workspaceContext: false',
      '    includeRuntimeContext: false',
      '    skills:',
      '      enabled: false',
      '    goals: false',
      '    toolBash: false',
      '    toolJobs: false',
      '',
    ].join('\n'),
    'utf8',
  )
  return configPath
}

async function mountTls(
  gateway: SolveGateway,
  caDir: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createHttpsServer(
    {
      key: await readFile(join(caDir, 'server.key')),
      cert: await readFile(join(caDir, 'server.crt')),
    },
    gateway.handler,
  )
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address() as AddressInfo
  return {
    url: `https://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  }
}

// ---------------------------------------------------------------------------
// The E2E.
// ---------------------------------------------------------------------------

describeNative('capsule native cancel-exec E2E (ADR-030: session/cancel kills the in-flight terminal)', () => {
  let caDir = ''

  beforeAll(async () => {
    expect(existsSync(acpBootPath), `built runner missing (run \`pnpm build\` first)`).toBe(true)
    caDir = await freshScratch('native-cancel-exec-ca-')
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(caDir, 'server.key'),
      '-out',
      join(caDir, 'server.crt'),
      '-subj',
      '/CN=127.0.0.1',
      '-days',
      '2',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ])
  }, 30_000)

  it('session/cancel mid-tool-execution fires solve_exec kill-once over the wire and settles cancelled', async () => {
    const root = await freshScratch('native-cancel-exec-')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const configPath = await buildNativeComposition(root, closureRoot as string)

    // The command must outlive the test unless killed: `sleep 300` runs five
    // minutes; only the kill-once path ends it inside the budget.
    const upstream = new ScriptedExecUpstream('sleep', ['300'])
    const baseUrl = await upstream.listen()
    const gateway = openSolveGateway({
      stateDir: join(root, 'solve-gateway'),
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-native-cancel-exec-credential',
    })
    const mounted = await mountTls(gateway, caDir)
    const client = new CancelExecTestClient()
    let child: ReturnType<typeof spawn> | undefined
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('native-cancel-exec')
      child = spawn(process.execPath, [acpBootPath, configPath], {
        cwd: workspace,
        env: {
          ...process.env,
          DSH_SOLVE_GATEWAY_URL: mounted.url,
          DSH_SOLVE_GATEWAY_TOKEN_FILE: tokenFilePath,
          DSH_SOLVE_GATEWAY_ROUTE_HASH: gateway.routeHash,
          DSH_SOLVE_AGENT_TIMEOUT_MS: '2700000',
          DSH_NATIVE_PROVIDER: 'zen-compatible',
          DSH_NATIVE_MODEL: 'deepseek-v4-flash',
          DSH_BOOT_BARE_MODULE_BASE_URL:
            pathToFileURL(join(closureRoot as string, 'node_modules')).href + '/',
          SSL_CERT_FILE: join(caDir, 'server.crt'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stderrChunks: string[] = []
      child.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk.toString('utf8'))
      })
      const connection = new ClientSideConnection(
        () => client,
        ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)),
      )
      const timer = setTimeout(() => child?.kill('SIGKILL'), 120_000)
      try {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'dsh-evolve-le-native-cancel-exec-test', version: '0.0.1' },
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        })
        const session = await connection.newSession({ cwd: workspace, mcpServers: [] })
        const promptPromise = connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'run sleep 300, then answer' }],
        })
        // Cancel only after the terminal is actually running: the loop has
        // dispatched the tool call and solve_exec is parked in waitForExit.
        // This is the ordering harbor's session/cancel produces when the user
        // interrupts a long command, not a model request.
        for (let i = 0; i < 100 && client.terminalCalls.length === 0; i += 1) {
          await new Promise<void>((resolveTick) => setTimeout(resolveTick, 100))
        }
        expect(client.terminalCalls).toEqual([{ command: 'sleep', args: ['300'], cwd: workspace }])
        await connection.cancel({ sessionId: session.sessionId })
        const prompt = await promptPromise

        // The cancel crossed into the native agent: the loop aborted the step,
        // its turn/end record carries reason.kind 'aborted', and the ACP stop
        // reason is cancelled — never a fake end_turn for a killed turn.
        expect(prompt.stopReason).toBe('cancelled')

        // Kill-once over the wire: the abort listener fired killOnce() and the
        // aborted branch awaited it again — the memoized promise means the
        // client's killTerminal ran EXACTLY once for the terminal.
        expect(client.killedTerminals).toEqual(['t0'])

        // The killed process really died: waitForTerminalExit observed the
        // SIGKILL exit, and the tool's finally released the terminal.
        const exit = client.exitStatuses.get('t0')
        expect(exit?.signal).toBe('SIGKILL')
        expect(client.releasedTerminals).toEqual(['t0'])

        // Exactly one model request crossed the wire: the cancelled turn never
        // reached for a second completion.
        expect(upstream.requests).toHaveLength(1)
        const fact = await gateway.terminalFact('native-cancel-exec')
        expect(fact.ok).toBe(true)
        expect(fact.usage.requests).toBe(1)
      } finally {
        clearTimeout(timer)
        child.stdin!.end()
        const exit = await new Promise<{ code: number | null }>((resolveClosed) => {
          child?.on('close', (code) => resolveClosed({ code }))
          setTimeout(() => child?.kill('SIGKILL'), 30_000).unref()
        })
        const stderr = stderrChunks.join('')
        const reportLine = stderr
          .split('\n')
          .filter((line) => line.startsWith(REPORT_PREFIX))
          .at(-1)
        const report =
          reportLine === undefined
            ? undefined
            : (JSON.parse(reportLine.slice(REPORT_PREFIX.length)) as RunnerReport)
        // A cancelled tool execution must not strand the terminal, a timer, or
        // a socket: the unload invariant is checked against the serving
        // baseline exactly as in a clean round.
        expect(exit.code, `stderr: ${stderr.slice(-600)}`).toBe(0)
        expect(report?.quiescent, `stderr: ${stderr.slice(-600)}`).toBe(true)
      }
    } finally {
      await mounted.close()
      await gateway.close()
      await upstream.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
