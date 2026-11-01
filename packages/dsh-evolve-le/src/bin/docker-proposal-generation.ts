/** run/read/sweep <private config>; mutating commands re-exec under the attempt's kernel lock. */
import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCanonicalJson } from '../state/canonical.js'
import { validateGenerationConfig } from '../execution/proposal-generation-config.js'
import {
  generationOwnerContext,
  runFrozenGeneration,
  readFrozenGeneration,
  sweepFrozenGeneration,
} from '../execution/proposal-generation-process.js'
const abort = new AbortController()
process.once('SIGTERM', () => abort.abort())
process.once('SIGINT', () => abort.abort())
try {
  const [command, configPath, credentialFlag, credentialPath] = process.argv.slice(2)
  if (
    ![4, 6].includes(process.argv.length) ||
    (process.argv.length === 6 &&
      (credentialFlag !== '--credential-file' ||
        !credentialPath?.startsWith('/') ||
        !['run', 'locked-run'].includes(command ?? ''))) ||
    !['run', 'read', 'sweep', 'locked-run', 'locked-sweep'].includes(command ?? '') ||
    !configPath?.startsWith('/')
  )
    throw Error('usage: docker-proposal-generation run|read|sweep /absolute/private-config.json')
  const file = await open(
    configPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let raw: unknown
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.uid !== 0 ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      stat.size > 16 * 1024 * 1024
    )
      throw Error('generation config must be bounded, private and root-owned')
    raw = parseCanonicalJson(await file.readFile('utf8'))
  } finally {
    await file.close()
  }
  const config = validateGenerationConfig(raw)
  if (command === 'read')
    process.stdout.write(JSON.stringify(await readFrozenGeneration(config)) + '\n')
  else if (command === 'locked-run') {
    const result = await runFrozenGeneration(config, abort.signal, credentialPath)
    process.stdout.write(JSON.stringify(result) + '\n')
    if (result.outcome !== 'SUCCEEDED') process.exitCode = 1
  } else if (command === 'locked-sweep')
    process.stdout.write(JSON.stringify(await sweepFrozenGeneration(config)) + '\n')
  else {
    const { root } = await generationOwnerContext(config)
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
        resolve(fileURLToPath(import.meta.url)),
        `locked-${command}`,
        configPath,
        ...(credentialPath ? ['--credential-file', credentialPath] : []),
      ],
      {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    const forward = () => child.kill('SIGTERM')
    abort.signal.addEventListener('abort', forward, { once: true })
    try {
      process.exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', (code) => resolveExit(code ?? 1))
      })
    } finally {
      abort.signal.removeEventListener('abort', forward)
    }
  }
} catch {
  // Never serialize arbitrary transport errors or an operator's config/credential contents.
  process.stderr.write(
    'proposal generation command failed; inspect the attempt evidence and platform report\n',
  )
  process.exitCode = 1
}
