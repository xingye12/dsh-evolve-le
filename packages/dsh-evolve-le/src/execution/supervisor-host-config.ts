/** Shared trusted host configuration checks; actual platform proof remains preflight. */
import { resolve } from 'node:path'
import { assertExact, ExecutionError } from './types.js'
export function assertSupervisorPath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value === '/' ||
    value.length > 4096 ||
    value.includes('\0') ||
    resolve(value) !== value
  )
    throw new ExecutionError('invalid supervisor absolute path')
}
export function validateSupervisorHostConfig(value: Record<string, unknown>): void {
  for (const key of ['hostRoot', 'executionRoot', 'cgroupRoot', 'resourceRoot', 'storeRoot'])
    assertSupervisorPath(value[key])
  assertExact(value.security, ['seccompJson', 'apparmorProfile', 'cgroupParent'], ['profile'])
  if (value.security.profile !== undefined && value.security.profile !== 'local-generation/v1')
    throw new ExecutionError('unknown Docker security profile')
  for (const field of Object.values(value.security))
    if (typeof field !== 'string' || !field || field.length > 262144)
      throw new ExecutionError('invalid supervisor security profile')
  assertExact(value.pools, ['proposal', 'test', 'validator'])
  for (const pool of Object.values(value.pools)) {
    assertExact(pool, ['slots', 'memoryBytes', 'cpuMillis', 'pids', 'bytes', 'inodes'])
    for (const quantity of Object.values(pool))
      if (!Number.isSafeInteger(quantity) || Number(quantity) < 1)
        throw new ExecutionError('invalid supervisor resource capacity')
  }
}
