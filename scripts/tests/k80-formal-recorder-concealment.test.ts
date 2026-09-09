/** Static contract for the paid formal recorder's public-evidence boundary.
 * The recorder itself must not be imported in tests: module initialization is
 * intentionally protected by the paid-run confirmation gate. */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../record-tree-v2-k80-formal-live.ts',
)

describe('K=80 formal recorder concealment copy set (ADR-052)', () => {
  it('routes every copied artifact and final document through restricted-name sanitation', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toContain('const copySanitizedArtifact')
    expect(source).toContain('await copySanitizedArtifact(source, name)')
    expect(source).toContain("'image-prefetch.attestation.json'")
    expect(source).not.toContain("[join(runRoot, 'image-prefetch.json'), 'image-prefetch.json']")
    expect(source).toContain("'final formal record'")
    expect(source).toContain("'formal status document'")
  })
})
