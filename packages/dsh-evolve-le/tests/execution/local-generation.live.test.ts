import { Controller, type ProposalRunner } from '../../src/controller/controller.js'
import { FakeProvider } from '../../src/controller/provider.js'
import { readProposalInputBinding } from '../../src/execution/proposal-input.js'
import { publishCanonical, verifyExecutionBundle } from '../../src/execution/evidence.js'
import { remoteRoutePlanOf } from '../../src/proposer/remote-runner.js'
/** Actual local Engine + production owner/Loader; replay only, no provider credentials. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it, expect } from 'vitest'
import { openObjectStore, type ObjectRef } from '../../src/state/object-store.js'
import { canonicalJson } from '../../src/state/canonical.js'
import { captureBoundedTree, readSourceSnapshot } from '../../src/execution/snapshot.js'
import { composeProposalInputs } from '../../src/execution/proposal-input.js'
import { readFrozenGeneration } from '../../src/execution/proposal-generation-process.js'
import { readGenerationResult } from '../../src/execution/proposal-generation-result.js'
import { verifySubmission } from '../../src/execution/submission.js'
import { executionName } from '../../src/execution/types.js'
import { SECCOMP_PROFILE } from '../../src/execution/security.js'
import { localDockerEngine, DockerApiError } from '../../src/execution/docker-engine.js'
import { readKernelLockOwner } from '../../src/execution/owner.js'
import { readCanonicalFile } from '../../src/execution/evidence.js'
import { makeProposalConfig } from './fixtures.js'
const exec = promisify(execFile)
async function fixture(mode: 'success' | 'timeout' | 'orphan' | 'live' = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'local-generation-'))
  const source = JSON.parse(
    await readFile('evidence/docker-sandbox-20261031/proposal-input-5.json', 'utf8'),
  )
  const store = await openObjectStore(source.casRoot)
  const put = (value: unknown) =>
    store.put(Buffer.from(canonicalJson(value)), {
      mediaType: 'application/json',
      label: 'CONTROLLER_INTERNAL',
    })
  const refs: ObjectRef[] = source.result.inputs
  const workerInventory = await put(
    await captureBoundedTree({
      root: resolve('packages/dsh-evolve-le/lib'),
      store,
      limits: { bytes: 32 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, inodes: 8192 },
    }),
  )
  const lock = JSON.parse(await readFile('native-dsh.lock.json', 'utf8'))
  const liveConfig =
    mode === 'live'
      ? JSON.parse(await readFile(process.env.DSH_LOCAL_GENERATION_LIVE_CONFIG!, 'utf8'))
      : null
  const liveRoute = liveConfig?.modelRoutes.find(
    (route: any) => route.id === liveConfig.proposerRoute,
  )
  const worker = {
    ...source.config,
    ...(liveRoute ? { provider: liveRoute.provider, model: liveRoute.model, maxTurns: 32 } : {}),
    executionId: `local-gen-${Date.now()}`,
    width: 1,
    generationOnly: true,
    maxTokens: liveRoute ? 4096 : 2048,
    contextWindowTokens: liveRoute ? 65536 : 131072,
    outputBytes: 8 * 1024 * 1024,
    shellTimeoutMs: 15000,
    clientTimeoutMs: 120000,
  }
  const input = await composeProposalInputs({
    store,
    parentSnapshot: refs[1]!,
    parentCapsuleInventory: refs[2]!,
    workerInventory,
    dependencyClosureSha256: lock.dependencyClosureSha256,
    config: worker,
    catalog: refs[4]!,
    evidenceInventory: refs[5]!,
  })
  const proposal = {
    schemaVersion: 1,
    protocol: 'dsh-evolve-le/proposal/v1',
    parentSourceHash: worker.parentSourceHash,
    children: [
      {
        childName: 'child-1',
        hypothesis: 'Source generation isolated in local Docker.',
        donorCandidates: [],
        evidenceRefs: [],
        targetFailureModes: ['planning'],
      },
    ],
  }
  const tool = (id: string, name: string, args: unknown) => ({
    responseText: '',
    promptTokens: 100,
    completionTokens: 30,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  })
  let route = await put({
    protocol: 'dsh-evolve-le/model-replay/v1',
    provider: worker.provider,
    model: worker.model,
    responses: [
      tool('write', 'proposal_write_child', {
        childName: 'child-1',
        path: 'generation-probe.txt',
        content: 'model-edit',
      }),
      tool('shell', 'bash', {
        command:
          mode === 'success'
            ? 'set -e; test "$(id -u)" = 65532; test "$(ls /sys/class/net)" = lo; test ! -S /var/run/docker.sock; test -z "${OPENAI_API_KEY-}${DEEPSEEK_API_KEY-}${ANTHROPIC_API_KEY-}"; if touch /input/forbidden 2>/dev/null; then exit 9; fi; if touch /usr/forbidden 2>/dev/null; then exit 10; fi; printf "%s" "-shell-edit" >> generation-probe.txt'
            : 'sleep 60',
        description: 'verify isolation and modify candidate source',
        workdir: '/workspace/child-1',
      }),
      tool('finish', 'proposal_finish', { proposal }),
    ],
  })
  if (liveRoute)
    route = await store.put(
      Buffer.from(
        JSON.stringify(
          remoteRoutePlanOf({
            ...liveRoute,
            maxOutputTokens: worker.maxTokens,
            retry: { maxAttempts: 1, backoffMs: [] },
          }),
        ),
      ),
      { mediaType: 'application/json', label: 'CONTROLLER_INTERNAL' },
    )
  const { tests: _tests, ...base } = makeProposalConfig()
  const imageReport = JSON.parse(
    await readFile('evidence/docker-sandbox-20261031/executor-images-8.json', 'utf8'),
  )
  const image = imageReport.images.find((x: { kind: string }) => x.kind === 'proposal')
  const security = {
    profile: 'local-generation/v1' as const,
    seccompJson: JSON.stringify(SECCOMP_PROFILE),
    apparmorProfile: 'none',
    cgroupParent: '/unused',
  }
  const policy = await put(security)
  const config = {
    ...base,
    protocol: 'dsh-evolve-le/proposal-generation/v1',
    hostRoot: join(root, 'host'),
    executionRoot: join(root, 'executions'),
    resourceRoot: join(root, 'resources'),
    cgroupRoot: join(root, 'unused-cgroups'),
    storeRoot: store.root,
    inputManifest: input.inputManifest,
    security,
    model: {
      ...base.model,
      mode: liveRoute ? 'live' : 'replay',
      route,
      limits: {
        ...base.model.limits,
        maxInputTokens: worker.contextWindowTokens,
        maxOutputTokens: worker.maxTokens,
        maxTotalTokens: liveRoute ? 2000000 : 1000000,
        ...(liveRoute
          ? {
              maxRequests: 16,
              maxCostUsdMicros: 200000,
              inputUsdMicrosPerMillion: liveRoute.inputUsdMicrosPerMTok,
              outputUsdMicrosPerMillion: liveRoute.outputUsdMicrosPerMTok,
            }
          : {}),
        maxRequestBytes: 8 * 1024 * 1024,
      },
    },
    spec: {
      ...base.spec,
      runId: worker.executionId,
      executionId: worker.executionId,
      image: { reference: image.reference, id: image.id, platform: image.platform },
      inputs: input.inputs,
      policy,
      reservation: policy,
      deadlineUtc: new Date(Date.now() + (liveRoute ? 480000 : 300000)).toISOString(),
      maxElapsedMs: mode === 'timeout' ? 1500 : liveRoute ? 360000 : 90000,
      gateway: { route, authorization: policy },
      limits: {
        ...base.spec.limits,
        memoryBytes: 768 * 1024 * 1024,
        cpuMillis: 2000,
        pids: 128,
        workspace: { bytes: 32 * 1024 * 1024, inodes: 8192 },
        work: { bytes: 16 * 1024 * 1024, inodes: 4096 },
        tmp: { bytes: 16 * 1024 * 1024, inodes: 4096 },
        outputBytes: worker.outputBytes,
        shellTimeoutMs: worker.shellTimeoutMs,
      },
    },
  }
  for (const mount of config.spec.mounts)
    mount.source = join(
      config.hostRoot,
      executionName(config.spec),
      mount.target === '/gateway' ? 'ipc' : mount.target.slice(1),
    )
  const configPath = join(root, 'config.json')
  await writeFile(configPath, canonicalJson(config), { mode: 0o600 })
  return {
    root,
    store,
    worker,
    input,
    config,
    configPath,
    credentialFile: liveRoute?.credentialFile,
  }
}
it.skipIf(process.env.DSH_LOCAL_GENERATION !== '1')(
  'runs the production local Docker owner and Loader, snapshots file/shell edits and verifies cleanup from CAS',
  async () => {
    let root = ''
    let frozen: unknown
    try {
      const made = await fixture()
      root = made.root
      const { store, worker, config, configPath } = made
      frozen = config
      let output: unknown
      try {
        output = await exec(
          process.execPath,
          [
            resolve('packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js'),
            'run',
            configPath,
          ],
          { timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
        )
      } catch (error) {
        output = {
          code: (error as any).code,
          stdout: (error as any).stdout,
          stderr: (error as any).stderr,
        }
      }
      const result = await readFrozenGeneration(config)
      const report = process.env.DSH_LOCAL_GENERATION_REPORT
      if (report)
        await writeFile(
          report,
          JSON.stringify(
            {
              scope: 'actual local Docker production runner + replay Loader',
              casRoot: store.root,
              config,
              result,
              output,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
      expect(result.result.outcome, JSON.stringify(output)).toBe('SUCCEEDED')
      const expected = {
        store,
        spec: config.spec,
        children: ['child-1'],
        parentSourceHash: worker.parentSourceHash,
      }
      const submission = await verifySubmission({
        ...expected,
        ref: result.result.submission!,
        generationOnly: true,
      })
      const snapshot = await readSourceSnapshot(store, submission.sources[0]!.source)
      const file = snapshot.files.find((file) => file.path === 'generation-probe.txt')!
      expect((await store.read(file.content)).toString()).toBe('model-edit-shell-edit')
      const engine = localDockerEngine()
      await expect(
        engine.json('GET', `/containers/${executionName(config.spec)}/json`),
      ).rejects.toBeInstanceOf(DockerApiError)
      await rm(root, { recursive: true, force: true })
      expect(await readGenerationResult(result.ref, expected)).toEqual(result.result)
    } finally {
      // Preserve the trusted registry on failure so explicit sweep can reclaim owned resources.
      if (!frozen && root) await rm(root, { recursive: true, force: true })
    }
  },
  300000,
)

it.skipIf(process.env.DSH_LOCAL_GENERATION !== '1')(
  'kills an orphan by explicit sweep without restarting worker/model and enforces a wall timeout',
  async () => {
    for (const mode of ['orphan', 'timeout'] as const) {
      const f = await fixture(mode)
      const cli = resolve('packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js')
      if (mode === 'orphan') {
        const child = spawn(process.execPath, [cli, 'run', f.configPath], {
          env: { PATH: '/usr/bin:/bin' },
          stdio: 'ignore',
        })
        const exit = new Promise((resolveExit) => child.once('exit', resolveExit))
        const attempt = join(f.config.hostRoot, executionName(f.config.spec))
        const engine = localDockerEngine()
        let owner: number | null = null
        const until = performance.now() + 90000
        while (performance.now() < until) {
          owner = await readKernelLockOwner(attempt)
          try {
            const actual = await engine.json<{ State: { Running: boolean } }>(
              'GET',
              `/containers/${executionName(f.config.spec)}/json`,
            )
            if (owner && actual.State.Running) break
          } catch (error) {
            if (!(error instanceof DockerApiError && error.status === 404)) throw error
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100))
        }
        expect(owner).toBeGreaterThan(0)
        process.kill(owner!, 'SIGKILL')
        await exit
        await exec(process.execPath, [cli, 'sweep', f.configPath], {
          timeout: 90000,
          maxBuffer: 1048576,
        })
        await expect(
          engine.json('GET', `/containers/${executionName(f.config.spec)}/json`),
        ).rejects.toBeInstanceOf(DockerApiError)
        // Existing effect receipts and reservation are reclaimed; no new owner starts a worker.
        const receiptNames = await import('node:fs/promises').then((fs) =>
          fs.readdir(join(attempt, 'cleanup-receipts')),
        )
        expect(receiptNames).toHaveLength(1)
        const receipt = await readCanonicalFile(join(attempt, 'cleanup-receipts', receiptNames[0]!))
        const output = process.env.DSH_LOCAL_GENERATION_REPORT
        if (output)
          await writeFile(
            `${output}.orphan.json`,
            JSON.stringify({ config: f.config, cleanup: receipt }, null, 2) + '\n',
            { flag: 'wx' },
          )
      } else {
        await expect(
          exec(process.execPath, [cli, 'run', f.configPath], {
            timeout: 90000,
            maxBuffer: 1048576,
          }),
        ).rejects.toMatchObject({ code: 1 })
        const result = await readFrozenGeneration(f.config)
        expect(result.result.outcome).not.toBe('SUCCEEDED')
        expect(result.result.submission).toBeNull()
        expect(result.result.completion).not.toBeNull()
        const output = process.env.DSH_LOCAL_GENERATION_REPORT
        if (output)
          await writeFile(
            `${output}.timeout.json`,
            JSON.stringify({ config: f.config, result }, null, 2) + '\n',
            { flag: 'wx' },
          )
      }
      await rm(f.root, { recursive: true, force: true })
    }
  },
  300000,
)

it.skipIf(
  process.env.DSH_LOCAL_GENERATION_LIVE !== '1' || !process.env.DSH_LOCAL_GENERATION_LIVE_CONFIG,
)(
  'generates source with one bounded real provider attempt and keeps credentials outside all artifacts',
  async () => {
    const f = await fixture('live')
    const cli = resolve('packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js')
    let execution: unknown
    try {
      execution = await exec(
        process.execPath,
        [cli, 'run', f.configPath, '--credential-file', f.credentialFile],
        { timeout: 480000, maxBuffer: 1048576 },
      )
    } catch (error) {
      execution = {
        code: (error as any).code,
        stdout: (error as any).stdout,
        stderr: (error as any).stderr,
      }
    }
    const result = await readFrozenGeneration(f.config)
    const output = process.env.DSH_LOCAL_GENERATION_REPORT
    if (output)
      await writeFile(
        `${output}.live.json`,
        JSON.stringify({ config: f.config, result, execution }, null, 2) + '\n',
        { flag: 'wx' },
      )
    expect(result.result.outcome, JSON.stringify(execution)).toBe('SUCCEEDED')
    const secret = (await readFile(f.credentialFile, 'utf8')).trim()
    const bundle = await verifyExecutionBundle(f.store, result.result.execution!)
    let leaked = false
    for (const artifact of bundle.artifacts)
      if ((await f.store.read(artifact)).includes(secret)) leaked = true
    expect(leaked).toBe(false)
    await rm(f.root, { recursive: true, force: true })
  },
  600000,
)

it.skipIf(process.env.DSH_LOCAL_GENERATION !== '1')(
  'feeds actual Docker snapshots into the existing controller validation/admission path exactly once',
  async () => {
    const f = await fixture()
    const binding = await readProposalInputBinding(f.store, f.config.inputManifest, f.config.spec)
    const attempt = join(f.config.hostRoot, executionName(f.config.spec))
    let calls = 0
    const runner: ProposalRunner = async (input) => {
      calls++
      await exec(
        process.execPath,
        [
          resolve('packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js'),
          'run',
          f.configPath,
        ],
        { timeout: 180000, maxBuffer: 1048576 },
      )
      const result = await readFrozenGeneration(f.config)
      const outcome = {
        backend: 'local-generation/v1' as const,
        configuration: f.config as any,
        result: result.ref,
      }
      await publishCanonical(join(input.sandboxRoot, 'generation-handoff.json'), outcome)
      return outcome
    }
    runner.backend = 'local-generation/v1'
    runner.profile = { backend: 'local-generation/v1', mode: 'replay', image: f.config.spec.image }
    const controller = await Controller.open(
      join(f.root, 'controller'),
      f.store.root,
      {
        runId: f.config.spec.runId,
        budgetLimits: { usd: 100000, 'proposer-tokens': 4000000, 'proposal-calls': 5 },
        proposalRunner: runner,
      },
      new FakeProvider(),
    )
    try {
      const input = {
        actionId: f.config.spec.actionId,
        request: {
          parentCandidateId: binding.config.candidateId,
          parentSourceHash: binding.config.parentSourceHash,
          exportId: binding.exportManifest.exportId,
          width: 1,
        },
        estimate: [
          { dimension: 'usd' as const, amount: 100 },
          { dimension: 'proposer-tokens' as const, amount: 2000000 },
          { dimension: 'proposal-calls' as const, amount: 1 },
        ],
        capsuleDir: join(attempt, 'input/capsule'),
        parentTreeDir: join(attempt, 'input/parent'),
        exportDir: join(attempt, 'input/export'),
        catalog: binding.catalog,
        canaryTokens: [],
        priorRejections: [],
      }
      const result = await controller.runProposal(input)
      const output = process.env.DSH_LOCAL_GENERATION_REPORT
      if (output)
        await writeFile(
          `${output}.controller.json`,
          JSON.stringify(
            {
              config: f.config,
              result,
              artifacts: controller.state.actions[input.actionId]?.artifacts,
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        )
      expect(result.status).toBe('COMMITTED')
      expect(result.summary.admitted).toHaveLength(1)
      expect(result.summary.sandbox.kind).toBe('docker')
      expect((await controller.runProposal(input)).status).toBe('COMMITTED')
      expect(calls).toBe(1)
    } finally {
      await controller.close()
    }
    await rm(f.root, { recursive: true, force: true })
  },
  300000,
)
