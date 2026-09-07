/**
 * The durable controller as a standard DSH Cordis service (Gate 3, specs/07
 * §5 "`@dsh-evolve-le/core` bundle/service"; CLAUDE.md rule 2: trusted
 * controller logic is carried by DSH plugins/services, loaded through the
 * real Cordis Loader).
 *
 * Activation opens the single-writer controller (lock → verify → replay →
 * reconcile) against the configured evidence tree; the service value is a
 * facade whose methods await that open. Unloading the service's fiber runs
 * the flush — snapshot written, journal handles closed, writer lock released
 * — and Cordis awaits async disposers, so `fiber.dispose()` returning means
 * the flush is durable.
 *
 * Namespace form only (name/Config/apply, no default export): the Loader
 * normalizes modules through `exports.default ?? exports`.
 *
 * @module @dsh-evolve-le/core/service
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  Controller,
  type ControllerConfig,
  type EvaluationInput,
  type RunStatus,
} from '../controller/controller.js'
import type { RunPhase } from '../state/reducer.js'
import { FileProvider } from '../controller/file-provider.js'

/** Cordis plugin name; also the Loader runtime display name. */
export const name = 'dsh-evolve-le:controller-service'

/** Service configuration validated by the Loader at mount. */
export interface Config {
  /** Evidence-scoped run identity; binds journal, ledger, and state. */
  runId: string
  /** Run directory (journal, snapshots, lock). Relative paths resolve from cwd. */
  runDir: string
  /** Content-addressed object store root. Relative paths resolve from cwd. */
  objectsRoot: string
  /** File-backed provider state (the Harbor adapter lands in a later gate). */
  providerFile: string
  /** Frozen worst-case USD budget in micros. */
  budgetUsdMicros: number
  /** Frozen worst-case task-trial budget. */
  budgetTaskTrials: number
}

export const Config: Schema<Config> = Schema.object({
  runId: Schema.string().required(),
  runDir: Schema.string().required(),
  objectsRoot: Schema.string().required(),
  providerFile: Schema.string().required(),
  budgetUsdMicros: Schema.natural().default(1_000_000),
  budgetTaskTrials: Schema.natural().default(100),
})

/** The service value provided under the `dshEvolveController` key. */
export interface DshEvolveControllerService {
  /** Resolves when the controller holds the writer lock; rejects on open failure. */
  readonly ready: Promise<Controller>
  status(): Promise<RunStatus>
  changePhase(to: RunPhase, reason: string): Promise<void>
  planWave(
    waveId: string,
    split: 'dev-observed' | 'dev-guard' | null,
    members: string[],
  ): Promise<void>
  runEvaluation(input: EvaluationInput): Promise<RunStatus>
  runEvaluationWave(inputs: EvaluationInput[]): Promise<RunStatus>
  resumeEvaluationWave(actionIds: string[]): Promise<RunStatus>
  commitWave(waveId: string): Promise<RunStatus>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshEvolveController: DshEvolveControllerService
  }
}

export function apply(ctx: Context, config: Config): void {
  const absolute = (path: string): string =>
    isAbsolute(path) ? path : resolve(process.cwd(), path)
  const controllerConfig: ControllerConfig = {
    runId: config.runId,
    budgetLimits: {
      usd: config.budgetUsdMicros,
      'task-trials': config.budgetTaskTrials,
    },
  }
  // Open (or recover) as part of activation; the facade defers to `ready`.
  const ready = (async () => {
    const provider = await FileProvider.open(absolute(config.providerFile))
    return Controller.open(
      absolute(config.runDir),
      absolute(config.objectsRoot),
      controllerConfig,
      provider,
    )
  })()

  const api: DshEvolveControllerService = {
    ready,
    async status() {
      return (await ready).status()
    },
    async changePhase(to, reason) {
      await (await ready).changePhase(to, reason)
    },
    async planWave(waveId, split, members) {
      await (await ready).planWave(waveId, split, members)
    },
    async runEvaluation(input) {
      await (await ready).runEvaluation(input)
      return (await ready).status()
    },
    async runEvaluationWave(inputs) {
      await (await ready).runEvaluationWave(inputs)
      return (await ready).status()
    },
    async resumeEvaluationWave(actionIds) {
      await (await ready).resumeEvaluationWave(actionIds)
      return (await ready).status()
    },
    async commitWave(waveId) {
      await (await ready).commitWave(waveId)
      return (await ready).status()
    },
  }
  ctx.provide('dshEvolveController', api)

  // Unload = flush: Cordis awaits async disposers, so a returned dispose()
  // means the snapshot is durable, journal handles are closed, and the
  // single-writer lock is gone. An open that itself failed has nothing to
  // flush.
  ctx.effect(() => async () => {
    const controller = await ready.catch(() => undefined)
    if (controller !== undefined) {
      await controller.close()
    }
  })
}
