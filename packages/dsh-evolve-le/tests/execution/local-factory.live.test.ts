/** Explicit bounded paid smoke through the public CLI runner factory and existing controller. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { Controller } from '../../src/controller/controller.js'
import { FakeProvider } from '../../src/controller/provider.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { localDockerProposalRunner } from '../../src/execution/local-proposal-runner.js'
import {
  materializeExecutionInputs,
  publishExecutionInputs,
} from '../../src/execution/input-manifest.js'
import { materializeSourceSnapshot } from '../../src/execution/snapshot.js'
import { verifyExecutionBundle } from '../../src/execution/evidence.js'
import { createEvidenceExport } from '../../src/proposer/export.js'
import { CATALOG_VERSION } from '../../src/proposer/catalog.js'
import type { ModelRouteConfig } from '../../src/config/run-config.js'
it.skipIf(
  process.env.DSH_LOCAL_FACTORY_LIVE !== '1' || !process.env.DSH_LOCAL_GENERATION_LIVE_CONFIG,
)(
  'runs a bounded live proposal with the public Docker factory and external validation/admission',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-factory-live-'))
    const source = JSON.parse(
      await readFile('evidence/docker-sandbox-20261031/proposal-input-5.json', 'utf8'),
    )
    const store = await openObjectStore(source.casRoot)
    const original = JSON.parse(
      await readFile(process.env.DSH_LOCAL_GENERATION_LIVE_CONFIG!, 'utf8'),
    )
    const selected = original.modelRoutes.find(
      (r: ModelRouteConfig) => r.id === original.proposerRoute,
    )
    const route: ModelRouteConfig = {
      ...selected,
      contextWindowTokens: 262144,
      maxOutputTokens: 4096,
      retry: { maxAttempts: 1, backoffMs: [] },
    }
    const parentTreeDir = join(root, 'parent')
    await materializeSourceSnapshot(store, source.result.inputs[1], parentTreeDir)
    const capsuleRoot = join(root, 'capsule-root')
    await mkdir(capsuleRoot)
    await materializeExecutionInputs(
      store,
      await publishExecutionInputs(store, [
        { target: '/input', inventory: source.result.inputs[2] },
      ]),
      capsuleRoot,
    )
    const capsuleDir = join(capsuleRoot, 'input')
    const identity = JSON.parse(await readFile(join(capsuleDir, 'manifest.json'), 'utf8')).identity
    const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8'))
    const images = JSON.parse(
      await readFile('evidence/docker-sandbox-20261031/executor-images-8.json', 'utf8'),
    ).images
    const built = images.find((x: any) => x.kind === 'proposal')
    const image = { reference: built.reference, id: built.id, platform: built.platform }
    const runId = `local-live-${Date.now()}`
    const runner = localDockerProposalRunner({
      runId,
      storeRoot: store.root,
      profile: { backend: 'docker-local/v1', hostRoot: '/tmp/dsh-localgen', image },
      route,
      dependencyClosureSha256: lock.dependencyClosureSha256,
    })
    const controller = await Controller.open(
      join(root, 'controller'),
      store.root,
      {
        runId,
        budgetLimits: { usd: 200000, 'proposer-tokens': 2000000, 'proposal-calls': 1 },
        proposalRunner: runner,
      },
      new FakeProvider(),
    )
    try {
      const feedback = await store.put(
        Buffer.from(
          JSON.stringify({
            trialId: 'engineering-only-synthetic',
            failureMode: 'planning',
            note: 'Engineering source-generation smoke: improve a small general strategy while preserving the baseline plugin composition and tests. No benchmark outcome is asserted.',
          }),
        ),
        { label: 'DEV_OBSERVED', mediaType: 'application/vnd.dsh-evolve-le.trajectory+json' },
      )
      await mkdir(join(root, 'exports'), { recursive: true })
      const exported = await createEvidenceExport({
        exportsRoot: join(root, 'exports'),
        store,
        principal: 'proposer:engineering',
        purpose: 'engineering live proposal smoke',
        allowedLabels: ['PUBLIC_SPEC', 'DEV_OBSERVED'],
        refs: [feedback],
        createdFromStateHash: 'a'.repeat(64),
        canaryTokens: [],
      })
      const result = await controller.runProposal({
        actionId: 'proposal-1',
        request: {
          authoringInstruction:
            'Engineering source-authoring smoke only. In child-1, add one harmless comment to the inherited src/index.ts identifying local Docker source generation, and set candidate.json canonicalParent to the declared parent source hash. Preserve all executable behavior, package.json, cordis.patch.yml and existing tests. Submit child-1 using proposal_finish after these two edits. No benchmark improvement is requested. Do not explore the TCB implementation or run tests in this source-authoring container; validation runs externally.',
          parentCandidateId: identity.candidateId,
          parentSourceHash: source.config.parentSourceHash,
          exportId: exported.exportId,
          width: 1,
        },
        estimate: [
          { dimension: 'usd', amount: 200000 },
          { dimension: 'proposer-tokens', amount: 2000000 },
          { dimension: 'proposal-calls', amount: 1 },
        ],
        capsuleDir,
        parentTreeDir,
        exportDir: exported.dir,
        catalog: { schemaVersion: 1, catalogVersion: CATALOG_VERSION, runId, entries: [] },
        canaryTokens: [],
        priorRejections: [],
        maxTurns: 32,
        timeoutMs: 360000,
      })
      const artifacts = controller.state.actions['proposal-1']!.artifacts
      const generationRef = artifacts.find(
        (ref) => ref.mediaType === 'application/vnd.dsh-evolve-le.proposal-generation-result+json',
      )
      const generation = generationRef
        ? JSON.parse((await store.read(generationRef)).toString('utf8'))
        : null
      const output = process.env.DSH_LOCAL_GENERATION_REPORT
      if (output)
        await writeFile(
          output,
          JSON.stringify(
            {
              scope:
                'explicit paid engineering smoke on synthetic dev feedback; no benchmark/sealed claim',
              casRoot: store.root,
              runId,
              root,
              profile: runner.profile,
              result,
              generation,
              artifacts,
              budget: controller.state.budgetByAction['proposal-1'],
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
      expect(generation?.outcome).toBe('SUCCEEDED')
      expect(result.status).toBe('COMMITTED')
      expect(result.summary.batchErrors).toEqual([])
      expect(result.summary.usage?.costUsdMicros).toBeGreaterThan(0)
      expect(result.summary.usage!.costUsdMicros).toBeLessThanOrEqual(200000)
      const secret = (await readFile(route.credentialFile!, 'utf8')).trim()
      const bundle = await verifyExecutionBundle(store, generation.execution)
      let leaked = false
      for (const artifact of [...bundle.artifacts, ...artifacts])
        if ((await store.read(artifact)).includes(secret)) leaked = true
      expect(leaked).toBe(false)
    } finally {
      await controller.close()
    }
    // Keep controller evidence/config and sources for review; the generation container/mounts are cleaned by its owner.
    await rm(capsuleRoot, { recursive: true, force: true })
  },
  600000,
)
