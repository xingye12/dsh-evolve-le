/** Native proposal composition helpers.
 *
 * Proposal authoring tools are registered in the unpublished DSH agent scope.
 * The model therefore selects tools through `@deepseek-ai/dsh-tools`; no
 * controller-owned directive parser is involved in this path. The existing
 * `proposer/tools` implementation is used only as a capability backend.
 */
import type { Context } from '@deepseek-ai/cordis'
import { parseProposalOutput, type ProposalOutput } from '../proposer/protocol.js'

export interface NativeProposalToolBackend {
  listInput(path: string): Promise<string[]>
  readInput(path: string): Promise<string>
  writeChildFile(childName: string, relativePath: string, content: string): Promise<void>
  /** TCB receipt finalization at the submit boundary (ADR-034). */
  finalizeProposal(proposal: unknown): Promise<ProposalOutput>
}

export interface NativeProposalToolState {
  proposal?: ProposalOutput
  calls: number
  disposers: Array<() => void>
}

/**
 * Tool-call budget for the native proposal session (ADR-035). The tree-v2
 * protocol authors full child trees through proposal_write_child with inline
 * content, and the DSH session re-sends the whole tool history every request:
 * attempt 8 needed 91-111 calls and burned ~4.1M cumulative tokens, landing
 * exactly on the gateway cap (the discarded final response then killed the
 * proposal). The soft boundary appends a wrap-up note to every authoring-tool
 * result; the hard boundary refuses the authoring tools so the model can only
 * submit. proposal_finish is exempt at every count.
 */
export const NATIVE_PROPOSAL_TOOL_BUDGET = {
  softReminderAtCalls: 72,
  refuseAtCalls: 96,
} as const

type ToolRuntime = {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render: (args: unknown, value: unknown) => unknown[]
    }
    execute(args: unknown, exec: unknown): Promise<unknown>
  }): () => void
}

function signalOf(exec: unknown): AbortSignal | undefined {
  if (exec === null || typeof exec !== 'object') return undefined
  const signal = (exec as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : undefined
}

function assertNotAborted(exec: unknown, operation: string): void {
  if (signalOf(exec)?.aborted) throw new Error(`${operation} aborted`)
}

function toolsOf(ctx: Context): ToolRuntime | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get === 'function') {
    const provided = get.call(ctx, 'tools') as ToolRuntime | undefined
    if (provided !== undefined && typeof provided.register === 'function') return provided
  }
  const direct = (ctx as unknown as { tools?: ToolRuntime }).tools
  return direct !== undefined && typeof direct.register === 'function' ? direct : undefined
}

/** Wrap-up note appended to authoring-tool results in the soft budget band. */
function budgetNote(state: NativeProposalToolState): string {
  const { softReminderAtCalls, refuseAtCalls } = NATIVE_PROPOSAL_TOOL_BUDGET
  if (state.calls < softReminderAtCalls || state.calls >= refuseAtCalls) return ''
  return `\n\n[tool-call budget] ${state.calls}/${refuseAtCalls} tool calls used — write only what remains strictly necessary, then call proposal_finish.`
}

/** Hard boundary: authoring tools stop; only proposal_finish may proceed. */
function assertAuthoringAllowed(state: NativeProposalToolState, toolName: string): void {
  if (state.calls < NATIVE_PROPOSAL_TOOL_BUDGET.refuseAtCalls) return
  throw new Error(
    `tool-call budget exhausted (${NATIVE_PROPOSAL_TOOL_BUDGET.refuseAtCalls} calls): ${toolName} is refused — call proposal_finish with your current bundle now`,
  )
}

/** Install bounded proposal authoring tools into one native agent scope. */
export function installNativeProposalTools(
  agentCtx: Context,
  backend: NativeProposalToolBackend,
  state: NativeProposalToolState,
): void {
  const tools = toolsOf(agentCtx)
  if (tools === undefined)
    throw new Error('native proposal: ctx.tools is unavailable in agent scope')
  const register = (definition: Parameters<ToolRuntime['register']>[0]): void => {
    state.disposers.push(tools.register(definition))
  }
  const objectSchema = (properties: Record<string, unknown>): Record<string, unknown> => ({
    type: 'object',
    properties,
    additionalProperties: false,
  })
  const textOutput = {
    schema: { type: 'string' },
    render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
  }
  register({
    name: 'proposal_list_files',
    description: 'List files in the label-filtered proposal input view.',
    parameters: objectSchema({ path: { type: 'string' } }),
    output: textOutput,
    async execute(args, exec) {
      assertNotAborted(exec, 'proposal_list_files')
      state.calls += 1
      assertAuthoringAllowed(state, 'proposal_list_files')
      const path = (args as { path?: unknown }).path
      if (typeof path !== 'string') throw new Error('path must be a string')
      const result = await backend.listInput(path)
      assertNotAborted(exec, 'proposal_list_files')
      return `${result.join('\n')}${budgetNote(state)}`
    },
  })
  register({
    name: 'proposal_read_file',
    description: 'Read one file from the immutable proposal input view.',
    parameters: objectSchema({ path: { type: 'string' } }),
    output: textOutput,
    async execute(args, exec) {
      assertNotAborted(exec, 'proposal_read_file')
      state.calls += 1
      assertAuthoringAllowed(state, 'proposal_read_file')
      const path = (args as { path?: unknown }).path
      if (typeof path !== 'string') throw new Error('path must be a string')
      const result = await backend.readInput(path)
      assertNotAborted(exec, 'proposal_read_file')
      return `${result}${budgetNote(state)}`
    },
  })
  register({
    name: 'proposal_write_child',
    description: 'Write one file inside the preassigned child candidate root.',
    parameters: objectSchema({
      childName: { type: 'string' },
      path: { type: 'string' },
      content: { type: 'string' },
    }),
    output: textOutput,
    async execute(args, exec) {
      assertNotAborted(exec, 'proposal_write_child')
      state.calls += 1
      assertAuthoringAllowed(state, 'proposal_write_child')
      const input = args as { childName?: unknown; path?: unknown; content?: unknown }
      if (
        typeof input.childName !== 'string' ||
        typeof input.path !== 'string' ||
        typeof input.content !== 'string'
      ) {
        throw new Error('childName, path and content are required')
      }
      await backend.writeChildFile(input.childName, input.path, input.content)
      assertNotAborted(exec, 'proposal_write_child')
      return `ok${budgetNote(state)}`
    },
  })
  register({
    name: 'proposal_finish',
    description: 'Submit exactly one validated proposal after all child files are written.',
    parameters: objectSchema({ proposal: { type: 'object' } }),
    output: textOutput,
    async execute(args, exec) {
      assertNotAborted(exec, 'proposal_finish')
      state.calls += 1
      if (state.proposal !== undefined) throw new Error('proposal_finish may only be called once')
      const proposal = (args as { proposal?: unknown }).proposal
      if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
        throw new Error('proposal must be an object')
      }
      // ADR-034: finalization runs BEFORE the shape check. A real model cannot
      // compute receipt digests, so the raw bundle is expected to fail the
      // protocol check on its own; the TCB derives every v2 receipt from the
      // model's semantic fields here, and the controller re-verifies
      // independently. The raw tool-call event stays in the transcript.
      // ADR-036: the upstream DSH session deep-freezes every appended message,
      // so the model's bundle arrives here frozen; the ADR-034 finalizer
      // mutates it in place (receipt rebuilds). Deep-copy at this transport
      // boundary — the finalizer works on a private copy, the audit trail
      // keeps the raw frozen event.
      const finalized = await backend.finalizeProposal(structuredClone(proposal))
      // The native tool is a transport boundary, not a second proposal
      // validator. Shape-check here so a model cannot mark an invalid bundle
      // as finished and rely on a later compatibility path to accept it.
      parseProposalOutput(finalized)
      state.proposal = finalized
      return 'submitted'
    },
  })
}

/** Dispose every native registration created by installNativeProposalTools. */
export function disposeNativeProposalTools(state: NativeProposalToolState): void {
  for (const dispose of state.disposers.splice(0).reverse()) dispose()
}
