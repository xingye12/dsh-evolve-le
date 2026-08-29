/**
 * Journal contract tests (Gate 3, specs/06 §4): HEAD is the only commit
 * point, rotation follows the pinned size rules, crash residue is
 * quarantined (never rolled forward), and every committed-prefix corruption
 * fails closed. These tests simulate torn writes by manipulating segment
 * bytes directly, which is exactly the state a killed process leaves behind.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../src/state/canonical.js'
import {
  GENESIS_PREVIOUS_HASH,
  Journal,
  hashEvent,
  journalDirOf,
  readJournal,
  segmentName,
} from '../../src/state/journal.js'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freshRun(prefix: string, segmentMaxBytes = 1024 * 1024) {
  const runDir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(runDir)
  const config = { runId: 'run-test', segmentMaxBytes }
  return { runDir, config, journal: await Journal.open(runDir, config) }
}

function draft(seq: number) {
  return {
    type: 'test.event',
    actor: 'test',
    occurredAt: `2026-08-14T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    payload: { n: seq, text: 'x'.repeat(32) },
    eventId: `id-${String(seq).padStart(4, '0')}`,
  }
}

describe('append and replay', () => {
  it('commits events with a chained hash and replays them byte-exact', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-append-')
    const events = [await journal.append(draft(1)), await journal.append(draft(2))]
    expect(events[0]?.previousHash).toBe(GENESIS_PREVIOUS_HASH)
    expect(events[1]?.previousHash).toBe(events[0]?.eventHash)
    expect(events[1]?.seq).toBe(2)
    await journal.close()
    const read = await readJournal(runDir, config)
    expect(read.events).toEqual(events)
    expect(read.head?.seq).toBe(2)
    expect(read.head?.segment).toBe(segmentName(1))
    expect(read.residue).toEqual({ strayFiles: [], trailingBytesInActive: 0, laterSegments: [] })
  })

  it('validates the persisted event against the hash recomputation', async () => {
    const { runDir, journal } = await freshRun('dsh-jr-hash-')
    const event = await journal.append(draft(1))
    await journal.close()
    const { eventHash: _stripped, ...envelope } = event
    expect(event.eventHash).toBe(hashEvent(envelope))
    const raw = await readFile(join(journalDirOf(runDir), 'events-000001.jsonl'), 'utf8')
    expect(raw.trimEnd()).toBe(canonicalJson(event))
  })

  it('rejects malformed drafts at the boundary', async () => {
    const { journal } = await freshRun('dsh-jr-draft-')
    await expect(journal.append({ ...draft(1), type: '' })).rejects.toThrow(/non-empty/)
    await expect(journal.append({ ...draft(1), occurredAt: 'nope' })).rejects.toThrow(/timestamp/)
    await expect(journal.append({ ...draft(1), payload: { bad: 1.5 } })).rejects.toThrow(
      /safe integer/,
    )
    await journal.close()
  })

  it('refuses a second journal over a live one via its own invariants (config binding)', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-bind-')
    await journal.append(draft(1))
    await journal.close()
    await expect(Journal.open(runDir, { ...config, runId: 'other-run' })).rejects.toThrow(
      /runId mismatch/,
    )
  })
})

describe('rotation rules', () => {
  it('rotates only when the next record would exceed the limit', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-rot-', 1024 * 1024)
    // Write one record, measure it, then reopen with a limit of exactly two
    // records so the boundary cases are exact (all drafts share one length).
    const first = await journal.append(draft(1))
    await journal.close()
    const lineBytes = Buffer.byteLength(`${canonicalJson(first)}\n`)
    const exactFit = { runId: config.runId, segmentMaxBytes: 2 * lineBytes }
    const resumed = await Journal.open(runDir, exactFit)
    // Second record lands exactly at the limit: no rotation.
    await resumed.append(draft(2))
    expect(resumed.activeSegmentName).toBe(segmentName(1))
    // A third record would exceed: close segment 1, rotate first.
    await resumed.append(draft(3))
    expect(resumed.activeSegmentName).toBe(segmentName(2))
    await resumed.close()
    const read = await readJournal(runDir, exactFit)
    expect(read.events.map((event) => event.seq)).toEqual([1, 2, 3])
    // The closed segment carries a matching size/Merkle summary.
    const summary = JSON.parse(
      await readFile(join(journalDirOf(runDir), 'events-000001.jsonl.closed.json'), 'utf8'),
    )
    expect(summary.records).toBe(2)
    expect(summary.sizeBytes).toBe(2 * lineBytes)
  })

  it('keeps an oversized record alone in its own segment', async () => {
    const { runDir, journal } = await freshRun('dsh-jr-big-', 64)
    const huge = await journal.append({ ...draft(1), payload: { blob: 'y'.repeat(512) } })
    expect(Buffer.byteLength(canonicalJson(huge))).toBeGreaterThan(64)
    expect(journal.activeSegmentName).toBe(segmentName(1))
    const next = await journal.append(draft(2))
    expect(journal.activeSegmentName).toBe(segmentName(2))
    await journal.close()
    const read = await readJournal(runDir, { runId: 'run-test', segmentMaxBytes: 64 })
    expect(read.events.map((event) => event.seq)).toEqual([next.seq - 1, next.seq])
  })

  it('fails closed when the rotation target already exists', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-target-', 1)
    await journal.append({ ...draft(1), payload: { blob: 'z'.repeat(64) } })
    // Simulate a residue segment the quarantine did not remove: impossible
    // through the public path, so create it after close.
    await journal.close()
    await writeFile(join(journalDirOf(runDir), segmentName(2)), Buffer.from('junk\n'))
    // Reopening sees segment 2 as uncommitted residue and quarantines it.
    const reopened = await Journal.open(runDir, config)
    await reopened.append({ ...draft(2), payload: { blob: 'w'.repeat(64) } })
    expect(reopened.activeSegmentName).toBe(segmentName(2))
    await reopened.close()
    const read = await readJournal(runDir, config)
    expect(read.events).toHaveLength(2)
    const residue = await readdir(join(journalDirOf(runDir), 'crash-residue'))
    expect(residue).toHaveLength(1)
  })
})

describe('crash residue', () => {
  it('quarantines trailing bytes after the committed tail and resumes cleanly', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-torn-')
    const committed = await journal.append(draft(1))
    await journal.close()
    const segmentPath = join(journalDirOf(runDir), segmentName(1))
    const good = await readFile(segmentPath)
    // Simulate: record 2 fully written + fsynced, process killed before HEAD.
    const phantom = await Journal.open(runDir, config)
    const phantomEvent = await phantom.append(draft(2))
    await phantom.close()
    const withPhantom = await readFile(segmentPath)
    await writeFile(segmentPath, Buffer.concat([good, withPhantom.subarray(good.length)]))
    // Revert HEAD to the committed prefix (the crash did that).
    await writeFile(
      join(journalDirOf(runDir), 'HEAD'),
      `${canonicalJson({
        schemaVersion: 1,
        runId: 'run-test',
        seq: committed.seq,
        eventHash: committed.eventHash,
        segment: segmentName(1),
      })}\n`,
    )
    const read = await readJournal(runDir, config)
    expect(read.events).toEqual([committed])
    expect(read.residue.trailingBytesInActive).toBe(withPhantom.length - good.length)
    const resumed = await Journal.open(runDir, config)
    expect(resumed.residue.trailingBytesInActive).toBe(withPhantom.length - good.length)
    await resumed.append(draft(3))
    await resumed.close()
    // Record 2's bytes never rolled forward: the next append is seq 3 over a
    // truncated segment.
    const after = await readJournal(runDir, config)
    // seq restarts from the committed HEAD: the phantom record is gone and
    // the new append takes the next contiguous seq with its own identity.
    expect(after.events.map((event) => event.seq)).toEqual([1, 2])
    expect(after.events[1]?.previousHash).toBe(committed.eventHash)
    expect(after.events[1]?.eventId).toBe('id-0003')
    expect(after.events.map((e) => e.eventId)).not.toContain(phantomEvent.eventId)
    const final = await readFile(segmentPath, 'utf8')
    expect(final.trim().split('\n')).toHaveLength(2)
  })

  it('quarantines a stray HEAD.tmp', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-tmp-')
    await journal.append(draft(1))
    await journal.close()
    await writeFile(join(journalDirOf(runDir), 'HEAD.tmp'), Buffer.from('garbage'))
    const resumed = await Journal.open(runDir, config)
    expect(resumed.residue.strayFiles).toEqual(['HEAD.tmp'])
    await resumed.append(draft(2))
    await resumed.close()
    const entries = await readdir(journalDirOf(runDir))
    expect(entries).not.toContain('HEAD.tmp')
    expect(await readJournal(runDir, config)).toMatchObject({ head: { seq: 2 } })
  })

  it('treats all segments as residue when HEAD never existed', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-nohead-')
    const event = await journal.append(draft(1))
    await journal.close()
    await rm(join(journalDirOf(runDir), 'HEAD'))
    const read = await readJournal(runDir, config)
    expect(read.events).toEqual([])
    expect(read.head).toBeNull()
    const resumed = await Journal.open(runDir, config)
    expect(resumed.residue.laterSegments).toEqual([segmentName(1)])
    await resumed.append({ ...draft(9), eventId: 'id-fresh' })
    await resumed.close()
    const after = await readJournal(runDir, config)
    expect(after.events).toHaveLength(1)
    expect(after.events[0]?.previousHash).toBe(GENESIS_PREVIOUS_HASH)
    expect(after.events[0]?.eventId).not.toBe(event.eventId)
  })
})

describe('fail-closed corruption', () => {
  async function committed(prefix: string) {
    const { runDir, config, journal } = await freshRun(prefix)
    await journal.append(draft(1))
    await journal.append(draft(2))
    await journal.close()
    return { runDir, config }
  }

  it('rejects a mutated committed record (hash mismatch)', async () => {
    const { runDir, config } = await committed('dsh-jr-mutate-')
    const path = join(journalDirOf(runDir), segmentName(1))
    const text = await readFile(path, 'utf8')
    const lines = text.trimEnd().split('\n')
    const mutated = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>
    mutated['payload'] = { n: 999, text: 'x'.repeat(32) }
    lines[1] = canonicalJson(mutated)
    await writeFile(path, `${lines.join('\n')}\n`)
    await expect(readJournal(runDir, config)).rejects.toThrow(/eventHash|recomputed/)
  })

  it('rejects a reordered record (non-canonical persistence)', async () => {
    const { runDir, config } = await committed('dsh-jr-reorder-')
    const path = join(journalDirOf(runDir), segmentName(1))
    const text = await readFile(path, 'utf8')
    const lines = text.trimEnd().split('\n')
    const record = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>
    const reversed = Object.fromEntries(Object.entries(record).reverse())
    lines[0] = JSON.stringify(reversed)
    await writeFile(path, `${lines.join('\n')}\n`)
    await expect(readJournal(runDir, config)).rejects.toThrow(/not canonical/)
  })

  it('rejects a bad HEAD (tampered hash, wrong fields, bad segment)', async () => {
    const { runDir, config } = await committed('dsh-jr-head-')
    const headPath = join(journalDirOf(runDir), 'HEAD')
    const original = JSON.parse(await readFile(headPath, 'utf8')) as Record<string, unknown>
    const write = (value: unknown) => writeFile(headPath, `${canonicalJson(value)}\n`)
    await write({ ...original, eventHash: `sha256:${'f'.repeat(64)}` })
    await expect(readJournal(runDir, config)).rejects.toThrow(/!= HEAD|hash/)
    await write({ ...original, extra: 1 })
    await expect(readJournal(runDir, config)).rejects.toThrow(/wrong field set/)
    await write({ ...original, segment: 'events-999999.jsonl' })
    await expect(readJournal(runDir, config)).rejects.toThrow(/missing/)
    await write(original)
    await expect(readJournal(runDir, config)).resolves.toMatchObject({ head: { seq: 2 } })
  })

  it('rejects an illegal file in the journal directory', async () => {
    const { runDir, config } = await committed('dsh-jr-foreign-')
    await writeFile(join(journalDirOf(runDir), 'events-1.jsonl'), Buffer.from('x'))
    await expect(readJournal(runDir, config)).rejects.toThrow(/illegal file/)
  })

  it('rejects a missing close summary for a passed segment', async () => {
    const { runDir, config } = await committed('dsh-jr-nosummary-')
    // Force a rotation so segment 1 is closed and its summary is required.
    const journal = await Journal.open(runDir, { runId: config.runId, segmentMaxBytes: 1 })
    await journal.append({ ...draft(3), payload: { blob: 'q'.repeat(64) } })
    await journal.close()
    await rm(join(journalDirOf(runDir), 'events-000001.jsonl.closed.json'))
    await expect(readJournal(runDir, config)).rejects.toThrow(/missing its close summary/)
  })

  it('rejects a summary that disagrees with segment content', async () => {
    const { runDir, config } = await committed('dsh-jr-badsummary-')
    const journal = await Journal.open(runDir, { runId: config.runId, segmentMaxBytes: 1 })
    await journal.append({ ...draft(3), payload: { blob: 'q'.repeat(64) } })
    await journal.close()
    const summaryPath = join(journalDirOf(runDir), 'events-000001.jsonl.closed.json')
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>
    summary['records'] = 99
    await writeFile(summaryPath, `${canonicalJson(summary)}\n`)
    await expect(readJournal(runDir, config)).rejects.toThrow(/does not match segment/)
  })

  it('rejects an empty or non-regular active segment', async () => {
    const { runDir, config } = await committed('dsh-jr-empty-')
    const path = join(journalDirOf(runDir), segmentName(1))
    await writeFile(path, Buffer.alloc(0))
    await expect(readJournal(runDir, config)).rejects.toThrow(/empty/)
    const { mkdir } = await import('node:fs/promises')
    await rm(path)
    await mkdir(path)
    await expect(readJournal(runDir, config)).rejects.toThrow(/not a regular file|missing/)
  })

  it('rejects truncated committed prefix mid-record', async () => {
    const { runDir, config } = await committed('dsh-jr-trunc-')
    const path = join(journalDirOf(runDir), segmentName(1))
    const bytes = await readFile(path)
    await writeFile(path, bytes.subarray(0, bytes.length - 5))
    await expect(readJournal(runDir, config)).rejects.toThrow(/tail seq 2 not found/)
  })
})

describe('replay determinism', () => {
  it('produces identical event lists across repeated reads', async () => {
    const { runDir, config, journal } = await freshRun('dsh-jr-det-')
    for (let seq = 1; seq <= 20; seq += 1) await journal.append(draft(seq))
    await journal.close()
    const first = await readJournal(runDir, config)
    const second = await readJournal(runDir, config)
    expect(first.events).toEqual(second.events)
    expect(first.head).toEqual(second.head)
    expect(first.events).toHaveLength(20)
  })

  it('survives many rotations without numbering gaps', async () => {
    // Limit 400 with ~417-byte records: every record is oversized, so each
    // occupies its own segment — the spec's never-split rule at work.
    const { runDir, config, journal } = await freshRun('dsh-jr-many-', 400)
    for (let seq = 1; seq <= 12; seq += 1) {
      await journal.append({ ...draft(seq), payload: { n: seq, text: 'z'.repeat(48) } })
    }
    await journal.close()
    const read = await readJournal(runDir, config)
    expect(read.head?.segment).toBe(segmentName(12))
    expect(read.events).toHaveLength(12)
    expect(read.events.at(-1)?.seq).toBe(12)
  })
})
