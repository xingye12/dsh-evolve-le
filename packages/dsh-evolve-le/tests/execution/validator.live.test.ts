/** Full builder inside fresh validator containers. Host platform acceptance remains separate. */
import { cp, mkdir, mkdtemp, chmod, writeFile, readFile, rm, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { localDockerEngine, decodeDockerStream } from '../../src/execution/docker-engine.js'
import { SECCOMP_PROFILE } from '../../src/execution/security.js'
import { buildInstallManifest } from '../../src/builder/capsule.js'
import { stageDeclaredSource } from '../../src/builder/staging.js'
import { captureCanonicalSource } from '../../src/candidate/canonical.js'
import {
  verifyValidatorExport,
  readValidatorExport,
  type ValidatorExport,
} from '../../src/execution/validator-export.js'
import { openObjectStore } from '../../src/state/object-store.js'
import { composeValidatorInputs } from '../../src/execution/validator-input.js'
import { captureBoundedTree, captureSourceSnapshot } from '../../src/execution/snapshot.js'
import { materializeExecutionInputs } from '../../src/execution/input-manifest.js'
import { canonicalJson, canonicalHash } from '../../src/state/canonical.js'
import { makeSpec } from './fixtures.js'
import { STAGE_ORDER, type BuildResult } from '../../src/builder/pipeline.js'
const closure = process.env.DSH_DOCKER_NATIVE_CLOSURE ?? '/tmp/dsh-docker-native-closure',
  images = process.env.DSH_DOCKER_IMAGES ?? ''
const enabled =
  process.env.DSH_DOCKER_ENGINE_PROBES === '1' &&
  existsSync(images) &&
  existsSync(join(closure, 'node_modules'))
describe.skipIf(!enabled)('real Docker full candidate validator (engineering platform)', () => {
  it('runs all ten stages in two fresh containers and compares production artifact hashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-validator-probe-')),
      input = join(root, 'input'),
      capsule = join(input, 'capsule')
    await mkdir(capsule, { recursive: true })
    await chmod(root, 0o755)
    await cp(join(closure, 'node_modules'), join(capsule, 'node_modules'), { recursive: true })
    await cp(resolve('packages/dsh-evolve-le/lib'), join(capsule, 'runner'), { recursive: true })
    await mkdir(join(capsule, 'runtime'))
    await cp(process.execPath, join(capsule, 'runtime/node'))
    await mkdir(join(capsule, 'candidate'))
    await cp(
      resolve('packages/candidate-baseline/package.json'),
      join(capsule, 'candidate/package.json'),
    )
    const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
        packages: Array<{ name: string; version: string }>
        dependencyClosureSha256: string
      },
      manifest = await buildInstallManifest(join(capsule, 'node_modules'), lock.packages)
    await writeFile(join(capsule, 'runtime/install-manifest.json'), manifest.text)
    await stageDeclaredSource(resolve('packages/candidate-baseline'), join(input, 'source'))
    await stageDeclaredSource(resolve('packages/candidate-baseline'), join(input, 'parent'))
    const source = await captureCanonicalSource(join(input, 'source'))
    await writeFile(
      join(input, 'config.json'),
      JSON.stringify({
        protocol: 'dsh-evolve-le/validator/v1',
        sourceDigest: `sha256:${source.sha256}`,
        dependencyClosureSha256: lock.dependencyClosureSha256,
      }),
    )
    const image = (
      JSON.parse(await readFile(images, 'utf8')) as {
        images: Array<{ kind: string; reference: string }>
      }
    ).images.find((i) => i.kind === 'validator')!.reference
    const parentReportPath = process.env.DSH_VALIDATOR_PARENT_REPORT,
      parentReport = parentReportPath
        ? (JSON.parse(await readFile(parentReportPath, 'utf8')) as {
            casRoot: string
            exports: ValidatorExport[]
          })
        : null
    const engine = localDockerEngine(),
      results: BuildResult[] = [],
      exports: ValidatorExport[] = [],
      casRoot =
        parentReport?.casRoot ?? process.env.DSH_VALIDATOR_CAS_ROOT ?? join(root, 'external-cas'),
      store = await openObjectStore(casRoot)
    let inputComposition: Awaited<ReturnType<typeof composeValidatorInputs>> | undefined
    if (parentReport) {
      const sourceSpec = makeSpec(),
        parentSpec = makeSpec()
      parentSpec.executionId = 'baseline-parent'
      const sourceSnapshot = await captureSourceSnapshot({
          root: join(input, 'source'),
          store,
          spec: sourceSpec,
          child: 'child-1',
        }),
        parentSnapshot = await captureSourceSnapshot({
          root: join(input, 'parent'),
          store,
          spec: parentSpec,
          child: 'parent',
        }),
        workerTree = await captureBoundedTree({
          root: resolve('packages/dsh-evolve-le/lib'),
          store,
          limits: { bytes: 32 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, inodes: 8192 },
        }),
        workerInventory = await store.put(Buffer.from(canonicalJson(workerTree)), {
          mediaType: 'application/vnd.dsh-evolve-le.artifact-inventory+json',
          label: 'CONTROLLER_INTERNAL',
        })
      const options = {
        store,
        sourceSnapshot,
        parentSnapshot,
        workerInventory,
        parentCapsuleInventory: parentReport.exports[0]!.capsuleInventory,
        proposalExecutionId: sourceSpec.executionId,
        proposalSpecDigest: canonicalHash(sourceSpec),
        child: 'child-1',
        dependencyClosureSha256: lock.dependencyClosureSha256,
      }
      inputComposition = await composeValidatorInputs(options)
      expect(inputComposition.sourceDigest).toBe(`sha256:${source.sha256}`)
      await expect(
        composeValidatorInputs({ ...options, dependencyClosureSha256: '0'.repeat(64) }),
      ).rejects.toThrow(/closure/)
      await rename(input, join(root, 'original-input'))
      await materializeExecutionInputs(store, inputComposition.inputManifest, root)
      await writeFile(join(root, 'original-input/config.json'), 'unmounted original drift')
      if (process.env.DSH_VALIDATOR_VERIFICATION_PATH)
        await writeFile(
          process.env.DSH_VALIDATOR_VERIFICATION_PATH + '.inputs.json',
          JSON.stringify(
            {
              protocol: 'dsh-evolve-le/validator-composition-probe/v1',
              image,
              inputComposition,
              casRoot,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
    }

    try {
      for (let build = 0; build < 2; build++) {
        const workspace = join(root, `workspace-${build}`),
          work = join(root, `work-${build}`)
        await mkdir(workspace)
        await mkdir(work)
        await chmod(workspace, 0o777)
        await chmod(work, 0o777)
        let id: string | undefined
        try {
          const created = await engine.json<{ Id: string }>(
            'POST',
            `/containers/create?name=dsh-validator-probe-${process.pid}-${Date.now()}-${build}`,
            {
              Image: image,
              User: '65532:65532',
              Entrypoint: [
                '/input/capsule/runtime/node',
                '/input/capsule/runner/bin/validator-worker.js',
                '/input/config.json',
              ],
              Cmd: [],
              Env: ['PATH=/usr/bin:/bin', 'HOME=/work/home', 'TMPDIR=/tmp'],
              WorkingDir: '/workspace',
              Labels: { 'dsh.owner': 'dsh-evolve-le-engine-probe' },
              HostConfig: {
                ReadonlyRootfs: true,
                ReadonlyPaths: ['/dev'],
                NetworkMode: 'none',
                CapDrop: ['ALL'],
                SecurityOpt: [
                  'no-new-privileges=true',
                  `seccomp=${JSON.stringify(SECCOMP_PROFILE)}`,
                ],
                AutoRemove: false,
                RestartPolicy: { Name: 'no' },
                Memory: 2 * 1024 * 1024 * 1024,
                MemorySwap: 2 * 1024 * 1024 * 1024,
                PidsLimit: 128,
                Mounts: [
                  { Type: 'bind', Source: input, Target: '/input', ReadOnly: true },
                  { Type: 'bind', Source: workspace, Target: '/workspace' },
                  { Type: 'bind', Source: work, Target: '/work' },
                ],
                Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=134217728,nr_inodes=8192,mode=1777' },
              },
            },
          )
          id = created.Id
          await engine.request('POST', `/containers/${id}/start`)
          const stopped = await engine.json<{ StatusCode: number }>(
            'POST',
            `/containers/${id}/wait?condition=not-running`,
            undefined,
            { timeoutMs: 240000 },
          )
          const logs = decodeDockerStream(
            (await engine.request('GET', `/containers/${id}/logs?stdout=true&stderr=true`)).body,
            8 * 1024 * 1024,
          )
          const reported = await readFile(join(work, 'validator-result.json'), 'utf8')
            .then((t) => JSON.parse(t) as { result: BuildResult })
            .catch(() => null)
          expect(
            stopped.StatusCode,
            JSON.stringify({
              stderr: logs.stderr.toString(),
              rejection: reported?.result.rejection,
            }),
          ).toBe(0)
          const result = reported!.result
          expect(result.outcome).toBe('admitted')
          for (const stage of STAGE_ORDER) expect(result.receipts[stage].status, stage).toBe('pass')
          const verified = await verifyValidatorExport({
            executionId: `validator-${build}`,
            workspaceRoot: workspace,
            workRoot: work,
            source,
            dependencyClosureSha256: lock.dependencyClosureSha256,
            runnerSourceDir: inputComposition
              ? join(input, 'capsule/runner')
              : resolve('packages/dsh-evolve-le/lib'),
            store,
            limits: {
              bytes: 512 * 1024 * 1024,
              fileBytes: 160 * 1024 * 1024,
              inodes: 32768,
              diagnosticBytes: 2 * 1024 * 1024,
            },
          })
          expect(verified.value.capsuleTar.digest).toBe(result.capsule!.tarSha256)
          exports.push(verified.value)
          // Exported bytes stay independently available even if the live output drifts.
          await writeFile(join(workspace, 'build/capsule.tar'), 'after-export-drift')
          await expect(
            verifyValidatorExport({
              executionId: `validator-${build}`,
              workspaceRoot: workspace,
              workRoot: work,
              source,
              dependencyClosureSha256: lock.dependencyClosureSha256,
              runnerSourceDir: inputComposition
                ? join(input, 'capsule/runner')
                : resolve('packages/dsh-evolve-le/lib'),
              store,
              limits: {
                bytes: 512 * 1024 * 1024,
                fileBytes: 160 * 1024 * 1024,
                inodes: 32768,
                diagnosticBytes: 2 * 1024 * 1024,
              },
            }),
          ).rejects.toThrow(/tar/)
          await store.scrub(verified.artifacts)
          expect(
            await readValidatorExport(store, verified.receipt, {
              executionId: `validator-${build}`,
              sourceDigest: `sha256:${source.sha256}`,
            }),
          ).toEqual(verified.value)
          await expect(
            readValidatorExport(store, verified.receipt, {
              executionId: 'foreign-execution',
              sourceDigest: `sha256:${source.sha256}`,
            }),
          ).rejects.toThrow(/binding/)
          results.push(result)
        } finally {
          if (id) {
            await engine
              .request('POST', `/containers/${id}/kill?signal=KILL`)
              .catch(() => undefined)
            await engine.request('DELETE', `/containers/${id}?force=false&v=false`)
          }
        }
      }
      expect(results[1]!.sourceDigest).toBe(results[0]!.sourceDigest)
      expect(results[1]!.bundle?.tarSha256).toBe(results[0]!.bundle?.tarSha256)
      expect(results[1]!.capsule?.tarSha256).toBe(results[0]!.capsule?.tarSha256)
      if (process.env.DSH_VALIDATOR_VERIFICATION_PATH)
        await writeFile(
          process.env.DSH_VALIDATOR_VERIFICATION_PATH,
          JSON.stringify(
            {
              protocol: 'dsh-evolve-le/validator-engineering-probe/v1',
              image,
              sourceDigest: `sha256:${source.sha256}`,
              results,
              exports,
              casRoot,
              inputComposition,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 600000)
})
