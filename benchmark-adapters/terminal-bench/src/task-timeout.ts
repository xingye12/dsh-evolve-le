/**
 * Terminal-Bench agent-time parsing for live solver jobs. The pinned task
 * format is TOML, but the trusted adapter needs exactly one scalar under one
 * section. Keep the grammar deliberately narrow so a malformed or ambiguous
 * task fails before Harbor can spend a live-solver trial.
 * @module @dsh-evolve-le/tb-provider/task-timeout
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_TIMEOUT_MULTIPLIER } from './jobconfig.js'

/** Non-secret JobConfig env consumed by the live capsule. */
export const SOLVE_AGENT_TIMEOUT_ENV = 'DSH_SOLVE_AGENT_TIMEOUT_MS'

/** Parse the pinned `[agent].timeout_sec` scalar and reject ambiguity. */
export function parseTaskAgentTimeoutSec(taskToml: string): number {
  let inAgentSection = false
  let timeoutSec: number | undefined
  for (const rawLine of taskToml.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const section = /^\[([^\]]+)](?:\s+#.*)?$/.exec(line)
    if (section !== null) {
      inAgentSection = section[1] === 'agent'
      continue
    }
    if (!inAgentSection) continue
    const assignment = /^timeout_sec\s*=\s*(.+?)(?:\s+#.*)?$/.exec(line)
    if (assignment === null) continue
    if (timeoutSec !== undefined) {
      throw new Error('task-timeout: [agent].timeout_sec is specified more than once')
    }
    const rawTimeout = assignment[1]
    if (rawTimeout === undefined || !/^[0-9]+(?:\.[0-9]+)?$/.test(rawTimeout)) {
      throw new Error('task-timeout: [agent].timeout_sec must be a finite number > 0')
    }
    const parsed = Number(rawTimeout)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error('task-timeout: [agent].timeout_sec must be a finite number > 0')
    }
    timeoutSec = parsed
  }
  if (timeoutSec === undefined) {
    throw new Error('task-timeout: task.toml has no [agent].timeout_sec')
  }
  return timeoutSec
}

/** Read the task-local timeout; no default means live launch fails closed. */
export async function taskAgentTimeoutSec(taskPath: string): Promise<number> {
  return parseTaskAgentTimeoutSec(await readFile(join(taskPath, 'task.toml'), 'utf8'))
}

/**
 * Harbor applies this multiplier to the agent phase. The exact effective
 * ceiling, rather than a universal capsule number, is what the live agent
 * receives as evidence in its own JobConfig environment.
 */
export function effectiveTaskAgentTimeoutMs(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error('task-timeout: timeoutSec must be a finite number > 0')
  }
  const timeoutMs = Math.round(timeoutSec * 1_000 * AGENT_TIMEOUT_MULTIPLIER)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('task-timeout: effective agent timeout is outside the safe integer range')
  }
  return timeoutMs
}
