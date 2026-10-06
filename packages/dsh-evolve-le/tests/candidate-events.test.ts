import { validateManifest } from '../src/schema.js'
import { NATIVE_CAPABILITIES_POLICY } from '../src/dsh/native-capabilities.js'
import { NATIVE_DSH_PACKAGE_PINS } from '../src/dsh/native-composition.js'
import { describe, expect, it } from 'vitest'
import {
  installCandidateEventBridge,
  installCandidateStrategyEvents,
  CANDIDATE_RUNTIME_EVENT_NAMES,
  queueCandidateCheckpoint,
} from '../src/dsh/candidate-events.js'

function fixture() {
  const listeners = new Map<string, (...args: any[]) => any>()
  const services = new Map<string, any>()
  const log: any[] = []
  const ctx = {
    agent: {
      session: {
        id: 'mine',
        append(type: string, data: unknown) {
          log.push({ type, data })
          listeners.get('session/event')?.(ctx.agent.session, { type, data })
        },
      },
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
    },
    on(name: string, fn: any) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
  }
  const registry = installCandidateStrategyEvents(ctx as never)
  const checkpoints: string[] = []
  const bridge = installCandidateEventBridge(
    ctx as never,
    registry,
    (turn, step) => ({
      protocol: 'legacy',
      turn,
      step,
      phase: 'pre-step',
      observation: {
        toolCalls: { exec: 0, read: 0, write: 0 },
        previousAction: 'none',
        lastExec: { outcome: 'none', consecutiveRepeated: 0 },
        writesSinceLastExec: 0,
      },
    }),
    (c) => checkpoints.push(c),
  )
  return { ctx, registry, checkpoints, listeners, log, bridge }
}

describe('controlled candidate event bridge', () => {
  it('extends the three lifecycle events with real agent, tool, turn and compaction events', () => {
    expect(CANDIDATE_RUNTIME_EVENT_NAMES).toContain('candidate:agent/tool-result')
    expect(CANDIDATE_RUNTIME_EVENT_NAMES).toContain('candidate:session/compaction-summary')
    expect(CANDIDATE_RUNTIME_EVENT_NAMES.length).toBeGreaterThan(10)
  })
  it('awaits callbacks, preserves next exactly once, freezes safe facts and queues checkpoints', async () => {
    const f = fixture()
    const seen: any[] = []
    let nextCalls = 0
    f.registry.register({
      name: 'candidate:agent/tool-post-execute',
      handler: async (c) => {
        seen.push(c)
        return { checkpoint: 'inspect the result' }
      },
    })
    const result = { isError: true, error: { message: 'SECRET' }, content: 'SECRET' }
    const next = async () => {
      nextCalls++
      return { kind: 'accept' }
    }
    expect(
      await f.listeners.get('tools/post-execute')!(
        {
          name: 'solve_exec',
          arguments: { secret: 'SECRET' },
          signal: new AbortController().signal,
        },
        result,
        next,
      ),
    ).toEqual({ kind: 'accept' })
    await f.bridge.drain()
    expect(nextCalls).toBe(1)
    expect(f.checkpoints).toEqual(['inspect the result'])
    expect(seen[0]).toMatchObject({
      protocol: 'dsh-evolve-le/candidate-strategy-context/v2',
      phase: 'event',
      event: { name: 'candidate:agent/tool-post-execute', toolKind: 'exec', outcome: 'failed' },
    })
    expect(Object.isFrozen(seen[0].event)).toBe(true)
    expect(JSON.stringify(seen)).not.toContain('SECRET')
    expect(f.registry.audit()[0]).toMatchObject({
      name: 'candidate:agent/tool-post-execute',
      ok: true,
    })
  })
  it('filters other sessions and recursive audit events while awaiting async observers', async () => {
    const f = fixture()
    const names: string[] = []
    for (const name of ['candidate:session/event', 'candidate:session/turn-end'])
      f.registry.register({
        name,
        handler: async (c) => {
          await Promise.resolve()
          names.push((c as any).event.name)
        },
      })
    const observe = f.listeners.get('session/event')!
    observe({ id: 'other' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    observe(f.ctx.agent.session, { type: 'candidate/strategy-event', data: {} })
    observe(f.ctx.agent.session, {
      type: 'turn/end',
      data: { turn: 2, reason: { kind: 'completed' }, secret: 'SECRET' },
    })
    await f.bridge.drain()
    expect(names).toEqual(['candidate:session/event', 'candidate:session/turn-end'])
    expect(f.registry.audit()).toHaveLength(2)
  })
  it('fails closed on asynchronous handler errors instead of swallowing them', async () => {
    const f = fixture()
    f.registry.register({
      name: 'candidate:agent/error',
      handler: async () => {
        throw Error('handler failed')
      },
    })
    f.listeners.get('agent/error')!({ turn: 1, step: 2, error: new Error('SECRET') })
    await expect(f.bridge.drain()).rejects.toThrow('handler failed')
  })
  it('bounds emitting event floods and checkpoints independently', async () => {
    const f = fixture()
    f.registry.register({ name: 'candidate:agent/status', handler: () => undefined })
    for (let i = 0; i < 257; i++) f.listeners.get('agent/status')!({ status: 'running' })
    await expect(f.bridge.drain()).rejects.toThrow('queue limit exceeded')
    const queue: string[] = []
    for (let i = 0; i < 64; i++) queueCandidateCheckpoint(queue, 'checkpoint')
    expect(() => queueCandidateCheckpoint(queue, 'one more')).toThrow(
      'checkpoint queue limit exceeded',
    )
    expect(queue).toHaveLength(64)
  })
  it('projects compaction prune without exposing its summary or discarded messages', async () => {
    const f = fixture()
    let seen: any
    f.registry.register({
      name: 'candidate:session/compaction-prune',
      handler: (c) => {
        seen = c
      },
    })
    f.listeners.get('session/event')!(f.ctx.agent.session, {
      type: 'compaction/prune',
      data: { summary: 'SECRET', messages: ['SECRET'] },
    })
    await f.bridge.drain()
    expect(seen.event.sessionEventType).toBe('compaction/prune')
    expect(JSON.stringify(seen)).not.toContain('SECRET')
  })
  it('requires the new event policy for v3 while preserving historical v1/v2 manifests', () => {
    const hash = 'a'.repeat(64)
    const { events: _events, protocol: _protocol, ...components } = NATIVE_CAPABILITIES_POLICY
    const legacy = { ...components, protocol: 'dsh-evolve-le/native-capabilities/v1' }
    const capsule = (protocol: string, capabilities?: unknown) => ({
      $schema: 'https://dsh-evolve-le.local/schemas/capsule.manifest.schema.json',
      schemaVersion: 1,
      protocol: 'dsh-evolve-le/capsule/v1',
      identity: { candidateId: 'c_' + 'a'.repeat(26), sourceDigest: 'sha256:' + hash },
      contents: { fileCount: 1, bytes: 1, sha256SumsDigest: hash },
      candidate: { digest: hash, entry: 'lib/index.js' },
      runner: { digest: hash, entry: 'runner/acp-boot.js' },
      runtime: {
        kind: 'pinned-closure',
        digest: hash,
        detail: 'fixture',
        nativeDsh: {
          protocol,
          packages: NATIVE_DSH_PACKAGE_PINS,
          ...(capabilities === undefined ? {} : { capabilities }),
        },
      },
      sbom: { path: 'sbom.spdx.json', sha256: hash },
    })
    expect(validateManifest('capsule', capsule('dsh-evolve-le/native-dsh/v1')).ok).toBe(true)
    expect(validateManifest('capsule', capsule('dsh-evolve-le/native-dsh/v2', legacy)).ok).toBe(
      true,
    )
    expect(
      validateManifest(
        'capsule',
        capsule('dsh-evolve-le/native-dsh/v3', NATIVE_CAPABILITIES_POLICY),
      ).ok,
    ).toBe(true)
    expect(validateManifest('capsule', capsule('dsh-evolve-le/native-dsh/v3', legacy)).ok).toBe(
      false,
    )
    expect(validateManifest('capsule', capsule('dsh-evolve-le/native-dsh/v3')).ok).toBe(false)
  })
})
