/**
 * Live-solve container E2E (ADR-030, specs/02 §13): the packed capsule — and
 * nothing else — boots in a fresh NETWORKED container (the default docker
 * bridge, NOT `--network none` like the replay E2E: a live trial must reach
 * the controller's HTTPS listener at 172.17.0.1), authenticates with the
 * per-trial bearer token bind-mounted read-only, and executes its directives
 * INSIDE the container: the host-side ACP client answers createTerminal /
 * readTextFile / writeTextFile through `docker exec`, exactly the surface
 * harbor's ACP client provides in a real trial.
 *
 * The model turns come back over the real wire — container → TLS gateway
 * (the production openSolveGateway) → scripted upstream — so what is pinned
 * here is the whole path a paid trial takes, minus only the upstream model.
 *
 * Pinned:
 *  - the mounted CA bundle (SSL_CERT_FILE) is honored by the capsule's
 *    node:https client against the real bridge-IP cert (no disabled verify);
 *  - an authenticated trial leaves a gapless, receipt-verified chain with
 *    non-zero usage, and settles no other trial's token;
 *  - tool effects land inside the container (write → exec read-back proves
 *    the round trip through the container fs);
 *  - exit 0 + quiescent after real HTTP activity (R4 holds on the pinned
 *    runtime inside the image, not just on the host);
 *  - an unenrolled token is refused (401), writes NO receipt, and never
 *    reaches the upstream.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Readable, Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type PromptResponse,
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
import { buildCandidate, type BuildResult } from '../src/builder/pipeline.js'
import { openSolveGateway, type SolveGateway } from '../src/solver/gateway.js'
import type { RemoteRoutePlan } from '../src/proposer/remote-gateway.js'

const exec = promisify(execFile)
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..')
const NODE_IMAGE = process.env['CAPSULE_CONTAINER_IMAGE'] ?? 'ubuntu:24.04'
/** The docker bridge address the production artifact endpoint binds. */
const BRIDGE_IP = '172.17.0.1'
const CA_BUNDLE_CONTAINER = '/opt/dsh-evolve-le/ca-bundle.crt'
const TOKEN_CONTAINER = '/run/dsh-solve/token'
const REPORT_PREFIX = 'dsh-evolve-le-runner-report:'

const PLAN: RemoteRoutePlan = {
  routeId: 'deepseek/zen-compatible',
  baseUrl: 'http://127.0.0.1:1/v1',
  model: 'deepseek-v4-flash',
  temperature: 0,
  maxOutputTokens: 512,
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
  retry: { maxAttempts: 1, backoffMs: [] },
}

interface RunnerReport {
  quiescent: boolean
  sections: { afterUnload: string[] }
}

const scratchDirs: string[] = []

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshScratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// Scripted upstream (host-only: the gateway calls it from this process).
// ---------------------------------------------------------------------------

class ScriptedUpstream {
  readonly requests: Array<{ auth: string | undefined; userText: string }> = []
  private queue: string[] = []
  private fallback = ''
  private readonly server = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      const body = JSON.parse(raw === '' ? '{}' : raw) as {
        messages?: { role: string; content: string }[]
      }
      const user = (body.messages ?? []).filter((message) => message.role === 'user').at(-1)
      this.requests.push({ auth: req.headers['authorization'], userText: user?.content ?? '' })
      const turn = this.queue.length > 0 ? (this.queue.shift() as string) : this.fallback
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { content: turn } }],
          usage: { prompt_tokens: 41, completion_tokens: 7 },
        }),
      )
    })
  })

  serve(script: string[], fallback: string): void {
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
// Host-side ACP client whose file/terminal methods execute IN the container.
// ---------------------------------------------------------------------------

interface TerminalState {
  child: ChildProcess
  output: string
  exitStatus: { exitCode: number | null; signal: string | null } | null
  exited: Promise<{ exitCode: number | null; signal: string | null }>
}

function closed(stream: Readable | null): Promise<void> {
  return stream === null
    ? Promise.resolve()
    : new Promise((resolveClosed) => {
        if (stream.destroyed) resolveClosed()
        else stream.once('close', () => resolveClosed())
      })
}

/**
 * The harbor stand-in: every directive the capsule dispatches runs through
 * `docker exec` against the SAME container the capsule lives in — so a tool
 * effect observed here happened inside the trial container, not on the host.
 */
class DockerExecClient implements Client {
  readonly terminalCalls: { command: string; args: string[]; cwd: string | null | undefined }[] = []
  readonly readCalls: string[] = []
  readonly writeCalls: { path: string; content: string }[] = []
  readonly updates: {
    sessionUpdate: string
    content?: { text?: string }
    used?: number
    cost?: { amount: number; currency: string }
  }[] = []
  private readonly terminals = new Map<string, TerminalState>()
  private nextTerminalId = 0

  constructor(private readonly container: string) {}

  async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('solve container client: permission requests are not part of the round')
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params.update as (typeof this.updates)[number])
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.writeCalls.push({ path: params.path, content: params.content })
    // Content over stdin so no shell quoting ever touches it.
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const child = spawn(
        'docker',
        ['exec', '-i', this.container, 'sh', '-c', `cat > '${params.path}'`],
        { stdio: ['pipe', 'ignore', 'ignore'] },
      )
      child.stdin!.end(params.content, 'utf8')
      child.on('exit', (code) =>
        code === 0 ? resolveWrite() : rejectWrite(new Error(`docker write exited ${String(code)}`)),
      )
      child.on('error', rejectWrite)
    })
    return {}
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.readCalls.push(params.path)
    const { stdout } = await exec('docker', ['exec', this.container, 'cat', params.path], {
      maxBuffer: 32 << 20,
    })
    return { content: stdout }
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.terminalCalls.push({ command: params.command, args: params.args ?? [], cwd: params.cwd })
    const id = `t${String(this.nextTerminalId)}`
    this.nextTerminalId += 1
    const child = spawn(
      'docker',
      [
        'exec',
        ...(params.cwd !== undefined && params.cwd !== null ? ['-w', params.cwd] : []),
        this.container,
        params.command,
        ...(params.args ?? []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
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
    await Promise.all([state.exited, closed(state.child.stdout), closed(state.child.stderr)])
    const exit = await state.exited
    return { exitCode: exit.exitCode, signal: exit.signal }
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
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
    if (state === undefined)
      throw new Error(`solve container client: unknown terminal ${terminalId}`)
    return state
  }
}

// ---------------------------------------------------------------------------
// Container round driver.
// ---------------------------------------------------------------------------

interface RoundOutcome {
  exitCode: number | null
  timedOut: boolean
  stderr: string
  report: RunnerReport | undefined
  client: DockerExecClient
  prompt: PromptResponse | undefined
}

async function driveContainerRound(options: {
  container: string
  payloadDir: string
  caBundleHost: string
  tokenFileHost: string
  gatewayUrl: string
  routeHash: string
  prompt: string
  timeoutMs?: number
}): Promise<RoundOutcome> {
  // This fixture exercises the retained directive protocol (the upstream is a
  // scripted op server, not a native DSH tool-call stream), so the capsule
  // must boot the compatibility loop. Production Harbor jobs never receive
  // this opt-in: the CLI composition always sets DSH_NATIVE_PROVIDER/MODEL
  // (harbor-provider.ts perJob), and acp-boot fails closed without them. Keep
  // the exception explicit, mirroring live-solve-agent.test.ts.
  const compatibilityEnv = ['-e', 'DSH_COMPATIBILITY_LIVE=1']
  const entrypoint = [
    'set -e',
    'mkdir /capsule',
    'mkdir -p /workspace',
    'tar -C /capsule -xf /payload/capsule.tar.gz',
    'cd /capsule',
    'sha256sum -c SHA256SUMS > /dev/null',
    'cd /workspace',
    'exec /capsule/dsh-evolve-le-acp',
  ].join('; ')
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--name',
      options.container,
      '-w',
      '/workspace',
      '-v',
      `${options.payloadDir}:/payload:ro`,
      '-v',
      `${options.caBundleHost}:${CA_BUNDLE_CONTAINER}:ro`,
      '-v',
      `${options.tokenFileHost}:${TOKEN_CONTAINER}:ro`,
      '-e',
      `SSL_CERT_FILE=${CA_BUNDLE_CONTAINER}`,
      '-e',
      `DSH_SOLVE_GATEWAY_URL=${options.gatewayUrl}`,
      '-e',
      `DSH_SOLVE_GATEWAY_TOKEN_FILE=${TOKEN_CONTAINER}`,
      '-e',
      `DSH_SOLVE_GATEWAY_ROUTE_HASH=${options.routeHash}`,
      '-e',
      'DSH_SOLVE_AGENT_TIMEOUT_MS=600000',
      ...compatibilityEnv,
      NODE_IMAGE,
      'sh',
      '-c',
      entrypoint,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const stderrChunks: string[] = []
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk.toString('utf8'))
  })

  const client = new DockerExecClient(options.container)
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!)),
  )

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, options.timeoutMs ?? 180_000)

  const round = (async () => {
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'dsh-evolve-le-solve-e2e', version: '0.0.1' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    const session = await connection.newSession({ cwd: '/workspace', mcpServers: [] })
    const prompt = await connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: options.prompt }],
    })
    return { prompt }
  })()

  const closedPromise = new Promise<{ code: number | null }>((resolveClosed) => {
    child.on('close', (code) => resolveClosed({ code }))
  })
  const outcome = await Promise.race([
    round.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    closedPromise.then((info) => ({ ok: false as const, closed: info })),
  ])
  child.stdin!.end()
  const closedInfo = await closedPromise
  clearTimeout(timer)

  const stderr = stderrChunks.join('')
  const reportLine = stderr
    .split('\n')
    .filter((line) => line.startsWith(REPORT_PREFIX))
    .at(-1)
  const report =
    reportLine === undefined
      ? undefined
      : (JSON.parse(reportLine.slice(REPORT_PREFIX.length)) as RunnerReport)
  return {
    exitCode: closedInfo.code,
    timedOut,
    stderr: stderr.slice(-4000),
    report,
    client,
    prompt: outcome.ok ? outcome.value.prompt : undefined,
  }
}

describe('live solve in a networked container (ADR-030)', () => {
  let build: BuildResult
  let payloadDir: string
  let tlsDir: string
  let upstream: ScriptedUpstream
  let gateway: SolveGateway
  let gatewayUrl: string
  let gatewayStateDir: string
  let httpsServer: ReturnType<typeof createHttpsServer>

  beforeAll(async () => {
    try {
      await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
    } catch (error) {
      throw new Error(
        `docker is not available; the live-solve container E2E cannot run here: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
    await exec('docker', ['pull', NODE_IMAGE])

    build = await buildCandidate({
      sourceDir: join(repoRoot, 'packages/candidate-baseline'),
      workRoot: await freshScratch('dsh-solve-build-'),
    })
    expect(build.outcome).toBe('admitted')
    expect(build.capsule).toBeDefined()
    payloadDir = await freshScratch('dsh-solve-payload-')
    await writeFile(
      join(payloadDir, 'capsule.tar.gz'),
      await readFile(build.artifacts.capsuleArchive),
    )

    // A self-signed cert for the docker bridge IP: the capsule's client must
    // verify the real endpoint address against exactly this bundle.
    tlsDir = await freshScratch('dsh-solve-tls-')
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(tlsDir, 'server.key'),
      '-out',
      join(tlsDir, 'server.crt'),
      '-subj',
      `/CN=${BRIDGE_IP}`,
      '-days',
      '2',
      '-addext',
      `subjectAltName=IP:${BRIDGE_IP}`,
    ])

    upstream = new ScriptedUpstream()
    const baseUrl = await upstream.listen()
    gatewayStateDir = await freshScratch('dsh-solve-gateway-')
    gateway = openSolveGateway({
      stateDir: gatewayStateDir,
      plan: { ...PLAN, baseUrl },
      credential: 'sk-SECRET-container-e2e-credential',
    })
    httpsServer = createHttpsServer(
      {
        key: await readFile(join(tlsDir, 'server.key')),
        cert: await readFile(join(tlsDir, 'server.crt')),
      },
      gateway.handler,
    )
    await new Promise<void>((resolveListen, rejectListen) => {
      httpsServer.once('error', rejectListen)
      httpsServer.listen(0, BRIDGE_IP, () => resolveListen())
    })
    const address = httpsServer.address() as AddressInfo
    gatewayUrl = `https://${BRIDGE_IP}:${String(address.port)}`
    await gateway.ready()
  }, 600_000)

  afterAll(async () => {
    await new Promise<void>((resolveClose) => {
      if (httpsServer !== undefined) httpsServer.close(() => resolveClose())
      else resolveClose()
    })
    if (gateway !== undefined) await gateway.close().catch(() => undefined)
    if (upstream !== undefined) await upstream.close()
  })

  it('runs an authenticated live trial end to end with tools inside the container', async () => {
    const notesPath = '/workspace/inside-container.md'
    upstream.serve(
      [
        JSON.stringify({ op: 'write', path: notesPath, content: 'written inside the trial\n' }),
        JSON.stringify({ op: 'exec', command: 'cat', args: [notesPath] }),
        JSON.stringify({ op: 'read', path: notesPath }),
        JSON.stringify({ op: 'final', answer: 'the notes round-tripped inside the container' }),
      ],
      JSON.stringify({ op: 'final', answer: 'fallback' }),
    )
    const { tokenFilePath } = await gateway.enrollTrial('solve-e2e-live')
    const token = (await readFile(tokenFilePath, 'utf8')).trim()
    const upstreamCallsBefore = upstream.requests.length

    const outcome = await driveContainerRound({
      container: 'dsh-solve-e2e-live',
      payloadDir,
      caBundleHost: join(tlsDir, 'server.crt'),
      tokenFileHost: tokenFilePath,
      gatewayUrl,
      routeHash: gateway.routeHash,
      prompt: 'write the notes file, read it back, then answer',
      timeoutMs: 240_000,
    })

    // R4 inside the image: real HTTPS happened and the boot still exits clean.
    expect(outcome.timedOut, `timed out: ${outcome.stderr}`).toBe(false)
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0)
    expect(outcome.report?.quiescent).toBe(true)
    expect(outcome.report?.sections.afterUnload).toEqual([])
    expect(outcome.prompt?.stopReason).toBe('end_turn')

    // The trial container executed its tools: write landed in the container
    // fs (via docker exec) and the exec directive read the same bytes back.
    expect(outcome.client.writeCalls).toEqual([
      { path: notesPath, content: 'written inside the trial\n' },
    ])
    expect(outcome.client.terminalCalls).toEqual([
      { command: 'cat', args: [notesPath], cwd: '/workspace' },
    ])
    expect(outcome.client.readCalls).toEqual([notesPath])
    const chunks = outcome.client.updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content?.text ?? '')
    expect(chunks.some((text) => text.includes('written inside the trial'))).toBe(true)
    expect(chunks.some((text) => text.includes('final: the notes round-tripped'))).toBe(true)

    // The gateway saw exactly this token's chain: authenticated, gapless,
    // non-zero usage (verifySolveReceipts under solve semantics). Upstream
    // sees ONLY the gateway's own credential (its single point of appearance);
    // the per-trial token never rides the upstream wire or the prompt text.
    expect(upstream.requests.length - upstreamCallsBefore).toBe(4)
    expect(
      upstream.requests
        .slice(upstreamCallsBefore)
        .every((request) => request.auth === 'Bearer sk-SECRET-container-e2e-credential'),
    ).toBe(true)
    expect(
      upstream.requests
        .slice(upstreamCallsBefore)
        .every((request) => !request.userText.includes(token)),
    ).toBe(true)
    const fact = await gateway.terminalFact('solve-e2e-live')
    expect(fact.ok).toBe(true)
    expect(fact.usage.requests).toBe(4)
    expect(fact.usage.totalTokens).toBeGreaterThan(0)
    expect(fact.usage.costUsdMicros).toBeGreaterThan(0)
  }, 300_000)

  it('refuses an unenrolled token: 401, no receipt, no upstream call', async () => {
    // A token file the gateway never issued: mount it and the trial must be
    // refused at the boundary — the upstream is unreachable for it and the
    // receipts directory holds nothing (collect would fail closed).
    const rogueDir = await freshScratch('dsh-solve-rogue-')
    const rogueToken = join(rogueDir, 'rogue.token')
    await writeFile(rogueToken, `${'e'.repeat(64)}\n`, { mode: 0o600 })
    const upstreamCallsBefore = upstream.requests.length

    const outcome = await driveContainerRound({
      container: 'dsh-solve-e2e-rogue',
      payloadDir,
      caBundleHost: join(tlsDir, 'server.crt'),
      tokenFileHost: rogueToken,
      gatewayUrl,
      routeHash: gateway.routeHash,
      prompt: 'do anything at all',
      timeoutMs: 180_000,
    })

    expect(outcome.timedOut, `timed out: ${outcome.stderr}`).toBe(false)
    // The capsule stops after the frozen consecutive-error cap; usage 0.
    expect(outcome.exitCode, `stderr: ${outcome.stderr}`).toBe(0)
    const usage = outcome.client.updates.find(
      (update) => update.sessionUpdate === 'usage_update',
    )?.cost
    expect(usage).toEqual({ amount: 0, currency: 'USD' })
    // Nothing reached the model; no receipt records the rogue token's tries.
    expect(upstream.requests.length).toBe(upstreamCallsBefore)
    const receipts = await readdir(join(gatewayStateDir, 'receipts')).catch(() => [] as string[])
    expect(receipts.includes('solve-e2e-rogue.jsonl')).toBe(false)
  }, 240_000)

  it('capsule archive digest matches the build manifest (mount integrity)', async () => {
    const archiveBytes = await readFile(join(payloadDir, 'capsule.tar.gz'))
    expect(createHash('sha256').update(archiveBytes).digest('hex')).toBe(
      build.capsule?.archiveSha256,
    )
  })
})
