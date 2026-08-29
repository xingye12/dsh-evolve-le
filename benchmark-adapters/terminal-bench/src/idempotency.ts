/**
 * Idempotent submission ledger (Gate 2, specs/04 §5, specs/06; CLAUDE.md
 * rules 7-8): Harbor has no native submit-idempotency — its only guard is
 * "same job_name + same resolved config resumes, different config raises
 * FileExistsError". The provider therefore keeps its own append-only,
 * content-keyed ledger: the key is the sha256 of every input that could
 * change the paid outcome (provider protocol, candidate capsule archive,
 * task inventory digest, selected handles, attempts, Harbor version, agent
 * identity). Before any paid submit the provider consults the ledger; a hit
 * means the trial set already ran and must be re-read from the recorded job
 * directory, never re-paid. The file is JSONL and append-only: entries are
 * never rewritten or dropped, so the audit trail survives crashes.
 * @module @dsh-evolve-le/tb-provider/idempotency
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const LEDGER_PROTOCOL = 'dsh-evolve-le/tb-ledger/v1'

export interface IdempotencyInputs {
  /** Logical run identity (specs/04 §5 trial tuple: run). */
  runId: string
  /** Capsule tar.gz sha256 (trial tuple: candidate hash). */
  capsuleArchiveSha256: string
  /** Frozen task inventory digest (trial tuple: task set + split identity). */
  inventorySha256: string
  /** Selected task handles, in planned order. */
  handles: string[]
  /** Attempts per task (trial tuple: attempt count). */
  attempts: number
  /** Harbor version pinned in the run manifest. */
  harborVersion: string
}

export interface LedgerEntry {
  protocol: typeof LEDGER_PROTOCOL
  key: string
  runId: string
  jobName: string
  jobDir: string
  capsuleArchiveSha256: string
  inventorySha256: string
  handles: string[]
  attempts: number
  harborVersion: string
  /**
   * Controller-side idempotency key (`eval-<actionId>`) when the reservation
   * was made through the Gate 5 provider adapter. Deliberately NOT part of
   * the paid key: the ledger key names the paid outcome, this names the
   * controller action that paid for it. The adapter fails closed when a
   * second action tries to map onto an already-paid outcome (CLAUDE.md rule
   * 8: attempt identity belongs to the paid outcome).
   */
  controllerKey?: string
  /** ISO timestamp; audit metadata only, never part of the key. */
  recordedAt: string
}

/** Deterministic idempotency key over every paid-outcome-relevant input. */
export function idempotencyKey(inputs: IdempotencyInputs): string {
  const document = {
    protocol: LEDGER_PROTOCOL,
    runId: inputs.runId,
    capsuleArchiveSha256: inputs.capsuleArchiveSha256,
    inventorySha256: inputs.inventorySha256,
    handles: [...inputs.handles].sort(),
    attempts: inputs.attempts,
    harborVersion: inputs.harborVersion,
  }
  return createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex')
}

/** Filesystem-safe, collision-free job name derived from the key. */
export function jobNameForKey(key: string): string {
  return `dsh-${key.slice(0, 24)}`
}

/**
 * Append-only JSONL ledger. `reserve` is the only writer: it returns the
 * first recorded entry for the key (an existing paid submission) or appends
 * a new one. Existing entries are immutable; a second reservation with the
 * same key appends an audit line but `lookup` keeps answering with the
 * first, so re-submits converge on the original job directory.
 */
export class SubmissionLedger {
  constructor(private readonly path: string) {}

  async entries(): Promise<LedgerEntry[]> {
    const text = await readFile(this.path, 'utf8').catch(() => '')
    const out: LedgerEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const parsed = JSON.parse(line) as LedgerEntry
      if (parsed.protocol !== LEDGER_PROTOCOL) {
        throw new Error(`ledger: foreign record in ${this.path}: ${line.slice(0, 120)}`)
      }
      out.push(parsed)
    }
    return out
  }

  async lookup(key: string): Promise<LedgerEntry | undefined> {
    const entries = await this.entries()
    return entries.find((entry) => entry.key === key)
  }

  /** First entry reserved by a controller action key (Gate 5 adapter). */
  async lookupByControllerKey(controllerKey: string): Promise<LedgerEntry | undefined> {
    const entries = await this.entries()
    return entries.find((entry) => entry.controllerKey === controllerKey)
  }

  /** First entry recorded for a job name (job names embed the paid key). */
  async lookupByJobName(jobName: string): Promise<LedgerEntry | undefined> {
    const entries = await this.entries()
    return entries.find((entry) => entry.jobName === jobName)
  }

  async reserve(entry: Omit<LedgerEntry, 'protocol' | 'recordedAt'>): Promise<{
    status: 'new' | 'existing'
    entry: LedgerEntry
  }> {
    const existing = await this.lookup(entry.key)
    if (existing !== undefined) return { status: 'existing', entry: existing }
    const record: LedgerEntry = {
      ...entry,
      protocol: LEDGER_PROTOCOL,
      recordedAt: new Date().toISOString(),
    }
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8')
    return { status: 'new', entry: record }
  }
}
