/**
 * Fixed recorded-LLM replay table (Gate 2, specs/07 §4; specs/02 §9): the
 * stable runner's model-adapter slot serves deterministic recorded responses
 * — no network, no credentials, no wall clock. Entries are authored by the
 * trusted builder and labeled as such (`provenance`); they are NOT real model
 * transcripts. An entry is keyed by the sha256 of the canonical replay key
 * (composed system sections + user turn text, see `replayKey`). A miss
 * resolves to a deterministic fallback turn that still streams the composed
 * sections, so candidate influence stays observable on every prompt.
 *
 * Real transcript recording lands with the paid recording twin in the
 * proposal sandbox (specs/07 §6); until then the table is intentionally empty
 * and every turn takes the fallback path.
 * @module @dsh-evolve-le/core/acp/recorded-replay
 */

import { createHash } from 'node:crypto'

export interface RecordedTurn {
  /** sha256 hex of the canonical `replayKey` document for this turn. */
  promptSha256: string
  /** Exact assistant text streamed as one `agent_message_chunk`. */
  responseText: string
  provenance: 'builder-authored-deterministic-replay'
}

/**
 * Authoritative table. Builder-owned (TCB): candidates never influence which
 * responses exist; the capsule ships this exact file inside `runner/`, whose
 * digest is bound by `manifest.json` → `SHA256SUMS` → capsule tar.
 */
export const RECORDED_TURNS: readonly RecordedTurn[] = []

/** Canonical replay key: composed sections in declared order + user text. */
export function replayKey(options: {
  sections: readonly { name: string; order: number; text: string }[]
  userText: string
  messages?: readonly { role: string; content: unknown }[]
  tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
}): string {
  const document = {
    system: [...options.sections]
      .sort((a, b) => a.order - b.order)
      .map((section) => ({ name: section.name, text: section.text })),
    user: options.userText,
    ...(options.messages === undefined ? {} : { messages: options.messages }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
  }
  return JSON.stringify(document)
}

/** sha256 hex of the canonical replay key (the recording lookup key). */
export function promptSha256(options: {
  sections: readonly { name: string; order: number; text: string }[]
  userText: string
  messages?: readonly { role: string; content: unknown }[]
  tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[]
}): string {
  return createHash('sha256').update(replayKey(options), 'utf8').digest('hex')
}

/** Look up a recorded response; `undefined` when the table has no entry. */
export function replayResponseFor(hash: string): string | undefined {
  return RECORDED_TURNS.find((turn) => turn.promptSha256 === hash)?.responseText
}
