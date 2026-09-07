/**
 * Capsule ACP boot (Gate 1, specs/07 §3): boot the packed capsule composition
 * through the real Cordis Loader, then serve the Agent Client Protocol on
 * `@agentclientprotocol/sdk` 0.25.1 over JSON-RPC stdio (the same wire surface
 * as the locked `@deepseek-ai/dsh-acp` bridge). When the client closes stdin,
 * the app unloads, the unload invariant is checked against the pre-boot
 * baseline, and a final runner report goes to stderr as one JSON line —
 * stdout stays reserved for the protocol.
 *
 * The compiled file ships inside every capsule at `runner/bin/acp-boot.js`;
 * bare imports resolve against the capsule's flat pinned `node_modules/`.
 *
 * Usage: `node runner/bin/acp-boot.js <cordis.yml>`
 * Exit 0 when the unload invariant held, 1 when it did not, 2 on boot failure.
 * @module @dsh-evolve-le/core/bin/acp-boot
 */

import { isAbsolute, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { Agent } from '@agentclientprotocol/sdk'
import { createReplayAgent } from '../acp/replay-agent.js'
import { createLiveSolveAgent } from '../acp/live-solve-agent.js'
import { liveSolveLimitsFromAgentTimeout, SOLVE_AGENT_TIMEOUT_ENV } from '../acp/solve-protocol.js'
import {
  openSolveGatewayClient,
  readSolveTokenFile,
  SOLVE_CLIENT_REQUEST_TIMEOUT_MS,
} from '../acp/solve-client.js'
import { createNativeSolveAgent } from '../acp/native-solve-agent.js'
import { bootLoader } from '../cordis/boot.js'
import { hasNativeDshComposition } from '../dsh/native-composition.js'
import { installNativeLlmAdapter } from '../dsh/native-llm-adapter.js'
import {
  snapshotCordisInventory,
  snapshotProcessHandles,
  type CordisInventory,
  type ProcessHandleInventory,
} from '../cordis/inventory.js'

type ManagedAgent = Agent & { dispose?: () => Promise<void> }

interface RunnerReport {
  config: string
  sections: { afterBoot: string[]; afterUnload: string[] }
  quiescent: boolean
  timings: { bootMs: number; unloadMs: number }
  error?: string
}

const reportLine = 'dsh-evolve-le-runner-report:'
const logLine = 'dsh-evolve-le-runner-log:'

/**
 * Every teardown step the serving phase registered, run in reverse order of
 * installation before the Loader fiber disposes. Anything installed on the
 * ROOT context (the native LLM adapter's `registerAdapter` disposer) is not
 * owned by any loader entry, so the tree unload cannot collect it — the
 * runner must, or the quiescence census counts its own machinery as a leak.
 */
const teardownSteps: (() => Promise<void> | void)[] = []

async function sectionNames(ctx: Context): Promise<string[]> {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const provided = typeof get === 'function' ? get.call(ctx, 'systemPrompt') : undefined
  const resolved =
    provided ?? (ctx as unknown as { systemPrompt?: unknown }).systemPrompt
  const service = resolved as
    | {
        snapshot?: () => { name: string }[] | Promise<{ name: string }[]>
        assemble?: () => Promise<{ sections: { name: string }[] }>
      }
    | undefined
  if (service === null || service === undefined) return []
  if (typeof service.snapshot === 'function') return (await service.snapshot()).map((section) => section.name)
  if (typeof service.assemble === 'function') {
    return (await service.assemble()).sections.map((section) => section.name)
  }
  return []
}

/**
 * Teardown may release handles but must never create one: a candidate that
 * leaked a timer, socket, or pipe would raise a kind above its count while
 * the session was serving, or introduce a kind that was not there before.
 * The transport's own stdio wrappers are inside the serving baseline.
 */
function noNewHandles(serving: ProcessHandleInventory, after: ProcessHandleInventory): boolean {
  for (const [kind, count] of Object.entries(after)) {
    if ((serving[kind] ?? 0) < count) return false
  }
  return true
}

/**
 * Solve-gateway env (ADR-030). All values are non-secret (URL, path, hash,
 * task-specific effective timeout) and land in the job config = committed evidence; the token VALUE is
 * read from the mounted file inside this process only.
 *
 * Fail-closed asymmetry (the ADR-028 masquerade class): all four absent →
 * recorded replay (the offline builder path, byte-identical capsule); any
 * present but invalid → THROW, never a silent replay — a misconfigured live
 * trial must not score 0 on canned answers and pass as a capability result.
 */
const SOLVE_ENV = {
  url: 'DSH_SOLVE_GATEWAY_URL',
  tokenFile: 'DSH_SOLVE_GATEWAY_TOKEN_FILE',
  routeHash: 'DSH_SOLVE_GATEWAY_ROUTE_HASH',
  effectiveAgentTimeoutMs: SOLVE_AGENT_TIMEOUT_ENV,
} as const

function agentFactory(
  ctx: Context,
  report: (line: string) => void,
): (conn: AgentSideConnection) => ManagedAgent {
  const url = process.env[SOLVE_ENV.url]
  const tokenFile = process.env[SOLVE_ENV.tokenFile]
  const routeHash = process.env[SOLVE_ENV.routeHash]
  const effectiveAgentTimeoutMs = process.env[SOLVE_ENV.effectiveAgentTimeoutMs]
  const nativeRequested = process.env.DSH_NATIVE_ACP === '1'
  const nativeAvailable = hasNativeDshComposition(ctx)
  if (nativeRequested && !nativeAvailable) {
    throw new Error(
      'acp-boot: DSH_NATIVE_ACP=1 requires a mounted native DSH composition (ctx.agents.create())',
    )
  }

  const nativeProvider = process.env.DSH_NATIVE_PROVIDER
  const nativeModel = process.env.DSH_NATIVE_MODEL
  if ((nativeProvider === undefined) !== (nativeModel === undefined)) {
    throw new Error('acp-boot: DSH_NATIVE_PROVIDER and DSH_NATIVE_MODEL must be set together')
  }
  // A frozen provider/model declaration is an explicit native-runtime
  // contract. Never downgrade to the compatibility directive loop when the
  // capsule did not actually mount ctx.agents.create().
  if (!nativeAvailable && nativeProvider !== undefined && nativeModel !== undefined) {
    throw new Error(
      'acp-boot: native DSH provider/model declared but native composition is unavailable',
    )
  }
  const nativeMaxTokensValue = process.env.DSH_NATIVE_MAX_TOKENS
  let nativeMaxTokens: number | undefined
  if (nativeMaxTokensValue !== undefined) {
    const parsed = Number(nativeMaxTokensValue)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(
        `acp-boot: DSH_NATIVE_MAX_TOKENS must be a positive integer (got ${nativeMaxTokensValue})`,
      )
    }
    nativeMaxTokens = parsed
  }
  // Presence means the variable exists, even if its value is empty. Empty is
  // invalid live configuration, not permission to fall back to offline replay.
  const present = [url, tokenFile, routeHash, effectiveAgentTimeoutMs].filter(
    (value) => value !== undefined,
  )
  // A spine alone has no model route. Native execution is selected only when
  // explicitly requested or when the capsule supplies a complete provider /
  // model lock. Without a gateway-backed adapter, fail before ACP starts
  // rather than letting the first native turn fail ambiguously.
  const useNative =
    nativeRequested ||
    (nativeAvailable && nativeProvider !== undefined && nativeModel !== undefined)
  if (
    useNative &&
    present.length > 0 &&
    (nativeProvider === undefined || nativeModel === undefined)
  ) {
    throw new Error(
      'acp-boot: native DSH with live solve requires DSH_NATIVE_PROVIDER and DSH_NATIVE_MODEL',
    )
  }
  if (present.length === 0) {
    if (useNative) {
      throw new Error(
        'acp-boot: native DSH solve requires a complete live solve gateway; no model adapter is mounted',
      )
    }
    return (conn) => createReplayAgent(ctx, conn)
  }
  if (present.length !== 4) {
    throw new Error(
      `acp-boot: partial solve-gateway env (${Object.keys(SOLVE_ENV)
        .filter((key) => process.env[SOLVE_ENV[key as keyof typeof SOLVE_ENV]] !== undefined)
        .join(', ')}): all four of url/tokenFile/routeHash/effectiveAgentTimeoutMs are required`,
    )
  }
  if (!/^https:\/\/[^/]+/.test(url ?? '')) {
    throw new Error(`acp-boot: ${SOLVE_ENV.url} must be an https URL (got ${String(url)})`)
  }
  if (!/^[0-9a-f]{64}$/.test(routeHash ?? '')) {
    throw new Error(`acp-boot: ${SOLVE_ENV.routeHash} must be 64-hex (got ${String(routeHash)})`)
  }
  // A live gateway is a production solve boundary, so it must use the
  // upstream DSH runtime. The former directive loop remains available only
  // for hermetic historical/replay fixtures which name that exception.
  if (!useNative && process.env.DSH_COMPATIBILITY_LIVE !== '1') {
    throw new Error(
      'acp-boot: live solve requires native DSH provider/model and mounted composition; legacy compatibility loop requires DSH_COMPATIBILITY_LIVE=1',
    )
  }
  const token = readSolveTokenFile(tokenFile ?? '')
  const limits = liveSolveLimitsFromAgentTimeout(effectiveAgentTimeoutMs)
  report(`solve gateway: ${String(url)} (route ${String(routeHash).slice(0, 12)}…)`)
  const client = openSolveGatewayClient({
    url: url ?? '',
    token,
    routeHash: routeHash ?? '',
    // Outlast the gateway's whole ADR-033 retry loop so the reply is never raced.
    timeoutMs: SOLVE_CLIENT_REQUEST_TIMEOUT_MS,
  })
  if (useNative) {
    const provider = nativeProvider as string
    const model = nativeModel as string
    // Receipt-cost accumulator: the gateway reply's costUsdMicros never
    // enters the DSH chunk stream, so the adapter closure accumulates it here
    // and the native solve agent reads it after each turn settles.
    const usageSink = { costUsdMicros: 0 }
    const disposeAdapter = installNativeLlmAdapter(ctx, {
      provider,
      model,
      ...(nativeMaxTokens === undefined ? {} : { maxTokens: nativeMaxTokens }),
      complete: async (request) => {
        const reply = await client.complete(
          {
            sections:
              request.system === undefined
                ? []
                : [{ name: 'native:system', order: 0, text: request.system }],
            userText: request.userText ?? JSON.stringify(request.messages),
            messages: request.messages,
            tools: request.tools,
          },
          limits.requestTimeoutMs,
          // The loop's phase signal (session/cancel, wall-clock deadline)
          // destroys the in-flight HTTPS request at the wire level.
          request.signal === undefined ? {} : { signal: request.signal },
        )
        if (!reply.ok) throw new Error(reply.message)
        usageSink.costUsdMicros += reply.costUsdMicros
        return {
          responseText: reply.responseText,
          ...(reply.toolCalls === undefined ? {} : { toolCalls: reply.toolCalls }),
          promptTokens: reply.promptTokens,
          completionTokens: reply.completionTokens,
          ...(reply.promptSha256 === undefined || reply.responseSha256 === undefined
            ? {}
            : {
                audit: {
                  requestId: reply.requestId,
                  promptSha256: reply.promptSha256,
                  responseSha256: reply.responseSha256,
                },
              }),
        }
      },
    })
    // The adapter registered on the root context; the loader tree does not
    // own it, so the runner collects it explicitly before the census.
    teardownSteps.push(disposeAdapter)
    report('native DSH agent runtime selected (gateway-backed LLM adapter)')
    return (conn) =>
      createNativeSolveAgent(ctx, conn, {
        provider,
        model,
        ...(nativeMaxTokens === undefined ? {} : { maxTokens: nativeMaxTokens }),
        usageSink,
        limits,
      })
  }
  return (conn) => createLiveSolveAgent(ctx, conn, { client, limits })
}

async function main(argv: string[]): Promise<number> {
  const configPath = argv[0]
  if (configPath === undefined) {
    process.stderr.write('usage: acp-boot <cordis.yml>\n')
    return 2
  }
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)

  const ctx = new Context()
  const before: CordisInventory = snapshotCordisInventory(ctx)

  // Bare plugin specifiers in the config tree resolve against this package
  // tree instead of the config directory (upstream app-boot's
  // `bareModuleBaseUrl`, resolved through createRequire — the capsule ships
  // no node-addon-require-builtin peer). Production capsules need no override:
  // their config sits beside the capsule's own flat node_modules, so the
  // stock Loader resolution already finds the pinned closure.
  const bareModuleBaseUrl = process.env['DSH_BOOT_BARE_MODULE_BASE_URL']

  const bootStart = performance.now()
  let booted: Awaited<ReturnType<typeof bootLoader>>
  try {
    booted = await bootLoader(absolute, {
      context: ctx,
      ...(bareModuleBaseUrl === undefined ? {} : { bareModuleBaseUrl }),
    })
  } catch (error) {
    const report: RunnerReport = {
      config: absolute,
      sections: { afterBoot: [], afterUnload: [] },
      quiescent: false,
      timings: { bootMs: performance.now() - bootStart, unloadMs: 0 },
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    process.stderr.write(`${reportLine}${JSON.stringify(report)}\n`)
    return 2
  }
  const bootMs = performance.now() - bootStart
  const sectionsAfterBoot = await sectionNames(ctx)

  // Serve ACP until the client closes stdin (or the stream errors): the SDK
  // resolves `connection.closed` when its underlying stream ends. The factory
  // receives the live connection as its argument (the outer binding is not
  // yet initialized while the constructor runs). The solve-gateway env is
  // resolved BEFORE the transport exists so a broken live configuration
  // fails the boot loudly instead of mid-turn (R3: fail closed, never replay).
  let factory: (conn: AgentSideConnection) => ManagedAgent
  try {
    factory = agentFactory(ctx, (line) => process.stderr.write(`${logLine}${line}\n`))
  } catch (error) {
    const report: RunnerReport = {
      config: absolute,
      sections: { afterBoot: sectionsAfterBoot, afterUnload: [] },
      quiescent: false,
      timings: { bootMs, unloadMs: 0 },
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }
    process.stderr.write(`${reportLine}${JSON.stringify(report)}\n`)
    await booted.loaderFiber.dispose().catch(() => undefined)
    return 2
  }
  let managedAgent: ManagedAgent | undefined
  const connection: AgentSideConnection = new AgentSideConnection(
    (conn) => {
      const agent = factory(conn)
      managedAgent = agent
      return agent
    },
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  )
  // The handle baseline is re-taken once the runner's own transport is up:
  // its stdio wrappers are TCB machinery the candidate cannot touch, and the
  // invariant must measure exactly what the prompt turn leaves behind.
  const handlesServing: ProcessHandleInventory = snapshotProcessHandles()
  await connection.closed

  // Release the transport before the census; any handle surviving this is a
  // genuine leak, not transport bookkeeping.
  process.stdin.destroy()
  await managedAgent?.dispose?.().catch(() => undefined)
  const unloadStart = performance.now()
  // Runner-owned teardown first (the root-scoped LLM adapter), then the
  // loader tree — reverse order of installation.
  for (const step of teardownSteps.reverse()) {
    await Promise.resolve()
      .then(() => step())
      .catch(() => undefined)
  }
  await booted.loaderFiber.dispose()
  const unloadMs = performance.now() - unloadStart
  // Drain teardown I/O (the include plugin flushes its tree file) before the
  // final census; a genuinely leaked timer or socket would survive this.
  for (let i = 0; i < 4; i += 1) {
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise))
  }
  const afterUnload = snapshotCordisInventory(ctx)
  const handlesAfter = snapshotProcessHandles()
  const quiescent =
    JSON.stringify(afterUnload) === JSON.stringify(before) &&
    noNewHandles(handlesServing, handlesAfter)
  const report: RunnerReport = {
    config: absolute,
    sections: { afterBoot: sectionsAfterBoot, afterUnload: await sectionNames(ctx) },
    quiescent,
    timings: { bootMs, unloadMs },
  }
  process.stderr.write(`${reportLine}${JSON.stringify(report)}\n`)
  return quiescent ? 0 : 1
}

const exitCode = await main(process.argv.slice(2))
process.exitCode = exitCode
// The report above already records the machine-checked unload invariant. If
// teardown left references alive (web-stream wrappers over stdio), exit after
// the report had a turn to flush; the unref'd timer never holds the loop open
// itself, and a genuinely leaked handle is named in the report, not hidden.
const forceExit = setTimeout(() => process.exit(exitCode), 250)
forceExit.unref()
