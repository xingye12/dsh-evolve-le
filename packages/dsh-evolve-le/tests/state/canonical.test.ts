/**
 * Canonical-JSON contract tests (Gate 3, specs/06 §4): the project-fixed
 * serializer and strict parser that every journal event, budget entry,
 * snapshot, and state hash is built on. These pin the fail-closed rules —
 * safe integers only, sorted keys, no -0, byte-exact re-serialization —
 * because the journal's hash chain is only as strong as the byte stability
 * of this encoding.
 */
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_JSON_ID,
  CanonicalJsonError,
  canonicalHash,
  canonicalJson,
  isValidCanonicalTimestamp,
  parseCanonicalJson,
  sha256Hex,
} from '../../src/state/canonical.js'

describe('canonicalJson serialization', () => {
  it('sorts object keys by UTF-16 code unit order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ foo: { z: 1, a: 2 } })).toBe('{"foo":{"a":2,"z":1}}')
  })

  it('preserves array order (order is semantic)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('serializes primitives without escapes beyond JSON.stringify', () => {
    expect(canonicalJson('a"b\\c\nde')).toBe(JSON.stringify('a"b\\c\nde'))
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(false)).toBe('false')
  })

  it('rejects floats, -0, unsafe integers, and non-JSON types', () => {
    expect(() => canonicalJson({ x: 1.5 })).toThrow(CanonicalJsonError)
    // 1e2 is just 100 to the serializer — exponent *syntax* is a parser
    // concern and is rejected by parseCanonicalJson below.
    expect(canonicalJson({ x: 1e2 })).toBe('{"x":100}')
    expect(() => canonicalJson({ x: -0 })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ x: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ x: undefined })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ x: () => 1 })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ x: 10n })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ x: Symbol('no') })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(CanonicalJsonError)
  })

  it('round-trips any canonical-safe value through the strict parser', () => {
    const value = {
      a: [1, -2, 0],
      nested: { ün: 'ok', z: null, empty: {}, arr: [] },
      big: Number.MAX_SAFE_INTEGER,
      text: 'esc"\\\n\t',
    }
    const text = canonicalJson(value)
    expect(parseCanonicalJson(text)).toEqual(value)
  })
})

describe('parseCanonicalJson (strict)', () => {
  it('rejects non-canonical number forms', () => {
    expect(() => parseCanonicalJson('{"a":1.0}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('{"a":1e2}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('{"a":-0}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('{"a":01}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('{"a":9007199254740992}')).toThrow(CanonicalJsonError)
  })

  it('rejects duplicate keys', () => {
    expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrow(/duplicate/)
  })

  it('rejects any whitespace, since canonical form has none', () => {
    expect(() => parseCanonicalJson('{"a": 1}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson(' {"a":1}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('{"a":1}\n')).toThrow(CanonicalJsonError)
  })

  it('rejects unsorted keys (record not in canonical form)', () => {
    expect(() => parseCanonicalJson('{"b":1,"a":2}')).toThrow(/not in canonical form/)
  })

  it('rejects trailing content and literals that only prefix-match', () => {
    expect(() => parseCanonicalJson('{"a":1}x')).toThrow(/trailing/)
    expect(() => parseCanonicalJson('truex')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('null')).not.toThrow()
  })

  it('rejects invalid escapes and control characters in strings', () => {
    expect(() => parseCanonicalJson('{"a":"\\x"}')).toThrow(CanonicalJsonError)
    expect(() => parseCanonicalJson('{"a":"line\nbreak"}')).toThrow(CanonicalJsonError)
  })
})

describe('hashes and timestamps', () => {
  it('golden: sha256 and canonical hash are stable', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(canonicalHash({ b: 2, a: 1 })).toBe(sha256Hex('{"a":1,"b":2}'))
  })

  it('accepts exactly millisecond-precision UTC timestamps', () => {
    expect(isValidCanonicalTimestamp('2026-08-14T00:00:00.000Z')).toBe(true)
    expect(isValidCanonicalTimestamp('2026-08-14T00:00:00Z')).toBe(false)
    expect(isValidCanonicalTimestamp('2026-08-14T00:00:00.000+00:00')).toBe(false)
    expect(isValidCanonicalTimestamp('2026-13-14T00:00:00.000Z')).toBe(false)
  })

  it('pins the algorithm identity', () => {
    expect(CANONICAL_JSON_ID).toBe('dsh-evolve-le/canonical-json/v1')
  })
})
