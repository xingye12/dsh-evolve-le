/**
 * Contract tests for the trial egress forwarder (ADR-028 falsification
 * amendment). The forwarder replaces the `fwd` socat relay; trial plans point
 * at `172.17.0.1:17897` verbatim, so the listen/upstream addresses are pinned
 * here against accidental drift, and `--selftest` (loopback only, mock
 * upstream) pins the retry policy: a 502'd or connection-failed request is
 * re-issued up to 3 additional times, a persistent 502 is relayed faithfully,
 * healthy requests pass through untouched, and CONNECT tunnels survive.
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
    expect(source).toContain('DEFAULT_RETRIES = 3')
  })

  it('passes the loopback contract selftest (retry policy + tunnel)', async () => {
    const { stdout, stderr } = await exec('python3', [scriptPath, '--selftest'], {
      timeout: 60_000,
    })
    expect(stderr).toBe('')
    expect(stdout).toContain('SELFTEST OK')
    // The policy the ADR pre-registered: 1 initial + 3 retries, and a
    // persistent 502 is relayed to the client after exactly that many.
    expect(stdout).toContain('persistent 502 relayed after 1+3 attempts')
    expect(stdout).toContain('flaky 502 retried to success (3 attempts)')
    expect(stdout).toContain('connection-level failure retried to success')
    expect(stdout).toContain('CONNECT tunnel passes bytes through')
  })
})
