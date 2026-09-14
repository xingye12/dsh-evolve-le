import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  installNativeProposalTools,
  disposeNativeProposalTools,
  NATIVE_PROPOSAL_TOOL_BUDGET,
  type NativeProposalToolState,
} from '../src/dsh/native-proposal.js'
import {
  NativeProposalError,
  runNativeProposal,
  NATIVE_PROPOSAL_PROTOCOL,
} from '../src/dsh/native-proposal-runner.js'

describe('native proposal tools', () => {
  it('registers scoped DSH tools and routes effects through the backend', async () => {
    const calls: Array<{ name: string; definition: unknown }> = []
    const ctx = {
      tools: {
        register(definition: { name: string }) {
          calls.push({ name: definition.name, definition })
          return () => {
            calls.push({ name: `dispose:${definition.name}`, definition })
          }
        },
      },
    } as never
    const state: NativeProposalToolState = { calls: 0, disposers: [] }
    const seen: string[] = []
    installNativeProposalTools(
      ctx,
      {
        async listInput(path) {
          seen.push(`list:${path}`)
          return ['a.ts']
        },
        async readInput(path) {
          seen.push(`read:${path}`)
          return 'source'
        },
        async writeChildFile(child, path, content) {
          seen.push(`write:${child}/${path}:${content}`)
        },
        async finalizeProposal(proposal) {
          seen.push('finalize')
          return proposal as never
        },
      },
      state,
    )
    expect(calls.map((entry) => entry.name)).toEqual([
      'proposal_list_files',
      'proposal_read_file',
      'proposal_write_child',
      'proposal_finish',
    ])
    const list = calls[0]?.definition as { execute(args: unknown): Promise<unknown> }
    const write = calls[2]?.definition as { execute(args: unknown): Promise<unknown> }
    await expect(list.execute({ path: 'parent' })).resolves.toBe('a.ts')
    await expect(
      write.execute({ childName: 'child', path: 'src/index.ts', content: 'x' }),
    ).resolves.toBe('ok')
    expect(seen).toEqual(['list:parent', 'write:child/src/index.ts:x'])
    expect(state.calls).toBe(2)
    disposeNativeProposalTools(state)
    expect(state.disposers).toHaveLength(0)
  })

  it('finalizes the bundle at the finish boundary before the shape check (ADR-034)', async () => {
    const calls: Array<{ name: string; definition: unknown }> = []
    const ctx = {
      tools: {
        register(definition: { name: string }) {
          calls.push({ name: definition.name, definition })
          return () => undefined
        },
      },
    } as never
    const state: NativeProposalToolState = { calls: 0, disposers: [] }
    const order: string[] = []
    const raw = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/proposal/v1',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      children: [
        {
          childName: 'child-1',
          hypothesis: 'distinct mechanism hypothesis',
          donorCandidates: [],
          evidenceRefs: [],
          targetFailureModes: ['failure mode'],
        },
      ],
    }
    installNativeProposalTools(
      ctx,
      {
        async listInput() {
          return []
        },
        async readInput() {
          return ''
        },
        async writeChildFile() {},
        async finalizeProposal(proposal) {
          order.push('finalize')
          // ADR-036: the tool boundary deep-copies before finalization (the
          // DSH session freezes tool-call arguments), so identity differs
          // while the content must survive losslessly.
          expect(proposal).not.toBe(raw)
          expect(proposal).toStrictEqual(raw)
          return proposal as never
        },
      },
      state,
    )
    const finish = calls[3]?.definition as { execute(args: unknown): Promise<unknown> }
    // A shape-check on the raw bundle would happen AFTER finalization; were the
    // order inverted, this v1 envelope would be parsed twice and the fake's
    // finalize call could never be the only mutation. resolve/submitted proves
    // finalize ran first and the finalized bundle passed the parse.
    await expect(finish.execute({ proposal: raw })).resolves.toBe('submitted')
    expect(order).toEqual(['finalize'])
    // The finalized private copy (ADR-036), not the frozen argument.
    expect(state.proposal).not.toBe(raw)
    expect(state.proposal).toStrictEqual(raw)
    expect(state.calls).toBe(1)
    disposeNativeProposalTools(state)
  })

  it('permits exactly one feedback-driven repair submission', async () => {
    const calls: Array<{ name: string; definition: unknown }> = []
    const ctx = {
      tools: {
        register(definition: { name: string }) {
          calls.push({ name: definition.name, definition })
          return () => undefined
        },
      },
    } as never
    const state: NativeProposalToolState = { calls: 0, disposers: [] }
    let finalizations = 0
    installNativeProposalTools(
      ctx,
      {
        async listInput() {
          return []
        },
        async readInput() {
          return ''
        },
        async writeChildFile() {},
        async finalizeProposal(proposal) {
          finalizations += 1
          if (finalizations === 1) throw new Error('candidate tests failed: inherited silent shape')
          return proposal as never
        },
      },
      state,
    )
    const finish = calls[3]?.definition as { execute(args: unknown): Promise<unknown> }
    const proposal = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/proposal/v1',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      children: [
        {
          childName: 'child-1',
          hypothesis: 'distinct mechanism hypothesis',
          donorCandidates: [],
          evidenceRefs: [],
          targetFailureModes: ['failure mode'],
        },
      ],
    }
    await expect(finish.execute({ proposal })).rejects.toThrow('inherited silent shape')
    expect(state.finishAttempts).toBe(1)
    await expect(finish.execute({ proposal })).resolves.toBe('submitted')
    expect(state.finishAttempts).toBe(2)
    await expect(finish.execute({ proposal })).rejects.toThrow('already submitted')
    expect(finalizations).toBe(2)
    disposeNativeProposalTools(state)
  })

  it('applies the tool-call budget: soft reminder, hard refusal, finish exempt (ADR-035)', async () => {
    const { softReminderAtCalls, refuseAtCalls } = NATIVE_PROPOSAL_TOOL_BUDGET
    expect(refuseAtCalls).toBeGreaterThan(softReminderAtCalls)
    const calls: Array<{ name: string; definition: unknown }> = []
    const ctx = {
      tools: {
        register(definition: { name: string }) {
          calls.push({ name: definition.name, definition })
          return () => undefined
        },
      },
    } as never
    const state: NativeProposalToolState = { calls: 0, disposers: [] }
    installNativeProposalTools(
      ctx,
      {
        async listInput() {
          return ['a.ts']
        },
        async readInput() {
          return 'source'
        },
        async writeChildFile() {},
        async finalizeProposal(proposal) {
          return proposal as never
        },
      },
      state,
    )
    const list = calls[0]?.definition as { execute(args: unknown): Promise<unknown> }
    const write = calls[2]?.definition as { execute(args: unknown): Promise<unknown> }
    const finish = calls[3]?.definition as { execute(args: unknown): Promise<unknown> }
    // Below the soft boundary: results are untouched.
    await expect(list.execute({ path: 'p' })).resolves.toBe('a.ts')
    expect(state.calls).toBe(1)
    // At the soft boundary the reminder appears in every authoring result.
    state.calls = softReminderAtCalls - 1
    const soft = await list.execute({ path: 'p' })
    expect(soft).toContain(`[tool-call budget] ${softReminderAtCalls}/${refuseAtCalls}`)
    expect(soft).toContain('call proposal_finish')
    const softWrite = await write.execute({ childName: 'c', path: 'f.ts', content: 'x' })
    expect(softWrite).toContain('[tool-call budget]')
    // At the hard boundary the authoring tools refuse, naming the submit tool.
    state.calls = refuseAtCalls
    await expect(list.execute({ path: 'p' })).rejects.toThrow(/call proposal_finish/)
    await expect(write.execute({ childName: 'c', path: 'f.ts', content: 'x' })).rejects.toThrow(
      /tool-call budget exhausted/,
    )
    // proposal_finish stays usable at every count.
    state.calls = refuseAtCalls + 7
    await expect(
      finish.execute({
        proposal: {
          schemaVersion: 1,
          protocol: 'dsh-evolve-le/proposal/v1',
          parentSourceHash: `sha256:${'a'.repeat(64)}`,
          children: [
            {
              childName: 'child-1',
              hypothesis: 'distinct mechanism hypothesis',
              donorCandidates: [],
              evidenceRefs: [],
              targetFailureModes: ['failure mode'],
            },
          ],
        },
      }),
    ).resolves.toBe('submitted')
    expect(state.proposal).toBeDefined()
    disposeNativeProposalTools(state)
  })

  it('deep-copies the frozen tool-call argument before TCB finalization (ADR-036)', async () => {
    const calls: Array<{ name: string; definition: unknown }> = []
    const ctx = {
      tools: {
        register(definition: { name: string }) {
          calls.push({ name: definition.name, definition })
          return () => undefined
        },
      },
    } as never
    const state: NativeProposalToolState = { calls: 0, disposers: [] }
    const raw = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/proposal/v1',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      children: [
        {
          childName: 'child-1',
          hypothesis: 'distinct mechanism hypothesis',
          donorCandidates: [],
          evidenceRefs: [],
          targetFailureModes: ['failure mode'],
        },
      ],
    }
    // The upstream DSH session deep-freezes every appended message (attempt 9
    // evidence: "Cannot assign to read only property ..."), so the tool-call
    // argument arrives fully frozen.
    const deepFreeze = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        Object.freeze(value)
        for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
      }
    }
    deepFreeze(raw)
    let finalized: unknown
    installNativeProposalTools(
      ctx,
      {
        async listInput() {
          return []
        },
        async readInput() {
          return ''
        },
        async writeChildFile() {},
        async finalizeProposal(proposal) {
          // A mutating finalizer (ADR-034 rebuilds receipts in place) proves
          // the tool handed over a private copy, not the frozen argument.
          ;(proposal as Record<string, unknown>)['tcbMarker'] = 'written'
          finalized = proposal
          return proposal as never
        },
      },
      state,
    )
    const finish = calls[3]?.definition as { execute(args: unknown): Promise<unknown> }
    await expect(finish.execute({ proposal: raw })).resolves.toBe('submitted')
    expect((finalized as Record<string, unknown>)['tcbMarker']).toBe('written')
    expect((raw as unknown as Record<string, unknown>)['tcbMarker']).toBeUndefined()
    expect(Object.isFrozen(raw)).toBe(true)
    disposeNativeProposalTools(state)
  })

  it('resolves the native tools service through Cordis get()', () => {
    const names: string[] = []
    const tools = {
      register(definition: { name: string }) {
        names.push(definition.name)
        return () => undefined
      },
    }
    const ctx = {
      get(name: string) {
        return name === 'tools' ? tools : undefined
      },
      get tools(): never {
        throw new Error('guarded tools property was read')
      },
    } as never
    const state: NativeProposalToolState = { calls: 0, disposers: [] }
    installNativeProposalTools(
      ctx,
      {
        async listInput() {
          return []
        },
        async readInput() {
          return ''
        },
        async writeChildFile() {},
        async finalizeProposal(proposal) {
          return proposal as never
        },
      },
      state,
    )
    expect(names).toEqual([
      'proposal_list_files',
      'proposal_read_file',
      'proposal_write_child',
      'proposal_finish',
    ])
    disposeNativeProposalTools(state)
  })
})
describe('native proposal runner: failure transcripts (ADR-035)', () => {
  it('injects one recovery turn when files were written but the first turn did not submit', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-proposal-recovery-'))
    const proposalPath = join(scratch, 'work', 'proposal.json')
    const tools = new Map<string, { execute(args: unknown): Promise<unknown> }>()
    const followups: unknown[] = []
    const sessionIds: unknown[] = []
    const proposal = {
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/proposal/v1',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      children: [
        {
          childName: 'child-1',
          hypothesis: 'complete the already written candidate',
          donorCandidates: [],
          evidenceRefs: [],
          targetFailureModes: ['missing submission'],
        },
      ],
    }
    const ctx = {
      agents: {
        async create(options: {
          sessionId?: unknown
          setup?: (agentCtx: object) => void | Promise<void>
        }) {
          sessionIds.push(options.sessionId)
          await options.setup?.({
            tools: {
              register(definition: { name: string; execute(args: unknown): Promise<unknown> }) {
                tools.set(definition.name, definition)
                return () => undefined
              },
            },
          })
          return {
            agent: {
              followup(message: unknown) {
                followups.push(message)
              },
              async whenIdle() {
                if (followups.length === 1) {
                  await tools.get('proposal_write_child')!.execute({
                    childName: 'child-1',
                    path: 'src/strategy.ts',
                    content: 'export const checkpoint = 1\n',
                  })
                  return
                }
                await tools.get('proposal_finish')!.execute({ proposal })
              },
              session: { events: [] },
            },
            async dispose() {},
          }
        },
      },
    } as unknown as Context
    const result = await runNativeProposal({
      ctx,
      backend: {
        async listInput() {
          return []
        },
        async readInput() {
          return ''
        },
        async writeChildFile() {},
        async finalizeProposal(value) {
          return value as never
        },
      },
      sessionId: 'recovery-turn-test',
      cwd: scratch,
      prompt: 'propose a child',
      proposalPath,
      provider: 'test',
      model: 'test',
    })
    expect(result.proposal).toEqual(proposal)
    expect(followups).toHaveLength(2)
    expect(sessionIds).toEqual(['recovery-turn-test', expect.any(String)])
    expect(sessionIds[1]).not.toBe(sessionIds[0])
    expect(JSON.stringify(followups[1])).toContain('[TCB recovery turn]')
    const transcript = JSON.parse(await readFile(result.transcriptPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(transcript['recoveryTurnInjected']).toBe(true)
    expect(transcript['recoverySessionId']).toBe(sessionIds[1])
    expect(transcript['finishAttempts']).toBe(1)
    await rm(scratch, { recursive: true, force: true })
  })

  it('rejects a native proposal step past maxTurns through the agent/pre-step waterfall', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-native-proposal-cap-'))
    const proposalPath = join(scratch, 'work', 'proposal.json')
    let preStep:
      | ((
          payload: { step?: unknown },
          next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
        ) => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>)
      | undefined
    let admitted = 0
    const ctx = {
      agents: {
        async create(options: { setup?: (agentCtx: object) => void | Promise<void> }) {
          await options.setup?.({
            tools: { register: () => () => undefined },
            on(event: string, listener: typeof preStep) {
              if (event === 'agent/pre-step') preStep = listener
            },
          })
          return {
            agent: {
              followup() {},
              async whenIdle() {
                const first = await preStep?.({ step: 48 }, async () => {
                  admitted += 1
                  return { kind: 'enter' as const, messages: [] }
                })
                expect(first).toEqual({ kind: 'enter', messages: [] })
                const overCap = await preStep?.({ step: 49 }, async () => {
                  admitted += 1
                  return { kind: 'enter' as const, messages: [] }
                })
                expect(overCap).toEqual({ kind: 'reject' })
              },
              session: { events: [] },
            },
            async dispose() {},
          }
        },
      },
    } as unknown as Context
    await expect(
      runNativeProposal({
        ctx,
        backend: {
          async listInput() {
            return []
          },
          async readInput() {
            return ''
          },
          async writeChildFile() {},
          async finalizeProposal(proposal) {
            return proposal as never
          },
        },
        sessionId: 'native-proposal-cap-test',
        cwd: scratch,
        prompt: 'propose a child',
        proposalPath,
        provider: 'test',
        model: 'test',
        maxTurns: 48,
      }),
    ).rejects.toThrow('agent exited without proposal_finish')
    expect(admitted).toBe(1)
    await rm(scratch, { recursive: true, force: true })
  })

  it('writes the session chronology before throwing when proposal_finish never runs', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'dsh-fail-transcript-'))
    const proposalPath = join(scratch, 'work', 'proposal.json')
    const eventCount = 3
    const sessionEvents = [
      { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'propose' }] } } },
      {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done in prose' }] } },
      },
      { type: 'tool/result', data: { name: 'proposal_read_file', ok: true } },
    ]
    const ctx = {
      agents: {
        async create(options: { setup?: (agentCtx: object) => void | Promise<void> }) {
          await options.setup?.({
            tools: { register: () => () => undefined },
          })
          return {
            agent: {
              followup() {},
              async whenIdle() {},
              session: { events: sessionEvents },
            },
            async dispose() {},
          }
        },
      },
    } as unknown as Context
    const error = await runNativeProposal({
      ctx,
      backend: {
        async listInput() {
          return []
        },
        async readInput() {
          return ''
        },
        async writeChildFile() {},
        async finalizeProposal(proposal) {
          return proposal as never
        },
      },
      sessionId: 'failure-transcript-test',
      cwd: scratch,
      prompt: 'propose a child',
      proposalPath,
      provider: 'test',
      model: 'test',
    }).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(NativeProposalError)
    expect(String((error as Error).message)).toContain('agent exited without proposal_finish')
    expect(String((error as Error).message)).toContain('failure-transcript.jsonl')
    const transcript = JSON.parse(
      await readFile(join(scratch, 'work', 'failure-transcript.jsonl'), 'utf8'),
    ) as Record<string, unknown>
    expect(transcript['protocol']).toBe(NATIVE_PROPOSAL_PROTOCOL)
    expect(transcript['ok']).toBe(false)
    expect(transcript['eventCount']).toBe(eventCount)
    expect(transcript['toolCalls']).toBe(0)
    expect(transcript['events']).toEqual(sessionEvents)
    expect(String(transcript['error'])).toContain('agent exited without proposal_finish')
    await rm(scratch, { recursive: true, force: true })
  })
})
