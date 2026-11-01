import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, it, expect, vi } from 'vitest'
import { Controller } from '../../src/controller/controller.js'
import { FakeProvider } from '../../src/controller/provider.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { makeProposalConfig } from '../execution/fixtures.js'
const probe = vi.hoisted(() => ({ status: 'NOT_STARTED', starts: 0, failBoundary: false }))
vi.mock('../../src/execution/proposal-launcher.js', () => ({
  startProposalSupervisor: async () => { probe.starts++; probe.status = 'RUNNING'; return { pid: 123, root: '/fixed' } },
}))
vi.mock('../../src/execution/proposal-process.js', () => ({
  proposalProcessContext: async (config: ReturnType<typeof makeProposalConfig>) => ({
    config, root: '/fixed', binding: {
      config: { candidateId: 'c_parent', parentSourceHash: `sha256:${'a'.repeat(64)}`, width: 1 },
      exportManifest: { exportId: 'export' },
    },
  }),
  readProposalProcessState: async () => ({ status: probe.status, pid: probe.status === 'RUNNING' ? 123 : null, result: null, failures: [] }),
}))
beforeEach(() => { probe.status = 'NOT_STARTED'; probe.starts = 0; probe.failBoundary = false })
const limits = { usd: 100000, 'proposer-tokens': 1000000, 'proposal-calls': 10, 'task-trials': 10 }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'controller-docker-'))
  const store = await openObjectStore(join(root, 'cas'))
  const config = makeProposalConfig()
  config.storeRoot = store.root
  config.tests.profile.storeRoot = store.root
  const controllerConfig = { runId: config.spec.runId, budgetLimits: limits,
    onBoundary: (point: string) => { if (probe.failBoundary && point === 'launch-before-effect') throw Error('crash-before-effect') } }
  const open = () => Controller.open(join(root, 'run'), store.root, controllerConfig, new FakeProvider())
  const input = { actionId: config.spec.actionId, configuration: config,
    request: { parentCandidateId: 'c_parent', parentSourceHash: `sha256:${'a'.repeat(64)}`, exportId: 'export', width: 1 },
    estimate: [{ dimension: 'proposal-calls' as const, amount: 1 }, { dimension: 'usd' as const, amount: 1000 }, { dimension: 'proposer-tokens' as const, amount: 100000 }] }
  return { root, store, open, input }
}
it('journals a frozen Docker intent, observes lost owners and never relaunches or admits on resume', async () => {
  const f = await fixture(); let controller = await f.open()
  try {
    const progress = await controller.runDockerProposal(f.input)
    expect(progress.state).toBe('RUNNING'); expect(probe.starts).toBe(1)
    expect(controller.state.evidence?.['docker-proposal-profile']).toBeTruthy()
    expect(controller.state.actions[f.input.actionId]?.externalJobId).toBe('/fixed')
    expect(Object.keys(controller.state.candidates)).toHaveLength(0)
    const frozen = JSON.parse((await f.store.read(progress.configuration)).toString('utf8'))
    expect(frozen).toEqual(f.input.configuration)
    await controller.close(); probe.status = 'INCOMPLETE'; controller = await f.open()
    expect(controller.recovery.inspected[0]?.disposition).toBe('lost')
    expect((await controller.runDockerProposal(f.input)).state).toBe('INCOMPLETE')
    expect(probe.starts).toBe(1)
    expect(controller.state.actions[f.input.actionId]?.status).toBe('RUNNING')
    expect(Object.keys(controller.state.candidates)).toHaveLength(0)
    f.input.configuration.model.limits.maxRequests++
    await expect(controller.runDockerProposal(f.input)).rejects.toThrow(/profile|drift/)
    await expect(controller.runProposal({ actionId: f.input.actionId } as never)).rejects.toThrow(/Docker/)
  } finally { await controller.close(); await rm(f.root, { recursive: true, force: true }) }
})
it('retains a launch-intent crash as unknown instead of buying another model execution', async () => {
  const f = await fixture(); let controller = await f.open()
  try {
    probe.failBoundary = true
    await expect(controller.runDockerProposal(f.input)).rejects.toThrow(/crash-before-effect/)
    expect(probe.starts).toBe(0)
    await controller.close(); probe.failBoundary = false; controller = await f.open()
    expect((await controller.runDockerProposal(f.input)).state).toBe('INCOMPLETE')
    expect(probe.starts).toBe(0)
  } finally { await controller.close(); await rm(f.root, { recursive: true, force: true }) }
})
it('requires the durable parent, action namespace and worst-case model budget before reserving', async () => {
  const f = await fixture(); const controller = await f.open()
  try {
    await expect(controller.runDockerProposal({ ...f.input, request: { ...f.input.request, parentCandidateId: 'other' } })).rejects.toThrow(/binding/)
    await expect(controller.runDockerProposal({ ...f.input, actionId: 'other' })).rejects.toThrow(/namespace/)
    await expect(controller.runDockerProposal({ ...f.input, estimate: [] })).rejects.toThrow(/reservation/)
    expect(Object.keys(controller.state.actions)).toHaveLength(0)
    expect(probe.starts).toBe(0)
  } finally { await controller.close(); await rm(f.root, { recursive: true, force: true }) }
})
