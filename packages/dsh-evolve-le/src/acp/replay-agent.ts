/**
 * ACP mock-replay agent (Gate 1, specs/07 §3): serves the Agent Client
 * Protocol over a Capsule composition booted through the real Cordis Loader,
 * on `@agentclientprotocol/sdk` 0.25.1 — the exact version the locked
 * upstream `@deepseek-ai/dsh-acp` 0.1.0-rc.5 builds on. The turn is a
 * deterministic replay, not an LLM call: the assistant message carries the
 * composed system-prompt sections verbatim, so the E2E can assert that the
 * candidate's section actually flowed through the real Loader into the
 * session layer. Recorded-LLM replay lands when the full DSH production
 * closure is staged (Gate 2 runner).
 * @module @dsh-evolve-le/core/acp/replay-agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import { BUILDER_VERSION } from '../version.js'
import type { StubSystemPromptService } from '../probe/system-prompt-stub.js'

/** One composed system-prompt section captured at session creation. */
export interface ReplaySession {
  sessionId: string
  sections: readonly { name: string; order: number; text: string }[]
}

/** The deterministic replay turn emitted for `session/prompt`. */
export interface ReplayTurn {
  stopReason: 'end_turn'
  chunks: { name: string; text: string }[]
}

function systemPromptService(ctx: Context): StubSystemPromptService | undefined {
  const service = (ctx as unknown as { systemPrompt?: StubSystemPromptService }).systemPrompt
  return typeof service?.snapshot === 'function' ? service : undefined
}

/**
 * Build the mock-replay `Agent` over a booted Capsule context. Session
 * creation captures the composed prompt sections; each prompt turn replays
 * them as `agent_message_chunk` updates through the connection, then ends the
 * turn. No model, no network, no wall-clock dependence beyond UUID identity.
 */
export function createReplayAgent(
  ctx: Context,
  connection: AgentSideConnection,
): Agent & { sessions: Map<string, ReplaySession> } {
  const sessions = new Map<string, ReplaySession>()
  return {
    sessions,
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'dsh-evolve-le-capsule-runner', version: BUILDER_VERSION },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
        },
      }
    },
    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      const sections = systemPromptService(ctx)?.snapshot() ?? []
      const sessionId = randomUUID()
      sessions.set(sessionId, { sessionId, sections })
      return { sessionId }
    },
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId)
      if (session === undefined) {
        throw new Error(`acp replay: unknown session ${params.sessionId}`)
      }
      for (const section of [...session.sections].sort((a, b) => a.order - b.order)) {
        await connection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `[${section.name}]\n${section.text}`,
            },
          },
        })
      }
      return { stopReason: 'end_turn' }
    },
    async cancel(_params: CancelNotification): Promise<void> {
      // Replay turns are synchronous; there is nothing in flight to cancel.
    },
    async authenticate(_params: AuthenticateRequest): Promise<void> {
      // The replay agent advertises no authMethods, so the connection never
      // routes here; the interface requires the method to exist.
    },
  }
}

/** Extract the plain text of `agent_message_chunk` updates from a session. */
export function replayChunkText(
  updates: { sessionUpdate: string; content?: { text?: string } }[],
): string[] {
  return updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => update.content?.text ?? '')
}
