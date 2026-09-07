/**
 * Native DSH agent driver used by proposal and solve integrations.
 *
 * This is deliberately a very small adapter: turn scheduling, tool dispatch,
 * session persistence and cancellation belong to the upstream DSH agent-loop.
 * The evolution project only supplies the scoped setup and translates the
 * final session events to its existing evidence/ACP envelope.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  createNativeDshAgent,
  nativeAssistantText,
  nativeUserMessage,
  candidateStrategySetupOf,
  type NativeDshAgentOptions,
} from './native-composition.js'

export interface NativeDshTurnInput extends NativeDshAgentOptions {
  prompt: string
  /** Optional candidate hook discovered from the parent Loader composition. */
  candidateSetup?: (agentCtx: Context) => void | Promise<void>
}

export interface NativeDshTurnResult {
  assistantText: string
  eventCount: number
  toolTrace: Array<{ type: string; data: unknown }>
}

/**
 * Drive exactly one user turn through an upstream DSH Agent. The caller owns
 * the root context and the returned handle owns the agent scope; disposal is
 * always awaited before this function resolves, including extraction errors.
 */
export async function runNativeDshTurn(
  ctx: Context,
  input: NativeDshTurnInput,
): Promise<NativeDshTurnResult> {
  const strategySetup = input.candidateSetup ?? candidateStrategySetupOf(ctx)
  const handle = await createNativeDshAgent(ctx, {
    ...input,
    setup: async (agentCtx) => {
      await strategySetup?.(agentCtx)
      await input.setup?.(agentCtx)
    },
  })
  try {
    handle.agent.followup(nativeUserMessage(input.prompt))
    await handle.agent.whenIdle()
    const events = handle.agent.session?.events ?? []
    return {
      assistantText: nativeAssistantText(events),
      eventCount: events.length,
      toolTrace: events
        .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
        .map((event) => ({ type: event.type, data: event.data ?? null })),
    }
  } finally {
    await handle.dispose()
  }
}
