/**
 * TCB systemPrompt stub for capsule runner compositions (Gate 1). The real
 * DSH `systemPrompt` service belongs to the upstream DSH stack and is staged
 * with the full ACP closure (Gate 1 container E2E); admission boots use this
 * byte-stable stub, which provides the same `section()` contract plus a
 * `snapshot()` readout the runner probe can assert on. Compiled to a single
 * dependency-free file and shipped inside every capsule at
 * `runtime/system-prompt-stub.mjs`.
 * @module @dsh-evolve-le/core/probe/system-prompt-stub
 */

import type { Context } from '@deepseek-ai/cordis'

/** One registered prompt section. */
export interface PromptSectionRecord {
  readonly name: string
  readonly order: number
  readonly text: string
}

/** Stub service contract: the real surface plus a test readout. */
export interface StubSystemPromptService {
  section(input: PromptSectionRecord): () => void
  snapshot(): readonly PromptSectionRecord[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: StubSystemPromptService
  }
}

export const name = 'dsh-evolve-le:system-prompt-stub'

export function apply(ctx: Context): void {
  const sections: PromptSectionRecord[] = []
  ctx.provide('systemPrompt', {
    section(input: PromptSectionRecord): () => void {
      const record: PromptSectionRecord = { name: input.name, order: input.order, text: input.text }
      sections.push(record)
      return () => {
        const at = sections.indexOf(record)
        if (at >= 0) sections.splice(at, 1)
      }
    },
    snapshot(): readonly PromptSectionRecord[] {
      return [...sections]
    },
  })
}
