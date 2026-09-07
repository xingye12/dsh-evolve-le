/**
 * TB provider planning (Gate 2, specs/04 §2-5, specs/06): compose the frozen
 * task inventory, the candidate capsule identity, and the Harbor job config
 * into one paid-submission plan, guarded by the idempotency ledger. Planning
 * is pure except for the ledger: same inputs → same key → same job name and
 * directory. The provider never sees sealed-set results (CLAUDE.md rule 5)
 * and never re-pays an existing key (rule 7 economics; specs/04 §5).
 * @module @dsh-evolve-le/tb-provider/provider
 */

import { join } from 'node:path'
import { buildTaskInventory, selectTasks, type TaskInventory } from './inventory.js'
import { buildAcpRegistryEntry } from './registry.js'
import { buildJobConfig, PROVIDER_PROTOCOL, type JobPlan } from './jobconfig.js'
import {
  idempotencyKey,
  jobNameForKey,
  type IdempotencyInputs,
  type LedgerEntry,
  type SubmissionLedger,
} from './idempotency.js'

/** Per-job overlay computed once the jobName exists (ADR-030 solve gateway). */
export interface PerJobOverlay {
  /** Read-only bind mounts for exactly this job (the per-trial token file). */
  mounts?: { source: string; target: string }[]
  /** Non-secret env entries for exactly this job (URL, token path, route hash). */
  env?: Record<string, string>
}

export interface PlanSubmissionInput {
  runId: string
  tasksRoot: string
  handles: string[]
  capsuleArchiveSha256: string
  archiveUrl: string
  /** Harbor jobs root; the job directory is `<jobsRoot>/<jobName>`. */
  jobsRoot: string
  harborVersion: string
  /** Frozen Terminal-Bench eligibility ceiling (seconds). */
  maxAgentTimeoutSec?: number
  attempts?: number
  /**
   * Request-level attempt (ADR-046): distinct paid identity per attempt of
   * one (candidate, task), while `attempts` (JobConfig n_attempts) stays 1.
   */
  trialAttempt?: number
  concurrentTrials?: number
  mounts?: { source: string; target: string }[]
  env?: Record<string, string>
  /**
   * Invoked exactly once per plan, after the jobName is computed and before
   * the JobConfig is built: the solve-gateway enrollment mints (or reuses)
   * the per-trial token file, and the overlay bind-mounts it into exactly
   * this job. Merged AFTER the global mounts/env; env keys are re-sorted so
   * the emitted YAML is byte-stable across re-plans.
   */
  perJob?: (jobName: string) => Promise<PerJobOverlay> | PerJobOverlay
  ledger: SubmissionLedger
  /** Controller action key to record alongside the paid key (Gate 5). */
  controllerKey?: string
}

export interface SubmissionPlan {
  protocol: typeof PROVIDER_PROTOCOL
  status: 'new' | 'existing'
  idempotencyKey: string
  jobName: string
  jobDir: string
  jobPlan: JobPlan
  inventory: TaskInventory
  /** Trial identity inputs (specs/04 §5), recorded in the run manifest. */
  identity: IdempotencyInputs
  /** The durable ledger entry backing this plan (existing or newly reserved). */
  entry: LedgerEntry
}

/** Plan one paid submission; reserves it in the ledger (idempotent). */
export async function planSubmission(input: PlanSubmissionInput): Promise<SubmissionPlan> {
  const inventory = await buildTaskInventory(input.tasksRoot, {
    ...(input.maxAgentTimeoutSec !== undefined
      ? { maxAgentTimeoutSec: input.maxAgentTimeoutSec }
      : {}),
  })
  for (const handle of input.handles) {
    if (!inventory.tasks.some((task) => task.handle === handle)) {
      throw new Error(`provider: task ${handle} not in inventory`)
    }
  }
  const selected = selectTasks(inventory, input.handles)
  const attempts = input.attempts ?? 1

  const identity: IdempotencyInputs = {
    runId: input.runId,
    capsuleArchiveSha256: input.capsuleArchiveSha256,
    inventorySha256: inventory.inventorySha256,
    handles: selected.map((task) => task.handle),
    attempts,
    harborVersion: input.harborVersion,
    ...(input.trialAttempt !== undefined ? { trialAttempt: input.trialAttempt } : {}),
  }
  const key = idempotencyKey(identity)
  const jobName = jobNameForKey(key)
  const jobDir = join(input.jobsRoot, jobName)

  const overlay = input.perJob !== undefined ? await input.perJob(jobName) : ({} as PerJobOverlay)
  // Global mounts/env first, the per-job overlay after (later wins on env key
  // collisions); env keys sorted so equal inputs emit byte-equal YAML.
  const mounts = [...(input.mounts ?? []), ...(overlay.mounts ?? [])]
  const envEntries = Object.entries({ ...(input.env ?? {}), ...(overlay.env ?? {}) }).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )
  const env = Object.fromEntries(envEntries)

  const { status, entry } = await input.ledger.reserve({
    key,
    runId: input.runId,
    jobName,
    jobDir,
    capsuleArchiveSha256: input.capsuleArchiveSha256,
    inventorySha256: inventory.inventorySha256,
    handles: identity.handles,
    attempts,
    harborVersion: input.harborVersion,
    ...(identity.trialAttempt !== undefined ? { trialAttempt: identity.trialAttempt } : {}),
    ...(input.controllerKey !== undefined ? { controllerKey: input.controllerKey } : {}),
  })

  const jobPlan = buildJobConfig({
    jobName,
    jobsDir: input.jobsRoot,
    taskPaths: selected.map((task) => task.path),
    registryEntry: buildAcpRegistryEntry({
      capsuleArchiveSha256: input.capsuleArchiveSha256,
      archiveUrl: input.archiveUrl,
    }),
    attempts,
    concurrentTrials: input.concurrentTrials ?? 1,
    ...(mounts.length > 0 ? { mounts } : {}),
    ...(envEntries.length > 0 ? { env } : {}),
  })

  return {
    protocol: PROVIDER_PROTOCOL,
    status,
    idempotencyKey: key,
    jobName,
    jobDir,
    jobPlan,
    inventory,
    identity,
    entry,
  }
}
