/**
 * Native DSH proposal driver.
 *
 * This is the proposal equivalent of the ACP native adapter: AgentLoop owns
 * model turns, tool dispatch and cancellation; this package only supplies the
 * candidate-scoped setup and the bounded proposal capability backend. A
 * proposal is successful only when the model invokes `proposal_finish`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  candidateStrategySetupOf,
  createNativeDshAgent,
  nativeAssistantText,
  nativeUserMessage,
  type NativeDshAgent,
  installNativePromptSections,
  type NativePromptSection,
} from './native-composition.js'
import {
  disposeNativeProposalTools,
  installNativeProposalTools,
  type NativeProposalToolBackend,
  type NativeProposalToolState,
} from './native-proposal.js'
import { parseProposalOutput, type ProposalOutput } from '../proposer/protocol.js'
import type { NativeLlmAudit } from './native-llm-adapter.js'

export const NATIVE_PROPOSAL_PROTOCOL = 'dsh-evolve-le/native-proposal/v1' as const

export class NativeProposalError extends Error {
  constructor(message: string) {
    super(`native proposal: ${message}`)
    this.name = 'NativeProposalError'
  }
}

export interface NativeProposalRunOptions {
  ctx: Context
  backend: NativeProposalToolBackend
  sessionId: string
  cwd: string
  prompt: string
  proposalPath: string
  provider: string
  model: string
  maxTokens?: number
  signal?: AbortSignal
  /** Candidate hook captured from the parent Loader composition. */
  candidateSetup?: (agentCtx: Context) => void | Promise<void>
  /** TCB-owned prompt policy mounted inside the agent scope. */
  tcbPromptSections?: readonly NativePromptSection[]
  /** Per-turn gateway bindings captured by the TCB adapter. */
  audits?: readonly NativeLlmAudit[]
}

export interface NativeProposalRunResult {
  proposal: ProposalOutput
  assistantText: string
  eventCount: number
  toolTrace: Array<{ type: string; data: unknown }>
  /** DSH owns the internal loop; one invocation is one native session turn. */
  turns: 1
  transcriptPath: string
}

function eventsOf(handle: NativeDshAgent): ReadonlyArray<{ type: string; data?: unknown }> {
  return handle.agent.session?.events ?? []
}

/**
 * Run one proposal through the upstream DSH agent runtime. The transcript is
 * an append-only JSON document because native session events already carry the
 * complete tool and assistant chronology; no compatibility directive parser
 * is involved in this path.
 */
export async function runNativeProposal(
  options: NativeProposalRunOptions,
): Promise<NativeProposalRunResult> {
  if (options.provider.length === 0 || options.model.length === 0) {
    throw new NativeProposalError('provider and model are required')
  }
  if (options.prompt.length === 0) throw new NativeProposalError('prompt must not be empty')

  const state: NativeProposalToolState = { calls: 0, disposers: [] }
  const candidateSetup = options.candidateSetup ?? candidateStrategySetupOf(options.ctx)
  const handle = await createNativeDshAgent(options.ctx, {
    sessionId: options.sessionId,
    cwd: options.cwd,
    mode: 'propose',
    provider: options.provider,
    model: options.model,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    setup: async (agentCtx) => {
      if (options.tcbPromptSections !== undefined) {
        installNativePromptSections(agentCtx, options.tcbPromptSections)
      }
      await candidateSetup?.(agentCtx)
      installNativeProposalTools(agentCtx, options.backend, state)
    },
  })

  try {
    handle.agent.followup(nativeUserMessage(options.prompt))
    await handle.agent.whenIdle()
    const events = eventsOf(handle)
    const proposal = state.proposal
    // ADR-035: the session events are the only complete record of what the
    // model did, and attempt 8 proved they are lost on failure (the success
    // transcript is the only one written). Failed proposals must stay
    // attributable (rule 7): write the full chronology + audits + error
    // before throwing, and name the path in the error.
    const failureTranscriptPath = options.proposalPath.replace(
      /proposal\.json$/,
      'failure-transcript.jsonl',
    )
    const writeFailureTranscript = async (error: unknown): Promise<void> => {
      const transcript = {
        protocol: NATIVE_PROPOSAL_PROTOCOL,
        ok: false,
        eventCount: events.length,
        toolCalls: state.calls,
        events,
        error: error instanceof Error ? error.message : String(error),
        ...(options.audits === undefined ? {} : { audits: options.audits }),
      }
      await mkdir(dirname(options.proposalPath), { recursive: true })
      await writeFile(failureTranscriptPath, `${JSON.stringify(transcript)}\n`, 'utf8')
    }
    if (proposal === undefined) {
      await writeFailureTranscript('agent exited without proposal_finish')
      throw new NativeProposalError(
        `agent exited without proposal_finish (tool calls=${String(state.calls)}; failure transcript at ${failureTranscriptPath})`,
      )
    }
    try {
      parseProposalOutput(proposal)
    } catch (error) {
      await writeFailureTranscript(error)
      throw new NativeProposalError(
        `proposal_finish bundle failed the shape check: ${
          error instanceof Error ? error.message : String(error)
        } (failure transcript at ${failureTranscriptPath})`,
      )
    }
    await mkdir(dirname(options.proposalPath), { recursive: true })
    await writeFile(options.proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8')
    const transcript = {
      protocol: NATIVE_PROPOSAL_PROTOCOL,
      eventCount: events.length,
      toolCalls: state.calls,
      events,
      proposal,
      ...(options.audits === undefined ? {} : { audits: options.audits }),
    }
    // Session events are the native runtime's audit surface. Keep this file
    // free of credentials: the model adapter is required to redact them.
    const transcriptPath = options.proposalPath.replace(/proposal\.json$/, 'transcript.jsonl')
    await writeFile(transcriptPath, `${JSON.stringify(transcript)}\n`, 'utf8')
    return {
      proposal,
      assistantText: nativeAssistantText(events),
      eventCount: events.length,
      toolTrace: events
        .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
        .map((event) => ({ type: event.type, data: event.data ?? null })),
      turns: 1,
      transcriptPath,
    }
  } finally {
    disposeNativeProposalTools(state)
    await handle.dispose()
  }
}
