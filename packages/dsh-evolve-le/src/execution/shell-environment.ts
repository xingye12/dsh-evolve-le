/** Frozen managed shell facts. They identify the session, never authorize it. */
import { posix } from 'node:path'
import { assertExact, ExecutionError } from './types.js'
export function managedShellEnvironment(value: unknown): Record<string, string> {
  const result: Record<string, string> = { DSH_HOME: '/work/home', DSH_SHELL: '1' }
  if (value === undefined) return result
  assertExact(value, [], ['DSH_HOME', 'DSH_SHELL', 'DSH_SESSION_ID', 'DSH_SESSION_JSONL'])
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > 4096)
      throw new ExecutionError('invalid managed shell environment value')
    if (key === 'DSH_HOME' && entry !== '/work/home')
      throw new ExecutionError('managed DSH_HOME differs from frozen profile')
    if (key === 'DSH_SHELL' && entry !== '1') throw new ExecutionError('invalid managed DSH_SHELL')
    if (key === 'DSH_SESSION_ID' && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(entry))
      throw new ExecutionError('invalid managed session ID')
    if (
      key === 'DSH_SESSION_JSONL' &&
      (!entry.startsWith('/work/') || posix.normalize(entry) !== entry)
    )
      throw new ExecutionError('managed session persistence outside work')
    result[key] = entry
  }
  return result
}
