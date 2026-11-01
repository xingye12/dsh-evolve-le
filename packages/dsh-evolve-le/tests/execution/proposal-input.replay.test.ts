import { makeSpec } from './fixtures.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEvidenceExport } from '../../src/proposer/export.js'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { it, expect } from 'vitest'
import { canonicalJson } from '../../src/state/canonical.js'
import { openObjectStore, type ObjectRef } from '../../src/state/object-store.js'
import { captureBoundedTree, readCapturedTree } from '../../src/execution/snapshot.js'
import {
  composeProposalInputs,
  readProposalInputBinding,
} from '../../src/execution/proposal-input.js'
import {
  DOCKER_SANDBOX_PROTOCOL,
  DOCKER_NATIVE_PROTOCOL,
  DOCKER_CAPABILITIES_PROTOCOL,
  DOCKER_TOOLS_PROTOCOL,
} from '../../src/execution/types.js'
const report = process.env.DSH_PROPOSAL_PARENT_REPORT ?? ''
it.skipIf(!report || !existsSync(report))(
  'freezes proposal source, real parent capsule, current worker and development feedback from CAS',
  async () => {
    const document = JSON.parse(await readFile(report, 'utf8')) as {
      casRoot: string
      inputComposition: { inputs: ObjectRef[]; parentSourceDigest: string }
    }
    const store = await openObjectStore(document.casRoot),
      refs = document.inputComposition.inputs
    const capsule = await readCapturedTree(store, refs[3]!)
    const json = async (path: string) =>
      JSON.parse(
        (await store.read(capsule.files.find((f) => f.path === path)!.content)).toString('utf8'),
      )
    const identity = (await json('manifest.json')).identity as { candidateId: string }
    const pkg = (await json('candidate/package.json')) as { name: string }
    const worker = await captureBoundedTree({
      root: 'packages/dsh-evolve-le/lib',
      store,
      limits: { bytes: 32 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, inodes: 8192 },
    })
    const put = (value: unknown) =>
      store.put(Buffer.from(canonicalJson(value)), {
        mediaType: 'application/json',
        label: 'CONTROLLER_INTERNAL',
      })
    const workerInventory = await put(worker)
    const catalog = await put({ protocol: 'test-catalog', entries: [] })
    const feedback = await store.put(Buffer.from('development feedback\n'), {
      mediaType: 'text/plain',
      label: 'DEV_OBSERVED',
    })
    const temporary = await mkdtemp(join(tmpdir(), 'proposal-evidence-'))
    let evidenceInventory: ObjectRef
    try {
      const exported = await createEvidenceExport({
        exportsRoot: temporary,
        store,
        principal: 'proposer:input-replay',
        purpose: 'development proposal',
        allowedLabels: ['PUBLIC_SPEC', 'DEV_OBSERVED'],
        refs: [feedback],
        createdFromStateHash: 'a'.repeat(64),
        canaryTokens: [],
      })
      evidenceInventory = await put(
        await captureBoundedTree({
          root: exported.dir,
          store,
          limits: { bytes: 1048576, fileBytes: 1048576, inodes: 128 },
        }),
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
      dependencyClosureSha256: string
    }
    const config = {
      protocol: DOCKER_SANDBOX_PROTOCOL,
      nativeProtocol: DOCKER_NATIVE_PROTOCOL,
      capabilityProtocol: DOCKER_CAPABILITIES_PROTOCOL,
      toolsProtocol: DOCKER_TOOLS_PROTOCOL,
      executionId: 'proposal-input-replay',
      candidatePackage: pkg.name,
      candidateId: identity.candidateId,
      parentSourceHash: document.inputComposition.parentSourceDigest,
      width: 2,
      provider: 'replay',
      model: 'fixed',
      maxTokens: 1024,
      contextWindowTokens: 8192,
      maxTurns: 8,
      shellTimeoutMs: 1000,
      outputBytes: 1048576,
      clientTimeoutMs: 10000,
    }
    const options = {
      store,
      parentSnapshot: refs[2]!,
      parentCapsuleInventory: refs[3]!,
      workerInventory,
      dependencyClosureSha256: lock.dependencyClosureSha256,
      config,
      catalog,
      evidenceInventory,
    }
    const frozenConfig = structuredClone(config)
    const pending = composeProposalInputs(options)
    config.model = 'mutated-after-dispatch'
    const result = await pending
    expect(result.children).toEqual(['child-1', 'child-2'])
    const spec = makeSpec()
    spec.executionId = frozenConfig.executionId
    spec.inputs = result.inputs
    spec.command = [
      '/input/capsule/runtime/node',
      '/input/capsule/runner/bin/docker-proposer-worker.js',
      '/input/config.json',
    ]
    const binding = await readProposalInputBinding(store, result.inputManifest, spec)
    expect(binding.config).toEqual(frozenConfig)
    expect(`sha256:${binding.parent.sha256}`).toBe(frozenConfig.parentSourceHash)
    expect(binding.children).toEqual(result.children)
    await expect(
      readProposalInputBinding(store, result.inputManifest, { ...spec, executionId: 'foreign' }),
    ).rejects.toThrow(/execution\/limits/)
    const manifest = JSON.parse((await store.read(result.inputManifest)).toString('utf8')) as {
      trees: Array<{ inventory: ObjectRef }>
    }
    const input = await readCapturedTree(store, manifest.trees[0]!.inventory)
    const file = (path: string) => input.files.find((f) => f.path === path)!
    expect(JSON.parse((await store.read(file('config.json').content)).toString('utf8'))).toEqual(
      frozenConfig,
    )
    expect(file(`export/objects/${feedback.digest}`).content.digest).toEqual(feedback.digest)
    expect(file('capsule/runner/execution/proposal-worker-config.js')).toBeDefined()
    expect(file('capsule/runtime/candidate-workflow-stub.mjs')).toBeDefined()
    expect(input.files.some((f) => f.path === 'capsule/manifest.json')).toBe(false)
    await expect(
      composeProposalInputs({
        ...options,
        config: frozenConfig,
        catalog: { ...catalog, label: 'SEALED' },
      }),
    ).rejects.toThrow(/sealed/)
    await expect(
      composeProposalInputs({
        ...options,
        config: { ...frozenConfig, parentSourceHash: `sha256:${'0'.repeat(64)}` },
      }),
    ).rejects.toThrow(/parent identity/)
    await expect(
      composeProposalInputs({
        ...options,
        config: frozenConfig,
        dependencyClosureSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow(/dependency bytes/)
    const originalEvidence = await readCapturedTree(store, evidenceInventory)
    const evidenceManifest = originalEvidence.files.find((file) => file.path === 'manifest.json')!
    const changedManifest = JSON.parse(
      (await store.read(evidenceManifest.content)).toString('utf8'),
    )
    changedManifest.merkleRoot = '0'.repeat(64)
    const changedContent = await put(changedManifest)
    const changedFiles = originalEvidence.files.map((file) =>
      file.path === 'manifest.json' ? { ...file, content: changedContent } : file,
    )
    const corruptEvidence = await put({
      files: changedFiles,
      totalBytes: changedFiles.reduce((total, file) => total + file.content.size, 0),
    })
    await expect(
      composeProposalInputs({
        ...options,
        config: frozenConfig,
        evidenceInventory: corruptEvidence,
      }),
    ).rejects.toThrow(/Merkle root/)
    if (process.env.DSH_PROPOSAL_INPUT_RECEIPT)
      await writeFile(
        process.env.DSH_PROPOSAL_INPUT_RECEIPT,
        JSON.stringify(
          {
            protocol: 'dsh-evolve-le/proposal-input-probe/v1',
            casRoot: document.casRoot,
            result,
            config: frozenConfig,
            workerInventory,
            scope: 'CAS composition only; no Docker execution, model dispatch or admission',
          },
          null,
          2,
        ) + '\n',
      )
  },
  120000,
)
