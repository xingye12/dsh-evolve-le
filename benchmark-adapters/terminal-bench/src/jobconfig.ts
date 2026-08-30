/**
 * Harbor job config generation (Gate 2, specs/04 §3, specs/07 §4): produce
 * the JobConfig YAML for a planned candidate-vs-tasks job, bound to harbor
 * 0.21.0 `src/harbor/models/job/config.py` (`JobConfig`) and
 * `src/harbor/models/trial/config.py` (`AgentConfig.kwargs` → installed
 * `acp` agent, `EnvironmentConfig.mounts` → compose service volumes). The
 * generated config is part of the paid-outcome identity: job_name embeds the
 * idempotency key, so a re-submit with identical inputs lands on the same
 * job directory and Harbor resumes instead of re-paying.
 * @module @dsh-evolve-le/tb-provider/jobconfig
 */

import { dump } from 'js-yaml'
import { INFRA_RETRYABLE_EXCEPTIONS } from './normalize.js'
import type { AcpRegistryEntry } from './registry.js'

export const PROVIDER_PROTOCOL = 'dsh-evolve-le/tb-provider/v1'

/**
 * Pre-registered infrastructure retry (specs/04 §6, ADR-028): harbor retries a
 * trial at most once, and ONLY for the reward-independent infra exception
 * classes the normalizer already treats as INFRA_RETRYABLE — everything else
 * (agent timeouts, verifier errors, refusals) stays excluded, matching
 * harbor's own default exclusion list for reward-attributable outcomes.
 */
export const INFRA_MAX_RETRIES = 1

/**
 * The ACP agent bootstrap (apt + venv + `pip install agent-client-protocol`)
 * runs before the agent process exists and is pure infrastructure. Measured on
 * the real ubuntu:24.04 task base under the plan's 1-cpu/2G limits: ~380-420 s
 * isolated, >850 s twice live under shared-host load (Gate 8 attempt 8 died on
 * adaptive-rejection-sampler both with 360 s and 900 s). 5× (1800 s) covers
 * ~4.7× the isolated cost plus the observed load variance (ADR-028).
 */
export const AGENT_SETUP_TIMEOUT_MULTIPLIER = 5

export interface JobPlanInput {
  jobName: string
  jobsDir: string
  /** Local task directories (from the inventory). */
  taskPaths: string[]
  registryEntry: AcpRegistryEntry
  attempts: number
  concurrentTrials: number
  /** Optional read-only bind mounts (compose service volumes). */
  mounts?: { source: string; target: string }[]
  /** Optional container environment entries (e.g. SSL_CERT_FILE). */
  env?: Record<string, string>
}

export interface JobPlan {
  /** The JobConfig YAML handed to `harbor job run <config>`. */
  yaml: string
  /** Parsed shape of `yaml` (for tests and the run manifest). */
  config: Record<string, unknown>
  /** Planned trial count: tasks × attempts × one agent. */
  plannedTrials: number
}

export function buildJobConfig(input: JobPlanInput): JobPlan {
  if (input.attempts < 1) throw new Error('jobconfig: attempts must be ≥ 1')
  if (input.concurrentTrials < 1) throw new Error('jobconfig: concurrentTrials must be ≥ 1')
  if (input.taskPaths.length === 0) throw new Error('jobconfig: no tasks planned')

  const config: Record<string, unknown> = {
    job_name: input.jobName,
    jobs_dir: input.jobsDir,
    n_attempts: input.attempts,
    n_concurrent_trials: input.concurrentTrials,
    // Infra-only, single retry + setup-timeout headroom (ADR-028): the
    // include-list is sourced from the normalizer's pre-registered set so the
    // plan and the observation classification can never drift apart.
    agent_setup_timeout_multiplier: AGENT_SETUP_TIMEOUT_MULTIPLIER,
    retry: {
      max_retries: INFRA_MAX_RETRIES,
      include_exceptions: [...INFRA_RETRYABLE_EXCEPTIONS].sort(),
    },
    environment: {
      type: 'docker',
      ...(input.mounts !== undefined && input.mounts.length > 0
        ? {
            mounts: input.mounts.map((mount) => ({
              type: 'bind',
              source: mount.source,
              target: mount.target,
              read_only: true,
            })),
          }
        : {}),
      ...(input.env !== undefined && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
    },
    agents: [
      {
        // Job-config slot name (harbor AgentConfig.name); distinct from the
        // registry entry id that lands in the trial's agent_info.
        name: 'acp',
        // No model_name: the replay capsule routes to no external model, and a
        // requested model would force harbor's session/set_model path, which
        // the pinned ACP TS SDK 0.25.1 cannot serve (it has no model-selection
        // surface). Model routing for real-model capsules is recorded in the
        // run manifest and advertised by the capsule itself (specs/02).
        kwargs: {
          // Inline registry entry as a mapping (acp.py `_load_registry_entry`
          // accepts a dict verbatim): no long-string YAML folding risk, no
          // credentials (CLAUDE.md rule 8).
          registry_entry: input.registryEntry,
          permission_mode: 'deny',
          auth_policy: 'disabled',
        },
      },
    ],
    tasks: input.taskPaths.map((path) => ({ path })),
  }
  const yaml = dump(config, { lineWidth: 120 })
  return { yaml, config, plannedTrials: input.taskPaths.length * input.attempts }
}
