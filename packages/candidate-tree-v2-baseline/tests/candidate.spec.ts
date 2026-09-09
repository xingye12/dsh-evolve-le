/**
 * Candidate-owned mechanism spec for the tree-v2 migration-root baseline
 * (docs/tree-v2-implementation-spec.md §migration root). These are the
 * assertions named by `tests.mechanism` in candidate.json: the component
 * root mounts its strategy through `ctx.plugin()`, and both modes reproduce
 * the golden baseline surfaces — verified against the SDK testkit without a
 * live harness, network or model.
 */
import { describe, expect, it } from 'vitest'
import { createHarness } from '@dsh-evolve-le/candidate-sdk/testkit'
import { apply, type Config } from '../src/index.js'

const config = (mode: Config['mode']): Config => ({
  candidateId: 'c_treev2migrationroot0000000000',
  mode,
})

/**
 * Mount the candidate the way the Loader does, with a minimal `ctx.plugin`
 * that runs function plugins inline. The SDK testkit deliberately models
 * only the services the SDK touches; the component mount is the candidate's
 * own, so the spec supplies it (and asserts the root really goes through
 * `ctx.plugin`, as the tree-v2 contract demands of the source).
 */
const mount = (mode: Config['mode']) => {
  const harness = createHarness()
  const mounted: string[] = []
  const ctx = harness.ctx as unknown as {
    plugin: (plugin: (ctx: unknown, config: Config) => void, config: Config) => void
  }
  ctx.plugin = (plugin, pluginConfig) => {
    mounted.push(plugin.name)
    plugin(harness.ctx, pluginConfig)
  }
  apply(harness.ctx, config(mode))
  return { harness, mounted }
}

describe('tree-v2 migration-root baseline', () => {
  it('mounts its strategy component through ctx.plugin', () => {
    const { mounted } = mount('solve')
    expect(mounted).toEqual(['strategyPlugin'])
  })

  it('registers exactly one candidate:identity section in solve mode', () => {
    const { harness } = mount('solve')
    const sections = harness.sections()
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('candidate:identity')
    expect(sections[0]?.order).toBe(100)
    expect(sections[0]?.text).toContain('c_treev2migrationroot0000000000')
    expect(sections[0]?.text).toContain('solve mode')
    expect(harness.tools().map((tool) => tool.name)).toEqual(['candidate_strategy_snapshot'])
    expect(harness.skills().map((skill) => skill.name)).toEqual(['candidate-strategy-review'])
    expect(harness.workflows().map((workflow) => workflow.name)).toEqual([
      'candidate-workflow:solve-policy',
    ])
  })

  it('registers exactly one candidate:proposal-policy section in propose mode', () => {
    const { harness } = mount('propose')
    const sections = harness.sections()
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('candidate:proposal-policy')
    expect(sections[0]?.order).toBe(100)
    expect(sections[0]?.text).toContain('propose mode')
    expect(harness.tools()).toHaveLength(1)
    expect(harness.skills()).toHaveLength(1)
  })

  it('owns its contributions through effects: disposal restores the inventory', () => {
    const { harness } = mount('solve')
    // Section + tool + skill + solve-policy workflow, each effect-owned.
    expect(harness.effects()).toHaveLength(4)
    expect(harness.effects()[0]?.disposed).toBe(false)

    harness.dispose()
    expect(harness.sections()).toEqual([])
    expect(harness.tools()).toEqual([])
    expect(harness.skills()).toEqual([])
    expect(harness.workflows()).toEqual([])
    expect(harness.effects()[0]?.disposed).toBe(true)
  })

  it('registers nothing beyond the declared surfaces in either mode', () => {
    for (const mode of ['solve', 'propose'] as const) {
      const { harness } = mount(mode)
      expect(harness.sections()).toHaveLength(1)
      expect(harness.tools()).toHaveLength(1)
      expect(harness.skills()).toHaveLength(1)
      expect(harness.workflows()).toHaveLength(mode === 'solve' ? 1 : 0)
      expect(harness.effects()).toHaveLength(mode === 'solve' ? 4 : 3)
    }
  })
})
