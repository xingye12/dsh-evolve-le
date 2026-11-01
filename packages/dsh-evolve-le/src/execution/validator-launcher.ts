/** Controller-facing process launch and verified result readback. A PID is not completion. */
import { requestExecutionCancellation } from './cancellation.js'
import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSupervisorDirectory } from './host-directory.js'
import { publishCanonical } from './evidence.js'
import { executionName } from './types.js'
import {
  validateValidatorSupervisorConfig,
  type ValidatorSupervisorResult,
} from './validator-supervisor.js'
import { readValidatorResult } from './validator-result.js'
export async function startValidatorSupervisor(
  raw: unknown,
): Promise<{ pid: number | null; root: string }> {
  const config = validateValidatorSupervisorConfig(raw),
    root = join(config.hostRoot, executionName(config.spec))
  for (const path of [config.executionRoot, config.resourceRoot, config.storeRoot, root])
    await prepareSupervisorDirectory(path)
  const configPath = join(root, 'supervisor-config.json')
  await publishCanonical(configPath, config)
  if (await readValidatorSupervisorResult(config)) return { pid: null, root }
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
            '../../lib/bin/docker-validator-supervisor.js',
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
export async function readValidatorSupervisorResult(
  raw: unknown,
): Promise<ValidatorSupervisorResult | null> {
  return readValidatorResult(validateValidatorSupervisorConfig(raw))
}

/** Publishes intent only; callers must await verified terminal/cleanup receipts. */
export async function cancelValidatorSupervisor(raw: unknown, reason: string): Promise<void> {
  const config = validateValidatorSupervisorConfig(raw)
  const root = join(config.hostRoot, executionName(config.spec))
  await prepareSupervisorDirectory(root)
  await publishCanonical(join(root, 'supervisor-config.json'), config)
  await requestExecutionCancellation(root, config.spec, reason)
}
