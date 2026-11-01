import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { openObjectStore } from '../../src/state/object-store.js'
import { captureCanonicalSource } from '../../src/candidate/canonical.js'
import { stageDeclaredSource } from '../../src/builder/staging.js'
import { verifyValidatorExport } from '../../src/execution/validator-export.js'
it('rejects missing, foreign, partial and linked validator completion facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'validator-export-'))
  try {
    const workRoot = join(root, 'work'),
      workspaceRoot = join(root, 'workspace')
    await mkdir(workRoot)
    await mkdir(workspaceRoot)
    await stageDeclaredSource(resolve('packages/candidate-baseline'), join(root, 'source'))
    const options = {
      executionId: 'validator-1',
      workRoot,
      workspaceRoot,
      source: await captureCanonicalSource(join(root, 'source')),
      dependencyClosureSha256: 'a'.repeat(64),
      runnerSourceDir: resolve('packages/dsh-evolve-le/lib'),
      store: await openObjectStore(join(root, 'cas')),
      limits: { bytes: 10000, fileBytes: 10000, inodes: 32, diagnosticBytes: 10000 },
    }
    await expect(verifyValidatorExport(options)).rejects.toThrow()
    await writeFile(
      join(workRoot, 'validator-result.json'),
      JSON.stringify({
        protocol: 'dsh-evolve-le/validator-result/v1',
        sourceDigest: 'sha256:' + '0'.repeat(64),
        result: {},
      }),
    )
    await expect(verifyValidatorExport(options)).rejects.toThrow(/source/)
    await writeFile(
      join(workRoot, 'validator-result.json'),
      JSON.stringify({
        protocol: 'dsh-evolve-le/validator-result/v1',
        sourceDigest: 'sha256:' + options.source.sha256,
        result: { outcome: 'rejected' },
      }),
    )
    await expect(verifyValidatorExport(options)).rejects.toThrow(/complete admission/)
    await rm(join(workRoot, 'validator-result.json'))
    await symlink('/etc/passwd', join(workRoot, 'validator-result.json'))
    await expect(verifyValidatorExport(options)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
