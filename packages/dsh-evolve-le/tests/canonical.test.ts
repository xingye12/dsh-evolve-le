/**
 * Canonical source tar and candidate identity contract tests (Gate 1,
 * specs/02 §1). The canonical tar is the candidate's only identity basis:
 * same source → same bytes → same sha256 → same `c_<base32>` id, and the
 * adversarial fixtures (symlink, traversal, case/Unicode collisions, caps)
 * must all fail closed. The ustar structure itself is verified by parsing the
 * produced archive back, not by trusting the writer.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CANONICAL_SOURCE_CAPS,
  base32Lower,
  buildCanonicalTar,
  candidateIdFromDigest,
  captureCanonicalSource,
} from '../src/candidate/canonical.js'
import { diffCanonicalSources } from '../src/candidate/diff.js'

let work: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'dsh-evolve-canonical-'))
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

async function dir(name: string): Promise<string> {
  const path = join(work, name)
  await mkdir(path, { recursive: true })
  return path
}

/** Parse a ustar stream into headers + concatenated file bytes per entry. */
interface ParsedEntry {
  name: string
  mode: string
  uid: string
  gid: string
  mtime: string
  typeflag: string
  size: number
  data: Buffer
}

function parseUstar(tar: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const string = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/, '')
    const octal = (start: number, length: number): string =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/[\0 ].*$/, '')
    const prefix = string(345, 155)
    const name = string(0, 100)
    const sizeField = header.subarray(124, 136).toString('utf8')
    const size = parseInt(sizeField.replace(/\0.*$/, '').trim() || '0', 8)
    if (header.subarray(257, 263).toString('utf8') !== 'ustar\0') {
      throw new Error('missing ustar magic')
    }
    const declaredChecksum = parseInt(octal(148, 8), 8)
    const sumBytes = header.subarray(0, 148)
    const sumRest = header.subarray(156, 512)
    const actual =
      sumBytes.reduce((acc, byte) => acc + byte, 0) +
      8 * 32 +
      sumRest.reduce((acc, byte) => acc + byte, 0)
    if (declaredChecksum !== actual) throw new Error(`bad checksum for ${name}`)
    entries.push({
      name: prefix ? `${prefix}/${name}` : name,
      mode: parseInt(octal(100, 8), 8).toString(8),
      uid: parseInt(octal(108, 8), 8).toString(8),
      gid: parseInt(octal(116, 8), 8).toString(8),
      mtime: parseInt(octal(136, 12), 8).toString(8),
      typeflag: String.fromCharCode(header[156]!),
      size,
      data: tar.subarray(offset + 512, offset + 512 + size),
    })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const tail = tar.subarray(offset)
  if (tail.length !== 1024 || !tail.every((byte) => byte === 0)) {
    throw new Error('archive must end with exactly two zero blocks')
  }
  return entries
}

describe('base32 identity', () => {
  it('matches the RFC 4648 lowercase vector over sha256("")', () => {
    const digest = Buffer.from(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'hex',
    )
    expect(base32Lower(digest, 26)).toBe('4oymiquy7qobjgx36tejs35zeq')
  })

  it('produces candidate ids in the c_<26 chars from [a-z2-7]> shape', () => {
    const id = candidateIdFromDigest('a'.repeat(64))
    expect(id).toMatch(/^c_[a-z2-7]{26}$/)
  })
})

describe('canonical capture + tar', () => {
  it('is byte-identical across two captures regardless of creation order', async () => {
    const root = await dir('determinism')
    // Deliberately create in non-sorted order.
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"a":1}')
    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1\n')
    await writeFile(join(root, 'README.md'), '# t\n')
    const first = await captureCanonicalSource(root)
    const second = await captureCanonicalSource(root)
    expect(first.tar.equals(second.tar)).toBe(true)
    expect(first.sha256).toBe(second.sha256)
    expect(first.bytes).toBe(first.files.reduce((acc, f) => acc + f.content.length, 0))
  })

  it('emits sorted deterministic ustar headers (fixed uid/gid/mtime, exec-bit mode)', async () => {
    const root = await dir('ustar')
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\n')
    await chmod(join(root, 'run.sh'), 0o755)
    await writeFile(join(root, 'plain.txt'), 'data')
    const source = await captureCanonicalSource(root)
    const entries = parseUstar(source.tar)
    expect(entries.map((entry) => entry.name)).toEqual(['plain.txt', 'run.sh'])
    for (const entry of entries) {
      expect(entry.uid).toBe('0')
      expect(entry.gid).toBe('0')
      expect(entry.mtime).toBe('0')
      expect(entry.typeflag).toBe('0')
    }
    expect(entries[0]?.mode).toBe('644')
    expect(entries[1]?.mode).toBe('755')
    expect(entries[0]?.data.toString('utf8')).toBe('data')
  })

  it('rejects a symlink anywhere in the tree', async () => {
    const root = await dir('symlink')
    await writeFile(join(root, 'a.txt'), 'a')
    await symlink('a.txt', join(root, 'b.txt'))
    await expect(captureCanonicalSource(root)).rejects.toThrow(/symbolic link/)
  })

  it('rejects case-fold collisions', async () => {
    const root = await dir('case')
    await writeFile(join(root, 'A.txt'), '1')
    await writeFile(join(root, 'a.txt'), '2')
    await expect(captureCanonicalSource(root)).rejects.toThrow(/normalization/)
  })

  it('rejects Unicode normalization collisions', async () => {
    const root = await dir('unicode')
    await writeFile(join(root, 'café.txt'), 'nfc')
    await writeFile(join(root, 'café.txt'), 'nfd')
    await expect(captureCanonicalSource(root)).rejects.toThrow(/normalization/)
  })

  it('rejects forbidden components (node_modules, .git, build output)', async () => {
    const root = await dir('forbidden')
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'x', 'y.js'), 'y')
    await expect(captureCanonicalSource(root)).rejects.toThrow(/node_modules/)
  })

  it('enforces file-count and byte caps', async () => {
    const tooMany = await dir('many')
    for (let i = 0; i < CANONICAL_SOURCE_CAPS.maxFiles + 1; i += 1) {
      await writeFile(join(tooMany, `f${String(i).padStart(3, '0')}.txt`), 'x')
    }
    await expect(captureCanonicalSource(tooMany)).rejects.toThrow(/file count/)

    const tooBig = await dir('big')
    await writeFile(join(tooBig, 'big.bin'), Buffer.alloc(CANONICAL_SOURCE_CAPS.maxBytes + 1, 1))
    await expect(captureCanonicalSource(tooBig)).rejects.toThrow(/bytes/)
  })

  it('builds the same tar from an explicit file list (builder staging path)', async () => {
    const root = await dir('staged')
    await writeFile(join(root, 'x.txt'), 'x')
    await writeFile(join(root, 'y.txt'), 'y')
    const captured = await captureCanonicalSource(root)
    const rebuilt = buildCanonicalTar(captured.files)
    expect(rebuilt.equals(captured.tar)).toBe(true)
  })
})

describe('canonical diff', () => {
  it('reports zeros for identical sources', async () => {
    const root = await dir('diff-same')
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    const source = await captureCanonicalSource(root)
    const diff = diffCanonicalSources(source, source)
    expect(diff.filesChanged).toBe(0)
    expect(diff.linesAdded).toBe(0)
    expect(diff.linesRemoved).toBe(0)
    expect(diff.parentDigest).toBe(`sha256:${source.sha256}`)
  })

  it('counts added, removed and modified files deterministically', async () => {
    const parentRoot = await dir('diff-parent')
    await writeFile(join(parentRoot, 'keep.txt'), 'same\n')
    await writeFile(join(parentRoot, 'edit.txt'), 'a\nb\nc\n')
    await writeFile(join(parentRoot, 'gone.txt'), 'gone\n')
    const childRoot = await dir('diff-child')
    await writeFile(join(childRoot, 'keep.txt'), 'same\n')
    await writeFile(join(childRoot, 'edit.txt'), 'a\nX\nc\nd\n')
    await writeFile(join(childRoot, 'new.txt'), 'new\n')
    const parent = await captureCanonicalSource(parentRoot)
    const child = await captureCanonicalSource(childRoot)
    const diff = diffCanonicalSources(parent, child)
    expect(diff.filesChanged).toBe(3)
    expect(diff.linesAdded).toBe(3) // X, d, new
    expect(diff.linesRemoved).toBe(2) // b, gone
    expect(diff.differingFiles.map((file) => file.path).sort()).toEqual([
      'edit.txt',
      'gone.txt',
      'new.txt',
    ])
    // Stable across recomputation.
    expect(diffCanonicalSources(parent, child).diffHash).toBe(diff.diffHash)
  })

  it('enforces the changed-lines cap', async () => {
    const parentRoot = await dir('cap-parent')
    await writeFile(join(parentRoot, 'a.txt'), '')
    const childRoot = await dir('cap-child')
    await writeFile(
      join(childRoot, 'a.txt'),
      `${Array.from({ length: CANONICAL_SOURCE_CAPS.maxChangedLines + 1 }, (_, i) => `line${i}`).join('\n')}\n`,
    )
    const parent = await captureCanonicalSource(parentRoot)
    const child = await captureCanonicalSource(childRoot)
    expect(() => diffCanonicalSources(parent, child)).toThrow(/changed lines/)
  })
})
