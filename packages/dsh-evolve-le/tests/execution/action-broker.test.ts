import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { ProposalActionBroker } from '../../src/execution/action-broker.js'
import { captureSourceSnapshot } from '../../src/execution/snapshot.js'
import { ACTION_RPC_PROTOCOL, type ActionRpcRequest } from '../../src/execution/rpc.js'
import { ContainerShell } from '../../src/execution/shell.js'
import { parseProposalOutput } from '../../src/proposer/protocol.js'
import { makeSpec } from './fixtures.js'
describe('action broker source and submission authority', () => {
  it('shares tool edits, captures exact child snapshots, seals submission, and retains failed calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'action-broker-')),
      input = join(root, 'input'),
      workspace = join(root, 'workspace')
    const store = await openObjectStore(join(root, 'cas'))
    const spec = makeSpec()
    spec.deadlineUtc = new Date(Date.now() + 30000).toISOString()
    await mkdir(input)
    await mkdir(workspace)
    await mkdir(join(workspace, 'child-1'))
    await writeFile(join(workspace, 'child-1', 'index.ts'), 'parent')
    let snapshots = 0,
      submissions = 0
    const options: ConstructorParameters<typeof ProposalActionBroker>[0] = {
      spec,
      inputRoot: input,
      workspaceRoot: workspace,
      controlRoot: join(root, 'control'),
      store,
      children: ['child-1'],
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      shell: new ContainerShell({
        engine: {
          async request() {
            throw Error('not used')
          },
          async json() {
            throw Error('not used')
          },
        },
        store,
        async abort() {
          throw Error('not used')
        },
      }),
      async snapshot(child) {
        snapshots++
        return captureSourceSnapshot({ root: join(workspace, child), spec, store, child })
      },
      async test() {
        throw Error('not used')
      },
      async finalize(proposal, sources) {
        parseProposalOutput(proposal)
        return { proposal, sources: [...sources] }
      },
      async submitted() {
        submissions++
      },
    }
    const broker = new ProposalActionBroker(options)
    const call = (id: string, method: ActionRpcRequest['method'], args: unknown) =>
      broker.handler(
        {
          protocol: ACTION_RPC_PROTOCOL,
          executionId: spec.executionId,
          invocationId: id,
          method,
          args,
        },
        new AbortController().signal,
      )
    try {
      await call('write', 'write-child', { child: 'child-1', path: 'index.ts', content: 'child' })
      await call('write', 'write-child', { child: 'child-1', path: 'index.ts', content: 'child' })
      expect(await broker.mutationCount()).toBe(1)
      await expect(
        call('outside', 'write-child', { child: 'other', path: 'index.ts', content: 'bad' }),
      ).rejects.toThrow(/preallocated/)
      const proposal = {
        schemaVersion: 1,
        protocol: 'dsh-evolve-le/proposal/v1',
        parentSourceHash: `sha256:${'a'.repeat(64)}`,
        children: [
          {
            childName: 'child-1',
            hypothesis: 'general mechanism improvement',
            donorCandidates: [],
            evidenceRefs: [],
            targetFailureModes: ['planning'],
          },
        ],
      }
      const result = (await call('finish', 'finish', { proposal })) as { receipt: unknown }
      expect(result.receipt).toBeDefined()
      expect(snapshots).toBe(1)
      expect(submissions).toBe(1)
      const recovered = new ProposalActionBroker(options)
      expect(await recovered.restore()).toEqual(result.receipt)
      await expect(
        recovered.handler(
          {
            protocol: ACTION_RPC_PROTOCOL,
            executionId: spec.executionId,
            invocationId: 'restart-write',
            method: 'write-child',
            args: { child: 'child-1', path: 'index.ts', content: 'bad' },
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/revoked/)
      expect(
        (await recovered.artifacts()).some(
          (r) => r.digest === (result.receipt as { digest: string }).digest,
        ),
      ).toBe(true)
      await expect(
        call('late-write', 'write-child', { child: 'child-1', path: 'index.ts', content: 'late' }),
      ).rejects.toThrow(/revoked/)
      await expect(
        new ProposalActionBroker({
          ...options,
          parentSourceHash: `sha256:${'b'.repeat(64)}`,
        }).restore(),
      ).rejects.toThrow(/parent/)
      await expect(
        new ProposalActionBroker({ ...options, children: ['other-child'] }).restore(),
      ).rejects.toThrow(/allocation/)
      await expect(
        new ProposalActionBroker({
          ...options,
          spec: { ...spec, attemptId: 'another-attempt' },
        }).restore(),
      ).rejects.toThrow(/binding/)
      expect((await broker.artifacts()).length).toBeGreaterThan(5)
      let release!: () => void, reached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const finalizing = new Promise<void>((resolve) => {
        reached = resolve
      })
      const cancelled = new ProposalActionBroker({
        ...options,
        controlRoot: join(root, 'cancelled-control'),
        async finalize(raw, sources) {
          reached()
          await gate
          parseProposalOutput(raw)
          return { proposal: raw, sources: [...sources] }
        },
      })
      const pending = cancelled.handler(
        {
          protocol: ACTION_RPC_PROTOCOL,
          executionId: spec.executionId,
          invocationId: 'cancelled-finish',
          method: 'finish',
          args: { proposal },
        },
        new AbortController().signal,
      )
      const completed = pending.then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      )
      await finalizing
      cancelled.revoke()
      release()
      expect((await completed).error?.message).toMatch(/revoked/)
      expect(submissions).toBe(1)
      expect(await cancelled.restore()).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
