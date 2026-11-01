/** Protect trusted supervisor state before publishing any config, lock or log. */
import { lstat, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ExecutionError } from './types.js'
export async function prepareSupervisorDirectory(path: string): Promise<void> {
  if (process.getuid?.() !== 0 || path === '/' || resolve(path) !== path || path.includes('\0'))
    throw new ExecutionError('unsafe supervisor directory identity')
  let current = '/'
  const parts = path.split('/').filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    try {
      await mkdir(current, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(current)
    // Shared sticky /tmp is safe as an ancestor of a private root-owned slot;
    // the supervisor's final directory must itself exclude other writers.
    const writable = (stat.mode & 0o022) !== 0,
      stickyAncestor = index < parts.length - 1 && (stat.mode & 0o1000) !== 0
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (writable && !stickyAncestor)
    )
      throw new ExecutionError('unsafe supervisor directory ownership or mode')
  }
}
