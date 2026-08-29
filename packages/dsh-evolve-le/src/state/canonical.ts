/**
 * Canonical JSON for durable state (specs/06 §4): the project-fixed
 * equivalent of RFC 8785/JCS that every journal event, budget entry, state
 * snapshot, and state hash is serialized and validated against. The rule set
 * is deliberately narrower than JCS so it can be enforced at both the append
 * and the replay boundary:
 *
 * - objects: keys sorted by UTF-16 code unit order, no duplicate keys;
 * - numbers: safe integers only, serialized as plain decimal — floats,
 *   exponents, `-0`, and non-finite values are protocol violations (all
 *   durable quantities are integral by construction: micros, tokens, trials,
 *   bytes, milliseconds);
 * - strings/booleans/null: minimal JSON escaping exactly as `JSON.stringify`;
 * - `undefined`, functions, symbols, and bigints never appear.
 *
 * A raw record is canonical iff serializing the parsed value reproduces the
 * original bytes exactly; {@link parseCanonicalJson} enforces that plus
 * duplicate-key and integer-only parsing, so non-canonical persistence
 * (re-ordered keys, `1.0`, `1e2`, trailing digits) fails closed instead of
 * hashing to something the writer would not have produced.
 * @module @dsh-evolve-le/core/state/canonical
 */

import { createHash } from 'node:crypto'

export const CANONICAL_JSON_ID = 'dsh-evolve-le/canonical-json/v1'

/** Error type for every canonicalization/parse violation (fail closed). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(`canonical-json: ${message}`)
    this.name = 'CanonicalJsonError'
  }
}

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER

function serialize(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null')
    return
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return
    case 'number':
      if (!Number.isInteger(value) || value < -SAFE_INTEGER || value > SAFE_INTEGER) {
        throw new CanonicalJsonError(`number ${String(value)} is not a safe integer`)
      }
      if (Object.is(value, -0)) {
        throw new CanonicalJsonError('-0 is not canonical')
      }
      out.push(String(value))
      return
    case 'string':
      out.push(JSON.stringify(value))
      return
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[')
        for (let i = 0; i < value.length; i += 1) {
          if (i > 0) out.push(',')
          serialize(value[i], out)
        }
        out.push(']')
        return
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
      const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      out.push('{')
      for (let i = 0; i < sorted.length; i += 1) {
        const key = sorted[i] ?? ''
        if (i > 0) out.push(',')
        out.push(`${JSON.stringify(key)}:`)
        serialize(record[key], out)
      }
      out.push('}')
      return
    }
    default:
      throw new CanonicalJsonError(`value of type ${typeof value} is not representable`)
  }
}

/** Serialize a value to the canonical form (throws on violation). */
export function canonicalJson(value: unknown): string {
  const out: string[] = []
  serialize(value, out)
  return out.join('')
}

/** sha256 over raw bytes/utf8 text — the single hash primitive for state. */
export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

/** sha256 over the canonical serialization of `value`. */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Canonical ISO timestamp (specs/06 §4): UTC, always millisecond precision —
 * exactly `Date.toISOString()` output. Wall clock is audit-only; `seq`
 * decides order.
 */
export function isValidCanonicalTimestamp(value: string): boolean {
  if (!CANONICAL_TIMESTAMP.test(value)) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

const STRING_TOKEN = /^"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)/

class Scanner {
  private pos = 0
  public constructor(private readonly text: string) {}
  public atEnd(): boolean {
    return this.pos >= this.text.length
  }
  public peek(): string {
    return this.text[this.pos] ?? ''
  }
  public consume(char: string): void {
    if (this.text[this.pos] !== char) {
      throw new CanonicalJsonError(`expected ${JSON.stringify(char)} at offset ${this.pos}`)
    }
    this.pos += 1
  }
  public tryConsume(char: string): boolean {
    if (this.text[this.pos] === char) {
      this.pos += 1
      return true
    }
    return false
  }
  public readLiteral(literal: string): void {
    if (!this.text.startsWith(literal, this.pos)) {
      throw new CanonicalJsonError(`invalid literal at offset ${this.pos}`)
    }
    this.pos += literal.length
  }
  public readString(): string {
    const rest = this.text.slice(this.pos)
    const match = STRING_TOKEN.exec(rest)
    if (match === null) {
      throw new CanonicalJsonError(`unterminated string at offset ${this.pos}`)
    }
    const token = match[0] ?? ''
    this.pos += token.length
    return JSON.parse(token) as string
  }
  public readNumber(): number {
    const rest = this.text.slice(this.pos)
    const match = INTEGER_TOKEN.exec(rest)
    if (match === null) {
      throw new CanonicalJsonError(`invalid number at offset ${this.pos}`)
    }
    const token = match[0] ?? ''
    const tail = rest.slice(token.length).at(0) ?? ''
    if (tail === '.' || tail === 'e' || tail === 'E' || (tail >= '0' && tail <= '9')) {
      throw new CanonicalJsonError(
        `non-canonical number ${rest.split(/[},\]\s]/)[0]} at offset ${this.pos}`,
      )
    }
    const value = Number(token)
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalJsonError(`number ${token} is not a safe integer`)
    }
    if (token === '-0') throw new CanonicalJsonError('-0 is not canonical')
    this.pos += token.length
    return value
  }
}

function parseValue(scanner: Scanner): unknown {
  const char = scanner.peek()
  if (char === '{') return parseObject(scanner)
  if (char === '[') return parseArray(scanner)
  if (char === '"') return scanner.readString()
  if (char === 't') {
    scanner.readLiteral('true')
    return true
  }
  if (char === 'f') {
    scanner.readLiteral('false')
    return false
  }
  if (char === 'n') {
    scanner.readLiteral('null')
    return null
  }
  if (char === '-' || (char >= '0' && char <= '9')) return scanner.readNumber()
  throw new CanonicalJsonError(`unexpected character ${JSON.stringify(char)}`)
}

function parseObject(scanner: Scanner): Record<string, unknown> {
  scanner.consume('{')
  const value: Record<string, unknown> = {}
  if (scanner.tryConsume('}')) return value
  for (;;) {
    const key = scanner.readString()
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw new CanonicalJsonError(`duplicate key ${JSON.stringify(key)}`)
    }
    scanner.consume(':')
    value[key] = parseValue(scanner)
    if (scanner.tryConsume(',')) continue
    scanner.consume('}')
    return value
  }
}

function parseArray(scanner: Scanner): unknown[] {
  scanner.consume('[')
  const value: unknown[] = []
  if (scanner.tryConsume(']')) return value
  for (;;) {
    value.push(parseValue(scanner))
    if (scanner.tryConsume(',')) continue
    scanner.consume(']')
    return value
  }
}

/**
 * Parse `text` under the canonical rules: strict JSON syntax plus
 * integer-only numbers, duplicate-key rejection, no trailing content, and
 * byte-exact re-serialization. Anything else is a {@link CanonicalJsonError}.
 */
export function parseCanonicalJson(text: string): unknown {
  const scanner = new Scanner(text)
  const value = parseValue(scanner)
  if (!scanner.atEnd()) {
    throw new CanonicalJsonError('trailing content after value')
  }
  if (canonicalJson(value) !== text) {
    throw new CanonicalJsonError('record is not in canonical form')
  }
  return value
}
