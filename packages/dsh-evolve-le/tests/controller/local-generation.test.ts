import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it, expect } from 'vitest'
import {
  Controller,
  type ProposalRunner,
  type ProposalInput,
} from '../../src/controller/controller.js'
import { FakeProvider } from '../../src/controller/provider.js'
it('journals a Docker launch before effects, charges an unknown attempt conservatively, and never retries or falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controller-local-generation-'))
  let calls = 0
  const runner: ProposalRunner = async () => {
    calls++
    throw Error('lost owner')
  }
  runner.backend = 'local-generation/v1'
  runner.profile = { backend: 'local-generation/v1', image: 'frozen' }
  const config = {
    runId: 'local-test',
    budgetLimits: { usd: 1000, 'proposer-tokens': 1000, 'proposal-calls': 10 },
    proposalRunner: runner,
  }
  let controller = await Controller.open(
    join(root, 'run'),
    join(root, 'cas'),
    config,
    new FakeProvider(),
  )
  const input: ProposalInput = {
    actionId: 'proposal-1',
    request: {
      parentCandidateId: 'parent',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      exportId: 'export',
      width: 1,
    },
    estimate: [
      { dimension: 'usd', amount: 100 },
      { dimension: 'proposer-tokens', amount: 200 },
      { dimension: 'proposal-calls', amount: 1 },
    ],
    capsuleDir: '/unused',
    parentTreeDir: '/unused',
    exportDir: '/unused',
    catalog: {
      schemaVersion: 1,
      catalogVersion: 'dsh-evolve-le/archive-catalog/v1',
      runId: 'local-test',
      entries: [],
    },
    canaryTokens: [],
    priorRejections: [],
  }
  try {
    const result = await controller.runProposal(input)
    expect(result.status).toBe('FAILED')
    expect(calls).toBe(1)
    expect(controller.state.actions[input.actionId]!.externalJobId).toBeTruthy()
    expect(Object.keys(controller.state.candidates)).toHaveLength(0)
    expect(controller.state.budgetByAction[input.actionId]!.usd?.spent).toBe(100)
    await controller.close()
    controller = await Controller.open(
      join(root, 'run'),
      join(root, 'cas'),
      config,
      new FakeProvider(),
    )
    expect((await controller.runProposal(input)).status).toBe('FAILED')
    expect(calls).toBe(1)
    await expect(
      controller.runProposal({
        ...input,
        request: { ...input.request, authoringInstruction: 'changed objective' },
      }),
    ).rejects.toThrow(/durable request/)
    await controller.close()
    controller = await Controller.open(
      join(root, 'run'),
      join(root, 'cas'),
      { ...config, proposalRunner: undefined },
      new FakeProvider(),
    )
    await expect(controller.runProposal({ ...input, actionId: 'other' })).rejects.toThrow(
      /fall back/,
    )
  } finally {
    await controller.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('survives a real controller SIGKILL after durable launch without buying a second generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controller-local-crash-'))
  const input = {
    actionId: 'proposal-1',
    request: {
      parentCandidateId: 'parent',
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
      exportId: 'export',
      width: 1,
    },
    estimate: [
      { dimension: 'usd' as const, amount: 100 },
      { dimension: 'proposer-tokens' as const, amount: 200 },
      { dimension: 'proposal-calls' as const, amount: 1 },
    ],
    capsuleDir: '/unused',
    parentTreeDir: '/unused',
    exportDir: '/unused',
    catalog: {
      schemaVersion: 1 as const,
      catalogVersion: 'dsh-evolve-le/archive-catalog/v1',
      runId: 'crash-test',
      entries: [],
    },
    canaryTokens: [],
    priorRejections: [],
  }
  const inputPath = join(root, 'input.json')
  await writeFile(inputPath, JSON.stringify(input))
  const entry = join(root, 'owner.mjs')
  const core = pathToFileURL(resolve('packages/dsh-evolve-le/lib/controller/controller.js')).href
  const provider = pathToFileURL(resolve('packages/dsh-evolve-le/lib/controller/provider.js')).href
  await writeFile(
    entry,
    `import {Controller} from ${JSON.stringify(core)};import{FakeProvider}from ${JSON.stringify(provider)};import{readFile}from 'node:fs/promises';import{join}from 'node:path';const root=process.argv[2];const runner=async()=>{throw Error('must not launch')};runner.backend='local-generation/v1';runner.profile={backend:'local-generation/v1',image:'frozen'};const c=await Controller.open(join(root,'run'),join(root,'cas'),{runId:'crash-test',budgetLimits:{usd:1000,'proposer-tokens':1000,'proposal-calls':10},proposalRunner:runner,onBoundary(point){if(point==='launch-before-effect')process.kill(process.pid,'SIGKILL')}},new FakeProvider());await c.runProposal(JSON.parse(await readFile(join(root,'input.json'),'utf8')));`,
  )
  try {
    await expect(
      promisify(execFile)(process.execPath, [entry, root], { timeout: 30000 }),
    ).rejects.toMatchObject({ signal: 'SIGKILL' })
    let calls = 0
    const runner: ProposalRunner = async () => {
      calls++
      throw Error('must not relaunch')
    }
    runner.backend = 'local-generation/v1'
    runner.profile = { backend: 'local-generation/v1', image: 'frozen' }
    const c = await Controller.open(
      join(root, 'run'),
      join(root, 'cas'),
      {
        runId: 'crash-test',
        budgetLimits: { usd: 1000, 'proposer-tokens': 1000, 'proposal-calls': 10 },
        proposalRunner: runner,
      },
      new FakeProvider(),
    )
    try {
      expect((await c.runProposal(input)).status).toBe('FAILED')
      expect(calls).toBe(0)
      expect(c.state.budgetByAction[input.actionId]!.usd?.spent).toBe(100)
      expect(Object.keys(c.state.candidates)).toHaveLength(0)
    } finally {
      await c.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
