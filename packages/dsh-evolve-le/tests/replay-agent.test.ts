import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { replayPromptSections } from '../src/acp/replay-agent.js'

describe('replay prompt inventory', () => {
  it('preserves the compatibility snapshot order', async () => {
    const sections = await replayPromptSections({
      systemPrompt: {
        snapshot: () => [
          { name: 'candidate:later', order: 200, text: 'later' },
          { name: 'candidate:first', order: 100, text: 'first' },
        ],
      },
    } as unknown as Context)

    expect(sections).toEqual([
      { name: 'candidate:later', order: 200, text: 'later' },
      { name: 'candidate:first', order: 100, text: 'first' },
    ])
  })

  it('uses the native public assembly in its canonical sequence', async () => {
    const sections = await replayPromptSections({
      get(name: string) {
        if (name !== 'systemPrompt') return undefined
        return {
          assemble: async () => ({
            sections: [
              { name: 'harness:identity', text: 'harness' },
              { name: 'candidate:identity', text: 'candidate' },
            ],
          }),
        }
      },
    } as unknown as Context)

    expect(sections).toEqual([
      { name: 'harness:identity', order: 0, text: 'harness' },
      { name: 'candidate:identity', order: 1, text: 'candidate' },
    ])
  })
})
