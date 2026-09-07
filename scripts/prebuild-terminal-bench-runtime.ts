/**
 * Prebuild the verifier and Harbor ACP runtime for every Terminal-Bench task
 * that is eligible under the frozen <=1800s agent-time policy.
 *
 * Usage:
 *   node --import tsx/esm scripts/prebuild-terminal-bench-runtime.ts \
 *     --source-tasks /path/to/tasks --output-tasks /path/to/prebuilt/tasks
 *
 * The output task root is run-scoped and may be used directly as
 * `benchmark.tasksRoot`. Existing content-addressed images are reused by the
 * builder; no `docker pull` is requested for an image already in the local
 * cache.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  buildTaskInventory,
  prepareOfflineVerifierTasks,
  VERIFIER_IMAGE_PROTOCOL,
} from '../benchmark-adapters/terminal-bench/src/index.ts'

const DEFAULT_SOURCE = '/root/dsh-evolve-le-scratch/dsh-gate8-live-pilot-EdAql9/tasks'
const DEFAULT_OUTPUT = '/root/dsh-evolve-le-scratch/terminal-bench-t1800-prebuilt/tasks'
const MAX_AGENT_TIMEOUT_SEC = 1_800

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function main(): Promise<void> {
  const sourceTasksRoot = resolve(
    arg('--source-tasks') ?? process.env['DSH_TERMINAL_BENCH_SOURCE_TASKS'] ?? DEFAULT_SOURCE,
  )
  const outputTasksRoot = resolve(
    arg('--output-tasks') ?? process.env['DSH_TERMINAL_BENCH_PREBUILT_TASKS'] ?? DEFAULT_OUTPUT,
  )
  const dockerBin = arg('--docker') ?? process.env['DOCKER_BIN'] ?? 'docker'

  const inventory = await buildTaskInventory(sourceTasksRoot, {
    maxAgentTimeoutSec: MAX_AGENT_TIMEOUT_SEC,
  })
  const taskAllowlist = inventory.tasks.map((task) => task.handle)
  if (taskAllowlist.length === 0) {
    throw new Error('prebuild-terminal-bench-runtime: no eligible tasks')
  }
  await mkdir(outputTasksRoot, { recursive: true })
  const prepared = await prepareOfflineVerifierTasks({
    sourceTasksRoot,
    outputTasksRoot,
    taskAllowlist,
    dockerBin,
  })
  if (prepared.receipt.tasks.length !== taskAllowlist.length) {
    throw new Error(
      `prebuild-terminal-bench-runtime: receipt has ${String(prepared.receipt.tasks.length)} derived tasks, expected ${String(taskAllowlist.length)}`,
    )
  }

  const receipt = {
    protocol: 'dsh-evolve-le/terminal-bench-prebuild/v1',
    verifierImageProtocol: VERIFIER_IMAGE_PROTOCOL,
    sourceTasksRoot,
    outputTasksRoot,
    maxAgentTimeoutSec: MAX_AGENT_TIMEOUT_SEC,
    sourceTaskCount: inventory.selection?.sourceTaskCount ?? inventory.tasks.length,
    eligibleTaskCount: inventory.tasks.length,
    excludedTaskCount: inventory.selection?.excludedHandles.length ?? 0,
    excludedHandles: inventory.selection?.excludedHandles ?? [],
    eligibleHandles: taskAllowlist,
    inventorySha256: inventory.inventorySha256,
    runtimeImageRef: prepared.receipt.runtimeImageRef,
    runtimeImageId: prepared.receipt.runtimeImageId,
    acpRuntime: prepared.receipt.acpRuntime,
    derivedImageCount: prepared.receipt.tasks.length,
    verifierReceiptSha256: sha256(JSON.stringify(prepared.receipt)),
    generatedAt: new Date().toISOString(),
  }
  await writeFile(
    resolve(outputTasksRoot, '..', 'terminal-bench-prebuild.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
}

await main()
