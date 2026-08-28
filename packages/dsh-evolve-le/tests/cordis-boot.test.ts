/**
 * Gate 0 real-Loader E2E (in-process): boot the fixture `cordis.yml` trees
 * through the real Cordis Loader (`bootLoader` mounts
 * `@deepseek-ai/cordis-plugin-loader` and a root `cordis:include` entry —
 * never a hand-built `ctx.plugin({ name, inject, apply })`), assert the
 * baseline plugin activates with its namespace metadata intact, assert the
 * negative default-export fixture fails with the lost-`inject` error from DSH
 * postmortem 0001, and assert the loader-fiber unload returns the Cordis
 * inventory to exactly the pre-boot snapshot.
 */

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bootLoader, snapshotCordisInventory } from '../src/index.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const fixture = (name: string): string => resolve(fixturesDir, name)

/** Root contexts created by tests; disposed after the suite. */
const contexts: Context[] = []

afterAll(async () => {
  await Promise.all(contexts.map((ctx) => ctx.fiber.dispose()))
})

describe('bootLoader through the real Cordis Loader', () => {
  it('activates the baseline composition and exposes the probe service', async () => {
    const booted = await bootLoader(fixture('cordis.baseline.yml'))
    contexts.push(booted.ctx)
    const { ctx } = booted

    const entries = [...ctx.loader.entries()].map((entry) => ({
      id: entry.options.id,
      name: entry.options.name,
      disabled: entry.disabled === true,
      state: entry.fiber?.state,
    }))
    expect(entries).toEqual([
      { id: 'include', name: 'cordis:include', disabled: false, state: 2 },
      { id: 'probe-service', name: './plugins/probe-service.ts', disabled: false, state: 2 },
      {
        id: 'candidate-baseline',
        name: '@dsh-evolve-le/candidate-baseline',
        disabled: false,
        state: 2,
      },
    ])

    // The probe service is provided and readable from the root context.
    expect(ctx.get('dshEvolveProbe')).toEqual({ marker: 'gate0-probe' })

    // The baseline plugin's runtime name (namespace metadata) survived loading.
    const runtimeNames = [...ctx.registry.values()].map((runtime) => runtime.name ?? '<anonymous>')
    expect(runtimeNames).toContain('dsh-evolve-le:candidate-baseline')

    // The probe event listener registered by the baseline plugin is live.
    ctx.emit('dsh-evolve-le/candidate-baseline:probe', 'e2e')
  })

  it('rejects a namespace plugin with a stray export default (lost inject)', async () => {
    const failure = await bootLoader(fixture('cordis.negative.yml')).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    // The activation audit names the offending entry and preserves the
    // deepest cause: the direct property read failed because the Loader
    // unwrapped the module to the bare default export and dropped `inject`.
    expect(message).toContain('bad-default-export')
    expect(message).toContain('cannot get property "dshEvolveProbe" without inject')
  })

  it('boots the inject-honoring twin, proving the default export is the cause', async () => {
    const booted = await bootLoader(fixture('cordis.twin.yml'))
    contexts.push(booted.ctx)
    expect(booted.ctx.get('dshEvolveProbe')).toEqual({ marker: 'gate0-probe' })
    const twin = [...booted.ctx.loader.entries()].find(
      (entry) => entry.options.id === 'good-inject-twin',
    )
    expect(twin?.fiber?.state).toBe(2)
  })

  it('returns the Cordis inventory to exactly the pre-boot state after unload', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const before = snapshotCordisInventory(ctx)

    const booted = await bootLoader(fixture('cordis.baseline.yml'), { context: ctx })
    const afterBoot = snapshotCordisInventory(ctx)
    expect(afterBoot.services).toContainEqual({ name: 'dshEvolveProbe', fiber: expect.any(String) })
    expect(afterBoot.runtimes.map((r) => r.name)).toContain('dsh-evolve-le:candidate-baseline')
    expect(afterBoot.listeners).toContainEqual({
      event: 'dsh-evolve-le/candidate-baseline:probe',
      fiber: expect.any(String),
      count: 1,
    })
    expect(afterBoot).not.toEqual(before)

    await booted.loaderFiber.dispose()
    const afterUnload = snapshotCordisInventory(ctx)
    expect(afterUnload).toEqual(before)
  })
})
