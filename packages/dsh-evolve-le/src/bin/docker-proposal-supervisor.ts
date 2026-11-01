/** Trusted fixed entrypoint, launched with flock --no-fork and a frozen config. */
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { parseCanonicalJson } from '../state/canonical.js'
import { runFrozenProposalSupervisor } from '../execution/proposal-process.js'
const abort = new AbortController()
process.once('SIGTERM', () => abort.abort())
process.once('SIGINT', () => abort.abort())
try {
  if (process.argv.length !== 3 || !process.argv[2]?.startsWith('/'))
    throw Error('expected absolute supervisor config path')
  const file = await open(
    process.argv[2],
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  let config: unknown
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== 0 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16 * 1024 * 1024
    )
      throw Error('supervisor config must be bounded, root-owned and private')
    config = parseCanonicalJson(await file.readFile('utf8'))
  } finally {
    await file.close()
  }
  const result = await runFrozenProposalSupervisor(config, abort.signal)
  process.stdout.write(
    JSON.stringify({ outcome: result.outcome, execution: result.execution }) + '\n',
  )
  if (result.outcome !== 'SUCCEEDED') process.exitCode = 1
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : 'proposal supervisor bootstrap failed').slice(
      0,
      2048,
    ) + '\n',
  )
  process.exitCode = 1
}
