/**
 * Content-addressed task inventory (Gate 2, specs/04 §2-3, specs/06): scan a
 * materialized task set, digest every task directory with the shared
 * `dsh-evolve-tree-v1` algorithm, and emit a frozen inventory document. The
 * inventory digest participates in the idempotency key and the run manifest,
 * so which tasks ran — and their exact content — is derivable from evidence
 * alone. No task name, reward, or trajectory flows back into selection here;
 * this module is pure description of the pinned set.
 * @module @dsh-evolve-le/tb-provider/inventory
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { computeTreeDigest } from '@dsh-evolve-le/core'
import { DATASET_PIN } from './dataset.js'

export const INVENTORY_PROTOCOL = 'dsh-evolve-le/tb-inventory/v1'

export interface InventoryTask {
  /** Filesystem-derived handle: the task directory name. Stable across runs. */
  handle: string
  /** Absolute path of the task directory at scan time (recorded, not identity). */
  path: string
  /** `dsh-evolve-tree-v1` digest of the task directory. */
  digest: string
  fileCount: number
}

export interface TaskInventory {
  protocol: typeof INVENTORY_PROTOCOL
  dataset: {
    id: string
    upstream: string
    commit: string
    tarballSha256: string
  }
  tasks: InventoryTask[]
  /** sha256 over the canonical inventory document (without this field). */
  inventorySha256: string
}

/** Parse the `[task] name` from a Harbor-native task.toml (display only). */
export function parseTaskName(taskToml: string): string | undefined {
  const match = taskToml.match(/^\[task\][^[]*?^name\s*=\s*"([^"]+)"/m)
  return match?.[1]
}

function inventoryDigest(tasks: InventoryTask[]): string {
  const hash = createHash('sha256')
  hash.update(
    `${INVENTORY_PROTOCOL}\n${DATASET_PIN.id}\n${DATASET_PIN.upstream}\n${DATASET_PIN.commit}\n${DATASET_PIN.tarballSha256}\n`,
  )
  for (const task of tasks) {
    hash.update(`${task.handle}\0${task.digest}\n`)
  }
  return hash.digest('hex')
}

/**
 * Scan a materialized task root (the dataset pin's `tasks/` directory) into a
 * frozen inventory. Task directories must contain `task.toml`; anything else
 * is an error, not a silent skip — a partially materialized set must never
 * plan a job (CLAUDE.md rule 7: fail closed).
 */
export async function buildTaskInventory(tasksRoot: string): Promise<TaskInventory> {
  const entries = await readdir(tasksRoot, { withFileTypes: true })
  const tasks: InventoryTask[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const dir = join(tasksRoot, entry.name)
    const tomlPath = join(dir, 'task.toml')
    const tomlStat = await stat(tomlPath).catch(() => undefined)
    if (tomlStat === undefined || !tomlStat.isFile()) {
      throw new Error(`inventory: ${dir} has no task.toml; refuse to plan over a partial set`)
    }
    await readFile(tomlPath, 'utf8')
    const { digest, fileCount } = await computeTreeDigest(dir)
    tasks.push({ handle: entry.name, path: dir, digest, fileCount })
  }
  if (tasks.length === 0) {
    throw new Error(`inventory: no task directories under ${tasksRoot}`)
  }
  const inventory: TaskInventory = {
    protocol: INVENTORY_PROTOCOL,
    dataset: {
      id: DATASET_PIN.id,
      upstream: DATASET_PIN.upstream,
      commit: DATASET_PIN.commit,
      tarballSha256: DATASET_PIN.tarballSha256,
    },
    tasks,
    inventorySha256: '',
  }
  inventory.inventorySha256 = inventoryDigest(tasks)
  return inventory
}

/** Select tasks by handle; unknown handles are an error (never a skip). */
export function selectTasks(inventory: TaskInventory, handles: string[]): InventoryTask[] {
  const byHandle = new Map(inventory.tasks.map((task) => [task.handle, task]))
  const selected: InventoryTask[] = []
  for (const handle of handles) {
    const task = byHandle.get(handle)
    if (task === undefined) {
      throw new Error(
        `inventory: unknown task handle ${handle}; available: ${inventory.tasks.map((t) => t.handle).join(', ')}`,
      )
    }
    selected.push(task)
  }
  if (selected.length === 0) throw new Error('inventory: empty task selection')
  return selected
}
