import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { describe, it, expect } from 'vitest'
import { makeSpec } from './fixtures.js'
import { validateExecutionSpec } from '../../src/execution/types.js'
describe('published execution JSON schemas', () => {
  it('compiles published strict contracts and agrees with runtime spec validation', async () => {
    const ajv = new Ajv({ strict: true, allErrors: true })
    addFormats(ajv)
    for (const name of [
      'execution.input',
      'execution.completion',
      'proposal.supervisor-result',
      'proposal.generation-result',
      'proposal.finalization',
      'proposal.test',
      'execution.spec',
      'proposal.generation',
      'proposal.supervisor',
      'model.replay',
      'model.ledger',
      'proposal.supervisor-failure',
      'execution.receipt',
      'execution.bundle',
      'source-snapshot',
    ]) {
      const schema = JSON.parse(await readFile(resolve('schemas', `${name}.schema.json`), 'utf8'))
      const validate = ajv.compile(schema)
      if (name === 'execution.spec') {
        const valid = makeSpec()
        expect(validate(valid), JSON.stringify(validate.errors)).toBe(true)
        expect(validateExecutionSpec(valid)).toEqual(valid)
        const mutations: Array<(s: ReturnType<typeof makeSpec> & { extra?: boolean }) => void> = [
          (s) => {
            s.extra = true
          },
          (s) => {
            s.limits.pids = 0
          },
          (s) => {
            s.image.reference = 'latest'
          },
          (s) => {
            s.inputs[0]!.size = -1
          },
        ]
        for (const mutate of mutations) {
          const invalid = structuredClone(valid)
          mutate(invalid)
          expect(validate(invalid)).toBe(false)
          expect(() => validateExecutionSpec(invalid)).toThrow()
        }
      }
    }
  })
})
