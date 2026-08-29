/**
 * Harbor BenchmarkProvider adapter (Gate 5, specs/07 §7; CLAUDE.md rules 2, 7,
 * 8): the trusted TypeScript implementation of the controller's
 * `BenchmarkProvider` port over real Harbor 0.21.0 jobs. One evaluation
 * action = one planned Harbor job = one task handle × one attempt × one
 * candidate capsule; the paid identity is the ledger key over
 * (run, capsule, inventory, handle, attempts, harbor version), and the
 * controller's action key is recorded beside it — never inside it.
 *
 * Effects and only effects:
 * - `launch` plans (idempotent via the append-only ledger), writes the
 *   JobConfig YAML under the jobs root, and runs `harbor run -c … -y -q` to
 *   completion. Re-launching the same controller key never re-spawns Harbor
 *   (no second paid trial); a different controller key hitting an already-paid
 *   identity fails closed.
 * - `inspect`/`inspectByKey` are read-only filesystem probes (job-level
 *   `result.json` is Harbor's terminal marker).
 * - `collect` re-reads the job directory through `normalizeJob` — no Harbor
 *   state, no network — and folds the single planned trial into the
 *   controller's terminal fact. `protocol_invalid` trials invalidate the run
 *   (thrown, never quietly scored); infra-retryable trials map to the
 *   reward-less `missing` observation and stay in the denominator.
 *
 * Guard concealment: the controller only ever names `guard-NN` opaque ids;
 * the real guard handle mapping is injected here (TCB-only, from the sealed
 * split store) and never appears in any controller-visible document.
 * @module @dsh-evolve-le/tb-provider/harbor-provider
 */

import { spawn } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BenchmarkProvider,
  ProviderInspect,
  ProviderJobStatus,
  ProviderTerminal,
} from '@dsh-evolve-le/core'
import type { ObservationOutcome } from '@dsh-evolve-le/core'
import { planSubmission } from './provider.js'
import { normalizeJob, type NormalizedTrial } from './normalize.js'
import type { SubmissionLedger } from './idempotency.js'

/** The controller's evaluation-request shape (core `EvaluationRequest`). */
export interface HarborEvaluationRequest {
  candidateId: string
  opaqueTaskId: string
  attempt: number
  split: 'dev-observed' | 'dev-guard'
}

export interface HarborProviderConfig {
  runId: string
  /** Harbor binary (config `benchmark.harbor.bin`); never a Python bridge. */
  harborBin: string
  harborVersion: string
  tasksRoot: string
  jobsRoot: string
  concurrentTrials: number
  ledger: SubmissionLedger
  /** Opaque guard id → real task handle; TCB-only (sealed split store). */
  guardMap?: Record<string, string>
  /** JobConfig YAML staging directory (default `<jobsRoot>/.plans`). */
  plansDir?: string
  /** Read-only container mounts (CA bundle for the artifact endpoint). */
  mounts?: { source: string; target: string }[]
  /** Container environment entries (e.g. SSL_CERT_FILE). */
  env?: Record<string, string>
  /**
   * Harbor runner seam: defaults to the real `harbor run` spawn. Tests
   * substitute a fake that materializes a terminal job directory.
   */
  runHarbor?: (configPath: string, jobDir: string) => Promise<void>
}

export interface RegisteredCapsule {
  capsuleArchiveSha256: string
  archiveUrl: string
}

export class HarborProviderError extends Error {
  constructor(message: string) {
    super(`harbor-provider: ${message}`)
    this.name = 'HarborProviderError'
  }
}

/** Terminal fact media carried to the controller's object store. */
export const TERMINAL_FACT_PROTOCOL = 'dsh-evolve-le/tb-terminal-fact/v1'

function toOutcome(trial: NormalizedTrial): ObservationOutcome {
  if (trial.status === 'pass') return 'success'
  if (trial.status === 'infra_retryable') return 'missing'
  return 'failure'
}

async function defaultRunHarbor(
  harborBin: string,
  configPath: string,
  jobDir: string,
): Promise<void> {
  const code = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(harborBin, ['run', '-c', configPath, '-y', '-q'], {
      cwd: jobDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Harbor's live progress (e.g. "1/1 Mean: …") mirrors to stderr: CLI
    // stdout must stay machine-parseable (the drive report is printed there);
    // the durable copy lives in the job dir's own job.log.
    child.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (exitCode) => resolvePromise(exitCode ?? -1))
  })
  if (code !== 0) {
    throw new HarborProviderError(`harbor run exited ${code}: see harbor output above`)
  }
}

export class HarborProvider implements BenchmarkProvider {
  readonly name = 'terminal-bench-2-1/harbor'
  private readonly capsules = new Map<string, RegisteredCapsule>()
  /** One entry per REAL harbor spawn (idempotent re-launch: none). */
  readonly launchEffects: string[] = []

  constructor(private readonly config: HarborProviderConfig) {}

  /** Bind a candidate id to its capsule identity before any launch. */
  registerCapsule(candidateId: string, capsule: RegisteredCapsule): this {
    this.capsules.set(candidateId, capsule)
    return this
  }

  private resolveHandle(request: HarborEvaluationRequest): string {
    if (request.split === 'dev-guard') {
      const handle = this.config.guardMap?.[request.opaqueTaskId]
      if (handle === undefined) {
        throw new HarborProviderError(
          `no guard mapping for ${request.opaqueTaskId} (sealed split store missing?)`,
        )
      }
      return handle
    }
    return request.opaqueTaskId
  }

  private parseRequest(request: unknown): HarborEvaluationRequest {
    const value = request as Record<string, unknown>
    if (
      typeof value?.['candidateId'] !== 'string' ||
      typeof value?.['opaqueTaskId'] !== 'string' ||
      typeof value?.['attempt'] !== 'number' ||
      (value?.['split'] !== 'dev-observed' && value?.['split'] !== 'dev-guard')
    ) {
      throw new HarborProviderError(
        `launch request is not an evaluation request: ${JSON.stringify(request)}`,
      )
    }
    return {
      candidateId: value['candidateId'],
      opaqueTaskId: value['opaqueTaskId'],
      attempt: value['attempt'],
      split: value['split'],
    }
  }

  async launch(request: unknown, idempotencyKey: string): Promise<{ externalJobId: string }> {
    const evaluation = this.parseRequest(request)
    const capsule = this.capsules.get(evaluation.candidateId)
    if (capsule === undefined) {
      throw new HarborProviderError(`candidate ${evaluation.candidateId} has no registered capsule`)
    }
    if (evaluation.attempt !== 1) {
      // One Harbor job = one task × one attempt (specs/04 §5 trial tuple); a
      // second attempt is a different paid identity and needs its own ADR,
      // not a silent ledger collision.
      throw new HarborProviderError(
        `attempt ${evaluation.attempt} unsupported: one paid trial per (candidate, task)`,
      )
    }
    const handle = this.resolveHandle(evaluation)
    const plan = await planSubmission({
      runId: this.config.runId,
      tasksRoot: this.config.tasksRoot,
      handles: [handle],
      capsuleArchiveSha256: capsule.capsuleArchiveSha256,
      archiveUrl: capsule.archiveUrl,
      jobsRoot: this.config.jobsRoot,
      harborVersion: this.config.harborVersion,
      attempts: 1,
      concurrentTrials: this.config.concurrentTrials,
      ledger: this.config.ledger,
      controllerKey: idempotencyKey,
      ...(this.config.mounts !== undefined ? { mounts: this.config.mounts } : {}),
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
    })
    if (plan.status === 'existing' && plan.entry.controllerKey !== idempotencyKey) {
      throw new HarborProviderError(
        `paid identity collision: job ${plan.jobName} already ran for controller key ${plan.entry.controllerKey ?? '<none>'}`,
      )
    }
    if (plan.status === 'new') {
      const plansDir = this.config.plansDir ?? join(this.config.jobsRoot, '.plans')
      await mkdir(plansDir, { recursive: true })
      const configPath = join(plansDir, `${plan.jobName}.yaml`)
      await writeFile(configPath, plan.jobPlan.yaml, 'utf8')
      await mkdir(plan.jobDir, { recursive: true })
      this.launchEffects.push(plan.jobName)
      const runner = this.config.runHarbor ?? defaultRunHarbor.bind(null, this.config.harborBin)
      await runner(configPath, plan.jobDir)
    }
    return { externalJobId: plan.jobName }
  }

  private async jobStatus(jobName: string): Promise<ProviderJobStatus> {
    const entry = await this.config.ledger.lookupByJobName(jobName)
    const jobDir = entry?.jobDir ?? join(this.config.jobsRoot, jobName)
    const dirStat = await stat(jobDir).catch(() => undefined)
    if (dirStat === undefined) {
      return entry === undefined ? 'UNKNOWN' : 'LOST'
    }
    const resultStat = await stat(join(jobDir, 'result.json')).catch(() => undefined)
    return resultStat?.isFile() === true ? 'SUCCEEDED' : 'RUNNING'
  }

  async inspect(externalJobId: string): Promise<ProviderInspect> {
    return { status: await this.jobStatus(externalJobId) }
  }

  async inspectByKey(
    idempotencyKey: string,
  ): Promise<{ externalJobId: string; status: ProviderJobStatus } | null> {
    const entry = await this.config.ledger.lookupByControllerKey(idempotencyKey)
    if (entry === undefined) return null
    return { externalJobId: entry.jobName, status: await this.jobStatus(entry.jobName) }
  }

  async collect(externalJobId: string): Promise<ProviderTerminal> {
    const entry = await this.config.ledger.lookupByJobName(externalJobId)
    if (entry === undefined) {
      throw new HarborProviderError(`collect of unknown job ${externalJobId}`)
    }
    const artifact = await normalizeJob({
      jobDir: entry.jobDir,
      jobName: entry.jobName,
      idempotencyKey: entry.key,
      identity: {
        runId: entry.runId,
        capsuleArchiveSha256: entry.capsuleArchiveSha256,
        inventorySha256: entry.inventorySha256,
        handles: entry.handles,
        attempts: entry.attempts,
        harborVersion: entry.harborVersion,
      },
    })
    if (!artifact.counts.valid) {
      // TCB attribution/plan violations invalidate the run; they never enter
      // the stats quietly (specs/04 §5; CLAUDE.md rule 7).
      const invalid = artifact.trials.filter((trial) => trial.status === 'protocol_invalid')
      throw new HarborProviderError(
        `job ${entry.jobName} is protocol-invalid: ${invalid
          .map((trial) => `${trial.identity.handle}: ${trial.outcome.reason}`)
          .join('; ')}`,
      )
    }
    const trial = artifact.trials[0]
    if (trial === undefined) {
      throw new HarborProviderError(`job ${entry.jobName} produced no trials`)
    }
    // Guard concealment: a guard task's terminal fact carries only the opaque
    // id the controller named — the real handle stays in TCB evidence (ledger
    // + raw job directory) and never enters controller-visible storage.
    const opaqueForHandle = new Map(
      Object.entries(this.config.guardMap ?? {}).map(([opaque, handle]) => [handle, opaque]),
    )
    const handle = entry.handles[0] ?? trial.identity.handle
    const opaque = opaqueForHandle.get(handle)
    const factTrial =
      opaque === undefined
        ? trial
        : { ...trial, taskName: opaque, identity: { ...trial.identity, handle: opaque } }
    const trajectory = Buffer.from(
      JSON.stringify({
        protocol: TERMINAL_FACT_PROTOCOL,
        jobName: entry.jobName,
        idempotencyKey: entry.key,
        artifactSha256: artifact.artifactSha256,
        trial: factTrial,
      }),
      'utf8',
    )
    return {
      outcome: toOutcome(trial),
      costUsdMicros:
        trial.usage.costUsd === null ? null : Math.round(trial.usage.costUsd * 1_000_000),
      durationMs: trial.usage.agentExecutionMs,
      trajectory,
    }
  }
}
