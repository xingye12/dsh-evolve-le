import {
  installCandidateStrategyEvents,
  installCandidateEventBridge,
  candidateCheckpoint,
  queueCandidateCheckpoint,
} from './candidate-events.js'
import {
  isolateNativeStrategyContext,
  installNativeSubagents,
  type NativeSessionEvidence,
} from './native-capabilities.js'
/**
 * Native DSH proposal driver.
 *
 * This is the proposal equivalent of the ACP native adapter: AgentLoop owns
 * model turns, tool dispatch and cancellation; this package only supplies the
 * candidate-scoped setup and the bounded proposal capability backend. A
 * proposal is successful only when the model invokes `proposal_finish`.
 */
import { createHash } from 'node:crypto'
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
  NATIVE_PROPOSAL_MAX_FINISH_ATTEMPTS,
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
  /**
   * Hard cap on upstream native-agent steps.  Native DSH treats one proposal
   * as a single session turn which can contain many model/tool steps, so this
   * must be enforced at the `agent/pre-step` waterfall rather than reported
   * as the runner's (always-one) session-turn count.
   */
  maxTurns?: number
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
  const eventDrains: Array<() => Promise<void>> = []
  const candidateEventAudits: Array<() => readonly unknown[]> = []
  const handles: NativeDshAgent[] = []
  const subagentEvidence: NativeSessionEvidence[] = []
  const recoverySessionId = `recovery-${createHash('sha256').update(options.sessionId).digest('hex')}`
  const setupEvents = async (agentCtx: Context) => {
    const registry = installCandidateStrategyEvents(agentCtx)
    const observation = {
      toolCalls: { exec: 0, read: 0, write: 0 },
      previousAction: 'none',
      lastExec: { outcome: 'none', consecutiveRepeated: 0 },
      writesSinceLastExec: 0,
    }
    const input = (phase: string, turn: number, step: number) => ({
      protocol: 'dsh-evolve-le/candidate-strategy-context/v1',
      phase,
      turn,
      step,
      observation,
    })
    const pending: string[] = []
    const accept = (values: unknown[]) => {
      for (const v of values) {
        const c = candidateCheckpoint(v)
        if (c !== undefined) queueCandidateCheckpoint(pending, c)
      }
    }
    await candidateSetup?.(agentCtx)
    const bridge = installCandidateEventBridge(
      agentCtx,
      registry,
      (turn, step) => input('pre-step', turn, step),
      (c) => queueCandidateCheckpoint(pending, c),
    )
    eventDrains.push(bridge.drain)
    candidateEventAudits.push(registry.audit)
    accept(await registry.emit('candidate:session/start', input('session-start', 0, 0)))
    agentCtx.on(
      'agent/pre-step' as never,
      (async (
        payload: { turn: number; step: number },
        next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
      ) => {
        await bridge.drain()
        const admitted = await next()
        if (admitted.kind === 'reject') return admitted
        accept(
          await registry.emit(
            'candidate:agent/pre-step',
            input('pre-step', payload.turn, payload.step),
          ),
        )
        const messages = pending
          .splice(0)
          .map((c) =>
            nativeUserMessage(`<candidate-solve-checkpoint>${c}</candidate-solve-checkpoint>`),
          )
        return { kind: 'enter', messages: [...admitted.messages, ...messages] }
      }) as never,
    )
    agentCtx.effect(() => async () => {
      await bridge.drain()
      await registry.emit('candidate:session/end', input('session-end', 0, 0))
    })
    return { drain: bridge.drain, audit: registry.audit }
  }
  const createSession = async (sessionId: string): Promise<NativeDshAgent> => {
    const handle = await createNativeDshAgent(options.ctx, {
      sessionId,
      cwd: options.cwd,
      mode: 'propose',
      provider: options.provider,
      model: options.model,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      setup: async (agentCtx) => {
        agentCtx = isolateNativeStrategyContext(agentCtx)
        if (options.tcbPromptSections !== undefined) {
          installNativePromptSections(agentCtx, options.tcbPromptSections)
        }
        await setupEvents(agentCtx)
        installNativeProposalTools(agentCtx, options.backend, state)
        await installNativeSubagents(
          agentCtx,
          async (childCtx) => {
            childCtx = isolateNativeStrategyContext(childCtx)
            if (options.tcbPromptSections !== undefined)
              installNativePromptSections(childCtx, options.tcbPromptSections)
            const events = await setupEvents(childCtx)
            installNativeProposalTools(childCtx, options.backend, state)
            return events
          },
          subagentEvidence,
        )
        if (options.maxTurns !== undefined) {
          const runtime = agentCtx as unknown as {
            on?: (
              event: string,
              listener: (
                payload: { step?: unknown },
                next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
              ) => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
            ) => void
          }
          if (typeof runtime.on !== 'function') {
            throw new NativeProposalError(
              'native proposal agent scope lacks agent/pre-step support',
            )
          }
          runtime.on('agent/pre-step', async (payload, next) => {
            const step = payload.step
            if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 1) {
              throw new NativeProposalError(
                'native proposal agent emitted an invalid step coordinate',
              )
            }
            if (step > options.maxTurns!) return { kind: 'reject' }
            return next()
          })
        }
      },
    })
    handles.push(handle)
    return handle
  }

  try {
    let handle = await createSession(options.sessionId)
    handle.agent.followup(nativeUserMessage(options.prompt))
    await handle.agent.whenIdle()
    await Promise.all(eventDrains.map((drain) => drain()))
    // Repair15 showed two distinct premature endings: after an actionable
    // finalizer error, and after child files existed but before submission.
    // Give one fresh, separately-audited native session exactly one recovery
    // turn.  It must not share the exhausted native session's model budget:
    // otherwise a recovery prompt deterministically receives another budget
    // stop before it can submit the files already written.  The writable
    // child root and TCB tool state are deliberately shared, while the DSH
    // session identity is not.  The finalizer remains authoritative and
    // accepts no invalid bundle.
    const needsRecoveryTurn =
      state.proposal === undefined &&
      ((state.finishAttempts ?? 0) === 1 ||
        ((state.finishAttempts ?? 0) === 0 && (state.writtenChildFiles ?? 0) > 0))
    if (needsRecoveryTurn) {
      const recoveryReason =
        (state.finishAttempts ?? 0) === 1
          ? `The first proposal_finish was rejected. Repair only the reported defect, then use the one remaining proposal_finish attempt (maximum ${String(NATIVE_PROPOSAL_MAX_FINISH_ATTEMPTS)}).`
          : 'Child files were written but no proposal_finish was called. Complete only the minimum remaining work and submit the existing bundle now.'
      handle = await createSession(recoverySessionId)
      handle.agent.followup(
        nativeUserMessage(
          `[TCB recovery turn] ${recoveryReason} A prose answer cannot complete this action.`,
        ),
      )
      await handle.agent.whenIdle()
      await Promise.all(eventDrains.map((drain) => drain()))
    }
    const events = handles.flatMap((created) => eventsOf(created))
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
        subagents: subagentEvidence,
        candidateEvents: candidateEventAudits.flatMap((audit) => audit()),
        toolCalls: state.calls,
        finishAttempts: state.finishAttempts ?? 0,
        recoveryTurnInjected: needsRecoveryTurn,
        ...(needsRecoveryTurn ? { recoverySessionId } : {}),
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
      subagents: subagentEvidence,
      candidateEvents: candidateEventAudits.flatMap((audit) => audit()),
      toolCalls: state.calls,
      finishAttempts: state.finishAttempts ?? 0,
      recoveryTurnInjected: needsRecoveryTurn,
      ...(needsRecoveryTurn ? { recoverySessionId } : {}),
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
  } catch (error) {
    // Callback/driver failures must retain the same audit as finalizer failures.
    // Keep an already-written detailed finalizer transcript immutable.
    const failurePath = options.proposalPath.replace(/proposal\.json$/, 'failure-transcript.jsonl')
    await mkdir(dirname(failurePath), { recursive: true })
    await writeFile(
      failurePath,
      JSON.stringify({
        protocol: NATIVE_PROPOSAL_PROTOCOL,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        events: handles.flatMap(eventsOf),
        candidateEvents: candidateEventAudits.flatMap((audit) => audit()),
        subagents: subagentEvidence,
        toolCalls: state.calls,
      }) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    ).catch((writeError: unknown) => {
      if ((writeError as { code?: string }).code !== 'EEXIST') throw writeError
    })
    throw error
  } finally {
    disposeNativeProposalTools(state)
    await Promise.all(handles.map((handle) => handle.dispose()))
  }
}
