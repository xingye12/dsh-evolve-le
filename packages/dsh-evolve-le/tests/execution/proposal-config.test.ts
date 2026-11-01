import { readFile } from 'node:fs/promises'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { it, expect } from 'vitest'
import { validateProposalSupervisorConfig } from '../../src/execution/proposal-config.js'
import { makeProposalConfig as configFixture, ref } from './fixtures.js'
it('freezes a closed native owner config and rejects credential fields, route drift and wrong test pools', async () => {
  const raw = configFixture(),
    frozen = validateProposalSupervisorConfig(raw)
  const ajv = new Ajv({ strict: true })
  addFormats(ajv)
  ajv.addSchema(JSON.parse(await readFile('schemas/execution.spec.schema.json', 'utf8')))
  const schema = ajv.compile(
    JSON.parse(await readFile('schemas/proposal.supervisor.schema.json', 'utf8')),
  )
  expect(schema(frozen), JSON.stringify(schema.errors)).toBe(true)
  expect(schema({ ...frozen, credential: 'never-stored' })).toBe(false)
  raw.model.limits.maxRequests = 999
  expect(frozen.model.limits.maxRequests).toBe(8)
  for (const mutate of [
    (config: ReturnType<typeof configFixture>) => {
      config.model.route = { ...ref, digest: 'b'.repeat(64) }
    },
    (config: ReturnType<typeof configFixture>) => {
      config.tests.profile.kind = 'validator'
    },
    (config: ReturnType<typeof configFixture>) => {
      config.spec.command = ['/bin/bash']
    },
    (config: ReturnType<typeof configFixture>) => {
      config.storeRoot = '/tmp/../cas'
    },
    (config: ReturnType<typeof configFixture>) => {
      config.model.limits.maxRequests = 0
    },
  ]) {
    const config = configFixture()
    mutate(config)
    expect(() => validateProposalSupervisorConfig(config)).toThrow()
  }
  expect(() =>
    validateProposalSupervisorConfig({ ...configFixture(), credential: 'never-stored' }),
  ).toThrow(/unexpected/)
  expect(() =>
    validateProposalSupervisorConfig({
      ...configFixture(),
      model: { ...configFixture().model, apiKey: 'never-stored' },
    }),
  ).toThrow(/unexpected/)
})
