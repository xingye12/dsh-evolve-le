/**
 * Hash-chain event journal (specs/06 §4). One writer appends canonical-JSON
 * events as single lines into numbered segments; the commit point is the
 * atomically published `HEAD` ({schemaVersion, runId, seq, eventHash,
 * segment}), never a segment fsync. Readers replay only to the exact
 * `(seq, eventHash, segment)` named by HEAD; anything after it — trailing
 * bytes in the active segment, later canonical segments, stray staging files
 * (`HEAD.tmp`, `*.closed.json.tmp`) — is uncommitted crash residue that is
 * quarantined under `crash-residue/` (content-hash identity) before the
 * writer's next append, never implicitly rolled forward. A committed prefix
 * that fails byte-exact re-validation fails closed.
 *
 * Rotation (spec-pinned): if the next complete record would push the current
 * non-empty segment past `segmentMaxBytes`, the writer first closes the
 * current segment (durable `*.closed.json` size/Merkle summary), then
 * exclusive-creates the next canonical segment; landing exactly at the limit
 * does not rotate; an oversized record is never split — it occupies a segment
 * alone and the next append rotates. A pre-existing rotation target, or an
 * empty / non-regular active segment, is corruption.
 *
 * Purity: the journal never reads the clock or RNG — `occurredAt` and
 * `eventId` (when deterministic) come from the caller.
 * @module @dsh-evolve-le/core/state/journal
 */

import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { lstat, open, readdir } from 'node:fs/promises'
import { mkdir, readFile, rename, truncate, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CanonicalJsonError,
  canonicalJson,
  isValidCanonicalTimestamp,
  parseCanonicalJson,
  sha256Hex,
} from './canonical.js'

export const JOURNAL_PROTOCOL = 'dsh-evolve-le/journal/v1'
export const JOURNAL_SCHEMA_VERSION = 1
export const GENESIS_PREVIOUS_HASH = `sha256:${'0'.repeat(64)}`
export const SEGMENT_MERKLE_ALGORITHM = 'sha256-of-eventhash-lines'

const HASH_VALUE = /^sha256:[0-9a-f]{64}$/
const SEGMENT_NAME = /^events-(\d{6})\.jsonl$/
const SUMMARY_SUFFIX = '.closed.json'
const STAGING_SUFFIX = '.tmp'
const CRASH_RESIDUE_DIR = 'crash-residue'
const EVENT_FIELDS =
  'actor,causationId,correlationId,eventHash,eventId,occurredAt,payload,previousHash,runId,schemaVersion,seq,type'

export class JournalError extends Error {
  constructor(message: string) {
    super(`journal: ${message}`)
    this.name = 'JournalError'
  }
}

/** Envelope persisted per event — exactly these 12 fields, no extensions. */
export interface JournalEvent {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  runId: string
  seq: number
  eventId: string
  occurredAt: string
  type: string
  causationId: string | null
  correlationId: string | null
  actor: string
  payload: Record<string, unknown>
  previousHash: string
  eventHash: string
}

/** The commit point — exactly these 5 fields. */
export interface JournalHead {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  runId: string
  seq: number
  eventHash: string
  segment: string
}

/** Durable segment summary written when a segment is closed by rotation. */
export interface SegmentSummary {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION
  runId: string
  segment: string
  firstSeq: number
  lastSeq: number
  records: number
  sizeBytes: number
  merkleRoot: string
}

export interface JournalConfig {
  runId: string
  /** Positive safe integer; measured on persisted bytes (record + newline). */
  segmentMaxBytes: number
}

export interface EventDraft {
  type: string
  actor: string
  payload: Record<string, unknown>
  /** Audit-only wall clock from the caller (never read here). */
  occurredAt: string
  causationId?: string | null
  correlationId?: string | null
  /** Omit to derive one from crypto randomness. */
  eventId?: string
}

export interface ResidueReport {
  /** Staging files present without a matching commit (`HEAD.tmp`, summaries). */
  strayFiles: string[]
  /** Bytes after the committed tail inside the active segment. */
  trailingBytesInActive: number
  /** Canonical segments numbered beyond the HEAD segment. */
  laterSegments: string[]
}

export function journalDirOf(runDir: string): string {
  return join(runDir, 'journal')
}

export function segmentName(index: number): string {
  return `events-${String(index).padStart(6, '0')}.jsonl`
}

function segmentIndexOf(name: string): number {
  return Number(name.slice('events-'.length, -'.jsonl'.length))
}

/** `sha256:`-prefixed hash over the canonical envelope minus `eventHash`. */
export function hashEvent(envelope: Omit<JournalEvent, 'eventHash'>): string {
  return `sha256:${sha256Hex(canonicalJson(envelope))}`
}

/** Parse a persisted canonical record: single trailing newline tolerated. */
function parseCanonicalRecord(text: string, what: string): unknown {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  try {
    return parseCanonicalJson(body)
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new JournalError(`${what} is not canonical: ${error.message}`)
    }
    throw error
  }
}

export function validateHead(raw: unknown, config: JournalConfig): asserts raw is JournalHead {
  const record = raw as Record<string, unknown> | null
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new JournalError('HEAD is not an object')
  }
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'eventHash,runId,schemaVersion,segment,seq') {
    throw new JournalError(`HEAD has wrong field set: ${keys}`)
  }
  if (record['schemaVersion'] !== JOURNAL_SCHEMA_VERSION) {
    throw new JournalError('HEAD schemaVersion must be 1')
  }
  if (record['runId'] !== config.runId) throw new JournalError('HEAD runId mismatch')
  const seq = record['seq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw new JournalError('HEAD seq must be a positive safe integer')
  }
  if (typeof record['eventHash'] !== 'string' || !HASH_VALUE.test(record['eventHash'])) {
    throw new JournalError('HEAD eventHash must be sha256:<64-hex>')
  }
  if (typeof record['segment'] !== 'string' || !SEGMENT_NAME.test(record['segment'])) {
    throw new JournalError('HEAD segment must be a canonical segment name')
  }
}

function validateDraft(draft: EventDraft): void {
  if (draft.type === '') throw new JournalError('event type must be non-empty')
  if (draft.actor === '') throw new JournalError('event actor must be non-empty')
  if (!isValidCanonicalTimestamp(draft.occurredAt)) {
    throw new JournalError(`occurredAt ${draft.occurredAt} is not a canonical ISO timestamp`)
  }
  for (const field of ['causationId', 'correlationId'] as const) {
    const value = draft[field] ?? null
    if (value !== null && value === '') {
      throw new JournalError(`${field} must be null or non-empty`)
    }
  }
  // Payload must itself be canonical-representable (fails closed on floats).
  canonicalJson(draft.payload)
}

/** Validate one parsed envelope against the chain (fail closed). */
function validateEvent(
  raw: unknown,
  config: JournalConfig,
  expected: { seq: number; previousHash: string },
): JournalEvent {
  const record = raw as Record<string, unknown> | null
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new JournalError(`event seq ${expected.seq} is not an object`)
  }
  const keys = Object.keys(record).sort().join(',')
  if (keys !== EVENT_FIELDS) {
    throw new JournalError(`event seq ${expected.seq} has wrong field set: ${keys}`)
  }
  if (record['schemaVersion'] !== JOURNAL_SCHEMA_VERSION) {
    throw new JournalError(`event seq ${expected.seq} schemaVersion must be 1`)
  }
  if (record['runId'] !== config.runId) {
    throw new JournalError(`event seq ${expected.seq} runId mismatch`)
  }
  if (record['seq'] !== expected.seq) {
    throw new JournalError(`event seq is ${String(record['seq'])}, expected ${expected.seq}`)
  }
  for (const field of ['eventId', 'type', 'actor'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      throw new JournalError(`event seq ${expected.seq} ${field} must be a non-empty string`)
    }
  }
  if (
    typeof record['occurredAt'] !== 'string' ||
    !isValidCanonicalTimestamp(record['occurredAt'])
  ) {
    throw new JournalError(`event seq ${expected.seq} occurredAt is not canonical`)
  }
  for (const field of ['causationId', 'correlationId'] as const) {
    const value = record[field]
    if (value !== null && (typeof value !== 'string' || value === '')) {
      throw new JournalError(`event seq ${expected.seq} ${field} must be null or non-empty`)
    }
  }
  const payload = record['payload']
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new JournalError(`event seq ${expected.seq} payload must be an object`)
  }
  if (record['previousHash'] !== expected.previousHash) {
    throw new JournalError(`event seq ${expected.seq} previousHash does not chain`)
  }
  if (typeof record['eventHash'] !== 'string' || !HASH_VALUE.test(record['eventHash'])) {
    throw new JournalError(`event seq ${expected.seq} eventHash must be sha256:<64-hex>`)
  }
  const event = raw as JournalEvent
  const { eventHash: _eventHash, ...envelope } = event
  const recomputed = hashEvent(envelope)
  if (recomputed !== event.eventHash) {
    throw new JournalError(
      `event seq ${expected.seq} eventHash ${event.eventHash} != recomputed ${recomputed}`,
    )
  }
  return event
}

interface ParsedSegment {
  events: JournalEvent[]
  /** Bytes of the complete records (each ending in `\n`). */
  committedBytes: number
  /** Uncommitted bytes after the committed tail (residue). */
  residue: Buffer
}

function parseSegment(
  bytes: Buffer,
  segment: string,
  config: JournalConfig,
  start: { seq: number; previousHash: string },
  stopAt: { seq: number; eventHash: string } | null,
): ParsedSegment {
  const events: JournalEvent[] = []
  let cursor = 0
  let seq = start.seq
  let previousHash = start.previousHash
  let torn = false
  while (cursor < bytes.length) {
    const newline = bytes.indexOf(0x0a, cursor)
    if (newline === -1) {
      // Torn write: no terminator after this point.
      torn = true
      break
    }
    if (newline === cursor) {
      throw new JournalError(`${segment}: empty line inside committed prefix`)
    }
    const raw = parseCanonicalRecord(
      bytes.subarray(cursor, newline).toString('utf8'),
      `${segment} record`,
    )
    const event = validateEvent(raw, config, { seq, previousHash })
    events.push(event)
    cursor = newline + 1
    seq += 1
    previousHash = event.eventHash
    if (stopAt !== null && event.seq === stopAt.seq) {
      if (event.eventHash !== stopAt.eventHash) {
        throw new JournalError(
          `${segment}: record ${event.seq} hash ${event.eventHash} != HEAD ${stopAt.eventHash}`,
        )
      }
      return { events, committedBytes: cursor, residue: bytes.subarray(cursor) }
    }
  }
  if (stopAt !== null) {
    throw new JournalError(
      `${segment}: committed tail seq ${stopAt.seq} not found before end of segment`,
    )
  }
  return {
    events,
    committedBytes: cursor,
    residue: torn ? bytes.subarray(cursor) : Buffer.alloc(0),
  }
}

function merkleRootOf(events: JournalEvent[]): string {
  return `sha256:${sha256Hex(events.map((event) => event.eventHash).join('\n'))}`
}

function summaryFor(
  segment: string,
  events: JournalEvent[],
  committedBytes: number,
  runId: string,
): SegmentSummary {
  const first = events[0]
  const last = events[events.length - 1]
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId,
    segment,
    firstSeq: first?.seq ?? 0,
    lastSeq: last?.seq ?? 0,
    records: events.length,
    sizeBytes: committedBytes,
    merkleRoot: merkleRootOf(events),
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readRegularFile(path: string, what: string): Promise<Buffer> {
  const stats = await lstat(path).catch(() => undefined)
  if (stats === undefined) throw new JournalError(`${what} is missing`)
  if (!stats.isFile()) throw new JournalError(`${what} is not a regular file`)
  return readFile(path)
}

interface JournalLayout {
  dir: string
  residueDir: string
  head: JournalHead | null
  /** Parse results for every segment up to and including the HEAD segment. */
  parsed: Map<string, ParsedSegment>
  residue: ResidueReport
}

function noResidue(): ResidueReport {
  return { strayFiles: [], trailingBytesInActive: 0, laterSegments: [] }
}

/** Scan + validate the journal directory. Never mutates anything. */
async function scanJournal(dir: string, config: JournalConfig): Promise<JournalLayout> {
  const residueDir = join(dir, CRASH_RESIDUE_DIR)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
  if (entries === null) {
    return { dir, residueDir, head: null, parsed: new Map(), residue: noResidue() }
  }
  const segmentIndexes: number[] = []
  const strayFiles: string[] = []
  let headText: string | null = null
  for (const entry of entries) {
    if (entry.name === CRASH_RESIDUE_DIR) continue
    if (entry.name === 'HEAD') {
      headText = (await readRegularFile(join(dir, 'HEAD'), 'HEAD')).toString('utf8')
      continue
    }
    if (entry.name === 'HEAD.tmp') {
      strayFiles.push(entry.name)
      continue
    }
    if (entry.name.endsWith(`${SUMMARY_SUFFIX}${STAGING_SUFFIX}`)) {
      strayFiles.push(entry.name)
      continue
    }
    const isSummary = entry.name.endsWith(SUMMARY_SUFFIX)
    const base = isSummary ? entry.name.slice(0, -SUMMARY_SUFFIX.length) : entry.name
    if (!SEGMENT_NAME.test(base)) {
      throw new JournalError(`illegal file in journal directory: ${entry.name}`)
    }
    if (isSummary) continue
    if (!entry.isFile()) throw new JournalError(`segment ${entry.name} is not a regular file`)
    segmentIndexes.push(segmentIndexOf(base))
  }
  segmentIndexes.sort((a, b) => a - b)
  const firstIndex = segmentIndexes[0]
  if (firstIndex !== undefined && firstIndex !== 1) {
    throw new JournalError(`segment numbering must start at 1, saw ${firstIndex}`)
  }
  for (let i = 1; i < segmentIndexes.length; i += 1) {
    if ((segmentIndexes[i] ?? 0) !== (segmentIndexes[i - 1] ?? 0) + 1) {
      throw new JournalError(`segment numbering gap at index ${segmentIndexes[i]}`)
    }
  }
  if (headText === null) {
    // No HEAD: every segment and staging file is uncommitted residue.
    return {
      dir,
      residueDir,
      head: null,
      parsed: new Map(),
      residue: {
        strayFiles,
        trailingBytesInActive: 0,
        laterSegments: segmentIndexes.map((index) => segmentName(index)),
      },
    }
  }
  const headRaw = parseCanonicalRecord(headText, 'HEAD')
  validateHead(headRaw, config)
  const head: JournalHead = headRaw
  const headIndex = segmentIndexOf(head.segment)
  const activeIndex = segmentIndexes[headIndex - 1]
  if (activeIndex === undefined || activeIndex !== headIndex) {
    throw new JournalError(`HEAD segment ${head.segment} is missing`)
  }
  const parsed = new Map<string, ParsedSegment>()
  let seq = 1
  let previousHash = GENESIS_PREVIOUS_HASH
  for (let index = 1; index < headIndex; index += 1) {
    const name = segmentName(index)
    const bytes = await readRegularFile(join(dir, name), `closed segment ${name}`)
    if (bytes.length === 0) throw new JournalError(`closed segment ${name} is empty`)
    const result = parseSegment(bytes, name, config, { seq, previousHash }, null)
    if (result.residue.length !== 0) {
      throw new JournalError(`closed segment ${name} has a torn final record`)
    }
    await expectSummary(dir, name, config, result)
    parsed.set(name, result)
    const last = result.events[result.events.length - 1]
    seq = (last?.seq ?? seq - 1) + 1
    previousHash = last?.eventHash ?? previousHash
  }
  const activeBytes = await readRegularFile(
    join(dir, head.segment),
    `active segment ${head.segment}`,
  )
  if (activeBytes.length === 0) {
    throw new JournalError(`active segment ${head.segment} is empty`)
  }
  const activeResult = parseSegment(activeBytes, head.segment, config, { seq, previousHash }, head)
  parsed.set(head.segment, activeResult)
  const activeSummaryPath = join(dir, `${head.segment}${SUMMARY_SUFFIX}`)
  if (await pathExists(activeSummaryPath)) {
    await expectSummary(dir, head.segment, config, activeResult)
  }
  return {
    dir,
    residueDir,
    head,
    parsed,
    residue: {
      strayFiles,
      trailingBytesInActive: activeResult.residue.length,
      laterSegments: segmentIndexes.slice(headIndex).map((index) => segmentName(index)),
    },
  }
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined
}

async function expectSummary(
  dir: string,
  name: string,
  config: JournalConfig,
  result: ParsedSegment,
): Promise<void> {
  const text = await readFile(join(dir, `${name}${SUMMARY_SUFFIX}`), 'utf8').catch(() => null)
  if (text === null) {
    throw new JournalError(`closed segment ${name} is missing its close summary`)
  }
  const record = parseCanonicalRecord(text, `summary for ${name}`) as Record<string, unknown>
  const keys = Object.keys(record).sort().join(',')
  if (keys !== 'firstSeq,lastSeq,merkleRoot,records,runId,schemaVersion,segment,sizeBytes') {
    throw new JournalError(`summary for ${name} has wrong field set: ${keys}`)
  }
  const expected = summaryFor(name, result.events, result.committedBytes, config.runId)
  if (canonicalJson(record) !== canonicalJson(expected)) {
    throw new JournalError(`summary for ${name} does not match segment content`)
  }
}

export interface ReadResult {
  events: JournalEvent[]
  head: JournalHead | null
  residue: ResidueReport
  config: JournalConfig
}

/** Read-only replay: validate everything, tolerate residue, mutate nothing. */
export async function readJournal(runDir: string, config: JournalConfig): Promise<ReadResult> {
  const layout = await scanJournal(journalDirOf(runDir), config)
  const events: JournalEvent[] = []
  if (layout.head !== null) {
    for (let index = 1; index <= segmentIndexOf(layout.head.segment); index += 1) {
      const parsed = layout.parsed.get(segmentName(index))
      if (parsed === undefined) break
      events.push(...parsed.events)
    }
  }
  return { events, head: layout.head, residue: layout.residue, config }
}

/**
 * Single-writer journal handle. Opening validates the whole committed prefix,
 * then quarantines any crash residue (before the next append, per spec). From
 * then on this process owns the only append path: rotate → append+fsync →
 * publish HEAD atomically.
 */
export class Journal {
  private readonly dir: string
  private readonly config: JournalConfig
  private head: JournalHead | null
  private lastSeq: number
  private lastHash: string
  private activeSegment: string
  private activeSize: number
  private activeEvents: JournalEvent[]
  private activeHandle: FileHandle | null = null
  private readonly scannedResidue: ResidueReport
  /** Serialize appends while allowing external effects to run concurrently. */
  private appendChain: Promise<void> = Promise.resolve()

  private constructor(config: JournalConfig, layout: JournalLayout, residueFound: ResidueReport) {
    this.config = config
    this.dir = layout.dir
    this.head = layout.head
    this.scannedResidue = residueFound
    this.lastSeq = layout.head?.seq ?? 0
    this.lastHash = layout.head?.eventHash ?? GENESIS_PREVIOUS_HASH
    this.activeSegment = layout.head?.segment ?? segmentName(1)
    const active = layout.parsed.get(this.activeSegment)
    this.activeEvents = [...(active?.events ?? [])]
    this.activeSize = active?.committedBytes ?? 0
  }

  static async open(runDir: string, config: JournalConfig): Promise<Journal> {
    if (config.runId === '') throw new JournalError('runId must be non-empty')
    if (
      typeof config.segmentMaxBytes !== 'number' ||
      !Number.isSafeInteger(config.segmentMaxBytes) ||
      config.segmentMaxBytes <= 0
    ) {
      throw new JournalError('segmentMaxBytes must be a positive safe integer')
    }
    const dir = journalDirOf(runDir)
    await mkdir(join(dir, CRASH_RESIDUE_DIR), { recursive: true })
    const layout = await scanJournal(dir, config)
    const residueFound = layout.residue
    await quarantineResidue(layout)
    return new Journal(config, layout, residueFound)
  }

  get currentHead(): JournalHead | null {
    return this.head
  }

  /** Residue found by the scan at open time (already quarantined). */
  get residue(): ResidueReport {
    return this.scannedResidue
  }

  get activeSegmentName(): string {
    return this.activeSegment
  }

  async append(draft: EventDraft): Promise<JournalEvent> {
    const operation = this.appendChain.then(() => this.appendExclusive(draft))
    this.appendChain = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async appendExclusive(draft: EventDraft): Promise<JournalEvent> {
    validateDraft(draft)
    const envelope: Omit<JournalEvent, 'eventHash'> = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: this.config.runId,
      seq: this.lastSeq + 1,
      eventId: draft.eventId ?? sha256Hex(randomBytes(32)),
      occurredAt: draft.occurredAt,
      type: draft.type,
      causationId: draft.causationId ?? null,
      correlationId: draft.correlationId ?? null,
      actor: draft.actor,
      payload: draft.payload,
      previousHash: this.lastHash,
    }
    const event: JournalEvent = { ...envelope, eventHash: hashEvent(envelope) }
    const line = Buffer.from(`${canonicalJson(event)}\n`, 'utf8')
    if (this.activeSize > 0 && this.activeSize + line.length > this.config.segmentMaxBytes) {
      await this.rotate()
    }
    const handle = await this.ensureHandle()
    const written = await handle.write(line, 0, line.length, this.activeSize)
    if (written.bytesWritten !== line.length) {
      throw new JournalError(`short write: ${written.bytesWritten} of ${line.length} bytes`)
    }
    await handle.sync()
    this.activeSize += line.length
    this.activeEvents.push(event)
    await this.publishHead(event)
    return event
  }

  async close(): Promise<void> {
    if (this.activeHandle !== null) {
      await this.activeHandle.close()
      this.activeHandle = null
    }
  }

  private async rotate(): Promise<void> {
    const next = segmentName(segmentIndexOf(this.activeSegment) + 1)
    const nextPath = join(this.dir, next)
    if (await pathExists(nextPath)) {
      throw new JournalError(`rotation target ${next} already exists`)
    }
    // Close the current segment: durable size/Merkle summary first…
    await this.writeActiveSummary()
    // …then exclusive-create the successor, fsync its directory entry, and
    // keep the handle so the appending record goes to exactly this file.
    if (this.activeHandle !== null) {
      await this.activeHandle.close()
      this.activeHandle = null
    }
    this.activeHandle = await open(nextPath, 'wx')
    await fsyncDir(this.dir)
    this.activeSegment = next
    this.activeEvents = []
    this.activeSize = 0
  }

  private async writeActiveSummary(): Promise<void> {
    const summary = summaryFor(
      this.activeSegment,
      this.activeEvents,
      this.activeSize,
      this.config.runId,
    )
    const tmp = join(this.dir, `${this.activeSegment}${SUMMARY_SUFFIX}${STAGING_SUFFIX}`)
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(`${canonicalJson(summary)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, join(this.dir, `${this.activeSegment}${SUMMARY_SUFFIX}`))
    await fsyncDir(this.dir)
  }

  private async ensureHandle(): Promise<FileHandle> {
    if (this.activeHandle !== null) return this.activeHandle
    const path = join(this.dir, this.activeSegment)
    if (this.activeSize === 0) {
      if (await pathExists(path)) {
        throw new JournalError(`active segment ${this.activeSegment} exists but is uncommitted`)
      }
      const handle = await open(path, 'wx')
      await fsyncDir(this.dir)
      this.activeHandle = handle
      return handle
    }
    // Residue beyond the committed prefix was truncated during quarantine.
    await truncate(path, this.activeSize)
    this.activeHandle = await open(path, 'r+')
    return this.activeHandle
  }

  private async publishHead(event: JournalEvent): Promise<void> {
    const head: JournalHead = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: this.config.runId,
      seq: event.seq,
      eventHash: event.eventHash,
      segment: this.activeSegment,
    }
    const tmp = join(this.dir, 'HEAD.tmp')
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(`${canonicalJson(head)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, join(this.dir, 'HEAD'))
    await fsyncDir(this.dir)
    this.head = head
    this.lastSeq = event.seq
    this.lastHash = event.eventHash
  }
}

async function quarantineResidue(layout: JournalLayout): Promise<void> {
  const { strayFiles, trailingBytesInActive, laterSegments } = layout.residue
  if (strayFiles.length === 0 && trailingBytesInActive === 0 && laterSegments.length === 0) {
    return
  }
  await mkdir(layout.residueDir, { recursive: true })
  const park = async (name: string, bytes: Buffer): Promise<void> => {
    if (bytes.length === 0) {
      await unlink(join(layout.dir, name)).catch(() => undefined)
      return
    }
    const target = join(layout.residueDir, `${sha256Hex(bytes)}-${name}`)
    const handle = await open(target, 'wx').catch(() => undefined)
    if (handle !== undefined) {
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    await unlink(join(layout.dir, name)).catch(() => undefined)
  }
  for (const name of strayFiles) {
    await park(name, await readFile(join(layout.dir, name)).catch(() => Buffer.alloc(0)))
  }
  for (const name of laterSegments) {
    await park(name, await readFile(join(layout.dir, name)))
    // Later segments' summaries are residue too — never validated forward.
    await park(
      `${name}${SUMMARY_SUFFIX}`,
      await readFile(join(layout.dir, `${name}${SUMMARY_SUFFIX}`)).catch(() => Buffer.alloc(0)),
    )
  }
  if (layout.head !== null && trailingBytesInActive > 0) {
    const parsed = layout.parsed.get(layout.head.segment)
    if (parsed !== undefined) {
      await park(`${layout.head.segment}.suffix`, parsed.residue)
      await truncate(join(layout.dir, layout.head.segment), parsed.committedBytes)
      await fsyncDir(layout.dir)
    }
  }
  await fsyncDir(layout.residueDir)
  layout.residue = noResidue()
}
