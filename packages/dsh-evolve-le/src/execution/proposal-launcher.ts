import { canonicalJson, parseCanonicalJson } from '../state/canonical.js'
import { openObjectStore, validateRef } from '../state/object-store.js'
import { readCanonicalFile, openExecutionEvidence } from './evidence.js'
import { cancelProposalSupervisor } from './supervisor.js'
import { readExecutionCancellation } from './cancellation.js'
import { validateProposalSupervisorConfig } from './proposal-config.js'
import { executionName } from './types.js'
/** Launches a fixed kernel-flock owner. Failure diagnostics never authorize model replay. */
import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical } from './evidence.js'
import { proposalProcessContext, readProposalProcessState } from './proposal-process.js'
import { ExecutionError } from './types.js'
export async function startProposalSupervisor(
  raw: unknown,
): Promise<{ pid: number | null; root: string }> {
  return launchProposalSupervisor(raw, false)
}
/** Explicit stop/export/cleanup of an existing attempt; never starts a fresh worker. */
export async function collectProposalSupervisor(
  raw: unknown,
): Promise<{ pid: number | null; root: string }> {
  return launchProposalSupervisor(raw, true)
}
async function launchProposalSupervisor(
  raw: unknown,
  collectOnly: boolean,
): Promise<{ pid: number | null; root: string }> {
  const config = validateProposalSupervisorConfig(raw),
    root = join(config.hostRoot, executionName(config.spec))
  for (const path of [config.executionRoot, config.resourceRoot, config.storeRoot, root])
    await prepareSupervisorDirectory(path)
  if (collectOnly) {
    const history = join(config.executionRoot, config.spec.executionId)
    let recorded: unknown
    try {
      recorded = await readCanonicalFile(join(history, 'spec.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ExecutionError('collection requires recorded execution effects')
      throw error
    }
    validateRef(recorded)
    const store = await openObjectStore(config.storeRoot)
    if (
      canonicalJson(parseCanonicalJson((await store.read(recorded)).toString('utf8'))) !==
      canonicalJson(config.spec)
    )
      throw new ExecutionError('collection execution spec mismatch')
    const evidence = await openExecutionEvidence(history, store, config.spec)
    if (!evidence.receipts.length)
      throw new ExecutionError('collection requires recorded execution effects')
  }
  await proposalProcessContext(config)
  const configPath = join(root, 'supervisor-config.json')
  await publishCanonical(configPath, config)
  const state = await readProposalProcessState(config)
  if (state.status === 'COMPLETE') return { pid: null, root }
  if (collectOnly && !(await readExecutionCancellation(root, config.spec)))
    await cancelProposalSupervisor(config, 'explicit orphan collection')
  if (state.pid) return { pid: state.pid, root }
  if (!collectOnly && state.status === 'INCOMPLETE')
    throw new ExecutionError(
      'proposal attempt has failure evidence; explicit reconcile required, model relaunch refused',
    )
  const stdout = await open(
    join(root, 'supervisor.stdout'),
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const stderr = await open(
      join(root, 'supervisor.stderr'),
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const child = spawn(
        '/usr/bin/flock',
        [
          '--exclusive',
          '--nonblock',
          '--conflict-exit-code',
          '75',
          '--no-fork',
          join(root, 'owner.lock'),
          process.execPath,
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            '../../lib/bin/docker-proposal-supervisor.js',
          ),
          configPath,
        ],
        {
          detached: true,
          cwd: root,
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
          stdio: ['ignore', stdout.fd, stderr.fd],
        },
      )
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      child.unref()
      return { pid: child.pid!, root }
    } finally {
      await stderr.close()
    }
  } finally {
    await stdout.close()
  }
}
