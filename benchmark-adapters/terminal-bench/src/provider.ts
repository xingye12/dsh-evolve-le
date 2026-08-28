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
  type SubmissionLedger,
} from './idempotency.js'

export interface PlanSubmissionInput {
  runId: string
  tasksRoot: string
  handles: string[]
  capsuleArchiveSha256: string
  archiveUrl: string
  /** Harbor jobs root; the job directory is `<jobsRoot>/<jobName>`. */
  jobsRoot: string
  harborVersion: string
  attempts?: number
  concurrentTrials?: number
  mounts?: { source: string; target: string }[]
  env?: Record<string, string>
  ledger: SubmissionLedger
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
}

/** Plan one paid submission; reserves it in the ledger (idempotent). */
export async function planSubmission(input: PlanSubmissionInput): Promise<SubmissionPlan> {
  const inventory = await buildTaskInventory(input.tasksRoot)
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
  }
  const key = idempotencyKey(identity)
  const jobName = jobNameForKey(key)
  const jobDir = join(input.jobsRoot, jobName)

  const { status } = await input.ledger.reserve({
    key,
    runId: input.runId,
    jobName,
    jobDir,
    capsuleArchiveSha256: input.capsuleArchiveSha256,
    inventorySha256: inventory.inventorySha256,
    handles: identity.handles,
    attempts,
    harborVersion: input.harborVersion,
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
    ...(input.mounts !== undefined ? { mounts: input.mounts } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
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
  }
}
