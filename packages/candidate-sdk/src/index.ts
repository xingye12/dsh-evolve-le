/**
 * Candidate SDK runtime surface (specs/02 §4–7).
 *
 * This is the ONLY non-TCB library a candidate may build on. It is
 * dependency-free at runtime (types come from `@deepseek-ai/cordis` as a
 * type-only import), so the trusted builder can compile it into every capsule
 * without pulling an evolving dependency closure behind the candidate's back.
 *
 * The SDK deliberately exposes behavior declaration, not escape hatches: a
 * candidate describes per-mode prompt contributions, and the SDK owns the
 * Cordis mechanics (`inject` expectations, effect ownership, section-name
 * namespacing). Everything a candidate contributes is named `candidate:*` so
 * a controller can attribute and revoke it.
 *
 * @module @dsh-evolve-le/candidate-sdk
 */

import type { Context } from '@deepseek-ai/cordis'

/** The two execution modes every candidate must support (specs/02 §2). */
export type CandidateMode = 'solve' | 'propose'

/** Section names are namespaced so contributions stay attributable. */
export type CandidateSectionName = `candidate:${string}`

/** Structural view of one system-prompt contribution. */
export interface PromptSection {
  name: CandidateSectionName
  order: number
  text: string
}

/** Per-candidate runtime config; candidates may extend this with their own fields. */
export interface CandidateRuntime {
  mode: CandidateMode
}

/** Minimal structural view of the DSH `systemPrompt` service. */
export interface SystemPromptLike {
  section(input: PromptSection): () => void
}

/** Structural subset of the DSH `ctx.tools` API used by candidates. */
export interface CandidateToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): unknown[]
  }
  execute(args: unknown, exec: CandidateToolExecution): Promise<unknown>
  /** Optional automatic facet; invoked only with TCB-derived state. */
  strategy?: CandidateToolStrategy
}

/** Cooperative execution context supplied by the DSH tool runtime. */
export interface CandidateToolExecution {
  signal?: AbortSignal
  agent?: unknown
}

export interface CandidateStrategyContext {
  protocol: 'dsh-evolve-le/candidate-strategy-context/v1'
  turn: number
  step: number
  phase: 'session-start' | 'pre-step' | 'session-end'
  observation: {
    toolCalls: { exec: number; read: number; write: number }
    previousAction: 'none' | 'exec' | 'read' | 'write'
    lastExec: {
      outcome: 'none' | 'succeeded' | 'failed' | 'empty-output' | 'timed-out' | 'unknown'
      consecutiveRepeated: number
    }
    writesSinceLastExec: number
  }
}

export interface CandidateStrategyOutcome {
  checkpoint?: string
}

export interface CandidateToolStrategy {
  autoInvoke: true
  run(context: CandidateStrategyContext): Promise<CandidateStrategyOutcome>
}

/** Candidate-facing view of the DSH tool registry. */
export interface ToolsLike {
  register(definition: CandidateToolDefinition): () => void
}

/** Invocation flags accepted by the DSH skill registry. */
export interface CandidateSkillInvocation {
  modelInvocable: boolean
  userInvocable: boolean
}

/** Runtime skill registration compatible with `ctx.skills.register()`. */
export interface CandidateSkillRegistration {
  name: string
  description: string
  content: string
  whenToUse?: string
  invocation?: CandidateSkillInvocation
  provider?: string
  source?: string
  rank?: number
  locator?: unknown
}

/** Candidate-facing view of the DSH skill registry. */
export interface SkillsLike {
  register(skill: CandidateSkillRegistration): () => void
}

/** Candidate-owned listener for an agent or session lifecycle event. */
export interface CandidateEventRegistration {
  /** `candidate:agent/*` or `candidate:session/*`, never a host event name. */
  name: `candidate:${'agent' | 'session'}/${string}`
  handler: (...args: unknown[]) => unknown
}

export interface CandidateStrategyEventsLike {
  register(event: CandidateEventRegistration): () => void
}

export interface CandidateStrategyToolsLike {
  register(tool: { name: string; run: CandidateToolStrategy['run'] }): () => void
}

/** A bounded workflow hook published through the trusted candidate registry. */
export interface CandidateWorkflowRegistration {
  name: `candidate-workflow:${string}`
  description: string
  run(input: unknown): Promise<unknown>
}

/** Registry supplied by the trusted runtime, never by another candidate. */
export interface CandidateWorkflowsLike {
  register(workflow: CandidateWorkflowRegistration): () => void
}

/** How one mode behaves; built lazily from config so text can embed runtime identity. */
export interface ModeBehavior<Config extends CandidateRuntime> {
  /** Called once at plugin activation; the returned section is effect-owned. */
  promptSection?: (config: Config) => PromptSection
  /** Candidate-owned DSH tools registered in this mode's agent scope. */
  tools?: (config: Config) => readonly CandidateToolDefinition[]
  /** Candidate-owned DSH skills registered in this mode's agent scope. */
  skills?: (config: Config) => readonly CandidateSkillRegistration[]
  /** Candidate-owned listeners for agent lifecycle events. */
  agentEvents?: (config: Config) => readonly CandidateEventRegistration[]
  /** Candidate-owned listeners for session lifecycle events. */
  sessionEvents?: (config: Config) => readonly CandidateEventRegistration[]
  /** Candidate-owned workflow hooks in the trusted workflow registry. */
  workflows?: (config: Config) => readonly CandidateWorkflowRegistration[]
}

/** What a candidate author writes: exactly two modes, nothing else. */
export interface CandidateDefinition<Config extends CandidateRuntime> {
  solve: ModeBehavior<Config>
  propose: ModeBehavior<Config>
}

/** Boundaries every contributed section must respect (specs/02 §7 budget). */
export const SECTION_LIMITS = {
  namePattern: /^candidate:[a-z0-9][a-z0-9-]*$/,
  maxNameLength: 64,
  minOrder: 0,
  maxOrder: 10_000,
  maxTextLength: 32 * 1024,
} as const

/** Bounds for candidate-owned strategy registrations. */
export const STRATEGY_LIMITS = {
  toolNamePattern: /^candidate_[a-z0-9][a-z0-9_-]*$/,
  skillNamePattern: /^candidate-[a-z0-9][a-z0-9-]*$/,
  maxDescriptionLength: 4 * 1024,
  maxSkillContentLength: 64 * 1024,
  maxToolsPerMode: 32,
  maxSkillsPerMode: 32,
  maxEventsPerMode: 32,
  maxWorkflowsPerMode: 16,
} as const

/** Introspection result: what this candidate would contribute in a mode. */
export interface CandidatePlan {
  mode: CandidateMode
  section: PromptSection | undefined
  tools: readonly CandidateToolDefinition[]
  skills: readonly CandidateSkillRegistration[]
  agentEvents: readonly CandidateEventRegistration[]
  sessionEvents: readonly CandidateEventRegistration[]
  workflows: readonly CandidateWorkflowRegistration[]
}

/** Select which candidate-owned surfaces are published into a context scope.
 * Native DSH agents use this to mount tools/skills in the agent Fiber while
 * inheriting the parent candidate's already-composed prompt sections. */
export interface CandidateRegistrationOptions {
  prompt?: boolean
  tools?: boolean
  skills?: boolean
  agentEvents?: boolean
  sessionEvents?: boolean
  workflows?: boolean
}

/** A registered candidate plugin factory returned by {@link defineCandidate}. */
export interface CandidatePlugin<Config extends CandidateRuntime> {
  /** Resolve what this candidate contributes in the given config's mode. */
  describe(config: Config): CandidatePlan
  /** Activate the contribution on a real Cordis plugin context (effect-owned). */
  register(ctx: Context, config: Config, options?: CandidateRegistrationOptions): void
}

function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const get = (ctx as unknown as { get?: (serviceName: string) => unknown }).get
  // Native AgentLoop runs candidate setup in an unpublished Fiber. Cordis
  // deliberately rejects guarded `ctx.service` property access there unless
  // that service was injected into the Fiber; `ctx.get()` is the supported
  // optional lookup and still respects scope visibility.
  if (typeof get === 'function') {
    const provided = get.call(ctx, name) as T | undefined
    if (provided !== undefined) return provided
  }
  // Structural test doubles and the compatibility probe intentionally expose
  // services as own properties only, so retain this narrow fallback.
  const descriptor = Object.getOwnPropertyDescriptor(ctx, name)
  return descriptor === undefined || !('value' in descriptor) ? undefined : (descriptor.value as T)
}

function invalid(reason: string): never {
  throw new Error(`candidate-sdk: ${reason}`)
}

function validateSection(section: PromptSection, mode: CandidateMode): PromptSection {
  if (section === null || typeof section !== 'object') {
    invalid(`promptSection for mode "${mode}" must return an object`)
  }
  const { name, order, text } = section
  if (
    typeof name !== 'string' ||
    name.length > SECTION_LIMITS.maxNameLength ||
    !SECTION_LIMITS.namePattern.test(name)
  ) {
    invalid(`section name must match ${String(SECTION_LIMITS.namePattern)} (got ${String(name)})`)
  }
  if (
    typeof order !== 'number' ||
    !Number.isInteger(order) ||
    order < SECTION_LIMITS.minOrder ||
    order > SECTION_LIMITS.maxOrder
  ) {
    invalid(
      `section "${name}" order must be an integer in [${SECTION_LIMITS.minOrder}, ${SECTION_LIMITS.maxOrder}] (got ${String(order)})`,
    )
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > SECTION_LIMITS.maxTextLength) {
    invalid(
      `section "${name}" text must be a non-empty string of at most ${SECTION_LIMITS.maxTextLength} chars`,
    )
  }
  return { name, order, text }
}

function resolveSection<Config extends CandidateRuntime>(
  definition: CandidateDefinition<Config>,
  config: Config,
): PromptSection | undefined {
  if (config === null || typeof config !== 'object') {
    invalid('config must be an object')
  }
  if (config.mode !== 'solve' && config.mode !== 'propose') {
    invalid(`config.mode must be "solve" or "propose" (got ${String(config.mode)})`)
  }
  const behavior = config.mode === 'solve' ? definition.solve : definition.propose
  if (behavior == null || typeof behavior !== 'object') {
    invalid(`candidate definition must declare a "${config.mode}" behavior object`)
  }
  if (behavior.promptSection == null) return undefined
  if (typeof behavior.promptSection !== 'function') {
    invalid(`promptSection for mode "${config.mode}" must be a function`)
  }
  return validateSection(behavior.promptSection(config), config.mode)
}

function resolveStrategy<Config extends CandidateRuntime>(
  definition: CandidateDefinition<Config>,
  config: Config,
): {
  section: PromptSection | undefined
  tools: readonly CandidateToolDefinition[]
  skills: readonly CandidateSkillRegistration[]
  agentEvents: readonly CandidateEventRegistration[]
  sessionEvents: readonly CandidateEventRegistration[]
  workflows: readonly CandidateWorkflowRegistration[]
} {
  const section = resolveSection(definition, config)
  const behavior = config.mode === 'solve' ? definition.solve : definition.propose
  const tools = behavior.tools === undefined ? [] : behavior.tools(config)
  const skills = behavior.skills === undefined ? [] : behavior.skills(config)
  const agentEvents = behavior.agentEvents === undefined ? [] : behavior.agentEvents(config)
  const sessionEvents = behavior.sessionEvents === undefined ? [] : behavior.sessionEvents(config)
  const workflows = behavior.workflows === undefined ? [] : behavior.workflows(config)
  if (!Array.isArray(tools) || tools.length > STRATEGY_LIMITS.maxToolsPerMode) {
    invalid(
      `tools for mode "${config.mode}" must be an array of at most ${STRATEGY_LIMITS.maxToolsPerMode}`,
    )
  }
  if (!Array.isArray(skills) || skills.length > STRATEGY_LIMITS.maxSkillsPerMode) {
    invalid(
      `skills for mode "${config.mode}" must be an array of at most ${STRATEGY_LIMITS.maxSkillsPerMode}`,
    )
  }
  if (!Array.isArray(agentEvents) || agentEvents.length > STRATEGY_LIMITS.maxEventsPerMode) {
    invalid(
      `agentEvents for mode "${config.mode}" must be an array of at most ${STRATEGY_LIMITS.maxEventsPerMode}`,
    )
  }
  if (!Array.isArray(sessionEvents) || sessionEvents.length > STRATEGY_LIMITS.maxEventsPerMode) {
    invalid(
      `sessionEvents for mode "${config.mode}" must be an array of at most ${STRATEGY_LIMITS.maxEventsPerMode}`,
    )
  }
  if (!Array.isArray(workflows) || workflows.length > STRATEGY_LIMITS.maxWorkflowsPerMode) {
    invalid(
      `workflows for mode "${config.mode}" must be an array of at most ${STRATEGY_LIMITS.maxWorkflowsPerMode}`,
    )
  }
  return {
    section,
    tools: tools.map((tool) => validateTool(tool, config.mode)),
    skills: skills.map((skill) => validateSkill(skill, config.mode)),
    agentEvents: agentEvents.map((event) => validateEvent(event, 'agent', config.mode)),
    sessionEvents: sessionEvents.map((event) => validateEvent(event, 'session', config.mode)),
    workflows: workflows.map((workflow) => validateWorkflow(workflow, config.mode)),
  }
}

function validateTool(tool: CandidateToolDefinition, mode: CandidateMode): CandidateToolDefinition {
  if (tool === null || typeof tool !== 'object')
    invalid(`tool for mode "${mode}" must be an object`)
  if (!STRATEGY_LIMITS.toolNamePattern.test(tool.name)) {
    invalid(
      `tool name must match ${String(STRATEGY_LIMITS.toolNamePattern)} (got ${String(tool.name)})`,
    )
  }
  if (
    typeof tool.description !== 'string' ||
    tool.description.length === 0 ||
    tool.description.length > STRATEGY_LIMITS.maxDescriptionLength
  ) {
    invalid(`tool "${tool.name}" description is empty or too long`)
  }
  if (
    tool.parameters === null ||
    typeof tool.parameters !== 'object' ||
    Array.isArray(tool.parameters)
  ) {
    invalid(`tool "${tool.name}" parameters must be a JSON schema object`)
  }
  if (
    tool.output === null ||
    typeof tool.output !== 'object' ||
    typeof tool.output.render !== 'function'
  ) {
    invalid(`tool "${tool.name}" must declare output { schema, render }`)
  }
  if (
    tool.output.schema === null ||
    typeof tool.output.schema !== 'object' ||
    Array.isArray(tool.output.schema)
  ) {
    invalid(`tool "${tool.name}" output.schema must be a JSON schema object`)
  }
  if (typeof tool.execute !== 'function') invalid(`tool "${tool.name}" execute must be a function`)
  return tool
}

function validateSkill(
  skill: CandidateSkillRegistration,
  mode: CandidateMode,
): CandidateSkillRegistration {
  if (skill === null || typeof skill !== 'object')
    invalid(`skill for mode "${mode}" must be an object`)
  if (!STRATEGY_LIMITS.skillNamePattern.test(skill.name)) {
    invalid(
      `skill name must match ${String(STRATEGY_LIMITS.skillNamePattern)} (got ${String(skill.name)})`,
    )
  }
  if (
    typeof skill.description !== 'string' ||
    skill.description.length === 0 ||
    skill.description.length > STRATEGY_LIMITS.maxDescriptionLength
  ) {
    invalid(`skill "${skill.name}" description is empty or too long`)
  }
  if (
    typeof skill.content !== 'string' ||
    skill.content.length === 0 ||
    skill.content.length > STRATEGY_LIMITS.maxSkillContentLength
  ) {
    invalid(`skill "${skill.name}" content is empty or too long`)
  }
  if (
    skill.invocation !== undefined &&
    (skill.invocation === null ||
      typeof skill.invocation !== 'object' ||
      typeof skill.invocation.modelInvocable !== 'boolean' ||
      typeof skill.invocation.userInvocable !== 'boolean')
  ) {
    invalid(`skill "${skill.name}" invocation must contain boolean modelInvocable/userInvocable`)
  }
  return skill
}

function validateEvent(
  event: CandidateEventRegistration,
  surface: 'agent' | 'session',
  mode: CandidateMode,
): CandidateEventRegistration {
  if (event === null || typeof event !== 'object') {
    invalid(`${surface} event for mode "${mode}" must be an object`)
  }
  const prefix = `candidate:${surface}/`
  if (typeof event.name !== 'string' || !event.name.startsWith(prefix) || event.name.length > 128) {
    invalid(`${surface} event name must start with ${prefix}`)
  }
  if (typeof event.handler !== 'function')
    invalid(`${surface} event "${event.name}" handler must be a function`)
  return event
}

function validateToolStrategy(tool: CandidateToolDefinition): CandidateToolDefinition {
  if (tool.strategy === undefined) return tool
  if (
    tool.strategy === null ||
    typeof tool.strategy !== 'object' ||
    tool.strategy.autoInvoke !== true ||
    typeof tool.strategy.run !== 'function'
  ) {
    invalid(`tool "${tool.name}" strategy must set autoInvoke:true and provide run(context)`)
  }
  return tool
}

function validateWorkflow(
  workflow: CandidateWorkflowRegistration,
  mode: CandidateMode,
): CandidateWorkflowRegistration {
  if (workflow === null || typeof workflow !== 'object') {
    invalid(`workflow for mode "${mode}" must be an object`)
  }
  if (
    typeof workflow.name !== 'string' ||
    !/^candidate-workflow:[a-z0-9][a-z0-9-]*$/.test(workflow.name)
  ) {
    invalid(`workflow name must match candidate-workflow:<slug> (got ${String(workflow.name)})`)
  }
  if (
    typeof workflow.description !== 'string' ||
    workflow.description.length === 0 ||
    workflow.description.length > STRATEGY_LIMITS.maxDescriptionLength
  ) {
    invalid(`workflow "${workflow.name}" description is empty or too long`)
  }
  if (typeof workflow.run !== 'function')
    invalid(`workflow "${workflow.name}" run must be a function`)
  return workflow
}

function registerEvents(
  ctx: Context,
  events: readonly CandidateEventRegistration[],
  surface: 'agent' | 'session',
): void {
  if (events.length === 0) return
  const strategyEvents = serviceOf<CandidateStrategyEventsLike>(ctx, 'candidateStrategyEvents')
  if (strategyEvents !== undefined && strategyEvents !== null) {
    for (const event of events) ctx.effect(() => strategyEvents.register(event))
    return
  }
  const on = (
    ctx as unknown as {
      on?: (name: string, listener: (...args: unknown[]) => unknown) => () => void
    }
  ).on
  if (typeof on !== 'function') {
    invalid(`${surface} event registration requires the Cordis ctx.on() surface`)
  }
  for (const event of events) {
    ctx.effect(() => on.call(ctx, event.name, event.handler))
  }
}

/**
 * Declare a two-mode candidate. Throws at registration time (activation fails,
 * the build is rejected) for any out-of-boundary contribution — candidates
 * fail closed, never silently.
 *
 * @example
 * ```ts
 * const candidate = defineCandidate<Config>({
 *   solve: { promptSection: cfg => ({ name: 'candidate:identity', order: 100, text: `…${cfg.candidateId}…` }) },
 *   propose: { promptSection: cfg => ({ name: 'candidate:proposal-policy', order: 100, text: '…' }) },
 * })
 * export function apply(ctx: Context, config: Config): void {
 *   candidate.register(ctx, config)
 * }
 * ```
 */
export function defineCandidate<Config extends CandidateRuntime = CandidateRuntime>(
  definition: CandidateDefinition<Config>,
): CandidatePlugin<Config> {
  if (definition === null || typeof definition !== 'object') {
    invalid('definition must be an object with solve and propose behaviors')
  }
  // Definition-time check is structural only: the section builders need a
  // real config, so their output is validated in register/describe.
  for (const mode of ['solve', 'propose'] as const) {
    const behavior = definition[mode]
    if (behavior === null || typeof behavior !== 'object') {
      invalid(`candidate definition must declare a "${mode}" behavior object`)
    }
    if (behavior.promptSection !== undefined && typeof behavior.promptSection !== 'function') {
      invalid(`promptSection for mode "${mode}" must be a function`)
    }
    if (behavior.tools !== undefined && typeof behavior.tools !== 'function') {
      invalid(`tools for mode "${mode}" must be a function`)
    }
    if (behavior.skills !== undefined && typeof behavior.skills !== 'function') {
      invalid(`skills for mode "${mode}" must be a function`)
    }
    if (behavior.agentEvents !== undefined && typeof behavior.agentEvents !== 'function') {
      invalid(`agentEvents for mode "${mode}" must be a function`)
    }
    if (behavior.sessionEvents !== undefined && typeof behavior.sessionEvents !== 'function') {
      invalid(`sessionEvents for mode "${mode}" must be a function`)
    }
    if (behavior.workflows !== undefined && typeof behavior.workflows !== 'function') {
      invalid(`workflows for mode "${mode}" must be a function`)
    }
  }

  return {
    describe(config: Config): CandidatePlan {
      return { mode: config.mode, ...resolveStrategy(definition, config) }
    },
    register(ctx: Context, config: Config, options: CandidateRegistrationOptions = {}): void {
      const strategy = resolveStrategy(definition, config)
      if (options.prompt !== false && strategy.section !== undefined) {
        const systemPrompt = serviceOf<SystemPromptLike>(ctx, 'systemPrompt')
        if (systemPrompt === null || systemPrompt === undefined) {
          invalid(
            'systemPrompt service unavailable; the plugin must declare inject = ["systemPrompt"]',
          )
        }
        // Effect-owned: the section's disposer runs when the plugin Fiber
        // disposes, so unload inventories stay exact.
        ctx.effect(() => systemPrompt.section(strategy.section!))
      }
      const tools = serviceOf<ToolsLike>(ctx, 'tools')
      if (
        options.tools !== false &&
        strategy.tools.length > 0 &&
        (tools === null || tools === undefined)
      ) {
        invalid('tools service unavailable; the plugin must declare inject = ["tools"]')
      }
      if (options.tools !== false) {
        const strategyTools = serviceOf<CandidateStrategyToolsLike>(ctx, 'candidateStrategyTools')
        for (const originalTool of strategy.tools) {
          const tool = validateToolStrategy(originalTool)
          ctx.effect(() => tools!.register(tool))
          const automatic = tool.strategy
          if (automatic !== undefined && strategyTools !== undefined && strategyTools !== null) {
            ctx.effect(() => strategyTools.register({ name: tool.name, run: automatic.run }))
          }
        }
      }

      const skills = serviceOf<SkillsLike>(ctx, 'skills')
      if (
        options.skills !== false &&
        strategy.skills.length > 0 &&
        (skills === null || skills === undefined)
      ) {
        invalid('skills service unavailable; the plugin must declare inject = ["skills"]')
      }
      if (options.skills !== false) {
        for (const skill of strategy.skills) ctx.effect(() => skills!.register(skill))
      }

      if (options.agentEvents !== false) registerEvents(ctx, strategy.agentEvents, 'agent')
      if (options.sessionEvents !== false) registerEvents(ctx, strategy.sessionEvents, 'session')

      const workflows = serviceOf<CandidateWorkflowsLike>(ctx, 'candidateWorkflows')
      if (
        options.workflows !== false &&
        strategy.workflows.length > 0 &&
        (workflows === null || workflows === undefined)
      ) {
        invalid(
          'candidateWorkflows service unavailable; the plugin must declare inject = ["candidateWorkflows"]',
        )
      }
      if (options.workflows !== false) {
        for (const workflow of strategy.workflows) ctx.effect(() => workflows!.register(workflow))
      }
    },
  }
}
