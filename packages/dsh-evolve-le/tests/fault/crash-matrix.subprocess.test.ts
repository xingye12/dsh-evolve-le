/**
 * Gate 3 crash-boundary matrix (specs/07 §5 acceptance): every durable saga
 * boundary is killed with SIGKILL in a REAL controller child process, resumed
 * in a fresh process, and the converged run is verified from the outside.
 * Requires `pnpm build` first; fails closed if the bin is missing. The same
 * matrix produces the auditable `evidence/gate3/fault-matrix.json` via
 * `pnpm evidence:gate3`.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MATRIX_BOUNDARIES, runCase, runFaultMatrix } from '../../src/controller/fault-matrix.js'

const binPath = fileURLToPath(new URL('../../lib/bin/fault-child.js', import.meta.url))

describe('crash-boundary matrix (real SIGKILL, fresh-process resume)', () => {
  it('has the built fault-child bin', () => {
    expect(
      existsSync(binPath),
      `fault-child bin missing: run \`pnpm build\` first (${binPath})`,
    ).toBe(true)
  })

  for (const boundary of MATRIX_BOUNDARIES) {
    it(`kill at ${boundary}: resume converges with no duplicate effect, score, or cost`, async () => {
      const result = await runCase({ binPath, crashPlan: [boundary] })
      expect(result.failures).toEqual([])
      expect(result.killed).toEqual([true])
      expect(result.duplicateLaunchEffect).toBe(false)
      expect(result.duplicateScore).toBe(false)
      expect(result.launchEffects).toHaveLength(3)
      expect(result.usd).toEqual({ reserved: 0, spent: 200, unpriced: 1 })
      expect(result.taskTrials).toEqual({ reserved: 0, spent: 3, unpriced: 0 })
    })
  }

  it('double kill (intent, then launch) still converges', async () => {
    const result = await runCase({ binPath, crashPlan: ['intent-durable', 'launch-effect-done'] })
    expect(result.failures).toEqual([])
    expect(result.killed).toEqual([true, true])
  })

  it('every boundary and the clean baseline converge to one state hash', async () => {
    const matrix = await runFaultMatrix(binPath)
    expect(matrix.allPassed).toBe(true)
    expect(matrix.convergedStateHash).toMatch(/^[0-9a-f]{64}$/)
  }, 240_000)
})
