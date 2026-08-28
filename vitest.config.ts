import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/*/tests/**/*.{test,spec}.ts',
      'benchmark-adapters/*/tests/**/*.{test,spec}.ts',
    ],
    // Fixture trees (e.g. the golden scan case) contain candidate-owned specs
    // that are data, not tests of this repo; only real packages run.
    exclude: ['**/node_modules/**', '**/tests/fixtures/**'],
    // Gate 0 lifecycle timing is not perf-sensitive; keep suite deterministic.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // The loader imports fixture/plugin modules through Node's real module
    // pipeline (native type stripping); vitest must not reserve worker-thread
    // state that would confuse handle inventories.
    fileParallelism: false,
  },
})
