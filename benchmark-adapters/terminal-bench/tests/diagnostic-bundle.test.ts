import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { diagnosticTraceBundle } from '../src/diagnostic-bundle.js'
import type { NormalizedTrial } from '../src/normalize.js'

const dirs: string[] = []
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const trial: NormalizedTrial = {
  protocol: 'dsh-evolve-le/tb-trial/v1',
  identity: {
    runId: 'run',
    capsuleArchiveSha256: 'a'.repeat(64),
    inventorySha256: 'b'.repeat(64),
    handle: 'dev',
    attempt: 1,
  },
  trialName: 'trial',
  taskName: 'must-not-leak',
  agentInfo: { name: 'acp', version: 'v' },
  status: 'fail',
  outcome: {
    category: 'reward',
    reward: 0,
    exceptionType: null,
    reason: 'zero',
    agentParticipation: 'ran',
  },
  usage: { agentExecutionMs: 1, verifierMs: 2, nInputTokens: 3, nOutputTokens: 4, costUsd: 0.1 },
  resultDigest: null,
}

describe('diagnostic trace bundle', () => {
  it('indexes bounded event/test evidence and excludes the task name and host path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-debug-trace-'))
    dirs.push(dir)
    await mkdir(join(dir, 'agent'), { recursive: true })
    await mkdir(join(dir, 'verifier'), { recursive: true })
    await writeFile(
      join(dir, 'agent', 'acp-events.jsonl'),
      '{"event_type":"create_terminal","command":"cat /root/secret"}\n',
    )
    await writeFile(
      join(dir, 'verifier', 'ctrf.json'),
      '{"tests":[{"name":"suite::case","status":"failed","message":"boom"}]}',
    )
    const bundle = JSON.parse(
      (await diagnosticTraceBundle({ trialDir: dir, trial })).toString('utf8'),
    )
    expect(bundle.events[0]).toMatchObject({ index: 0, kind: 'create_terminal' })
    expect(bundle.tests[0]).toMatchObject({ index: 0, name: 'suite::case', status: 'failed' })
    expect(JSON.stringify(bundle)).not.toContain('must-not-leak')
    expect(JSON.stringify(bundle)).not.toContain('/root/secret')
  })
})
