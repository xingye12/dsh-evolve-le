/** Native DSH composition seam.
 *
 * Proposal and solve code must ask DSH for an agent rather than implement a
 * second agent abstraction. This module keeps that seam explicit: a scoped
 * ctx.agents.create() call owns session, model selection, prompt assembly,
 * tool dispatch and cancellation. ACP only transports messages.
 */

import type { Context } from '@deepseek-ai/cordis'
/** Candidate execution mode (kept local so the TCB package has no runtime
 * dependency on the evolvable SDK). */
export type NativeDshMode = 'solve' | 'propose'

export const NATIVE_DSH_PROTOCOL = 'dsh-evolve-le/native-dsh/v1' as const

/** Exact upstream packages that form the trusted native runtime closure. */
export const NATIVE_DSH_PACKAGE_PINS = [
  ['@deepseek-ai/dsh-agent', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-agent-loop', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-agent-default-model', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-agent-spine-demo', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-llm', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-session', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-tools', '0.1.0-rc.5'],
  ['@deepseek-ai/dsh-skill', '0.1.0-rc.5'],
] as const

/** Ensure every native pin is represented by an immutable runtime manifest. */
export function assertNativeDshClosure(
  packages: readonly { name: string; version: string }[],
): void {
  for (const [name, version] of NATIVE_DSH_PACKAGE_PINS) {
    const found = packages.find((entry) => entry.name === name)
    if (found === undefined || found.version !== version) {
      throw new NativeDshUnavailableError(
        `runtime closure is missing ${name}@${version}; refusing native agent start`,
      )
    }
  }
}

/** Return true only when every pinned native package is present. */
export function nativeDshClosurePresent(
  packages: readonly { name: string; version: string }[],
): boolean {
  return NATIVE_DSH_PACKAGE_PINS.every(([name, version]) =>
    packages.some((entry) => entry.name === name && entry.version === version),
  )
}

export type NativeDshPackage = (typeof NATIVE_DSH_PACKAGE_PINS)[number][0]

export class NativeDshUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super('native DSH runtime unavailable: ' + message, options)
    this.name = 'NativeDshUnavailableError'
  }
}

export interface NativeDshAgentOptions {
  sessionId: string
  cwd: string
  mode: NativeDshMode
  provider?: string
  model?: string
  maxTokens?: number
  /** Candidate composition is installed inside the unpublished agent scope. */
  setup?: (agentCtx: Context) => void | Promise<void>
  signal?: AbortSignal
}

/** Candidate-owned setup hook exposed by the baseline Loader plugin. */
export type CandidateStrategySetup = (agentCtx: Context) => void | Promise<void>

/** The typed cancellation causes accepted by the upstream DSH agent. */
export type NativeDshCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** Structural view of the native DSH system-prompt registry. */
export interface NativePromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

type NativeSystemPrompt = {
  section(section: NativePromptSection): () => void
}

function systemPromptOf(ctx: Context): NativeSystemPrompt | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const provided =
    typeof get === 'function'
      ? (get.call(ctx, 'systemPrompt') as NativeSystemPrompt | undefined)
      : undefined
  if (provided !== undefined && typeof provided.section === 'function') return provided
  const direct = (ctx as unknown as { systemPrompt?: NativeSystemPrompt }).systemPrompt
  return direct !== undefined && typeof direct.section === 'function' ? direct : undefined
}

/** Register TCB-owned prompt sections in the unpublished agent Fiber. */
export function installNativePromptSections(
  agentCtx: Context,
  sections: readonly NativePromptSection[],
): () => void {
  const systemPrompt = systemPromptOf(agentCtx)
  if (systemPrompt === undefined) {
    throw new NativeDshUnavailableError('ctx.systemPrompt.section() is not mounted in agent scope')
  }
  const disposers = sections.map((section) => systemPrompt.section(section))
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}

/**
 * Resolve the candidate-owned agent-scope hook from a Cordis context. Loader
 * services are normally read through `ctx.get()`; the own-property fallback
 * keeps this bridge usable with the structural test doubles used by the
 * controller package without weakening the native runtime contract.
 */
export function candidateStrategySetupOf(ctx: Context): CandidateStrategySetup | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const provided =
    typeof get === 'function' ? get.call(ctx, 'candidateStrategySetup') : undefined
  if (typeof provided === 'function') return provided as CandidateStrategySetup
  const direct = (ctx as unknown as { candidateStrategySetup?: unknown }).candidateStrategySetup
  return typeof direct === 'function' ? (direct as CandidateStrategySetup) : undefined
}

export interface NativeDshAgent {
  readonly agent: {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    cancel?: (cause: NativeDshCancelCause) => void
    session?: { events?: ReadonlyArray<{ type: string; data?: unknown }> }
  }
  /** Owner capability; disposal unwinds the agent Fiber and session. */
  dispose(): Promise<void>
}

type AgentRegistry = {
  create(options: {
    sessionId: unknown
    meta?: { cwd?: string }
    agentOptions?: { provider?: string; model?: string; maxTokens?: number }
    setup?: (agentCtx: Context) => void | Promise<void>
    signal?: AbortSignal
  }): Promise<NativeDshAgent>
}

function registryOf(ctx: Context): AgentRegistry | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  const provided =
    typeof get === 'function' ? (get.call(ctx, 'agents') as AgentRegistry | undefined) : undefined
  if (provided !== undefined && typeof provided.create === 'function') return provided
  const direct = (ctx as unknown as { agents?: AgentRegistry }).agents
  return direct !== undefined && typeof direct.create === 'function' ? direct : undefined
}

function assertSessionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError('native DSH sessionId is invalid: ' + JSON.stringify(value))
  }
}

/** Create one native DSH agent after scoped setup has committed. */
export async function createNativeDshAgent(
  ctx: Context,
  options: NativeDshAgentOptions,
): Promise<NativeDshAgent> {
  assertSessionId(options.sessionId)
  if (options.cwd.length === 0 || !options.cwd.startsWith('/')) {
    throw new TypeError('native DSH cwd must be an absolute path')
  }
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
  ) {
    throw new TypeError('native DSH maxTokens must be a positive safe integer')
  }
  const agents = registryOf(ctx)
  if (agents === undefined) {
    throw new NativeDshUnavailableError('ctx.agents.create() is not mounted; load dsh-agent-loop')
  }
  return agents.create({
    sessionId: options.sessionId as unknown,
    meta: { cwd: options.cwd },
    agentOptions: {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    },
    ...(options.setup === undefined ? {} : { setup: options.setup }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

/** Build the lossless user message shape consumed by upstream DSH sessions. */
export function nativeUserMessage(text: string): unknown {
  if (text.length === 0) throw new TypeError('native DSH user message must not be empty')
  // DSH Session validates every surface message as identified and keeps the
  // object immutable after publication. Generate the identity here so this
  // bridge remains usable when the optional native package closure is absent.
  const content = Object.freeze([{ type: 'text' as const, text }])
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content,
    source: Object.freeze({ kind: 'user' as const }),
  })
}

/** Extract assistant text from native DSH session events for ACP/proposal sinks. */
export function nativeAssistantText(
  events: ReadonlyArray<{ type: string; data?: unknown }>,
): string {
  const result: string[] = []
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: unknown } } | undefined
    const content = data?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block !== null &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      )
        result.push((block as { text: string }).text)
    }
  }
  return result.join('\n')
}

/** Runtime capability check used by transitional callers and diagnostics. */
export function hasNativeDshComposition(ctx: Context): boolean {
  return registryOf(ctx) !== undefined
}

/** Options for mounting the upstream runtime into a disposable capsule. */
export interface NativeDshCompositionOptions {
  provider?: string
  model?: string
  dshHome?: string
  /** Keep the default spine hermetic: no workspace skills or shell tools. */
  hermetic?: boolean
}

/**
 * Mount the upstream DSH spine into a trusted Cordis context. Imports are
 * intentionally late-bound because the controller package itself must remain
 * buildable without copying the read-only upstream checkout; capsules that
 * declare the native closure resolve these exact package names from their
 * flat node_modules tree. A missing package returns false so callers can
 * choose an explicit compatibility profile; setting DSH_NATIVE_REQUIRED=1
 * turns that condition into a fail-closed error.
 */
export async function mountNativeDshComposition(
  ctx: Context,
  options: NativeDshCompositionOptions = {},
): Promise<boolean> {
  const load = async (specifier: string): Promise<unknown> => import(specifier)
  let spine: { default?: unknown }
  let defaultModel: { default?: unknown }
  try {
    spine = (await load('@deepseek-ai/dsh-agent-spine-demo')) as { default?: unknown }
    defaultModel = (await load('@deepseek-ai/dsh-agent-default-model')) as {
      default?: unknown
    }
  } catch (error) {
    const code =
      error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    const message = error instanceof Error ? error.message : String(error)
    const missing = code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package/.test(message)
    if (missing && process.env.DSH_NATIVE_REQUIRED !== '1') return false
    throw new NativeDshUnavailableError(message, { cause: error })
  }
  try {
    const spinePlugin = spine.default ?? spine
    const modelPlugin = defaultModel.default ?? defaultModel
    const plugin = (ctx as unknown as { plugin: (p: unknown, c?: unknown) => Promise<unknown> })
      .plugin
    await plugin(spinePlugin, {
      dshHome: options.dshHome ?? '/tmp/dsh-evolve-le',
      workspaceContext: false,
      includeRuntimeContext: false,
      ...(options.hermetic === false ? {} : { skills: { enabled: false } }),
      goals: false,
      toolBash: false,
      toolJobs: false,
    })
    if (options.provider !== undefined && options.model !== undefined) {
      await plugin(modelPlugin, { provider: options.provider, model: options.model })
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new NativeDshUnavailableError(`composition activation failed: ${message}`, {
      cause: error,
    })
  }
}
