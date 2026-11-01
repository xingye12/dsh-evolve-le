import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { canonicalJson } from '../../src/state/canonical.js'
import { openObjectStore } from '../../src/state/object-store.js'
import {
  freezeExecutionInputs,
  materializeExecutionInputs,
  verifyExecutionInputs,
} from '../../src/execution/input-manifest.js'
import { makeSpec } from './fixtures.js'
it('materializes only frozen CAS bytes and rejects drift, writable inputs and missing spec binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-inputs-'))
  try {
    const source = join(root, 'source'),
      action = join(root, 'action'),
      store = await openObjectStore(join(root, 'cas'))
    await mkdir(source)
    await mkdir(action)
    await mkdir(join(source, 'capsule/runner/bin'), { recursive: true })
    await mkdir(join(source, 'capsule/runtime'))
    await writeFile(join(source, 'capsule/runtime/node'), 'node')
    await chmod(join(source, 'capsule/runtime/node'), 0o755)
    await writeFile(join(source, 'capsule/runner/bin/proposer-worker.js'), 'worker')
    await writeFile(join(source, 'config.json'), '{}')
    const manifest = await freezeExecutionInputs(store, [{ target: '/input', root: source }], {
      bytes: 10000,
      fileBytes: 1000,
      inodes: 32,
    })
    await writeFile(join(source, 'config.json'), 'changed after freeze')
    const spec = makeSpec()
    spec.inputs = [manifest]
    spec.command[2] = '/input/config.json'
    spec.mounts = spec.mounts.filter((m) => m.target !== '/gateway')
    spec.kind = 'validator'
    delete spec.gateway
    for (const m of spec.mounts) m.source = join(action, m.target.slice(1))
    await materializeExecutionInputs(store, manifest, action)
    expect(await readFile(join(action, 'input/config.json'), 'utf8')).toBe('{}')
    await verifyExecutionInputs(store, manifest, spec)
    await expect(
      verifyExecutionInputs(store, manifest, {
        ...spec,
        command: [...spec.command, '/input/absent'],
      }),
    ).rejects.toThrow(/entry/)
    await materializeExecutionInputs(store, manifest, action)
    const document = JSON.parse((await store.read(manifest)).toString('utf8'))
    const inventory = JSON.parse((await store.read(document.trees[0].inventory)).toString('utf8'))
    for (const file of inventory.files) {
      file.content.label = 'CONTROLLER_INTERNAL'
      file.content.mediaType = 'application/test-binary'
    }
    document.trees[0].inventory = await store.put(Buffer.from(canonicalJson(inventory)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
    const alternate = await store.put(Buffer.from(canonicalJson(document)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
    const second = join(root, 'second')
    await mkdir(second)
    await materializeExecutionInputs(store, alternate, second)
    await verifyExecutionInputs(store, alternate, {
      ...spec,
      inputs: [alternate],
      mounts: spec.mounts.map((m) => ({ ...m, source: join(second, m.target.slice(1)) })),
    })
    await expect(verifyExecutionInputs(store, manifest, { ...spec, inputs: [] })).rejects.toThrow(
      /spec/,
    )
    await chmod(join(action, 'input/config.json'), 0o644)
    await expect(verifyExecutionInputs(store, manifest, spec)).rejects.toThrow(/writable/)
    await writeFile(join(action, 'input/config.json'), 'drift')
    await chmod(join(action, 'input/config.json'), 0o444)
    await expect(verifyExecutionInputs(store, manifest, spec)).rejects.toThrow(/drift/)
    await expect(materializeExecutionInputs(store, manifest, action)).rejects.toThrow(/drift/)
    await mkdir(join(root, 'linked'))
    await symlink('/etc/passwd', join(root, 'linked/escape'))
    await expect(
      freezeExecutionInputs(store, [{ target: '/input', root: join(root, 'linked') }], {
        bytes: 10000,
        fileBytes: 1000,
        inodes: 32,
      }),
    ).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
