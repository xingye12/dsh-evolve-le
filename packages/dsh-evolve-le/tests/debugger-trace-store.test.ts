import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Controller, DIAGNOSTIC_TRACE_MEDIA_TYPE } from '../src/controller/controller.js'
import { FakeProvider } from '../src/controller/provider.js'
import { openObjectStore } from '../src/state/object-store.js'
import { hydrateBundle } from '../src/attribution/lifecycle.js'

describe('immutable diagnostic shard directory', () => {
  it('persists and hydrates the complete >192 event trace, refusing unowned shard refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debugger-shards-'))
    const events = Array.from({ length: 241 }, (_, index) => ({
      index,
      eventId: `atif-${index}`,
      source: 'atif',
      sourceIndex: index,
      kind: 'trajectory:assistant',
      actor: 'agent',
      agentId: 'a',
      data: { content: index === 240 ? 'terminal tail' : 'step', metric: { numberText: '0.1' } },
    }))
    const provider = new FakeProvider({
      outcome: 'failure',
      costUsdMicros: 0,
      diagnosticBundle: Buffer.from(
        JSON.stringify({
          protocol: 'dsh-evolve-le/diagnostic-trace-bundle/v3',
          events,
          tests: [],
          terminal: { agentParticipation: 'ran' },
        }),
      ),
    })
    const options = { runId: 'shards', budgetLimits: { 'task-trials': 1 } }
    let controller = await Controller.open(
      join(root, 'controller'),
      join(root, 'objects'),
      options,
      provider,
    )
    try {
      await controller.changePhase('PREFLIGHT', 'fixture')
      await controller.runEvaluation({
        actionId: 'eval-long',
        waveId: null,
        candidateId: 'parent',
        opaqueTaskId: 'task',
        attempt: 1,
        split: 'dev-observed',
        estimate: [{ dimension: 'task-trials', amount: 1 }],
      })
      const artifacts = controller.state.actions['eval-long']!.artifacts
      const manifestRef = artifacts.find((r) => r.mediaType === DIAGNOSTIC_TRACE_MEDIA_TYPE)!
      const store = await openObjectStore(join(root, 'objects'))
      const manifest = JSON.parse((await store.read(manifestRef)).toString())
      expect(manifest.events).toEqual([])
      expect(manifest.eventDirectory).toHaveLength(241)
      expect(manifest.shards).toHaveLength(5)
      const bundle = await hydrateBundle(store, manifestRef, artifacts)
      expect(bundle.events).toEqual(events)
      expect(bundle.events[240]!.data).toMatchObject({ content: 'terminal tail' })
      await expect(
        hydrateBundle(
          store,
          manifestRef,
          artifacts.filter((r) => r.digest !== manifest.shards[0].digest),
        ),
      ).rejects.toThrow('outside trial evidence')
      await controller.close()
      controller = await Controller.open(
        join(root, 'controller'),
        join(root, 'objects'),
        options,
        provider,
      )
      const replayRefs = controller.state.actions['eval-long']!.artifacts
      expect(await hydrateBundle(store, manifestRef, replayRefs)).toEqual(bundle)
      expect(provider.counters.launchEffects).toHaveLength(1)
    } finally {
      await controller.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
