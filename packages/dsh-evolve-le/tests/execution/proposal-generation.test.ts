import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it, expect } from 'vitest'
import Ajv from 'ajv'
import { openObjectStore } from '../../src/state/object-store.js'
import { canonicalHash, canonicalJson } from '../../src/state/canonical.js'
import { makeProposalConfig } from './fixtures.js'
import { validateGenerationConfig } from '../../src/execution/proposal-generation-config.js'
import {
  verifyGenerationResult,
  publishGenerationResult,
  readGenerationResult,
} from '../../src/execution/proposal-generation-result.js'

it('accepts generation inputs without validator runtime and rejects policy/config drift', () => {
  const { tests: _tests, ...base } = makeProposalConfig()
  const config = {
    ...base,
    protocol: 'dsh-evolve-le/proposal-generation/v1',
    model: { ...base.model, mode: 'replay' },
  }
  expect(validateGenerationConfig(config)).toEqual(config)
  for (const change of [
    { tests: {} },
    { credential: 'secret' },
    { protocol: base.protocol },
    { model: { ...config.model, mode: 'auto' } },
    { spec: { ...config.spec, command: ['/bin/sh'] } },
    { inputManifest: { ...config.inputManifest, label: 'SEALED' } },
  ])
    expect(() => validateGenerationConfig({ ...config, ...change })).toThrow()
})

it('records pre-create failure without fabricated execution/completion and reads CAS after directory deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'generation-result-'))
  try {
    const store = await openObjectStore(join(root, 'cas'))
    const spec = makeProposalConfig().spec
    const diagnostic = await store.put(Buffer.from(canonicalJson({ reason: 'preflight' })), {
      label: 'CONTROLLER_INTERNAL',
      mediaType: 'application/json',
    })
    const result = {
      protocol: 'dsh-evolve-le/proposal-generation-result/v1' as const,
      admission: 'NONE' as const,
      outcome: 'FAILED' as const,
      specDigest: canonicalHash(spec),
      execution: null,
      completion: null,
      submission: null,
      diagnostic,
    }
    const expected = {
      store,
      spec,
      children: ['child-1'],
      parentSourceHash: `sha256:${'a'.repeat(64)}`,
    }
    expect(await verifyGenerationResult(result, expected)).toEqual(result)
    const ref = await publishGenerationResult(join(root, 'attempt'), result, expected)
    await rm(join(root, 'attempt'), { recursive: true })
    expect(await readGenerationResult(ref, expected)).toEqual(result)
    for (const changed of [
      { admission: 'ADMITTED' },
      { outcome: 'SUCCEEDED' },
      { specDigest: 'b'.repeat(64) },
      { completion: diagnostic },
      { submission: diagnostic },
    ])
      await expect(verifyGenerationResult({ ...result, ...changed }, expected)).rejects.toThrow()
    const schema = JSON.parse(
      await readFile(resolve('schemas/proposal.generation-result.schema.json'), 'utf8'),
    )
    const validate = new Ajv({ strict: true }).compile(schema)
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ ...result, outcome: 'SUCCEEDED' })).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('native finish accepts an unnormalized tree-v2 draft only through the generation capability', async () => {
  const { installNativeProposalTools } = await import('../../src/dsh/native-proposal.js')
  const { buildNativeProposalInstruction } = await import('../../src/proposer/prompt-text.js')
  const draft = {
    schemaVersion: 2,
    protocol: 'dsh-evolve-le/proposal/v2',
    parentSourceHash: `sha256:${'a'.repeat(64)}`,
    children: [
      {
        childName: 'child-1',
        hypothesis: 'General mechanism.',
        donorCandidates: [],
        targetFailureModes: ['planning'],
        analysisReceipt: { mechanism: 'raw semantic fields' },
        proposalReceipt: { unnormalized: true },
      },
    ],
  }
  for (const generationOnly of [true, false]) {
    let finish: any
    const ctx = {
      tools: {
        register(definition: any) {
          if (definition.name === 'proposal_finish') finish = definition
          return () => {}
        },
      },
    } as never
    const state = { calls: 0, disposers: [] }
    const backend = {
      ...(generationOnly ? { generationOnly: true as const } : {}),
      async listInput() {
        return []
      },
      async readInput() {
        return ''
      },
      async writeChildFile() {},
      async finalizeProposal() {
        return structuredClone(draft) as never
      },
    }
    installNativeProposalTools(ctx, backend, state)
    if (generationOnly) await expect(finish.execute({ proposal: draft })).resolves.toBeDefined()
    else await expect(finish.execute({ proposal: draft })).rejects.toThrow(/receipt/)
  }
  const prompt = buildNativeProposalInstruction({
    parentSourceHash: draft.parentSourceHash,
    width: 1,
    generationOnly: true,
    treeV2Parent: {
      candidateDigest: draft.parentSourceHash,
      mechanismOutcomeDigest: `sha256:${'b'.repeat(64)}`,
    },
  })
  expect(prompt).toContain('external trusted pipeline')
  expect(prompt).not.toContain('runs the parent baseline tests')
})

