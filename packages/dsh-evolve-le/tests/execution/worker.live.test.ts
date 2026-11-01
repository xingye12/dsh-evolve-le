import { ProposalValidatorTests } from '../../src/execution/proposal-tests.js'
import { ProposalSnapshotFinalizer } from '../../src/execution/proposal-finalizer.js'
import { readProposalInputBinding } from '../../src/execution/proposal-input.js'
/** Replay worker wiring probe; deliberately separate from production host acceptance. */
import { cp, mkdir, mkdtemp, chmod, chown, writeFile, readFile, rm, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { localDockerEngine, decodeDockerStream } from '../../src/execution/docker-engine.js'
import { ContainerShell } from '../../src/execution/shell.js'
import { SECCOMP_PROFILE } from '../../src/execution/security.js'
import { openObjectStore, type ObjectRef } from '../../src/state/object-store.js'
import { ProposalActionBroker } from '../../src/execution/action-broker.js'
import { ActionModelGateway } from '../../src/execution/model-gateway.js'
import { captureSourceSnapshot, readSourceSnapshot } from '../../src/execution/snapshot.js'
import { openActionRpc } from '../../src/execution/rpc.js'
import {
  freezeExecutionInputs,
  materializeExecutionInputs,
  verifyExecutionInputs,
} from '../../src/execution/input-manifest.js'
import { makeSpec } from './fixtures.js'
import {
  executionName,
  DOCKER_NATIVE_PROTOCOL,
  DOCKER_CAPABILITIES_PROTOCOL,
  DOCKER_SANDBOX_PROTOCOL,
  DOCKER_TOOLS_PROTOCOL,
} from '../../src/execution/types.js'
import { parseProposalOutput } from '../../src/proposer/protocol.js'
const onlineProbe = process.env.DSH_WORKER_TEST_CAPABILITY_PROBE === '1'
const composedReceipt = process.env.DSH_COMPOSED_PROPOSAL_INPUT ?? ''
const closure = process.env.DSH_DOCKER_NATIVE_CLOSURE ?? '/tmp/dsh-docker-native-closure'
const enabled =
  process.env.DSH_DOCKER_ENGINE_PROBES === '1' &&
  (existsSync(composedReceipt) ||
    existsSync(join(closure, 'node_modules/@deepseek-ai/dsh-shell/package.json')))
describe.skipIf(!enabled)(
  'real Docker native worker wiring (replay, not production acceptance)',
  () => {
    it(
      onlineProbe
        ? 'routes online feedback and rejects failed tests across main/recovery finish attempts'
        : 'uses real Loader and AgentLoop for model→file→same-container shell→snapshot-bound finish',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'dsh-worker-probe-')),
          input = join(root, 'input'),
          capsule = join(input, 'capsule'),
          workspace = join(root, 'workspace'),
          work = join(root, 'work'),
          ipc = join(root, 'ipc')
        await mkdir(capsule, { recursive: true })
        await mkdir(workspace)
        await mkdir(work)
        await mkdir(ipc)
        await chmod(root, 0o755)
        await chmod(workspace, 0o755)
        await chmod(work, 0o777)
        await chmod(ipc, 0o755)
        const composed = composedReceipt
          ? (JSON.parse(await readFile(composedReceipt, 'utf8')) as {
              casRoot: string
              result: { inputManifest: ObjectRef; inputs: ObjectRef[] }
              config: {
                executionId: string
                parentSourceHash: string
                provider: string
                model: string
              }
            })
          : null
        if (!composed) {
          await cp(join(closure, 'node_modules'), join(capsule, 'node_modules'), {
            recursive: true,
          })
          await cp(resolve('packages/dsh-evolve-le/lib'), join(capsule, 'runner'), {
            recursive: true,
          })
          await mkdir(join(capsule, 'runtime'))
          await cp(process.execPath, join(capsule, 'runtime', 'node'))
          await cp(
            resolve('packages/dsh-evolve-le/lib/probe/candidate-workflow-stub.js'),
            join(capsule, 'runtime/candidate-workflow-stub.mjs'),
          )
          const nativeLock = JSON.parse(
            await readFile(resolve('native-dsh.lock.json'), 'utf8'),
          ) as {
            packages: Array<{ name: string; version: string }>
          }
          await writeFile(
            join(capsule, 'runtime', 'install-manifest.json'),
            JSON.stringify({ packages: nativeLock.packages }),
          )
          const fixturePackage = join(capsule, 'node_modules/@dsh-evolve-le/worker-fixture')
          await mkdir(fixturePackage, { recursive: true })
          await writeFile(
            join(fixturePackage, 'package.json'),
            JSON.stringify({
              name: '@dsh-evolve-le/worker-fixture',
              version: '0.0.0',
              type: 'module',
              main: 'index.mjs',
            }),
          )
          await writeFile(
            join(fixturePackage, 'index.mjs'),
            "export const name='worker-fixture';export const inject=['systemPrompt','tools'];export function apply(ctx){}\n",
          )
        }
        const childRoot = join(workspace, 'child-1')
        await mkdir(childRoot)
        await chown(childRoot, 65532, 65532)
        await chmod(childRoot, 0o750)
        const spec = makeSpec()
        spec.runId = `worker-${Date.now()}`
        spec.executionId = composed?.config.executionId ?? 'worker-1'
        spec.deadlineUtc = new Date(Date.now() + 60000).toISOString()
        spec.limits.outputBytes = 4 * 1024 * 1024
        if (!composed) {
          await writeFile(
            join(input, 'config.json'),
            JSON.stringify({
              protocol: DOCKER_SANDBOX_PROTOCOL,
              nativeProtocol: DOCKER_NATIVE_PROTOCOL,
              capabilityProtocol: DOCKER_CAPABILITIES_PROTOCOL,
              toolsProtocol: DOCKER_TOOLS_PROTOCOL,
              executionId: spec.executionId,
              candidatePackage: '@dsh-evolve-le/worker-fixture',
              candidateId: 'c_fixture',
              parentSourceHash: `sha256:${'a'.repeat(64)}`,
              width: 1,
              provider: 'fixture',
              model: 'fixture',
              maxTokens: 1024,
              contextWindowTokens: 32000,
              maxTurns: 8,
              shellTimeoutMs: 5000,
              outputBytes: spec.limits.outputBytes,
              clientTimeoutMs: 30000,
            }),
          )
        }
        const engine = localDockerEngine(),
          store = await openObjectStore(composed?.casRoot ?? join(root, 'cas'))
        const originalInput = join(root, 'original-input')
        await rename(input, originalInput)
        const inputManifest =
          composed?.result.inputManifest ??
          (await freezeExecutionInputs(store, [{ target: '/input', root: originalInput }], {
            bytes: 512 * 1024 * 1024,
            fileBytes: 160 * 1024 * 1024,
            inodes: 32768,
          }))
        spec.inputs.push(inputManifest)
        spec.command = [
          '/input/capsule/runtime/node',
          '/input/capsule/runner/bin/docker-proposer-worker.js',
          '/input/config.json',
        ]
        for (const mount of spec.mounts)
          mount.source = mount.target === '/gateway' ? ipc : join(root, mount.target.slice(1))
        await materializeExecutionInputs(store, inputManifest, root)
        await verifyExecutionInputs(store, inputManifest, spec)
        await writeFile(join(originalInput, 'config.json'), 'unmounted original drift')
        const proposal = {
          schemaVersion: 1,
          protocol: 'dsh-evolve-le/proposal/v1',
          parentSourceHash: composed?.config.parentSourceHash ?? `sha256:${'a'.repeat(64)}`,
          children: [
            {
              childName: 'child-1',
              hypothesis: 'General planning mechanism.',
              donorCandidates: [],
              evidenceRefs: [],
              targetFailureModes: ['planning'],
            },
          ],
        }
        let requests = 0,
          submitted = 0,
          id: string | undefined
        const gateway = new ActionModelGateway({
          root: join(root, 'model'),
          store,
          executionId: spec.executionId,
          provider: composed?.config.provider ?? 'fixture',
          model: composed?.config.model ?? 'fixture',
          limits: {
            maxRequests: 8,
            maxInputTokens: 32000,
            maxOutputTokens: 1024,
            maxTotalTokens: 500000,
            maxCostUsdMicros: 1,
            maxRequestBytes: 8 * 1024 * 1024,
            inputUsdMicrosPerMillion: 0,
            outputUsdMicrosPerMillion: 0,
          },
          async dispatch(_id, request) {
            expect(request.tools.some((t) => t.name === 'bash')).toBe(true)
            if (onlineProbe)
              expect(request.tools.some((t) => t.name === 'proposal_test_child')).toBe(true)
            const index = requests++
            if (onlineProbe && (index === 4 || index === 6)) {
              expect(JSON.stringify(request.messages)).toContain('development feedback only')
              return {
                responseText: 'Snapshot validation failed; no proposal is submitted.',
                toolCalls: [],
                promptTokens: 10,
                completionTokens: 1,
              }
            }
            if (onlineProbe && index === 5)
              expect(JSON.stringify(request.messages)).toContain('[TCB recovery turn]')
            const tool =
              index === 0
                ? {
                    id: 'write',
                    name: 'proposal_write_child',
                    arguments: JSON.stringify({
                      childName: 'child-1',
                      path: 'index.ts',
                      content: 'agent',
                    }),
                  }
                : index === 1
                  ? {
                      id: 'shell',
                      name: 'bash',
                      arguments: JSON.stringify({
                        command:
                          'test "$DSH_HOME" = /work/home && test "$DSH_SHELL" = 1 && test -n "$DSH_SESSION_ID" && printf shell >> index.ts',
                        description: 'shared source edit',
                        workdir: '/workspace/child-1',
                      }),
                    }
                  : index === 2 && onlineProbe
                    ? {
                        id: 'test',
                        name: 'proposal_test_child',
                        arguments: JSON.stringify({ childName: 'child-1' }),
                      }
                    : index === (onlineProbe ? 3 : 2) || (onlineProbe && index === 5)
                      ? {
                          id: 'finish',
                          name: 'proposal_finish',
                          arguments: JSON.stringify({ proposal }),
                        }
                      : null
            if (!tool) throw Error('unexpected post-submission model request')
            return { responseText: '', toolCalls: [tool], promptTokens: 10, completionTokens: 1 }
          },
        })
        const shell = new ContainerShell({
          engine,
          store,
          async abort() {
            broker?.revoke()
            const actual = await engine.json<{ State: { Paused: boolean } }>(
              'GET',
              `/containers/${id}/json`,
            )
            if (actual.State.Paused) await engine.request('POST', `/containers/${id}/unpause`)
            await engine.request('POST', `/containers/${id}/kill?signal=KILL`)
            await engine.json('POST', `/containers/${id}/wait?condition=not-running`)
          },
        })
        const binding = composed ? await readProposalInputBinding(store, inputManifest, spec) : null
        const finalizer = binding
          ? new ProposalSnapshotFinalizer({
              root: join(root, 'finalizations'),
              store,
              spec,
              inputManifest,
              children: ['child-1'],
              context: {
                parentSourceHash: binding.config.parentSourceHash,
                ...(binding.config.treeV2Parent
                  ? { treeV2Parent: binding.config.treeV2Parent }
                  : {}),
                catalog: binding.catalog,
                exportManifest: binding.exportManifest,
                parentSourceFiles: Object.fromEntries(
                  binding.parent.files.map((file) => [file.path, file.content.toString('utf8')]),
                ),
              },
            })
          : null
        let tests: ProposalValidatorTests | undefined
        if (onlineProbe) {
          if (!composed) throw Error('online capability probe requires composed runtime refs')
          const caps = {
            slots: 1,
            memoryBytes: 1e9,
            cpuMillis: 4000,
            pids: 1024,
            bytes: 1e9,
            inodes: 100000,
          }
          const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8')) as {
            dependencyClosureSha256: string
          }
          tests = new ProposalValidatorTests({
            root: join(root, 'tests'),
            store,
            spec,
            children: ['child-1'],
            parentSnapshot: composed.result.inputs[1]!,
            parentCapsuleInventory: composed.result.inputs[2]!,
            workerInventory: composed.result.inputs[3]!,
            dependencyClosureSha256: lock.dependencyClosureSha256,
            profile: {
              kind: 'test',
              image: spec.image,
              policy: spec.policy,
              limits: spec.limits,
              maxElapsedMs: spec.maxElapsedMs,
              hostRoot: join(root, 'test-host'),
              executionRoot: join(root, 'test-executions'),
              storeRoot: store.root,
              resourceRoot: join(root, 'test-resources'),
              cgroupRoot: join(root, 'not-delegated'),
              security: { seccompJson: '{}', apparmorProfile: 'not-loaded', cgroupParent: 'test' },
              pools: { proposal: caps, test: caps, validator: caps },
            },
          })
        }
        const broker = new ProposalActionBroker({
          spec,
          inputRoot: input,
          workspaceRoot: workspace,
          controlRoot: join(root, 'control'),
          store,
          children: ['child-1'],
          parentSourceHash: proposal.parentSourceHash,
          shell,
          modelGateway: gateway,
          async snapshot(child) {
            await engine.request('POST', `/containers/${id}/pause`)
            try {
              return await captureSourceSnapshot({
                root: join(workspace, child),
                spec,
                store,
                child,
              })
            } finally {
              await engine.request('POST', `/containers/${id}/unpause`)
            }
          },
          async test(child, source) {
            if (tests) return tests.test(child, source)
            throw Error('probe does not grant candidate test capability')
          },
          async finalize(raw, sources) {
            if (finalizer) {
              const finalized = await finalizer.finalize(raw, sources)
              if (tests) await tests.testSubmission(finalized)
              return finalized
            }
            parseProposalOutput(raw)
            return { proposal: raw, sources: [...sources] }
          },
          async submitted() {
            submitted++
            gateway.revoke()
          },
        })
        const rpc = await openActionRpc({
          socketPath: join(ipc, 'action.sock'),
          executionId: spec.executionId,
          socketUid: 65532,
          socketGid: 65532,
          maxFrameBytes: spec.limits.outputBytes * 2 + 8192,
          maxConnections: 8,
          handler: (request, signal) => broker!.handler(request, signal),
        })
        try {
          const created = await engine.json<{ Id: string }>(
            'POST',
            `/containers/create?name=${executionName(spec)}`,
            {
              Image:
                'ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55',
              User: '65532:65532',
              Entrypoint: [
                '/input/capsule/runtime/node',
                '/input/capsule/runner/bin/docker-proposer-worker.js',
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
                Memory: 512 * 1024 * 1024,
                MemorySwap: 512 * 1024 * 1024,
                PidsLimit: 128,
                Mounts: [
                  { Type: 'bind', Source: input, Target: '/input', ReadOnly: true },
                  { Type: 'bind', Source: workspace, Target: '/workspace' },
                  { Type: 'bind', Source: work, Target: '/work' },
                  { Type: 'bind', Source: ipc, Target: '/gateway', ReadOnly: true },
                ],
                Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864,nr_inodes=4096,mode=1777' },
              },
            },
          )
          id = created.Id
          await engine.request('POST', `/containers/${id}/start`)
          const stopped = await engine.json<{ StatusCode: number }>(
            'POST',
            `/containers/${id}/wait?condition=not-running`,
            undefined,
            { timeoutMs: 60000 },
          )
          const logs = decodeDockerStream(
            (await engine.request('GET', `/containers/${id}/logs?stdout=true&stderr=true`)).body,
            8 * 1024 * 1024,
          )
          if (process.env.DSH_WORKER_PROBE_RECEIPT) {
            await writeFile(
              `${process.env.DSH_WORKER_PROBE_RECEIPT}.partial.json`,
              JSON.stringify(
                {
                  protocol: 'dsh-evolve-le/proposal-worker-partial-probe/v1',
                  casRoot: store.root,
                  inputManifest,
                  requests,
                  submitted,
                  exitCode: stopped.StatusCode,
                  stdout: await store.put(logs.stdout, {
                    mediaType: 'application/x-ndjson',
                    label: 'DEV_OBSERVED',
                  }),
                  stderr: await store.put(logs.stderr, {
                    mediaType: 'text/plain',
                    label: 'DEV_OBSERVED',
                  }),
                  scope: 'Raw engineering probe logs; not a success verdict',
                },
                null,
                2,
              ) + '\n',
            )
          }
          const artifacts = [
            ...(await broker.artifacts()),
            ...((await finalizer?.artifacts()) ?? []),
          ]
          artifacts.push(...((await tests?.artifacts()) ?? []))
          const snapshotRef = artifacts.find(
            (r) => r.mediaType === 'application/vnd.dsh-evolve-le.source-snapshot+json',
          )!
          expect(snapshotRef).toBeDefined()
          const snapshot = await readSourceSnapshot(store, snapshotRef)
          expect(
            (
              await store.read(snapshot.files.find((f) => f.path === 'index.ts')!.content)
            ).toString(),
          ).toBe('agentshell')
          expect(logs.stdout.toString()).toContain('worker-event/v1')
          if (process.env.DSH_WORKER_PROBE_RECEIPT) {
            const stdout = await store.put(logs.stdout, {
              mediaType: 'application/x-ndjson',
              label: 'DEV_OBSERVED',
            })
            const stderr = await store.put(logs.stderr, {
              mediaType: 'text/plain',
              label: 'DEV_OBSERVED',
            })
            const inspect = await engine.json('GET', `/containers/${id}/json`)
            await writeFile(
              process.env.DSH_WORKER_PROBE_RECEIPT,
              JSON.stringify(
                {
                  protocol: 'dsh-evolve-le/proposal-worker-engineering-probe/v1',
                  casRoot: store.root,
                  inputManifest,
                  requests,
                  submitted,
                  exitCode: stopped.StatusCode,
                  snapshot: snapshotRef,
                  artifacts,
                  stdout,
                  stderr,
                  inspection: await store.put(Buffer.from(JSON.stringify(inspect)), {
                    mediaType: 'application/json',
                    label: 'CONTROLLER_INTERNAL',
                  }),
                  scope: onlineProbe
                    ? 'Engineering negative gate: validator preflight failures reach native Agent and prevent submission; no production acceptance or admission'
                    : 'Engineering Docker profile; replay model; no production host acceptance, validator admission or benchmark result',
                },
                null,
                2,
              ) + '\n',
            )
          }
          if (onlineProbe) expect(stopped.StatusCode, logs.stderr.toString()).not.toBe(0)
          else expect(stopped.StatusCode, logs.stderr.toString()).toBe(0)
          expect(requests).toBe(onlineProbe ? 7 : 3)
          expect(submitted).toBe(onlineProbe ? 0 : 1)
          expect(await readFile(join(childRoot, 'index.ts'), 'utf8')).toBe('agentshell')
        } finally {
          await rpc.close()
          if (id) {
            await engine
              .request('POST', `/containers/${id}/kill?signal=KILL`)
              .catch(() => undefined)
            await engine.request('DELETE', `/containers/${id}?force=false&v=false`)
          }
          await rm(root, { recursive: true, force: true })
        }
      },
      90000,
    )
  },
)
