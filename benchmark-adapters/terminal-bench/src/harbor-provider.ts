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
  SolveReceiptVerification,
} from '@dsh-evolve-le/core'
import type { ObservationOutcome } from '@dsh-evolve-le/core'
import { planSubmission } from './provider.js'
import { normalizeJob, type NormalizedTrial } from './normalize.js'
import type { SubmissionLedger } from './idempotency.js'
import {
  effectiveTaskAgentTimeoutMs,
  SOLVE_AGENT_TIMEOUT_ENV,
  taskAgentTimeoutSec,
} from './task-timeout.js'

/** The controller's evaluation-request shape (core `EvaluationRequest`). */
export interface HarborEvaluationRequest {
  candidateId: string
  opaqueTaskId: string
  attempt: number
  split: 'dev-observed' | 'dev-guard' | 'sealed'
}

/**
 * Live-solve gateway wiring (ADR-030): all three env values and the mounted
 * token PATH are non-secret; the token VALUE stays inside the 0600 root-only
 * file and the trial container. The CLI composition binds `enroll` to the
 * controller's `openSolveGateway` instance (idempotent per jobName).
 */
export interface HarborSolveGateway {
  /** Frozen route id, recorded in the terminal fact's solver block. */
  routeId: string
  /** Native DSH provider/model lock, copied into the per-trial environment. */
  nativeProvider?: string
  nativeModel?: string
  nativeMaxTokens?: number
  /** Artifact-listener base URL the trial containers POST to. */
  url: string
  /** Frozen route-plan hash the capsule enforces on every reply. */
  routeHash: string
  /** Mount target of the token file inside the container. */
  containerTokenPath: string
  /** Enroll one jobName; resolves the host-side token file to bind-mount. */
  enroll(jobName: string): Promise<{ tokenFilePath: string }>
}

export interface HarborProviderConfig {
  runId: string
  /** Harbor binary (config `benchmark.harbor.bin`); never a Python bridge. */
  harborBin: string
  harborVersion: string
  tasksRoot: string
  /** Frozen Terminal-Bench eligibility ceiling (seconds). */
  maxAgentTimeoutSec: number
  jobsRoot: string
  concurrentTrials: number
  ledger: SubmissionLedger
  /** Opaque guard id → real task handle; TCB-only (sealed split store). */
  guardMap?: Record<string, string>
  /**
   * Opaque sealed id → real task handle (ADR-048); TCB-only, bound by the
   * sealed-evaluate CLI, never by the development driver.
   */
  sealedMap?: Record<string, string>
  /** JobConfig YAML staging directory (default `<jobsRoot>/.plans`). */
  plansDir?: string
  /** Read-only container mounts (CA bundle for the artifact endpoint). */
  mounts?: { source: string; target: string }[]
  /** Container environment entries (e.g. SSL_CERT_FILE). */
  env?: Record<string, string>
  /**
   * Live solver route (ADR-030). When set, every planned job enrolls with the
   * solve gateway and its JobConfig gains the read-only token mount plus the
   * three non-secret env values; `collect` then demands a receipt-verified
   * solver block (fail closed, specs/02 §13). Requires `solveUsage`.
   */
  solveGateway?: HarborSolveGateway
  /**
   * Receipt-verified solver usage for one finished job, derived ONLY from the
   * terminal receipts file (byte-stable across collects and restarts). Bound
   * by the CLI to the controller's receipt verifier over the gateway stateDir.
   */
  solveUsage?: (jobName: string) => Promise<SolveReceiptVerification>
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

/**
 * The live-solver usage block appended to a terminal fact (ADR-030). Every
 * figure comes from the receipt verifier over the receipts file; `problems`
 * is empty on the only path that emits the block (a failing chain throws).
 * No timestamps: the fact must be byte-stable across repeated collects.
 */
export interface SolverFactBlock {
  routeId: string
  routeHash: string
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsdMicros: number
  errorReceipts: number
  problems: string[]
}

function toOutcome(trial: NormalizedTrial): ObservationOutcome {
  if (trial.status === 'pass') return 'success'
  if (trial.status === 'infra_retryable') return 'missing'
  return 'failure'
}

/**
 * Zero-usage solver block for a trial whose agent never booted (F6, K=10
 * attempt 1): the gateway's receipts are written TCB-side by the controller,
 * so a container cannot suppress them — a trial that never reached the ACP
 * handshake can never have made an authenticated request, and "no receipts
 * file" is the honest zero rather than an attribution failure. The block still
 * names the frozen route so the terminal fact keeps its shape.
 */
function zeroUsageSolverBlock(gateway: HarborSolveGateway): SolverFactBlock {
  return {
    routeId: gateway.routeId,
    routeHash: gateway.routeHash,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsdMicros: 0,
    errorReceipts: 0,
    problems: [],
  }
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
  /** One entry per solve-gateway enrollment call (idempotent per jobName). */
  readonly solveEnrollments: string[] = []

  constructor(private readonly config: HarborProviderConfig) {
    // A live route without a usage verifier would spend solver tokens that
    // never settle against the budget dimension — wire both or neither.
    if (this.config.solveGateway !== undefined && this.config.solveUsage === undefined) {
      throw new HarborProviderError(
        'solveGateway is set but solveUsage is missing (solver tokens would never settle)',
      )
    }
    if (this.config.solveGateway === undefined && this.config.solveUsage !== undefined) {
      throw new HarborProviderError(
        'solveUsage is set but solveGateway is missing (no trial would produce receipts)',
      )
    }
  }

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
    if (request.split === 'sealed') {
      const handle = this.config.sealedMap?.[request.opaqueTaskId]
      if (handle === undefined) {
        throw new HarborProviderError(
          `no sealed mapping for ${request.opaqueTaskId} (sealed split store missing?)`,
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
      (value?.['split'] !== 'dev-observed' &&
        value?.['split'] !== 'dev-guard' &&
        value?.['split'] !== 'sealed')
    ) {
      throw new HarborProviderError(
        `launch request is not an evaluation request: ${JSON.stringify(request)}`,
      )
    }
    // ADR-046: any attempt ≥ 1 is a launchable paid identity; 0/NaN/fractional
    // attempts name no trial at all.
    if (
      typeof value?.['attempt'] !== 'number' ||
      !Number.isSafeInteger(value['attempt'] as number) ||
      (value['attempt'] as number) < 1
    ) {
      throw new HarborProviderError(
        `launch request attempt must be a positive safe integer, got ${JSON.stringify(value?.['attempt'])}`,
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
    // ADR-046: attempt N of one (candidate, task) is its own paid identity —
    // the request-level attempt feeds the ledger key (trialAttempt) while the
    // JobConfig n_attempts stays 1 (one Harbor job = one trial).
    const handle = this.resolveHandle(evaluation)
    const solveGateway = this.config.solveGateway
    // Harbor applies AGENT_TIMEOUT_MULTIPLIER to this TB-native base limit.
    // Resolve it before the paid reservation; a missing/malformed task limit
    // is a TCB configuration error, never an opportunity for a static fallback.
    const effectiveAgentTimeoutMs =
      solveGateway === undefined
        ? undefined
        : effectiveTaskAgentTimeoutMs(
            await taskAgentTimeoutSec(join(this.config.tasksRoot, handle)),
          )
    const plan = await planSubmission({
      runId: this.config.runId,
      tasksRoot: this.config.tasksRoot,
      handles: [handle],
      capsuleArchiveSha256: capsule.capsuleArchiveSha256,
      archiveUrl: capsule.archiveUrl,
      jobsRoot: this.config.jobsRoot,
      harborVersion: this.config.harborVersion,
      maxAgentTimeoutSec: this.config.maxAgentTimeoutSec,
      attempts: 1,
      // Attempt 1 keeps the historical key shape (no trialAttempt field):
      // pre-ADR-046 ledger entries resume unchanged.
      ...(evaluation.attempt > 1 ? { trialAttempt: evaluation.attempt } : {}),
      concurrentTrials: this.config.concurrentTrials,
      ledger: this.config.ledger,
      controllerKey: idempotencyKey,
      ...(this.config.mounts !== undefined ? { mounts: this.config.mounts } : {}),
      ...(this.config.env !== undefined ? { env: this.config.env } : {}),
      ...(solveGateway !== undefined
        ? {
            perJob: async (jobName: string) => {
              // Enrollment is idempotent per jobName, so calling it on every
              // plan (new or resumed) cannot mint a second token or budget.
              this.solveEnrollments.push(jobName)
              const { tokenFilePath } = await solveGateway.enroll(jobName)
              return {
                mounts: [{ source: tokenFilePath, target: solveGateway.containerTokenPath }],
                env: {
                  DSH_SOLVE_GATEWAY_URL: solveGateway.url,
                  DSH_SOLVE_GATEWAY_TOKEN_FILE: solveGateway.containerTokenPath,
                  DSH_SOLVE_GATEWAY_ROUTE_HASH: solveGateway.routeHash,
                  [SOLVE_AGENT_TIMEOUT_ENV]: String(effectiveAgentTimeoutMs),
                  ...(solveGateway.nativeProvider === undefined ||
                  solveGateway.nativeModel === undefined
                    ? {}
                    : {
                        DSH_NATIVE_PROVIDER: solveGateway.nativeProvider,
                        DSH_NATIVE_MODEL: solveGateway.nativeModel,
                        ...(solveGateway.nativeMaxTokens === undefined
                          ? {}
                          : { DSH_NATIVE_MAX_TOKENS: String(solveGateway.nativeMaxTokens) }),
                      }),
                },
              }
            },
          }
        : {}),
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
    // Solver block (ADR-030 + ADR-040): derived only from the receipt verifier
    // over the terminal receipts file — no gateway memory, no timestamps — so
    // repeated collects (across crashes and restarts) emit identical bytes.
    // ADR-040 makes the chain receipt-first: a verified chain with requests
    // always yields its figures, whatever Harbor's participation heuristic
    // says (an AgentTimeoutError kill discards the capsule report but the
    // gateway still recorded every request — attempt 13's 262,250-token trial
    // was zero-settled by the old participation-first branch). The heuristic
    // now only downgrades a MISSING chain to the honest zero (a never-booted
    // agent can never have called the gateway — K=10 attempt 1); any other
    // broken chain keeps the fail-closed throw.
    const solver =
      this.config.solveUsage !== undefined && this.config.solveGateway !== undefined
        ? await this.solverBlockFor(
            externalJobId,
            trial.outcome.agentParticipation === 'never-initialized' ||
              trial.status === 'infra_retryable',
          )
        : undefined
    const trajectory = Buffer.from(
      JSON.stringify({
        protocol: TERMINAL_FACT_PROTOCOL,
        jobName: entry.jobName,
        idempotencyKey: entry.key,
        artifactSha256: artifact.artifactSha256,
        trial: factTrial,
        ...(solver !== undefined ? { solver } : {}),
      }),
      'utf8',
    )
    return {
      outcome: toOutcome(trial),
      costUsdMicros:
        trial.usage.costUsd === null ? null : Math.round(trial.usage.costUsd * 1_000_000),
      durationMs: trial.usage.agentExecutionMs,
      // Null for replay trials (no live solver route configured).
      solverTokens: solver === undefined ? null : solver.totalTokens,
      trajectory,
    }
  }

  /** Receipt-verified solver usage, or a fail-closed throw (specs/02 §13). */
  private async solverBlockFor(
    jobName: string,
    honestZeroOnMissingChain: boolean,
  ): Promise<SolverFactBlock> {
    const gateway = this.config.solveGateway
    const solveUsage = this.config.solveUsage
    if (gateway === undefined || solveUsage === undefined) {
      throw new HarborProviderError(`solver block requested for ${jobName} without solve wiring`)
    }
    const verification = await solveUsage(jobName)
    if (!verification.ok) {
      // ADR-040: only the never-booted classification turns a missing/gapped
      // chain into the honest zero; a gapped/tampered receipt chain for any
      // other trial is an attribution failure — the run fails closed instead
      // of scoring an unattributable trial.
      if (honestZeroOnMissingChain) {
        return zeroUsageSolverBlock(gateway)
      }
      throw new HarborProviderError(
        `job ${jobName} solver receipts failed verification: ${verification.problems.join('; ')}`,
      )
    }
    return {
      routeId: gateway.routeId,
      routeHash: gateway.routeHash,
      requests: verification.usage.requests,
      promptTokens: verification.usage.promptTokens,
      completionTokens: verification.usage.completionTokens,
      totalTokens: verification.usage.totalTokens,
      costUsdMicros: verification.usage.costUsdMicros,
      errorReceipts: verification.errorReceipts,
      problems: verification.problems,
    }
  }
}
