/**
 * Contract tests for the proposal-saga evidence copy set (ADR-043): after a
 * live run the record script must preserve every per-expansion receipt the
 * post-mortem needs BEFORE the scratch root is deleted (rule 7). Pins:
 *
 * - every object-store file lands flat as `object-<sha256>` (the validation
 *   summary that carries per-child rejected reasons lives there);
 * - `search-state.json` and `failure-pool.json` are copied verbatim;
 * - per-expansion `worker-result.json` lands as `<actionId>-worker-result.json`;
 * - unrelated scratch content (staging objects, non-hex names, remote
 *   receipts beside the sandbox, root-level run documents) is NOT included —
 *   the helper owns exactly the ADR-043 scope.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { proposalEvidenceCopies } from '../lib/evidence-copy-set.ts'

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-evidence-copy-set-'))
  dirs.push(dir)
  return dir
}

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)

describe('proposalEvidenceCopies (ADR-043)', () => {
  it('copies every object-store file flat, the search/failure documents, and worker results', async () => {
    const root = await scratch()
    await mkdir(join(root, 'objects', 'sha256', 'aa'), { recursive: true })
    await mkdir(join(root, 'objects', 'sha256', 'bb'), { recursive: true })
    await writeFile(
      join(root, 'objects', 'sha256', 'aa', HEX_A),
      '{"kind":"proposal-validation"}\n',
    )
    await writeFile(join(root, 'objects', 'sha256', 'bb', HEX_B), '{"kind":"admission-receipt"}\n')
    await writeFile(join(root, 'search-state.json'), '{"expansionAttempts":2}\n')
    await writeFile(join(root, 'failure-pool.json'), '{"handles":["x"]}\n')
    await mkdir(join(root, 'controller', 'sandboxes', 'prop-1', 'work'), { recursive: true })
    await writeFile(
      join(root, 'controller', 'sandboxes', 'prop-1', 'work', 'worker-result.json'),
      '{"ok":true}\n',
    )

    const copies = await proposalEvidenceCopies(root)
    const names = new Map(copies.map(([source, name]) => [name, source]))

    expect(copies.map(([, name]) => name).sort()).toEqual([
      'failure-pool.json',
      `object-${HEX_A}`,
      `object-${HEX_B}`,
      'prop-1-worker-result.json',
      'search-state.json',
    ])
    expect(names.get(`object-${HEX_A}`)).toBe(join(root, 'objects', 'sha256', 'aa', HEX_A))
    expect(names.get('prop-1-worker-result.json')).toBe(
      join(root, 'controller', 'sandboxes', 'prop-1', 'work', 'worker-result.json'),
    )
  })

  it('excludes staging objects, non-hex names, sandbox receipts, and missing documents', async () => {
    const root = await scratch()
    await mkdir(join(root, 'objects', 'sha256', 'aa'), { recursive: true })
    await mkdir(join(root, 'objects', 'staging'), { recursive: true })
    await writeFile(join(root, 'objects', 'sha256', 'aa', 'not-a-digest.txt'), 'x\n')
    await writeFile(join(root, 'objects', 'staging', 'partial'), 'x\n')
    await mkdir(join(root, 'controller', 'sandboxes', 'prop-2-remote'), { recursive: true })
    await writeFile(
      join(root, 'controller', 'sandboxes', 'prop-2-remote', 'remote-receipts.jsonl'),
      '{"schemaVersion":3}\n',
    )
    // A sandbox with no worker-result manifest (crash mid-run) adds nothing.
    await mkdir(join(root, 'controller', 'sandboxes', 'prop-2'), { recursive: true })
    await writeFile(join(root, 'run-manifest.json'), '{}')

    const copies = await proposalEvidenceCopies(root)
    expect(copies).toEqual([])
  })

  it('tolerates a run root with no proposal saga at all (empty copy set, never throws)', async () => {
    const root = await scratch()
    await expect(proposalEvidenceCopies(root)).resolves.toEqual([])
  })
})
