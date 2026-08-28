/**
 * Per-trial normalization (Gate 2, specs/04 §5-7, specs/06; CLAUDE.md rule 7):
 * turn raw Harbor trial directories into canonical, content-addressed trial
 * records and one run artifact. Classification is fail-closed by default —
 * missing, corrupt, timed-out, or unattributable outcomes record FAIL and
 * stay in the denominator; only the pre-registered, reward-blind
 * infrastructure exception set (below) is INFRA_RETRYABLE, and TCB-level
 * attribution violations (wrong candidate, wrong task set, unexpected extra
 * trials) invalidate the whole run as PROTOCOL_INVALID rather than quietly
 * entering the stats. Nothing is ever dropped.
 *
 * Harbor facts this binds to (0.21.0): trial dirs `jobs/<jobs_dir>/<job_name>
 * /<trial_name>/{config.json,lock.json,result.json,exception.txt,trial.log}`;
 * `result.json` is a `TrialResult` whose `verifier_result.rewards["reward"]`
 * carries the score, `agent_info` is the registry entry's id/version (we set
 * version to the capsule archive sha256), and `exception_info.exception_type`
 * names the failure. Trials carry no attempt index — attempts expand to
 * sibling trial dirs, so the normalizer assigns attempt ordinals by sorted
 * trial name within each (task, agent) group.
 * @module @dsh-evolve-le/tb-provider/normalize
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ACP_AGENT_ID } from './registry.js'

export const TRIAL_PROTOCOL = 'dsh-evolve-le/tb-trial/v1'
export const RUN_PROTOCOL = 'dsh-evolve-le/tb-run/v1'

/**
 * Pre-registered, reward-blind infrastructure exception types (specs/04 §5):
 * every entry fails before the agent can influence the environment, so the
 * reward cannot depend on candidate behavior. Adding an entry requires an
 * ADR; ambiguity resolves to FAIL, never to retry.
 */
export const INFRA_RETRYABLE_EXCEPTIONS = new Set([
  'EnvironmentStartTimeoutError',
  'SandboxBuildFailedError',
  'HealthcheckError',
])

export type TrialStatus = 'pass' | 'fail' | 'infra_retryable' | 'protocol_invalid'

export type OutcomeCategory =
  | 'reward'
  | 'exception'
  | 'missing-trial'
  | 'missing-result'
  | 'unparsable-result'
  | 'missing-trajectory'
  | 'missing-reward'
  | 'attribution'
  | 'plan-mismatch'

export interface TrialIdentity {
  runId: string
  capsuleArchiveSha256: string
  inventorySha256: string
  handle: string
  attempt: number
}

export interface NormalizedTrial {
  protocol: typeof TRIAL_PROTOCOL
  identity: TrialIdentity
  /** Harbor trial directory name (random short uuid suffix). */
  trialName: string | null
  taskName: string | null
  agentInfo: { name: string | null; version: string | null }
  status: TrialStatus
  outcome: {
    category: OutcomeCategory
    reward: number | null
    exceptionType: string | null
    reason: string
  }
  usage: {
    agentExecutionMs: number | null
    verifierMs: number | null
    nInputTokens: number | null
    nOutputTokens: number | null
    costUsd: number | null
  }
  /** sha256 of the raw result.json bytes this record was derived from. */
  resultDigest: string | null
}

export interface RunArtifact {
  protocol: typeof RUN_PROTOCOL
  jobName: string
  jobDir: string
  idempotencyKey: string
  identity: {
    runId: string
    capsuleArchiveSha256: string
    inventorySha256: string
    handles: string[]
    attempts: number
    harborVersion: string
  }
  plannedTrials: number
  trials: NormalizedTrial[]
  counts: {
    pass: number
    fail: number
    infraRetryable: number
    protocolInvalid: number
    /** Trials that cannot be trusted at all: protocolInvalid > 0 invalidates. */
    valid: boolean
    /** Reward denominator: planned trials; infra retries reported separately. */
    denominator: number
    passRate: number | null
  }
  artifactSha256: string
}

/** Canonical JSON: recursively key-sorted, no whitespace — the hash basis. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

interface HarborTiming {
  started_at?: string | null
  finished_at?: string | null
}

interface HarborResultJson {
  task_name?: string
  trial_name?: string
  agent_info?: { name?: string; version?: string }
  verifier_result?: { rewards?: Record<string, number> | null } | null
  exception_info?: { exception_type?: string; exception_message?: string } | null
  agent_result?: {
    n_input_tokens?: number | null
    n_output_tokens?: number | null
    cost_usd?: number | null
  } | null
  agent_execution?: HarborTiming | null
  verifier?: HarborTiming | null
}

function durationMs(timing: HarborTiming | null | undefined): number | null {
  if (
    timing?.started_at === undefined ||
    timing?.finished_at === undefined ||
    timing.started_at === null ||
    timing.finished_at === null
  ) {
    return null
  }
  const ms = Date.parse(timing.finished_at) - Date.parse(timing.started_at)
  return Number.isFinite(ms) ? ms : null
}

function failRecord(
  identity: TrialIdentity,
  category: OutcomeCategory,
  reason: string,
  extra?: Partial<NormalizedTrial>,
): NormalizedTrial {
  return {
    protocol: TRIAL_PROTOCOL,
    identity,
    trialName: null,
    taskName: null,
    agentInfo: { name: null, version: null },
    status:
      category === 'attribution' || category === 'plan-mismatch' ? 'protocol_invalid' : 'fail',
    outcome: { category, reward: null, exceptionType: null, reason },
    usage: {
      agentExecutionMs: null,
      verifierMs: null,
      nInputTokens: null,
      nOutputTokens: null,
      costUsd: null,
    },
    resultDigest: null,
    ...extra,
  }
}

function normalizeResult(
  identity: TrialIdentity,
  trialName: string,
  raw: Buffer,
  plan: { capsuleArchiveSha256: string; agentName: string },
  trajectoryOk: boolean,
): NormalizedTrial {
  const digest = sha256Hex(raw)
  let parsed: HarborResultJson
  try {
    parsed = JSON.parse(raw.toString('utf8')) as HarborResultJson
  } catch (error) {
    return {
      ...failRecord(identity, 'unparsable-result', `result.json is not JSON: ${String(error)}`),
      trialName,
      resultDigest: digest,
    }
  }
  const base: Omit<NormalizedTrial, 'status' | 'outcome'> = {
    protocol: TRIAL_PROTOCOL,
    identity,
    trialName: parsed.trial_name ?? trialName,
    taskName: parsed.task_name ?? null,
    agentInfo: {
      name: parsed.agent_info?.name ?? null,
      version: parsed.agent_info?.version ?? null,
    },
    usage: {
      agentExecutionMs: durationMs(parsed.agent_execution),
      verifierMs: durationMs(parsed.verifier),
      nInputTokens: parsed.agent_result?.n_input_tokens ?? null,
      nOutputTokens: parsed.agent_result?.n_output_tokens ?? null,
      costUsd: parsed.agent_result?.cost_usd ?? null,
    },
    resultDigest: digest,
  }

  // Attribution first (specs/04 §5): a trial that cannot be pinned to the
  // planned candidate invalidates the run, whatever its reward says.
  if (parsed.agent_info?.name !== plan.agentName) {
    return {
      ...base,
      status: 'protocol_invalid',
      outcome: {
        category: 'attribution',
        reward: null,
        exceptionType: null,
        reason: `agent_info.name ${String(parsed.agent_info?.name)} != planned ${plan.agentName}`,
      },
    }
  }
  if (parsed.agent_info?.version !== plan.capsuleArchiveSha256) {
    return {
      ...base,
      status: 'protocol_invalid',
      outcome: {
        category: 'attribution',
        reward: null,
        exceptionType: null,
        reason: `agent_info.version ${String(parsed.agent_info?.version)} != capsule ${plan.capsuleArchiveSha256}`,
      },
    }
  }

  const reward = parsed.verifier_result?.rewards?.['reward']
  if (parsed.exception_info !== null && parsed.exception_info !== undefined) {
    const exceptionType = parsed.exception_info.exception_type ?? 'Unknown'
    const infra = INFRA_RETRYABLE_EXCEPTIONS.has(exceptionType)
    return {
      ...base,
      status: infra ? 'infra_retryable' : 'fail',
      outcome: {
        category: 'exception',
        reward: reward === undefined ? null : reward,
        exceptionType,
        reason: parsed.exception_info.exception_message?.slice(0, 500) ?? exceptionType,
      },
    }
  }
  // A completed agent turn must leave its ATIF trajectory behind (harbor
  // converts the captured ACP session updates): a missing or unparsable
  // trajectory makes the trial unauditable, which is an explicit FAIL
  // (specs/07 §4 Accept; CLAUDE.md rule 7) — never a silent pass. Trials that
  // died on an exception (the agent never completed a turn) are exempt; their
  // exception classification above is the stronger fact.
  if (!trajectoryOk && parsed.exception_info === null) {
    return {
      ...base,
      status: 'fail',
      outcome: {
        category: 'missing-trajectory',
        reward: reward === undefined ? null : reward,
        exceptionType: null,
        reason: 'agent/trajectory.json is missing or not JSON (specs/07 §4: explicit FAIL)',
      },
    }
  }
  if (reward === undefined) {
    return {
      ...base,
      status: 'fail',
      outcome: {
        category: 'missing-reward',
        reward: null,
        exceptionType: null,
        reason: 'verifier_result.rewards has no "reward" key (specs/04 §5: default fail)',
      },
    }
  }
  return {
    ...base,
    status: reward === 1 ? 'pass' : 'fail',
    outcome: {
      category: 'reward',
      reward,
      exceptionType: null,
      reason: reward === 1 ? 'reward == 1' : `reward ${reward} != 1`,
    },
  }
}

export interface NormalizeJobInput {
  jobDir: string
  jobName: string
  idempotencyKey: string
  identity: RunArtifact['identity']
  /**
   * Registry entry id the plan attributes trials through (default
   * `ACP_AGENT_ID`; harbor records it as the trial's `agent_info.name`).
   */
  agentName?: string
}

/**
 * Normalize a finished Harbor job directory against its plan. Reads the
 * trial directories from scratch — no Harbor state, no network — and returns
 * one record per planned (handle, attempt), synthesizing FAIL records for
 * planned trials that never produced a directory (CLAUDE.md rule 7). Trial
 * directories are attributed to planned handles through their own
 * `config.json` (`config.task.path` basename — the authoritative link to the
 * inventory, immune to trial-name truncation), and attempt ordinals are
 * assigned by sorted trial-name within each handle group (Harbor stores no
 * attempt index). The artifact digest is over the canonical document without
 * the digest field, so re-parsing the same directory yields the identical
 * hash.
 */
export async function normalizeJob(input: NormalizeJobInput): Promise<RunArtifact> {
  const agentName = input.agentName ?? ACP_AGENT_ID
  const plan = { capsuleArchiveSha256: input.identity.capsuleArchiveSha256, agentName }

  // Attribute every trial directory to a handle via its config.json.
  const entries = await readdir(input.jobDir, { withFileTypes: true })
  const byHandle = new Map<string, { trialName: string; taskPath: string | null }[]>()
  const unattributed: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const configStat = await stat(join(input.jobDir, entry.name, 'config.json')).catch(
      () => undefined,
    )
    let taskPath: string | null = null
    if (configStat !== undefined && configStat.isFile()) {
      try {
        const config = JSON.parse(
          await readFile(join(input.jobDir, entry.name, 'config.json'), 'utf8'),
        ) as { task?: { path?: string } }
        taskPath = config.task?.path ?? null
      } catch {
        taskPath = null
      }
    }
    if (taskPath === null) {
      unattributed.push(entry.name)
      continue
    }
    const handle = basename(taskPath)
    const list = byHandle.get(handle) ?? []
    list.push({ trialName: entry.name, taskPath })
    byHandle.set(handle, list)
  }

  const trials: NormalizedTrial[] = []
  for (const handle of input.identity.handles) {
    const found = (byHandle.get(handle) ?? []).sort((a, b) =>
      a.trialName < b.trialName ? -1 : a.trialName > b.trialName ? 1 : 0,
    )
    byHandle.delete(handle)
    if (found.length > input.identity.attempts) {
      trials.push(
        failRecord(
          {
            runId: input.identity.runId,
            capsuleArchiveSha256: plan.capsuleArchiveSha256,
            inventorySha256: input.identity.inventorySha256,
            handle,
            attempt: 0,
          },
          'plan-mismatch',
          `${found.length} trial directories for handle ${handle} exceed planned attempts ${input.identity.attempts}: ${found.map((f) => f.trialName).join(', ')}`,
        ),
      )
      continue
    }
    for (let attempt = 0; attempt < input.identity.attempts; attempt += 1) {
      const identity: TrialIdentity = {
        runId: input.identity.runId,
        capsuleArchiveSha256: plan.capsuleArchiveSha256,
        inventorySha256: input.identity.inventorySha256,
        handle,
        attempt,
      }
      const trial = found[attempt]
      if (trial === undefined) {
        trials.push(
          failRecord(
            identity,
            'missing-trial',
            `planned attempt ${attempt} produced no trial directory (default fail, never dropped)`,
          ),
        )
        continue
      }
      const resultPath = join(input.jobDir, trial.trialName, 'result.json')
      const resultStat = await stat(resultPath).catch(() => undefined)
      if (resultStat === undefined || !resultStat.isFile()) {
        trials.push({
          ...failRecord(
            identity,
            'missing-result',
            `trial ${trial.trialName} has no result.json (default fail, never dropped)`,
          ),
          trialName: trial.trialName,
        })
        continue
      }
      const trajectoryPath = join(input.jobDir, trial.trialName, 'agent', 'trajectory.json')
      const trajectoryRaw = await readFile(trajectoryPath).catch(() => null)
      let trajectoryOk = false
      if (trajectoryRaw !== null) {
        try {
          trajectoryOk = typeof JSON.parse(trajectoryRaw.toString('utf8')) === 'object'
        } catch {
          trajectoryOk = false
        }
      }
      trials.push(
        normalizeResult(identity, trial.trialName, await readFile(resultPath), plan, trajectoryOk),
      )
    }
  }
  // Anything left in the job dir that is not a planned handle invalidates the
  // run: the job ran tasks we did not plan (candidate/selection integrity).
  for (const handle of [...byHandle.keys()].sort()) {
    for (const trial of byHandle.get(handle) ?? []) {
      trials.push(
        failRecord(
          {
            runId: input.identity.runId,
            capsuleArchiveSha256: plan.capsuleArchiveSha256,
            inventorySha256: input.identity.inventorySha256,
            handle,
            attempt: 0,
          },
          'plan-mismatch',
          `trial directory ${trial.trialName} (${trial.taskPath ?? '?'}) is not in the planned task set`,
        ),
      )
    }
  }
  for (const trialName of unattributed.sort()) {
    trials.push(
      failRecord(
        {
          runId: input.identity.runId,
          capsuleArchiveSha256: plan.capsuleArchiveSha256,
          inventorySha256: input.identity.inventorySha256,
          handle: `unattributed:${trialName}`,
          attempt: 0,
        },
        'plan-mismatch',
        `trial directory ${trialName} has no readable config.json; cannot attribute`,
      ),
    )
  }

  const counts = {
    pass: trials.filter((trial) => trial.status === 'pass').length,
    fail: trials.filter((trial) => trial.status === 'fail').length,
    infraRetryable: trials.filter((trial) => trial.status === 'infra_retryable').length,
    protocolInvalid: trials.filter((trial) => trial.status === 'protocol_invalid').length,
  }
  const plannedTrials = input.identity.handles.length * input.identity.attempts
  const artifact: RunArtifact = {
    protocol: RUN_PROTOCOL,
    jobName: input.jobName,
    jobDir: input.jobDir,
    idempotencyKey: input.idempotencyKey,
    identity: input.identity,
    plannedTrials,
    trials: trials.sort((a, b) =>
      a.identity.handle < b.identity.handle
        ? -1
        : a.identity.handle > b.identity.handle
          ? 1
          : a.identity.attempt - b.identity.attempt,
    ),
    counts: {
      ...counts,
      valid: counts.protocolInvalid === 0 && trials.length === plannedTrials,
      denominator: plannedTrials,
      passRate:
        counts.protocolInvalid === 0 && trials.length === plannedTrials
          ? counts.pass / plannedTrials
          : null,
    },
    artifactSha256: '',
  }
  artifact.artifactSha256 = sha256Hex(canonicalJson({ ...artifact, artifactSha256: undefined }))
  return artifact
}
