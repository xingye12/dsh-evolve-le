/**
 * Contract tests for the trial egress forwarder (ADR-028 falsification
 * amendment). The forwarder replaces the `fwd` socat relay; trial plans point
 * at `172.17.0.1:17897` verbatim, so the listen/upstream addresses are pinned
 * here against accidental drift, and `--selftest` (loopback only, mock
 * upstream) pins the retry policy: a transient idempotent request is re-issued
 * up to 8 additional times, a non-idempotent POST is never retried, healthy
 * requests pass through untouched, and CONNECT tunnels survive.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const exec = promisify(execFile)
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '../lib/trial-egress-forwarder.py')

describe('trial-egress-forwarder (ADR-028 falsification amendment)', () => {
  it('pins the listen/upstream addresses the trial plans point at', async () => {
    const source = await readFile(scriptPath, 'utf8')
    expect(source).toContain("DEFAULT_LISTEN = '172.17.0.1:17897'")
    expect(source).toContain("DEFAULT_UPSTREAM = '127.0.0.1:7897'")
    expect(source).toContain('DEFAULT_RETRIES = 8')
  })

  it('passes the loopback contract selftest (retry policy + tunnel)', async () => {
    const { stdout, stderr } = await exec('python3', [scriptPath, '--selftest'], {
      timeout: 60_000,
    })
    expect(stderr).toBe('')
    expect(stdout).toContain('SELFTEST OK')
    expect(stdout).toContain('persistent 502 relayed after configured attempts')
    expect(stdout).toContain('flaky 502 retried to success (3 attempts)')
    expect(stdout).toContain('connection-level failure retried to success')
    expect(stdout).toContain('non-idempotent POST is not retried')
    expect(stdout).toContain('parallel preflight probe reaches the forwarder listener')
    expect(stdout).toContain('CONNECT tunnel passes bytes through')
  })
})
