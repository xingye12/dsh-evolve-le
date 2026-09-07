/**
 * Native live-solve E2E (ADR-030, specs/07): drive the NATIVE DSH branch of
 * acp-boot — real Cordis Loader booting the pinned upstream spine closure,
 * real HTTPS solve gateway, scripted OpenAI-compatible upstream — and assert
 * the contract the compatibility loop already satisfies, now owned by the
 * upstream AgentLoop:
 *
 *   - the loop reaches for the native solve tools (solve_exec → real terminal
 *     through the ACP client surface),
 *   - assistant text lands as agent_message_chunk trajectory updates,
 *   - exactly one usage_update per prompt carries session-event tokens and the
 *     gateway-receipt cost, mirrored into PromptResponse.usage,
 *   - session/cancel mid-request tears the wire down: the gateway observes
 *     the disconnect and the capsule still unloads quiescent.
 *
 * The upstream spine packages resolve from the content-addressed closure
 * cache the builder pins (NATIVE_DSH_PACKAGE_PINS); the test skips loudly when
 * that cache is absent rather than falling back to any mock.
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
// Test client: the terminal/file surface harbor's ACP client provides.
// ---------------------------------------------------------------------------

interface TerminalState {
  child: ReturnType<typeof spawn>
  output: string
  exitStatus: { exitCode: number | null; signal: string | null } | null
  exited: Promise<{ exitCode: number | null; signal: string | null }>
}

class NativeSolveTestClient implements Client {
  readonly terminalCalls: { command: string; args: string[]; cwd: string | null | undefined }[] = []
  readonly killedTerminals: string[] = []
  readonly updates: {
    sessionUpdate: string
    content?: { text?: string }
    used?: number
    size?: number
    cost?: { amount: number; currency: string }
  }[] = []
  private readonly terminals = new Map<string, TerminalState>()
  private nextTerminalId = 0

  async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('native solve test client: permission requests are not part of the round')
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params.update as (typeof this.updates)[number])
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
    const state = this.terminals.get(params.terminalId)
    if (state !== undefined && state.exitStatus === null) state.child.kill('SIGKILL')
    this.terminals.delete(params.terminalId)
    return {}
  }

  private require(terminalId: string): TerminalState {
    const state = this.terminals.get(terminalId)
    if (state === undefined) {
      throw new Error(`native solve test client: unknown terminal ${terminalId}`)
    }
    return state
  }
}

// ---------------------------------------------------------------------------
// Scripted upstream: OpenAI-compatible chat/completions with tool_calls.
// ---------------------------------------------------------------------------

type UpstreamReply =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; arguments: Record<string, unknown> }

class ScriptedToolUpstream {
  readonly requests: Array<{ auth: string | undefined; messageCount: number }> = []
  private readonly server: Server
  private queue: UpstreamReply[] = []
  private fallback: UpstreamReply = { kind: 'text', text: 'fallback' }
  private callSeq = 0

  constructor() {
    this.server = createHttpServer((req, res) => {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        const body = JSON.parse(raw === '' ? '{}' : raw) as { messages?: unknown[] }
        this.requests.push({
          auth: req.headers['authorization'],
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        })
        const reply = this.queue.length > 0 ? (this.queue.shift() as UpstreamReply) : this.fallback
        const message: Record<string, unknown> =
          reply.kind === 'text'
            ? { role: 'assistant', content: reply.text }
            : {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: `call_${String(this.callSeq++)}`,
                    type: 'function',
                    function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
                  },
                ],
              }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [{ message, finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls' }],
            usage: { prompt_tokens: 41, completion_tokens: 7 },
          }),
        )
      })
    })
  }

  serve(script: UpstreamReply[], fallback: UpstreamReply): void {
    this.queue = [...script]
    this.fallback = fallback
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
  // The Loader resolves bare package names from node_modules relative to the
  // composition; symlink the pinned closure in so the capsule under test uses
  // exactly the content-addressed trees the builder verified. The symlink
  // alone is NOT what makes the spine resolvable — the stock Loader resolves
  // bare specifiers from its own installation (the repo's node_modules, which
  // lacks the dsh-* packages). `DSH_BOOT_BARE_MODULE_BASE_URL` (upstream
  // app-boot's bareModuleBaseUrl mechanism, surfaced by our boot.ts) anchors
  // bare names at the closure's package tree instead; production capsules
  // need no override because their config sits inside the closure itself.
  await symlink(join(closure, 'node_modules'), join(dir, 'node_modules'), 'dir')
  const configPath = join(dir, 'cordis.yml')
  await writeFile(
    configPath,
    [
      '# native live-solve E2E composition (real upstream spine, hermetic)',
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

async function mountTls(gateway: SolveGateway, caDir: string): Promise<{ url: string; close(): Promise<void> }> {
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

function chunkTexts(client: NativeSolveTestClient): string[] {
  return client.updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
}

// ---------------------------------------------------------------------------
// The E2E suite.
// ---------------------------------------------------------------------------

describeNative('capsule native live-solve E2E (ADR-030: real spine + real gateway wire)', () => {
  let caDir = ''

  beforeAll(async () => {
    expect(existsSync(acpBootPath), `built runner missing (run \`pnpm build\` first)`).toBe(true)
    caDir = await freshScratch('native-live-ca-')
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

  it('runs a multi-turn native solve: tool call → real exec → text answer, with usage on the wire', async () => {
    const root = await freshScratch('native-live-round-')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const configPath = await buildNativeComposition(root, closureRoot as string)

    const upstream = new ScriptedToolUpstream()
    const baseUrl = await upstream.listen()
    upstream.serve(
      [
        { kind: 'tool', name: 'solve_exec', arguments: { command: 'printf', args: ['native-live-ok'] } },
        { kind: 'text', text: 'native answer: the exec output was verified' },
      ],
      { kind: 'text', text: 'fallback' },
    )
    const gateway = openSolveGateway({
      stateDir: join(root, 'solve-gateway'),
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-native-live-credential',
    })
    const mounted = await mountTls(gateway, caDir)
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_SOLVE_GATEWAY_URL: mounted.url,
      DSH_SOLVE_GATEWAY_ROUTE_HASH: gateway.routeHash,
      DSH_SOLVE_AGENT_TIMEOUT_MS: '2700000',
      DSH_NATIVE_PROVIDER: 'zen-compatible',
      DSH_NATIVE_MODEL: 'deepseek-v4-flash',
      SSL_CERT_FILE: join(caDir, 'server.crt'),
    }
    const client = new NativeSolveTestClient()
    let child: ReturnType<typeof spawn> | undefined
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('native-live')
      childEnv['DSH_SOLVE_GATEWAY_TOKEN_FILE'] = tokenFilePath
      childEnv['DSH_BOOT_BARE_MODULE_BASE_URL'] = pathToFileURL(
        join(closureRoot as string, 'node_modules'),
      ).href + '/'

      child = spawn(process.execPath, [acpBootPath, configPath], {
        cwd: workspace,
        env: childEnv,
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
          clientInfo: { name: 'dsh-evolve-le-native-live-test', version: '0.0.1' },
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        })
        const session = await connection.newSession({ cwd: workspace, mcpServers: [] })
        const prompt = await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'run printf native-live-ok, then answer' }],
        })

        // The upstream AgentLoop dispatched the tool call through the ACP
        // client surface — a REAL terminal ran the command.
        expect(client.terminalCalls).toEqual([
          { command: 'printf', args: ['native-live-ok'], cwd: workspace },
        ])

        // Trajectory: the final assistant text streamed as chunks.
        expect(chunkTexts(client).join('')).toContain('native answer')

        // Usage authority: exactly one usage_update; tokens from the loop's
        // session events (41+7 per upstream reply × 2 turns), cost from the
        // gateway receipt sink (41×3 + 7×15 micros per turn = 228).
        const usageUpdates = client.updates.filter(
          (update) => update.sessionUpdate === 'usage_update',
        )
        expect(usageUpdates).toHaveLength(1)
        expect(usageUpdates[0]).toMatchObject({
          used: 96,
          size: 96,
          cost: { amount: 0.000456, currency: 'USD' },
        })
        expect(prompt.stopReason).toBe('end_turn')
        expect(prompt.usage).toEqual({ inputTokens: 82, outputTokens: 14, totalTokens: 96 })

        // Both turns crossed the real wire; the receipt chain is gapless.
        const fact = await gateway.terminalFact('native-live')
        expect(fact.ok).toBe(true)
        expect(fact.usage.requests).toBe(2)
        expect(upstream.requests).toHaveLength(2)
        // The second turn carries the tool result back to the model.
        expect(upstream.requests[1]?.messageCount).toBeGreaterThan(
          upstream.requests[0]?.messageCount ?? 0,
        )
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
        // R4/R5 for the native branch: real HTTPS happened AND the capsule
        // still unloads quiescent (no live socket/timer survives the round).
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

  it('session/cancel mid-request destroys the in-flight HTTPS request and the capsule still exits clean', async () => {
    const root = await freshScratch('native-live-cancel-')
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const configPath = await buildNativeComposition(root, closureRoot as string)

    // The upstream holds its reply open until the connection drops underneath
    // it — the only way this request ends is the client destroying the socket.
    let sawUpstreamRequest = false
    let upstreamDisconnected: (() => void) | undefined
    const disconnected = new Promise<void>((resolve) => {
      upstreamDisconnected = resolve
    })
    const hangingUpstream = createHttpServer((req, res) => {
      sawUpstreamRequest = true
      req.socket.on('close', () => upstreamDisconnected?.())
      res.on('close', () => upstreamDisconnected?.())
    })
    await new Promise<void>((resolveListen) => {
      hangingUpstream.listen(0, '127.0.0.1', () => resolveListen())
    })
    const hangingAddress = hangingUpstream.address() as AddressInfo

    const gateway = openSolveGateway({
      stateDir: join(root, 'solve-gateway'),
      plan: { ...PLAN, baseUrl: `http://127.0.0.1:${String(hangingAddress.port)}/v1` },
      credential: 'sk-SECRET-native-cancel-credential',
      // The upstream only answers by disconnect; the gateway's own upstream
      // timeout is the backstop that ends its side of a request whose client
      // vanished, so the trial can still settle inside the test budget.
      requestTimeoutMs: 15_000,
    })
    const mounted = await mountTls(gateway, caDir)
    const client = new NativeSolveTestClient()
    let child: ReturnType<typeof spawn> | undefined
    try {
      await gateway.ready()
      const { tokenFilePath } = await gateway.enrollTrial('native-cancel')
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
          clientInfo: { name: 'dsh-evolve-le-native-cancel-test', version: '0.0.1' },
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        })
        const session = await connection.newSession({ cwd: workspace, mcpServers: [] })
        const promptPromise = connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'this request will be cancelled mid-flight' }],
        })
        // Let the turn reach the upstream, then cancel — the same ordering as
        // harbor's session/cancel firing while the model call is in flight.
        for (let i = 0; i < 100 && !sawUpstreamRequest; i += 1) {
          await new Promise<void>((resolveTick) => setTimeout(resolveTick, 100))
        }
        expect(sawUpstreamRequest).toBe(true)
        await connection.cancel({ sessionId: session.sessionId })
        const prompt = await promptPromise
        expect(prompt.stopReason).toBe('cancelled')
        // The cancel reached the wire: the upstream observed its socket drop.
        // (The gateway's own fetch to the upstream is server-side state; its
        // 15s upstream timeout backstops that half when the client is gone.)
        await disconnected
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
        // A cancelled turn must not strand handles: the unload invariant is
        // checked against the serving baseline exactly as in a clean round.
        expect(exit.code, `stderr: ${stderr.slice(-600)}`).toBe(0)
        expect(report?.quiescent, `stderr: ${stderr.slice(-600)}`).toBe(true)
      }
    } finally {
      await mounted.close()
      await gateway.close()
      await new Promise<void>((resolveClose) => hangingUpstream.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
