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

/**
 * Agent-phase timeout multiplier (paid-smoke attempts 2 and 4): Terminal-Bench
 * tasks pin `timeout_sec = 900`, which harbor enforces with a hard kill that
 * turns the trial into an AgentTimeoutError exception and discards the agent's
 * usage. A live solve trial spends its wall clock on network model turns the
 * replay capsule never had, so 900 s is not a capability budget — it is an
 * infra ceiling misread as an agent death. The multiplier applies uniformly to
 * every trial of every run (baseline and children alike), so candidate
 * comparisons keep their internal validity. The live capsule receives each
 * task's resulting effective agent timeout in JobConfig and derives its own
 * earlier deadline with a fixed teardown reserve. Verifier timeouts stay at
 * the task's canonical value (only the agent phase is multiplied).
 *
 * Why 3× and not 2× (attempt 4 finding): the graceful end is not the last
 * event. After the capsule's wall clock fires, the session/prompt reply must
 * travel back, harbor's runner writes acp-summary.json in its finally, the
 * runner exits, and only then does the docker exec return — measured ≈ 2.5-3
 * minutes in total, and the capsule's clock also starts later than harbor's
 * (runner venv startup + initialize/new_session handshake). With 2× the
 * nominal 60 s margin was therefore negative: both attempt-4 trials were
 * killed at exactly 1800.0 s, one of them AFTER solving its task (verifier
 * reward 1.0), with the usage update (191 301 tokens, $0.049) never reaching
 * the result. 3× (2700 s) leaves ~15 minutes for the whole teardown chain.
 */
export const AGENT_TIMEOUT_MULTIPLIER = 3

/**
 * Environment-build timeout multiplier (K=10 live pilot attempt 1): the
 * environment phase runs `docker compose up --wait` — which pulls the task
 * image when it is not local. Terminal-Bench tasks default `build_timeout_sec`
 * to 600 s, and harbor multiplies it by this value only
 * (`trial.py::_compute_environment_build_timeout_sec`); without it, a cold
 * pull under load dies as EnvironmentStartTimeoutError at exactly 600.0 s.
 * Attempt 1's second discovery trial died this way on
 * `alexgshaw/build-cython-ext:20251031` — harbor's one infra retry re-failed
 * (the pull was still in flight), and the pilot's pool cannot freeze
 * infra-dead (ADR-028). 5× (3000 s) matches the ACP bootstrap headroom and
 * covers a cold multi-GB pull; it only widens a wall clock the trial never
 * reaches when the image is already local (a warm start needs seconds).
 */
export const ENVIRONMENT_BUILD_TIMEOUT_MULTIPLIER = 5

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
    agent_timeout_multiplier: AGENT_TIMEOUT_MULTIPLIER,
    environment_build_timeout_multiplier: ENVIRONMENT_BUILD_TIMEOUT_MULTIPLIER,
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
