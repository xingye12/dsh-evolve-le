# Architecture decision records

**Status:** accepted for specification v1; changes require a new ADR entry

## ADR-001 — RSI lives inside DSH as a Cordis service

**Decision:** the trusted evolution controller is a standard DSH bundle/service; candidates are standard DSH
bundles/plugins. DSH upstream remains unchanged.

**Why:** DSH already owns dynamic composition, agent loop, services, tools, sessions and reversible lifecycle. An
external meta-controller would duplicate the most important harness mechanisms and evolve a wrapper rather than the
real runtime.

**Rejected:** DSH fork; independent Python evolution controller; candidate as arbitrary shell script.

## ADR-002 — Generated candidates execute in disposable processes

**Decision:** controller never imports or dynamically runs generated code. Proposal, build and task execution use
separate process/container boundaries.

**Why:** Cordis Fiber and `dynamicCordisRunner` provide compositional rollback, but DSH explicitly states its
`node:vm` is not a security boundary and declared services reach the live runtime.

**Cost:** more startup/capsule work. **Benefit:** controller/sealed/verifier secrets remain out of reach.

## ADR-003 — Harbor ACP is the benchmark bridge

**Decision:** build a DSH ACP binary capsule and use Harbor's generic ACP runner with inline, checksummed binary
distribution. The TB adapter remains TypeScript and does not implement a Python BaseAgent.

**Why:** both sides already implement the protocol and lifecycle/trajectory concerns. Reusing them removes a
duplicated command runner and preserves real DSH behavior.

**Fallback:** add a thin local-upload adapter only after a concrete provider cannot serve immutable HTTPS artifacts.

## ADR-004 — One canonical parent, optional donors

**Decision:** each candidate has one canonical parent for the HGM clade tree; other source/evidence inspirations are
donors.

**Why:** a multi-parent DAG makes descendant success double-counting ambiguous. Donor provenance retains
crossover without breaking CMP semantics.

## ADR-005 — HGM search, no greedy acceptance

**Decision:** all admitted candidates remain in Archive; CMP Thompson selects parents, node Thompson selects
measurement targets, and UCB-Air (`alpha=0.6`) decides expansion versus evaluation.

**Why:** immediate benchmark score can be a weak proxy for lineage productivity. Archive search preserves stepping
stones and allocates partial evaluation adaptively.

**Qualification:** formulas are fixed for the run and require TB-specific calibration/ablation; “CMP” is an
estimator, not an oracle.

## ADR-006 — Sealed test is one-time, not per-candidate gating

**Decision:** 48 observed + 12 guard development tasks drive search; 29 tasks remain sealed until exactly one
development champion is content-hash locked.

**Why:** repeatedly using 29 “held-out” outcomes for 80 accept/reject choices adapts to that set. One-time reveal
supports a clearer generalization claim.

**Consequence:** a sealed failure ends the run; testing the runner-up requires a new split/new run.

## ADR-007 — Filesystem event log is the state authority

**Decision:** content-addressed objects plus a hash-chained JSONL journal are authoritative. Snapshots, catalogs and
graphs are derived and rebuildable.

**Why:** files give the proposer rich, scalable evidence using model-native tools and keep every claim auditable.
A database/queue is deferred until measured scaling needs it.

## ADR-008 — Safety and cost are external policy

**Decision:** filesystem/network/process/model/budget/split/verifier policies live in trusted outer layers, never only
in prompts or candidate code.

**Why:** candidates optimize against feedback and may remove or bypass voluntary constraints. Policies must remain
non-evolvable and fail closed.

## ADR-009 — Accuracy is primary; efficiency is constrained/Pareto

**Decision:** maximize paired task performance first. Cost/time/tokens break near-performance ties and enforce hard
budgets; no arbitrary weighted scalar lets cheapness offset a material score regression.

**Why:** the project goal is SOTA capability, while still meeting explicit operational limits.

## ADR-010 — Static SOTA numbers are not product requirements

**Decision:** capture a timestamped official leaderboard snapshot and target comparator in each run manifest.

**Why:** models, harnesses, verification and submission policy change. The prior hard-coded `83.8%` was already a
moving external fact, not an architectural constant.

## ADR-011 — Stable-iteration release precedes benchmark-scale search

**Decision:** v0.1 completion means a usable open-source project that proves stable iteration, not a completed
Terminal-Bench improvement campaign. The default demo keeps `high`, the 1M context window and the 32k per-response
ceiling, and reduces API use only by limiting task trials:

- run baseline failure discovery in deterministic batches up to 12 observed tasks;
- freeze the baseline-failed pool before generating candidates;
- produce K=3 unique candidates across at least two lineage depths and evaluate each on one frozen baseline-failed
  task;
- inject and recover from one real process crash without duplicate effects;
- stop after engineering evidence, regardless of score.

The candidate-specific task is derived only from baseline outcomes and a committed RNG stream. It MUST NOT be
resampled after seeing that candidate's reward. A panel therefore guarantees known baseline failures, not candidate
failures.

**Why:** the reusable product is the iteration engine. Paying for 80 candidates, sealed confirmation and 445 formal
trials before the runner is packaged would test a benchmark campaign rather than open-source usability. The v0.1
solver envelope is at most 15 trials: 12 baseline discovery plus 3 candidate evaluations.

**Claim boundary:** `STABLE_ITERATION_VERIFIED` proves lifecycle/recovery/evidence behavior only. K=10/K=80,
sealed confirmation, full-set and SOTA remain optional post-release profiles with their original strict claims.

## ADR-012 — Baseline INVALID enters the frozen failure pool

**Decision:** stable-demo config schema v2 defines a baseline failure as `status != pass OR reward != 1`. The fixed
batch still completes before every FAIL/INVALID task in that batch is frozen for candidate evaluation.

**Why:** the first real predecessor produced an `INVALID` normalized observation with `reward=null`. The v1 product
engine selected only `reward=0`, contrary to the fail-closed evaluation contract. Run `stable-demo-20260814-v1` was
stopped and marked `QUARANTINED_PROTOCOL_BUG`; it cannot be resumed or used for Gate 6 evidence.

**Consequence:** the successor uses a new run ID and schema. This correction does not change the model route, sealed
boundary, candidate rewards or any benchmark promotion rule.

## ADR-013 — Admitted source diff is the candidate behavior

**Decision:** stable-demo config schema v3 requires the trusted builder to apply the admitted unified diff to the
canonical parent's `src/index.ts`, compile it twice, and atomically publish only a successful candidate. Patch headers
and paths outside that single editable file are rejected.

**Why:** the v2 builder preserved `sourceDiff` as evidence but compiled a prompt section derived only from the
hypothesis. That produced unique artifacts without implementing the proposed mechanism, so it could not prove real
self-modification. Run `stable-demo-20260814-v2` was stopped before candidate generation and marked
`QUARANTINED_BUILDER_SEMANTIC_MISMATCH`; its baseline evidence is not reused.

**Consequence:** incomplete staging directories fail closed, and every successor candidate's source digest covers the
actual model-proposed production patch.

## ADR-014 — Bounded replacement after build rejection

**Decision:** stable-demo config schema v4 allows at most three proposal/build attempts per generation. Every rejected
build records its proposal identity and a content-only error digest; the next attempt receives the same frozen raw
evidence and canonical parent. A successful build ends the generation's replacement loop.

**Why:** v3 could preserve a deterministic compile rejection but resume would request the same proposal forever.
That is auditable but not live. Run `stable-demo-20260814-v3` was stopped during baseline and marked
`QUARANTINED_BUILD_REJECT_LIVENESS_GAP`; no evidence is reused.

**Consequence:** at most nine proposer calls can produce the three admitted children, while the paid solver envelope
remains unchanged at 15 trials. Exhausting three build attempts fails closed and requires a successor.

## ADR-015 — Preserve normalizer status casing exactly

**Decision:** stable-demo config schema v5 accepts only the Terminal-Bench adapter's actual lowercase
`pass|fail|invalid` values and maps them identically into controller observations. Unknown values fail closed instead
of becoming `invalid` through a fallback branch.

**Why:** v4's typed summary declaration incorrectly used uppercase literals. Its first raw result was a real
`status=pass/reward=1`, but the controller fallback recorded `invalid`. Run `stable-demo-20260814-v4` was stopped and
marked `QUARANTINED_NORMALIZER_STATUS_CASE_MISMATCH`; its results are not reused.

**Consequence:** a real one-task adapter smoke must compare raw summary, collected observation and journal projection
before another multi-task successor starts.

## ADR-016 — Outcome-blind low-wall-time observed panel

**Decision:** stable-demo config schema v6 orders only the published `DEV_OBSERVED` inventory by
`agentTimeoutSec ASC, taskId ASC` before taking fixed batches of six. Timeout metadata is frozen before all outcomes;
guard/sealed tasks can never enter the sort input.

**Why:** v5 reached an observed task with a 3600-second allowance while many published observed tasks had 600–900
second limits. Split-file order was deterministic but unnecessarily expensive for an engineering proof. Run
`stable-demo-20260814-v5` was stopped and marked `QUARANTINED_INEFFICIENT_TASK_PANEL`; its results are not reused.

**Consequence:** selection remains outcome-blind and preregistered while reducing worst-case first-batch wall time.
The solver-trial ceiling and model token settings do not change.

## ADR-017 — Bind stable-demo to the full execution commit

**Decision:** stable-demo config schema v7 captures the full Git commit during `init`. `doctor`, `run` and `resume`
require the checkout HEAD to match before any paid or mutating action.

**Why:** v6 demonstrated terminal-raw reconciliation, but its config identified only `repoRoot`; a source edit could
otherwise alter behavior without an identity mismatch. v6 is retained as engineering recovery evidence and is not a
Gate 6 acceptance run.

**Consequence:** the v7 acceptance run starts from a committed clean implementation. No source or documentation commit
is made until its injected crash has resumed and its final audit receipt is written.

## ADR-018 — Canonical equality for idempotent event replay

**Decision:** stable-demo config schema v8 compares an existing event type and payload with the same canonical JSON
function used by the journal hash chain. Object insertion order is never semantic.

**Why:** v7 reached the injected real crash, but resume rejected `run:preflight`: the stored canonical payload had
sorted keys while the in-memory object used source insertion order. No external job was relaunched. v7 is retained as
crash evidence and marked `QUARANTINED_CANONICAL_REPLAY_COMPARISON_BUG`.

**Consequence:** a dedicated mid-run interruption test must resume from a nonterminal journal and prove launch and
collect counts remain exactly once before the next commit-bound real run.

## ADR-019 — Frozen commit plus clean executable source scope

**Decision:** stable-demo config schema v9 requires both the frozen HEAD and a clean executable source scope:
`packages/`, `benchmark-adapters/`, `scripts/` and root build/provenance manifests. Documentation-only work may remain
outside that runtime scope without changing candidate or evaluator behavior.

**Why:** a matching HEAD alone does not exclude dirty TypeScript or scripts being compiled into ignored `lib/` output.
The check is restricted to executable paths so independently authored release documentation does not alter or block a
running evidence lineage.

**Consequence:** `doctor`, `run` and `resume` fail before mutation if tracked or untracked executable source differs
from the bound commit.

## ADR-020 — Feed build rejection classification to replacement attempts

**Decision:** stable-demo config schema v10 adds each prior same-generation proposal/build rejection classification
and journal hash to the next attempt's immutable evidence. Raw compiler/provider text remains outside prompts; only a
fixed safe classification is exported.

**Why:** v9 successfully recovered from SIGKILL, then generation 2 produced three hunks that did not apply. The second
and third proposer calls did not know the earlier failure class, so the bounded replacement loop was blind. v9 is
retained as recovery/build-reject evidence and marked `QUARANTINED_REPLACEMENT_FEEDBACK_GAP`.

**Consequence:** replacement prompts explicitly require byte-exact parent context and receive
`PATCH_DOES_NOT_APPLY` when relevant. Solver-trial selection and frozen task outcomes remain unchanged.

## ADR-021 — v0.1.1 uses canonical child trees and governed capability catalogs

**Decision:** protocol `dsh-evolve-le-candidate-tree-v2` replaces model-authored unified patches with a trusted,
preassigned full child tree. The proposer may add, modify, or remove only `src/**/*.ts`,
`tests/**/*.spec.ts`, `fixtures/**/*.json`, `README.md`, and the behavior-intent JSON pointers in
`candidate.json`. `package.json`, `cordis.patch.yml`, compiler configuration, identities, dependencies,
model routing, evidence labels, budgets, and evaluation policy remain builder-owned. The trusted host derives
the actual operation set, resolves structured citations against one immutable export, and mints a single
materialization/admission chain. Exact DSH capabilities are frozen in a content-addressed catalog; proposer
capability requests are data-only and cannot alter the current lineage.

The exact selected parent capsule is loaded in `propose` mode through the real Cordis Loader. Generated
children are admitted only after candidate-owned tests in a bounded process, policy and import scanning, two
byte-identical builds, Loader boot/unload in both modes, fixed replay, and offline capsule verification. A
trusted mechanism-outcome record is derived exactly once from normalized `DEV_OBSERVED` trials and may enter a
later generation only through a new legal export.

**Why:** v0.1 proved crash-resumable iteration but its one-file patch, baseline-importing proposal worker,
summary-style evidence input, and scattered build receipts cannot establish autonomous multi-file plugin
development or cumulative trajectory-grounded iteration.

**Migration:** v0.1 artifacts remain byte-identical historical evidence. v0.1.1 starts from an explicit
migration receipt, new schemas, a new protocol identity, new evidence exports, a fresh task freeze, and a new
run lineage. No v0.1 score, failure pool, proposal output, or capability decision is relabeled as v0.1.1.

**Claim boundary:** all V011-A through V011-E receipts are required before
`AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED`. Green schemas, one generated child, or a K=3 terminal state alone are
insufficient. The capability is development-only, requires `sealedAccessCount=0`, and makes no benchmark
improvement claim.

## ADR-022 — Formal signer registry is an out-of-band TCB input

**Decision:** formal preflight evidence carries only the detached signature. A trusted caller supplies an external
`signatureKeyId -> Ed25519 public-key PEM` registry to the verifier. Unknown ids fail closed; for a registered entry
the verifier independently enforces Ed25519 and derives the SPKI SHA-256 id from the PEM before checking the
signature. Manifest, evidence, candidate output and run-local files cannot add or replace registry entries.

**Why:** accepting a PEM from the same evidence object made a self-generated key, signature and evidence commitment
internally consistent but untrusted. The signature proved authorship by an arbitrary key rather than authorization by
the TCB.

**Compatibility:** there is no production caller, deployed registry, formal run directory, signed formal manifest or
accepted formal receipt to migrate. This closes the trust boundary already specified and documented; the signed
manifest wire schema and evidence commitment are unchanged, so no protocol version is reinterpreted. After the first
deployed registry/run, changing registry authority or signer-selection semantics requires the ADR and protocol-version
change mandated by spec 07.

## ADR-023 — Disable synthetic Gate 8 acceptance until authentic artifacts exist

**Decision:** the public `verifyGate8Evidence` boundary always returns `PROTOCOL_INVALID`. The existing paired-matrix,
bootstrap, full-set and release logic is retained only as an internal synthetic consistency assessor and is not
exported from the package root. Enabling acceptance requires a new versioned design with real receipt producers,
trusted content-addressed artifact reads, external signature authority, journal/action replay and immutable launch
manifest reconstruction.

**Why:** an envelope commitment proves only that one caller kept its own strings and booleans consistent. It does not
prove that a search receipt, signed lock, reveal, trial artifact, journal, official verification or release operation
exists. Keeping a positive public path before those producers exist would turn test fixtures into false attestations.

**Compatibility:** Gate 8 is optional and `BLOCKED_NOT_STARTED`; there is no production caller, formal candidate lock,
reveal, sealed/full trial, release artifact or accepted Gate 8 receipt. Removing the unauthenticated positive path
therefore invalidates no evidence. The future authentic design must use a new schema/protocol identity rather than
reinterpret the synthetic envelope.

## ADR-024 — Freeze candidate bytes once and compile only a trusted project

**Decision:** candidate admission captures every declared file through directory-anchored descriptors with
`O_NOFOLLOW`, creates one content-addressed read-only staging tree, and makes identity, schema validation, policy scan,
candidate tests and both compiler passes consume that tree. Candidate `tsconfig.json` must match the inert declared
contract exactly but is never executed. The builder generates the effective config and runs pinned TypeScript inside
Bubblewrap with no network, a cleared environment, read-only source/toolchain mounts and one dedicated writable output
mount.

**Why:** path-based rereads allowed identity, scan and emitted code to observe different live source revisions. Running
`tsc -b` on the candidate project also gave candidate-controlled path options host filesystem privileges before any
post-build check. A single descriptor-captured snapshot removes the attribution race; the outer OS boundary and
builder-owned config remove compiler read/write authority from candidate configuration.

**Compatibility:** historical source, capsule and admission artifacts remain immutable evidence. Future bundle hashes
can differ because the trusted compiler no longer emits candidate-selected incremental metadata; no historical receipt
is relabeled or migrated. Resume continues to verify stored receipts rather than silently rebuilding them under the new
builder.

## ADR-025 — `AgentSetupTimeoutError` is pre-agent infrastructure, retry-eligible

**Decision:** add harbor's `AgentSetupTimeoutError` to the pre-registered, reward-blind infrastructure
exception set (`INFRA_RETRYABLE_EXCEPTIONS`) alongside `EnvironmentStartTimeoutError`,
`SandboxBuildFailedError` and `HealthcheckError`. Such a trial keeps FAIL-in-the-denominator semantics
(CLAUDE.md rule 7; it enters the search state as a pessimistic failure observation), but it is disclosed
as an infrastructure death — the agent never spoke ACP — and never as a capability result. The Gate 8
pilot's participation gate is correspondingly refined: a never-initialized trial fails the gate unless its
exception belongs to a pre-launch phase class, and every baseline-freeze (discovery) trial must have run
an agent.

**Why:** harbor 0.21.0 raises `AgentSetupTimeoutError` only inside `_setup_agent()`, which wraps
`agent.setup()` = `mkdir /installed-agent` + `install()` (the ACP venv bootstrap: `python3 -m venv`,
`pip install --upgrade pip`, `pip install agent-client-protocol`, archive fetch). The candidate process
is not launched until after setup, so the candidate cannot cause, influence, or observe this timeout —
identical in kind to the already-registered `EnvironmentStartTimeoutError` from the adjacent phase.
specs/04 §6 pre-registers the category in words ("sandbox provisioning 在 agent 启动前失败"); the string
allowlist simply predated any occurrence (Gate 2's bootstrap was always fast). Two Gate 8 pilot attempts
(2026-08-30) hit ~5% per-trial flakes of this class on a warm machine, both corroborated by
`agent_result.metadata.acp.initialize === null`.

**Not reopened:** the original Gate 8 capsule defect surfaced as `NonZeroAgentExitCodeError` — the agent
process launched and died (`exec: node: not found`). That class stays FAIL + never-initialized and still
fails the participation gate on its own; agent-process deaths remain capability/harness-integration
failures.

**Disclosure:** this ADR was authored after the class was observed in pilot attempts, with the mechanism
argument above as its basis (not the reward outcome — an infra-classified trial counts against the
candidate either way). Trial-budget funding for the pilot was corrected in the same amendment: observed
scheduler behavior spends ~2.8 pool trials per admitted child (UCB exploration beyond the q0 cold start),
so `maxSolverTrials` was raised from 24 to 48 to fund K=10; the old 24-trial cap would have exhausted the
budget at ~7 admitted children.

## ADR-026 — A trusted-rebuild rejection is a per-child outcome, not a run crash

**Decision:** the driver's capsule-build seam returns a discriminated verdict
(`admitted | rejected`) instead of throwing on every builder rejection. In `expand()`, a rejected child is
skipped: it stays `registered` in the candidate store, is never admitted, and the stage + reason ride the
drive report (`rebuildRejections`). An expansion whose children all reject counts as exactly ONE
consecutive-expansion failure. A crash that cuts an expansion between the committed proposal and its
rebuilds is closed the same way at recovery (`settleAbandonedIntents`): the intent counts as one attempt
and one failure unless one of its children had already admitted, and its never-rebuilt children are
recorded as abandoned (`abandonedIntents`) rather than silently lost. Two things remain fail-closed:
builder-ENVIRONMENT errors (the builder itself throws — missing pinned runtime, fs faults) and a
trusted-builder rejection of the BASELINE source, which is a TCB defect that invalidates the run.

**Why:** specs/03 §7 pre-registers exactly this: "空 proposal、全部 build reject、全部 duplicate，以及恢复时
仍未完成且没有 admitted child 的 intent，都计作一次失败……任一 attempt admitted child 后连续失败计数归零。" The
proposal-bundle validation (`validateProposalBundle`) is deliberately structural — diff sanity, canary scan,
candidate scan, manifest schema — and never runs the child's own test suite; the trusted rebuild IS the
admission gate (specs/03 §2). A real proposer therefore routinely produces children that fail their own
contract tests, and the pre-fix `admitted-or-throw` bridge converted that ordinary event into
`IterationDriverError`, killing the whole run after the money was spent.

**Disclosure:** authored 2026-08-30 after two live Gate 8 attempt-5 crashes (prop-6/prop-7 children failing
`registers exactly one candidate:identity section in solve mode`), BEFORE resuming that run root; the six
orphaned children were then settled under this rule (two expansion failures recorded), not rebuilt. The
same change re-binds persisted capsule records to the provider bridge at drive() start — the in-process
registry dies with the process, and a resumed run must be able to launch previously admitted children.

**Amendment (trial-cap re-sizing, same day, pre-registered before the next pilot launch):** the resumed
attempt 5 finished `STOPPED:TRIAL_CAP` at a fully-spent 48/48 trials with **12 admitted children** (K=10
exceeded by the pre-registered W_p overshoot; prop-8 admitted 3/3 with zero rebuild rejections) but with
the final wave's last 2 q0 cold starts unfunded. specs/03 §6 requires every admitted node to complete q0,
so that run is recorded as the pilot's budget-calibration measurement — not as the recorded pilot profile,
and no acceptance check was bent to fit it. From the measured curve (6 batch-1 freeze + ≤12 q0 + ~2.8 pool
trials per admitted child ≈ 49) the pilot cap is re-sized to `maxSolverTrials=60` (budget `taskTrials=60`).

## ADR-027 — External clock skew is unknown duration; payloads validate before durability

**Decision:** two boundary fixes for the same live defect. (1) The Terminal-Bench normalizer treats a
negative `started_at → finished_at` delta as UNKNOWN (`null`) duration — harbor stamps `agent_execution`
from the ACP agent container's clock and the verifier from the host's, so a ~1s skew can put the finish
before the start; duration is usage metadata, never a reward fact, and `null` is the honest value. (2)
`Controller.emit` validates the payload (`validatePayload`, the fold's own invariants, now exported)
BEFORE appending to the journal: a malformed event must fail closed while the run root stays replayable,
never become durable and brick every future replay.

**Why:** Gate 8 pilot attempt 6 (2026-08-30, run root `dsh-gate8-pilot-ilqc34`) died at discovery trial 5
(`chess-best-move`: finished 958 ms before it started). The negative delta rode through the provider into
an observation, the reducer rejected it — after `journal.append` had already made it durable — and the
paid run root became permanently unreplayable (`status`/`resume`/`audit` all crash on the folded event).
Sanitizing external data belongs at the provider boundary; validating payloads belongs before durability.

**Not reopened:** reward classification is untouched — the skewed trial is an ordinary reward-0 FAIL in
the denominator either way (rule 7). Only the metadata field and the crash-ordering changed. Attempt 6's
scratch root is kept as the defect's evidence; the recorded pilot runs on a fresh root.

**Disclosure:** authored immediately after the crash, before the replacement launch; the fix is covered by
the `agent-clock-skew.json` normalizer fixture (negative deltas → null, classification unchanged) and a
controller contract test (malformed payload throws, journal bytes unchanged, reopen folds cleanly).

## ADR-028 — Pre-registered infra retry at the harbor layer; infra-dead discovery fails closed

**Decision:** three coordinated fixes, all pre-registered before the next pilot launch. (1) Harbor job
plans carry `retry: { max_retries: 1, include_exceptions: INFRA_RETRYABLE_EXCEPTIONS }` — one retry,
restricted to the normalizer's own reward-independent infra classes, so the plan and the observation
classification share one source; harbor's default exclusion list still blocks reward-attributable
exceptions (agent/verifier timeouts, refusals). (2) Plans carry `agent_setup_timeout_multiplier: 2.5`
(360 s → 900 s): the ACP bootstrap (apt + venv + pip install) is pre-launch infrastructure that exceeded
harbor's default on 9/42 attempt-7 trials under WSL2 IO. (3) The driver fails closed the moment a
discovery observation is `missing`: an agent that never ran is not a capability fact, so its handle can
never freeze into the pool — no further paid launch, restart the pilot.

**Why:** Gate 8 attempt 7 (2026-08-30, run root `dsh-gate8-pilot-Gyz9DL`) reached `K_REACHED`
(42 trials, 11 admitted children, depth 3, all audit checks green) but its recorder failed closed twice
over. First, a recorder-script bug joined relative trial paths against the process CWD, so every trial
read as a missing file and the participation tally collapsed to `unknown=42` — masking the real facts
(ran=33, never-initialized=9, all nine `AgentSetupTimeoutError`). Second, under correct classification
the baseline's `adaptive-rejection-sampler` discovery trial was never-initialized, yet its handle froze
into the pool as a "baseline failure" — exactly the masquerade class the pilot's
`baselineFreezeTrialsAllRanAgents` check exists to catch. The run is therefore not admissible as pilot
evidence; the root is kept as the defect's evidence.

**Boundary:** child-evaluation trials that die infra after the retry still record outcome `missing` with
reward 0 in the denominator (rule 7) — they only lose pool-freeze eligibility, which only discovery
trials ever had.

**Disclosure:** the include-list is imported from `normalize.ts`, not re-typed; the upstream-contract
test validates the plan through harbor's own pydantic `JobConfig`; a driver contract test pins the
fail-closed throw (no freeze, zero paid proposals).

### ADR-028 amendment — setup headroom re-calibrated to 5× after attempt 8

Attempt 8 (2026-08-30, run root `dsh-gate8-pilot-tHdvWP`) was stopped early by hand: the
`adaptive-rejection-sampler` discovery trial died with `AgentSetupTimeoutError` at the ADR-028 900 s
limit, harbor's new retry fired correctly, and the retry died the same way — a durable `missing`
discovery observation the driver would have failed closed on after paying for the rest of the batch.

Measured on the host (compose-exec, 1 cpu / 2 GiB, the plan's env injection): the harbor ACP setup
script costs ~133 s on the `alexgshaw` image but **~383 s on the task's real `ubuntu:24.04` base**
(the local `environment/Dockerfile` overrides the tag in `task.toml`), with up to ~2× wall-clock
variance under shared-host load (other always-on containers + WSL2 DNS/mirror latency). Live runs
exceeded 850 s twice inside one 30-minute window; 900 s was not enough.

**Change:** `agent_setup_timeout_multiplier` 2.5 → **5** (1800 s ≈ 4.7× the isolated cost), retry
still 1× and still restricted to the pre-registered infra classes. Worst case per trial on an
affected task is now ~1 h wall clock; discovery has 6 trials, of which historically only this task
class is affected. Disclosed before the attempt-9 launch; no other protocol change.

### ADR-028 amendment — trial-container egress proxy via the jobconfig `env` lever (tree-v2 K=3 attempts 2–4)

Tree-v2 K=3 live attempts 2–4 (2026-09-04, run roots `dsh-tree-v2-k3-live-swFrCZ`, `-oa98ch`,
`-bv5f3o`) all died or were heading for the ADR-028 infra-dead fail-closed on the same class: the
ACP setup's apt stage inside trial containers crawled at ~16–27 KB/s, so debian-based tasks
(`code-from-image`, `break-filter-js-from-html`, `build-pmars`, `cancel-async-tasks`) could not
install python3 inside the 1800 s setup ceiling — twice per task (initial + pre-registered retry).

**Root cause.** The host's fast egress path is a local HTTP proxy (`127.0.0.1:7897`, 0.7–1.5 MB/s);
direct egress to deb.debian.org and the tested mirrors is intermittently throttled to ~6–27 KB/s.
Harbor trial containers do not inherit the host's proxy env, and the proxy (a Windows-side client
bridged into WSL) accepts loopback connections only, so `http://172.17.0.1:7897` from a container
is connection-refused even with the client's LAN mode on. A WSL restart restored the host path but
never touched the container path.

**Change (two parts, both disclosed before the attempt-5 launch):**

1. _Host-side forwarder (environment, not protocol):_ a `socat` container on the docker0 gateway
   (`TCP-LISTEN:17897,bind=172.17.0.1 → 127.0.0.1:7897`) makes the loopback-only proxy reachable
   from trial containers. No code change; it is part of the host environment, like the proxy
   itself. Measured through the forwarder from a fresh `debian:bookworm-slim` container: full ACP
   apt stage (update + install python3/pip/venv/curl/certs/archive tools) in **240 s** — under the
   isolated ~383 s baseline the 5× multiplier already covers.
2. _Protocol-side injection (the TCB lever, already built):_ the run config's provider `env` map
   gains three entries — `http_proxy`/`https_proxy`/`HTTP_PROXY`+`HTTPS_PROXY` =
   `http://172.17.0.1:17897`, plus `no_proxy`/`NO_PROXY` =
   `localhost,127.0.0.1,172.17.0.1,host.docker.internal` — landing in every job plan's
   `environment.env` via the pre-existing `JobPlanInput.env` channel (jobconfig.ts), the same
   channel that already carries `SSL_CERT_FILE`. The values contain no credentials (rule 8) and
   are recorded verbatim in every job plan YAML under the run root, hence in the run manifest's
   content-addressed plan set (rule 8's content-addressing requirement).

**Why this is not a silent protocol shrink (rule 9):** the change widens no timeout, drops no
trial, and touches no reward-attributable surface — it only gives the pre-launch apt bootstrap the
same network path the host already uses. The 1800 s ceiling, the 1× infra retry, and the
infra-dead fail-closed all stay exactly as ADR-028 registered them. If the forwarder dies, trials
fail into the same infra classes as before and the driver still fails closed.

**Boundary:** the proxy env applies to the whole trial container, so the agent phase inherits it
too. The solver's model traffic does not use it: the capsule reaches the solve gateway over the
docker0 bridge (`https://172.17.0.1:8443`), which `no_proxy` excludes, and the gateway itself
holds the only upstream credential — the trial container never sees one (ADR-030). Task-side
network access was already unconstrained (`NetworkMode.PUBLIC`); routing it through a logging
proxy changes nothing the candidate could not already do.

### ADR-028 amendment — attempt-5 disclosure: upstream-proxy 502 intermittency stays a capability FAIL (tree-v2 K=3 attempt 5)

Tree-v2 K=3 live attempt 5 (2026-09-04, run root `dsh-tree-v2-k3-live-ChaXVB`) lost 2 of 6
discovery trials (`code-from-image`, `db-wal-recovery`) in the ACP apt setup phase: the upstream
proxy (the Windows-side client behind `127.0.0.1:7897`) intermittently answered `502 Bad Gateway`
for deb.debian.org `.deb` fetches and ubuntu Packages indexes; apt exited 100 and harbor
classified the failure `NonZeroAgentExitCodeError`.

**Root cause.** The forwarder (`fwd` socat container) is exonerated: the first-wave discovery
trials succeeded minutes earlier through the identical forwarder path with zero 502s, and the
exact failed URLs returned 206 through `127.0.0.1:7897` directly when re-probed after the run.
The intermittency lives in the upstream proxy client itself.

**Decision: no retry-classification change.** Harbor's `_classify_exec_error` matches no
`ERROR_PATTERN` against apt's `Failed to fetch ... 502 Bad Gateway` output, so it falls back to
`NonZeroAgentExitCodeError` — the Gate 8 masquerade class that MUST stay a capability FAIL
(pinned by normalize.test.ts 'agent never booted'). Harbor is read-only (rule 1), so the
exception type cannot be refined upstream; adding `NonZeroAgentExitCodeError` to
`INFRA_RETRYABLE_EXCEPTIONS` would make every genuine agent-boot failure retryable and re-open
the masquerade hole ADR-028 closed. Per rule 7 the two failed trials stay failures in the
denominator; per the normalize.ts invariant ("ambiguity resolves to FAIL, never to retry") the
class is accepted as environment intermittency, not a protocol defect. The pre-registered 1×
infra retry continues to cover only the four registered infra classes.

**Operational note (environment, not protocol):** the `fwd` forwarder container exited (255)
after attempt 5 ended; it was recreated with `--restart unless-stopped` and re-verified
end-to-end (fresh `debian:bookworm-slim` container, full `apt-get update` through
`http://172.17.0.1:17897`) before the attempt-6 launch.

## ADR-029 — Gate 8 pilot evidence is a documented subset; capsule tarballs stay out

**Context.** The PASS evidence copy for the Gate 8 pilot (attempt 9) deliberately includes
`capsules/<candidateId>.json` records but not the 13 `<sha256>.tar.gz` capsule archives: every
archive bundles the pinned node runtime (~130 MB each, ~1.7 GB total — ADR-025), out of
proportion to the 522 MB evidence set. After the copy the recorder deletes the scratch run
root (its job is done; scratch is not durable), so the subset is the only durable record.

**Consequence.** Re-running `dsh-evolve audit` over the evidence subset reports
`capsule-archives: archive missing` per record. The PASS-time audit ran over the live run
root and verified all 13 (`capsule-archives: 13 archive(s) verified`). This is subset
semantics, not tampering.

**Position.** Capsules are content-addressed builds of the archived candidate source
(`run/objects/`) plus the pinned runtime pinned by the manifest; the expected digest lives in
each capsule record. An archive is therefore re-derivable and its authenticity checkable by
rebuild-and-compare; a rebuild that misses `archiveSha256` is a real defect, a missing file in
the evidence subset is designed. `evidence/gate8/pilot/EVIDENCE.md` documents the boundary
in-place for future auditors. If a future gate needs bit-exact archive re-verification from
evidence alone, the options are an external artifact store with recorded fetch digests or
accepting the repo size — both are new decisions, not silent changes.

## ADR-030 — Live solver route through a token-authenticated gateway on the artifact listener

**Context.** Every solve trial in the Gate 8 pilot — the baseline included — ran the
recorded-replay capsule: its LLM surface answers from a recording table that is empty by
design, so each trial produced one canned line, zero tool calls, and reward 0. That is a
verifier outcome of a zero-capability agent, not a capability measurement of any model. The
live `deepseek-v4-flash` route existed only on the propose side (`openRemoteModelProxy`,
Gate 8). specs/04 §4.2's baseline matrix and the K=80 search both presuppose a solve layer
with a real model behind it; there was no code path for that.

**Decision.**

1. One HTTPS listener — the existing content-addressed artifact endpoint on the docker bridge
   (172.17.0.1, locally-minted CA with IP SAN, augmented CA bundle bind-mounted plus
   `SSL_CERT_FILE`) — gains an authenticated `POST /gateway/complete`. No harbor changes; the
   gateway handler is an optional hook on `startArtifactServer`.
2. The gateway is TCB in the controller process and the **only** holder of the model
   credential on the solve side, extending the Gate 8 credential firewall: route, method, body
   shape, model, temperature and max_tokens are locked by the route plan hash; the bearer
   credential exists only in controller memory.
3. Per-trial bearer tokens: 32 random bytes, mode 0600, root-only, under
   `<runRoot>/solve-gateway/tokens/<jobName>.token`, bind-mounted read-only into exactly that
   trial's container. Enrollment is idempotent by `jobName` (a pure function of the frozen
   idempotency key), so resume reuses the same token and no secret value ever enters an env
   var, `config.json`, a receipt, a log, or a prompt.
4. Route lock, atomic budget refusal, and redacted receipts are inherited from the proposer
   proxy; requestIds are **per trial**, so each trial's receipt chain is independently
   gapless under concurrent trials. Receipts are `schemaVersion: 3` (adds `jobName`) and carry
   hashes/usage only.
5. `verifySolveReceipts` deliberately differs from `verifyRemoteReceipts`: gaps, duplicates,
   non-monotonic ids, or a route-hash mismatch fail; an unattributable or missing chain fails
   closed (specs/02 §13, missing cost receipt ⇒ trial incomplete); but an `ok:false` receipt
   (upstream 429/timeout mid-trial) is an expected event — counted separately as
   `errorReceipts` and excluded from usage. One failed turn must not kill a run the way it
   kills a single proposal saga.
6. The capsule gains an env-gated `live-solve-agent`: with the three `DSH_SOLVE_GATEWAY_*`
   variables absent it is the recorded-replay agent (the builder's offline ACP round is
   unaffected, the capsule stays byte-identical across builds); with them present but broken
   (unreadable token, bad URL, malformed hash) it **throws** rather than silently replaying —
   a misconfigured live trial must not score 0 on canned answers and pass as a capability
   result (the ADR-028 masquerade class). All agent actions flow through the ACP client
   methods (`createTerminal`/`readTextFile`/`writeTextFile`) so harbor records them in
   `agent/trajectory.json`; the model loop emits one `agent_message_chunk` per turn so a
   missing trajectory can never masquerade as an empty one.
7. Attribution and settlement: receipt-verified usage rides the provider terminal fact;
   the controller settles `usd` + `task-trials` + `solver-tokens`, reserving the token
   dimension per trial before launch. The observation document's field set is unchanged
   (ADR-027); solver fields enter the run manifest only when configured, so old run roots
   still freeze byte-identically on resume.

**Alternatives rejected.** A token derived from `masterSeed` (the canary pattern) — the
manifest embeds the whole config including the seed, so the token would be only as secret as
an artifact already copied into evidence subsets. One run-level token with a trial-id header —
the capsule contains untrusted candidate code, and a shared token would let a candidate shift
its cost onto a rival trial's attribution. A second HTTPS listener — another frozen config
field and a second firewall story for no isolation gain. Post-build injection into the capsule
(the `WORKER_RUNTIME_FILES` pattern) — the trial container receives only the tarball harbor
downloads; there is no injection seam on that side.

**Consequences.** Capsule bytes change once (three new `runner/acp/*` files) and every future
build gets a new `archiveSha256`; existing run roots resume unaffected because capsule records
re-bind rather than rebuild. `<runRoot>/solve-gateway/tokens/` joins capsule tarballs on the
evidence-exclusion list (root-only, never copied); `receipts/` is evidence and must be copied.
The capsule-side HTTP client uses `node:https.request` with `agent:false` and destroys its
socket per request — `acp-boot`'s no-new-handles invariant treats a lingering undici pool as
a dirty process and turns it into a capability FAIL. The solver route freezes into the run
manifest at PREFLIGHT with a derived `solverTrack` (`self` iff it equals `proposerRoute`,
specs/00 §4).

**Boundary.** The 60-task × ≥2-attempt baseline matrix, the K=80 profile, and sealed
evaluation are separately pre-registered follow-ons. The one-task live smoke against the real
route is paid work behind an explicit gate.

**Amendment (2026-08-31, paid smoke attempt 2).** The first live trial burned most of its
turn budget on the exec grammar: the model reached first for `{"command":["bash","-lc","…"]}`
(argv-array habit — a parse rejection) and for compound shell strings such as
`"pwd && which R"` — which `createTerminal` tries to spawn as one executable name and dies
server-side ("Resource not found"). Only bare single-word commands with an explicit empty
argv ever ran. Fix, in `parseSolveDirective` (normalization at parse time; the agent's spawn
path is unchanged): a directive that names **no argv** — a bare string, a string paired with
`"args":[]`, or a one-element command array — is a SHELL command and normalizes to
`/bin/sh -c <command>`; an explicit non-empty argv (or a ≥2-element command array) spawns the
named program directly without a shell. `SOLVE_PROTOCOL_SECTION` documents all three
spellings, so the prompt hash changes once more; capsule bytes change a second time. No
boundary moves: the shell wrap only executes what the model could already exec by naming
`sh` explicitly, inside the trial container, behind the same per-trial token and budget stops.

The same smoke run exposed the wall-clock boundary: Terminal-Bench tasks pin
`timeout_sec = 900`, and harbor kills the agent at that ceiling with an `AgentTimeoutError` —
the trial records as an exception, the agent's `usage_update` never reaches harbor
(`result.json.usage` all null), and an in-flight upstream completion appends a receipt
_after_ collect, so `sum(receipts) ≠ settled`. The agent's 30-minute self-cap was
unreachable inside 900 s. Fix, config-only (no upstream change): the job config sets
`agent_timeout_multiplier: 2` (agent phase only — verifier timeouts stay canonical), giving
harbor 1800 s, and `SOLVE_AGENT_LIMITS.wallClockMs` drops to 1740 s so the capsule ends its
own loop — clean turn end, usage update, normal (possibly failed) capability result — before
harbor's kill. A run root frozen before this change must be resumed with the code that froze
it: the multiplier is part of harbor's JobLock identity, so mixing versions changes the
resolved run input of a relaunched job.

**Amendment (2026-08-31, paid smoke attempt 3).** With the timeout fix in place the trial
recorded normally — until the controller crashed in `collectAndCommit`:
`BudgetError: zero-amount entry with no unpriced usage`. Every gateway receipt was `ok:false`
(the upstream route returned 402 for the whole run), the agent loop ended gracefully, and
harbor recorded a **normal** trial whose usage update carried `costUsdMicros: 0` — a priced
zero, not a null. The trial-commit settle then mirrored `amount 0 / unpriced 0` into the
ledger, tripping the ledger's anti-noise guard (a zero-amount entry with no unpriced usage
is not an accounting fact). The guard is correct; the settle call was wrong to reach it. Fix:
every settle flows through `settleIfAccountable`, which skips exactly the no-op entries —
`amount 0` with no unpriced usage — before mirroring. A priced zero stays a fact of the
observation/usage document (cost 0 is recorded there); the ledger simply gets no row, and
`releaseRemainder` returns the reservation either way, so the skip is accounting-neutral.
This covers the same latent shape on the proposal side (`settleProposalBudget` could land at
`amount 0 / unpriced 0` for a zero-token gateway reply) and replaces the solver-token path's
ad-hoc `> 0` check. The environmental root cause of the smoke's failure — the upstream
account's 402 — is outside any code boundary and blocks re-running the smoke until the
balance is restored.

**Amendment (2026-08-31, paid smoke attempt 4 — DeepSeek official route).** The endpoint
switch (one-api balance exhausted → `https://api.deepseek.com/v1`, same
`deepseek-v4-flash`) worked end to end: the run closed (`K_REACHED`, 2 live trials,
~$0.10 total) and the first live solve trial in the project's history **solved its task**
(verifier reward 1.0 on adaptive-rejection-sampler). But both trials were recorded as
`AgentTimeoutError` exceptions killed at exactly 1800.0 s, with `agent_result` all null —
the smoke's `agentUsageReportedToHarbor` check failed, and the failure signal that drove
discovery → proposal → child evaluation was an artifact of the kill, not capability. The
margin arithmetic behind the 2× multiplier was wrong twice over: the capsule's wall clock
starts only when `session/prompt` arrives (after the runner's venv startup and the
initialize/new-session handshake), and the graceful end is not the last event — after the
capsule's 1740 s the prompt reply must travel back, harbor's runner writes
`acp-summary.json` in its `finally`, the runner exits, and only then does the docker exec
return; that teardown measured ≈ 2.5-3 minutes (summary mtime 14:19:23 vs the 14:16:58
kill). `asyncio.wait_for` cancelled the exec at 1800.0 s, `populate_context_post_run`
ran four seconds later, found no summary, and recorded the trial with no usage — the
agent HAD emitted `usage_update` (191 301 tokens, $0.0487) as its final event, and the
summary on disk after the fact proves the figures were correct. The non-timeout path is
healthy: attempt 3's 3-second all-error trial populated `agent_result`
(`cost_usd: 0.0`, tokens 0) exactly as designed. Fix, config-only:
`AGENT_TIMEOUT_MULTIPLIER` 2 → 3 (2700 s), leaving ~15 minutes of real teardown headroom
over the capsule's unchanged 1740 s wall clock. As before, the multiplier is part of
harbor's JobLock identity: run roots frozen under 2× must not be resumed under 3×.

**Amendment (2026-08-31, paid smoke attempt 5 PASS + K=10 launch unblocked).** Attempt 5 on
the official route validated the 3× multiplier live: both trials recorded normally with full
usage attribution (`exception: null`, 1923 s agent duration, `agent_result` populated —
11 213 in / 144 900 out / $0.0421 on trial 1), closed `K_REACHED` after 2 trials / 25 gateway
requests / 483 783 tokens / 112 592 µUSD, `allPassed: true`, evidence sha256 pinned. Both
rewards were genuine 0s — a capability signal, not an artifact. The immediately following
K=10 live-pilot launch then died in `init` before spending anything:
`/budget/wallClockMinutes: must be <= 960`. The schema's global `maximum: 960` encoded the
16 h _efficiency objective_ (specs/00 §6.3) as a system invariant for every config, while its
own description said "advisory for stable-demo, hard for formal profiles" — the recorded-replay
pilot (~4 h for 50 trials) never tripped it, but the live pilot's pre-registered 48 h loop
budget (~50 live trials at minutes-to-half-an-hour each) cannot fit 16 h, and silently
shrinking the rehearsal to 960 would have stopped the loop mid-run and defeated its purpose
(confirming the full closed loop). Fix: schema `maximum` 960 → 2880 with the two tiers spelled
out — formal profiles still fail closed at 960, rehearsal deviations must be pre-registered in
the run's STATUS (the pilot script already records `wallClockDeviation`). The 16 h objective
itself is untouched; it remains the K=80 design input the recorded pilot's extrapolation
already flagged (the time side needs trial parallelization).

**Amendment (2026-08-31, K=10 live pilot attempt 1 — two defects, fail-closed as designed).**
Attempt 1 ran one fully healthy live trial (34 min, receipts chain complete, usage attributed:
17 967 in / 230 466 out / $0.0670 — the 3× agent-timeout fix holds at pilot scale), then the
second discovery trial died `EnvironmentStartTimeoutError` at exactly 600.0 s and the pilot
crashed in `collect`. Two independent defects:

1. _Cold-image pull inside the environment timeout._ The task image
   (`alexgshaw/build-cython-ext:20251031`) was not local; harbor's environment phase runs
   `docker compose up --wait`, which pulls it, and the trial's effective budget was the task's
   default `build_timeout_sec` 600 s × no multiplier — our jobconfig set
   `agent_setup_timeout_multiplier` and `agent_timeout_multiplier` but not
   `environment_build_timeout_multiplier`. Harbor consumed its one pre-registered retry and
   re-failed (the pull was still in flight). Fix: `ENVIRONMENT_BUILD_TIMEOUT_MULTIPLIER = 5`
   in the jobconfig (3000 s, matching the ACP-bootstrap headroom) plus pre-pulling the
   discovery-candidate images before relaunch.
2. _F6 — a never-booted trial cannot have receipts, and `collect` treated that as an
   attribution failure._ `solverBlockFor` demanded a receipts file for EVERY trial when solve
   wiring is configured. But receipts are written TCB-side by the controller's own gateway —
   a container cannot suppress them — so a missing file genuinely means the gateway never saw
   an authenticated request. For a trial that died before the ACP handshake
   (`agentParticipation === 'never-initialized'`, infra-retryable status), zero usage is the
   honest fact, not a gap. Fix: `collect` emits a zero-usage solver block (same shape, frozen
   route ids, all-zero figures) for never-initialized/infra-retryable trials; every trial
   whose agent DID run keeps the fail-closed throw. A regression test pins both directions.

Neither defect touched money discipline: the run failed closed exactly where it should have
(ADR-028's infra-dead discovery check would have fired even without F6 — an agent that never
ran is not a capability fact, and the pool cannot freeze on it). Per ADR-028 the retry is
spent, so attempt 2 needs a FRESH run root; the env-build multiplier changes harbor's JobLock
identity anyway, so resume was never an option. F6 is not a license to skip receipts: the
carve-out is gated on the participation fact recorded by harbor's own ACP bookkeeping, not on
the convenience of the moment.

**Amendment (2026-09-01, K=10 live pilot attempt 2 — simulated-transcript loop).** The fresh
run's live solver trials all failed. Operator analysis of the quarantined failure artifacts
(not promoted into accepted `evidence/gate8/`) found the same shape across eight completed
trajectories: each ended at the capsule's 1,740,000 ms wall-clock backstop without a final
directive or required deliverable. In the representative `bn-fit-modify__ZVG8Gw2` trial the
trajectory text contained 204 JSON-looking directives and 157 `[exec exitCode=0]` markers,
while Harbor's ACP event stream recorded only six real `create_terminal` calls. Several model
receipts consumed the full 32,768 completion-token allowance. The model had emitted a first
directive, then hallucinated tool results, later directives and role-labelled prompts in one
completion, effectively simulating the remaining multi-turn loop itself.

Two runner defects amplified that model behavior. First, `parseSolveDirective` sliced from
`indexOf('{')` through `lastIndexOf('}')`, gluing every simulated object together and rejecting
the whole turn as invalid JSON. Second, the parse-error branch returned only an error sentence
to the stateless gateway conversation and discarded the raw reply, so prompt tokens barely
grew while the model repeated the same output pattern. Attempt 2 is therefore an invalidated
capability measurement and MUST NOT be resumed or made green retrospectively.

The repair is strict and fail-closed:

1. Starting at the first `{`, scan string/escape-aware brace depth and parse exactly the first
   complete object. Later prose, tool-result text and objects are never fallback directives;
   if the first object is malformed or off-grammar, the turn enters the recoverable parse-error
   path.
2. A successful turn records the full raw completion in the ACP trajectory for audit but adds
   only the normalized accepted directive plus the real ACP tool result to the next gateway
   prompt. Hallucinated suffixes and forged role labels do not become conversation state.
3. A failed turn adds at most 2,000 characters of the raw reply plus an explicit truncation
   marker to the next prompt, so the model can inspect and correct its previous output without
   allowing one bad completion to grow every later prompt without bound.

This changes stable-runner behavior and capsule bytes; `BUILDER_VERSION` advances to
`dsh-evolve-le-builder-0.0.3`. Unit tests pin first-object-only parsing, including rejection of
an invalid first object followed by a valid-looking later directive. A real Loader + HTTPS
gateway regression sends the observed chatty shape, verifies only the first command executes,
and verifies the hallucinated suffix remains in trajectory but not in the next model request.
The production capsule contract also asserts that the solve protocol/client/agent JS files are
present and hash-listed. These are engineering checks only: no post-repair paid smoke or K=10
result exists yet. Per specs/06 §14 and specs/07 §13 the next live validation requires a fresh
run lineage and may not inherit attempt-2 evaluation results.

## ADR-031 — Verifier dependencies are prepared before a live solver launch

**Decision:** a live solver run MUST use a run-scoped verifier-image receipt in addition to the
Harbor task-image prefetch receipt. The adapter may create derived images from the pinned upstream
task images, install the exact verifier Python and literal system-package requirements during
preparation, and materialize a task-copy whose verifier runs the installed `python -m pytest`
directly. The derived image IDs, base image IDs, dependency lists and rewritten verifier hashes are
content-bound in the receipt.

**Why:** Harbor image prefetch only proves that the image named by `[environment].docker_image` is
local and has not drifted. It does not execute `tests/test.sh` or pre-install commands contained in
that script. The K=10 attempt showed three verifiers downloading `uv` from GitHub after startup;
those downloads failed although the task images were cached, and the resulting reward 0 was
mistaken for a task result. Verifier-side `apt-get` and `pip` bootstrap commands, plus fixed
verifier-side `git clone` fixtures, are likewise moved to one preparation step (the clone is
rewritten to copy the frozen fixture from the derived image).

**Boundary:** the upstream Terminal-Bench checkout remains unchanged. A run using a derived verifier
image is a repaired development measurement and must carry the receipt; it is not an official
benchmark result unless the benchmark protocol explicitly accepts the same image/verifier bytes.
Missing or malformed receipts fail closed before any paid Harbor launch. The repair does not
auto-install a task's package-under-test: solver-produced installation remains part of the task
and is still scored by the verifier.

## ADR-032 — Live solver deadline follows the Terminal-Bench agent limit

**Decision:** the real-solver capsule MUST derive its wall clock from the launched task's pinned
`[agent].timeout_sec`, rather than from one universal duration. The trusted Terminal-Bench adapter
parses the scalar before the paid reservation, applies the frozen
`AGENT_TIMEOUT_MULTIPLIER = 3`, and records the effective milliseconds in the per-job non-secret
`DSH_SOLVE_AGENT_TIMEOUT_MS` environment value. A live capsule requires that fourth solve-gateway
environment value and calculates `wallClockMs = effectiveAgentTimeoutMs - 300000`. Invalid,
missing, non-positive or reserve-exhausted values fail closed. Each model HTTP request and each
terminal command is capped by the remaining deadline, in addition to its independent request or
command cap.

**Why:** the previous 1,740,000ms backstop was unrelated to TB's variable task budgets. It could
truncate a 3,600s, 7,200s or 12,000s task despite Harbor still allowing the agent phase, while it
gave a 600s task substantially more solve time than its task class. The Harbor multiplier remains
uniform across baseline and candidates; the five-minute reserve avoids losing accepted work at the
hard agent kill while ACP usage/reporting and Harbor teardown complete. `[verifier].timeout_sec`
is deliberately excluded because it governs a later verifier phase, not solver execution.

**Output policy:** the default zen-compatible route now freezes `maxOutputTokens = 131072` in its
run config and route plan. The K=10 live-pilot launcher asserts the same frozen value. This is an
input/cost change and requires a new run identity; `BUILDER_VERSION` advances to
`dsh-evolve-le-builder-0.0.4`. No old live root may resume under this policy, and this decision is
engineering configuration only, not a post-repair capability result.

## ADR-033 — Gateway-layer retry for transient upstream model failures; receipt attempts trace

**Decision:** every live model request gets a frozen retry policy from its route plan
(`retry: { maxAttempts, backoffMs }`, default `{ maxAttempts: 4, backoffMs: [500, 1500, 4500] }`),
applied inside the shared upstream call core (`upstream.ts`), so the proposer proxy and the solve
gateway inherit one behavior. Retryable classes: upstream HTTP **5xx** and **network failure**.
Not retryable — ambiguity resolves to FAIL, never to retry: 4xx (auth/model errors are
deterministic), per-attempt timeout (a request that ate its whole budget is an extreme upstream
state, and the retry budget is finite), empty content and malformed tool calls (model behavior,
not infrastructure). Each request still produces exactly **one receipt line**; the line carries a
new `attempts` array recording every upstream attempt (per-attempt `ok`/`error`/`httpStatus`/
`timedOut`), so the sequence invariant (`req-N` == line N+1) is untouched and the attempt trace is
durable evidence. Receipt schema versions bump: remote receipts 2 → 3, solve receipts 3 → 4;
verifiers accept both the pre- and post-ADR shapes.

**Budget bound.** The retry loop runs inside an explicit per-surface total budget so it can never
outlive its consumer: the proposer proxy gets `maxAttempts × requestTimeoutMs + Σ backoffMs`
(600 s per attempt on the live route → worst case ≈ 40 min, inside the 60-min live-proposal
sandbox; the worker's socket-client timeout is derived as total + 30 s margin, exactly as before
but over the loop). The solve gateway gets **650 s** — 10 s inside the ACP client's fixed 660 s
request budget (ADR-032's per-request cap, unchanged), so the in-container client never races the
gateway's retries; per-attempt budgets shrink to `min(requestTimeoutMs, remaining)` as attempts
consume the total. Failed attempts never consume the request/token/cost budget (unchanged: only
successful requests increment usage), and every attempt is bounded by the same per-request
`requestTimeoutMs` as today.

**Why:** tree-v2 K=3 live attempt 6 (2026-09-04, run root `dsh-tree-v2-k3-live-2dsMQ8`) reached
its first real-model expansions with both attempt-5 fixes holding — all three proposal boots were
quiescent with empty drift (the PipeWrap regression is fixed) and all six discovery trials
completed without an apt 502 (the forwarder held; `db-wal-recovery` scored reward 1). But the
expansion phase died 3/3: every proposal's **first** model call returned `upstream 500`
(`remote-receipts.jsonl`: `req-1`, `error: "upstream 500"`), the native agent made zero tool calls
and exited without `proposal_finish`, and `maxConsecutiveExpansionFailures` stopped the run
(NO_ADMISSIBLE_CHILD, trials=6 expansions=3). The same class killed the `code-from-image` solve
trial: its single receipt is `req-1: upstream 500`, the agent exited with zero tokens, and the
post-run audit flagged `agentUsageReportedToHarbor` with all-zero usage. The failure is the
external model endpoint (one-api) answering `Database error` — a probe against the same route
with a minimal request 500s right now — not the request shape: sibling trials made 26–49
successful calls each through the identical gateway in the same window. A single transient
upstream failure currently kills an entire paid proposal (or solve trial) with no retry anywhere
in the path; this ADR pre-registers the bounded retry that closes that gap. It changes no
reward-attributable surface, no timeout that bounds an agent, and no discovery classification —
the two attempt-5 apt-502 failures stay failures (rule 7), and the ADR-028 infra-retry set is
untouched.

**Disclosure:** the policy is frozen in the route plan and therefore in the route hash and the
run manifest (rule 8); `validateRunConfig` requires `retry` on every zen-compatible route
(missing or malformed → fail closed). The attempt trace is verified by the same receipt-chain
audits as before (sequence, hashes, attribution); tests pin the retry classification against a
local HTTP stub. Disclosed before the attempt-7 launch; no other protocol change.

**Amendment (2026-09-05, before attempt 7 — endpoint switch to the official DeepSeek API).**
The one-api upstream is retired (reported unusable after days of `Database error` 500s). Attempt
7 runs the same `deepseek-v4-flash` on `https://api.deepseek.com/v1` with a fresh credential
(mode-0600 file, never in any receipt/log/prompt). The route lock is otherwise unchanged — in
particular `maxOutputTokens: 131_072` — and was verified against the official endpoint before
launch: probes accepted both a minimal request and `max_tokens: 131072`, with API-reported usage.
The switch has precedent (the 2026-08-31 Gate 8 smoke amendment moved in the other direction for
an exhausted balance). Run id, master seed, task set and trial budgets are unchanged; the new
baseUrl is content-addressed into the fresh run root's route hash and manifest (rule 8).

### ADR-028 amendment — apt-level retry drop-in for the trial-container egress proxy (before attempt 8)

**Context.** Since attempt 5 (2026-09-04) every tree-v2 K=3 run has lost 2 of 6 discovery trials in
the ACP apt stage: the upstream proxy (the Windows-side client behind `127.0.0.1:7897`, bridged by
the `fwd` socat container) intermittently answers `502 Bad Gateway` for single deb.debian.org
fetches. Attempt 5 lost `code-from-image` and `db-wal-recovery`; attempt 7 lost
`break-filter-js-from-html` (the 502 hit `libfakeroot_1.31-1.2_amd64.deb`, the 90th and last file,
after 91.3 MB at 595 kB/s) and `cancel-async-tasks`. apt exits 100, harbor classifies
`NonZeroAgentExitCodeError`, and the trials stay capability FAILs in the denominator (ADR-028
amendment 3, unchanged — this ADR changes no classification).

**Why the proxy must stay.** Measured 2026-09-05 against the same bookworm base: direct container
egress to deb.debian.org still takes 320 s for a bare `apt-get update` (the ADR-028 throttle
class), while the proxy chain does the same update in 8.7 s. The fast path is real; the 502s are
the price, roughly one failed fetch per 90-file bootstrap for ~1/3 of trials.

**Change.** The TCB materializes one content-addressed apt drop-in —
`/etc/apt/apt.conf.d/99-dsh-evolve-le-retries.conf` with `Acquire::Retries "3";` — and bind-mounts
it read-only into every trial container through the pre-existing provider mounts channel (the same
`environment.mounts` lever that carries the CA bundle and the solve token, CLI line ~635). apt
then retries a 502'd fetch up to three times inside the setup phase; a persistently 502'd file
still fails apt and lands in the same `NonZeroAgentExitCodeError` capability-FAIL class. The
trial-level 1× infra retry, the 1800 s setup ceiling, and the classification table are untouched
— this widens no timeout, drops no trial, and touches no reward-attributable surface (rule 9).
The mount target is recorded verbatim in every job plan YAML, hence in the run manifest's
content-addressed plan set (rule 8).

### ADR-028 amendment — the apt `Acquire::Retries` drop-in is FALSIFIED; retry moves to the egress forwarder (during attempt 8)

**Falsification evidence.** The drop-in shipped with attempt 8, and the run proved it ineffective
while running: `break-filter-js-from-html` died on a single 502 with the mount provably attached
(sibling env containers inspected live carry the exact read-only mount at the exact target), and
`build-pmars` died with two different URLs 502'ing (`javascript-common_12+nmu1_all.deb`,
`libpython3.13_3.13.5-2+deb13u4_amd64.deb`). A container experiment on the same
`verifier-runtime` image family (apt 2.6.1) confirms the mechanism: apt treats an HTTP-status
failure as an answered request, and `Acquire::Retries` only re-dispatches _transient
connection-level_ failures. Against an always-502 endpoint, apt issued the identical number of
attempts with and without the drop-in (1 for a body-less 502 — apt 2.6.1's `basehttp.cc` marks a
content-less error `ERROR_UNRECOVERABLE`; 7 for a body-bearing 502 — its internal transient
allowlist 500/502/503/504/599 retry, which is independent of `Acquire::Retries`). The 502s are
bursty: 180 sequential probes through the production proxy saw zero 502s, while trial-setup load
windows produce multiple (two different URLs in one build-pmars bootstrap). The drop-in is a
no-op for every observed failure mode; it is reverted (CLI materialization, plan mounts, and
their contract pin removed) so no plan carries a config that pretends to retry.

**Replacement.** Retry moves under the client: the `fwd` socat relay (TCP
`172.17.0.1:17897 → 127.0.0.1:7897`) is replaced by a retrying HTTP forwarder bound to the _same_
address — zero changes to job plans, frozen config, route hashes, or the run manifest. It speaks
plain-HTTP proxying for non-TLS requests and re-issues a 502'd (or connection-failed) request up
to 3 additional times with backoff and a fresh upstream connection per attempt, so the trial
container's apt/curl/pip/uv never sees the 502 at all. CONNECT tunnels (HTTPS) pass through as
today — no retry inside TLS, and every observed failure is plain HTTP. This is host-side
environment infrastructure (the same class as the socat relay it replaces, ADR-028 second
amendment), deliberately not content-addressed in the run manifest; the retry policy itself is
pre-registered here and its implementation lives in the repository as
`scripts/lib/trial-egress-forwarder.py` with a loopback contract test, so the policy is versioned
and falsifiable. The capability-FAIL classification, the 1800 s setup ceiling, and the
trial-level 1× infra retry are untouched.

## ADR-034 — tree-v2 proposal receipts are TCB-finalized; the model never authors digests

**Context.** Attempt 7 (2026-09-05, run root `dsh-tree-v2-k3-live-XNO5PX`) was the first run where
live-model proposals reached admission validation end-to-end (the official DeepSeek endpoint
served every request, zero ADR-033 retries needed, all three proposer sandboxes completed). All
three expansions died on the tree-v2 contract: prop-1 and prop-3 were rejected 3/3 children with
`receiptDigest does not match canonical receipt`; prop-2 was rejected with `analysis schema:
must have required property 'parentCandidateDigest'/'findings'; must NOT have additional
properties "$schema"` plus an invented donor (`@dsh-evolve-le/candidate-tree-v2-baseline is not in
the archive catalog`). The preserved bundles show why: the model _fabricated_ digest-looking
strings — prop-1 child-1's `analysisReceipt.receiptDigest` is a copy of the parent candidate
digest, its `proposalReceipt.receiptDigest` is a concatenation of two evidence digests, and its
`mechanismOutcomeDigest` is random hex. The wire protocol demanded the impossible: it told the
model that receipt digests cover canonical JSON (TCB_PROTOCOL_SECTION), i.e. it asked an LLM to
compute sorted-key sha256 by hand. Recorded deterministic policies compute these in TypeScript and
always passed (Gate 8 ran recorded-replay); no live model ever will.

**Root cause.** Digest computation is TCB work that leaked into the model-authored surface. The
proposal bundle's digests are content-addressed bindings between documents — they must be derived,
never authored. The archive catalog (the sole donor source, per specs/03 §9) was also never shown
to the model, so donors were hallucinated names.

**Change (three parts, disclosed before the attempt-8 launch):**

1. _TCB finalization at the proposal tool boundary_ — new module `tree-v2/finalize-bundle.ts`,
   invoked by the native `proposal_finish` tool _before_ the bundle shape check and _before_ the
   worker writes `proposal.json`. For a v2 envelope it rebuilds each child's documents from
   semantic fields and replaces every digest:
   - analysis receipt: `{parentCandidateDigest: <trusted treeV2Parent.candidateDigest>,
findings: <model's>, evidenceDigests: <model's, every digest must resolve to an object of
the export the model actually read>}` — extra properties such as `$schema` are dropped by
     construction; then `finalizeTreeV2Receipt` computes the digest.
   - candidate-intent (`candidate.json`): the parent binding and
     `requiredParentEvidence.analysisDigest`/`mechanismOutcomeDigest` are TCB-forced from the
     trusted `treeV2Parent`; `normalizedTrialDigest`/`trajectoryDigest` keep the model's choices
     but must resolve to normalized-trial/trajectory objects of the export AND appear in the
     analysis `evidenceDigests` (this closes the hollow-evidence hole: today the controller never
     checks these two refs against the export, so a fabricated but pattern-valid digest would
     verify). The receipt digest is recomputed and the file rewritten. All other intent fields
     (modeContract, modeComponents, modeSurfaces, capabilities, tests) stay model-authored and
     controller-validated.
   - proposal receipt: rebuilt with `proposalId = childName`, `analysisDigest =
analysis.receiptDigest`, `candidateIntentDigest = intent.receiptDigest`, the intent's
     `modeContract` and `requiredParentEvidence`; then finalized.
   - `donorCandidates`: every donor must exist in the staged archive catalog; otherwise the tool
     returns the attributable error to the model (it has one bounded turn budget to adjust).
     v1 envelopes pass through untouched; the recorded-policy path is untouched (it never reaches
     this tool and already produces verified digests).
2. _The archive catalog becomes sandbox input_ — `input/archive-catalog.json` is staged beside the
   export view (dev-observed-only content with the guard-exclusion counter, per catalog.ts) so the
   model reads real candidate ids instead of inventing donors; an empty catalog (expansion 1)
   makes `donorCandidates: []` the only valid choice.
3. _Prompt correction_ — the wire-protocol section and the native proposal instruction now state
   that every digest and digest-binding field is computed by the toolchain (model may omit them or
   write null; any digest-looking value is replaced), and name `archive-catalog.json` in the
   readable roots.

**Why this is not a protocol shrink (rule 9).** The controller's independent validation is
unchanged: `assertTreeV2ReceiptDocument` still re-verifies every finalized digest and
cross-binding, `validateProposalBundle` still checks donors, export refs, canaries, diffs and the
intent contract. The finalization only moves an impossible-for-LLM computation into TCB code at
the last moment before validation; the raw model bundle stays in the transcript's tool-call
events, so the derivation remains auditable. Structural impossibilities (missing/unparseable
`candidate.json`, unusable findings/evidence) fail the proposal at the tool boundary with the same
proposal-failure outcome the controller rejection would have produced — attributable, never
silently repaired.

**Disclosure:** implemented behind contract tests that replay the actual attempt-7 prop-1/3
fixtures (fabricated digests must finalize to a chain that verifies; a valid bundle must pass
through unchanged; v1 must be untouched). No upstream (harbor/tb/deepseek-harness) change.

## ADR-035 — Proposal-loop budget wall: token-cap headroom, tool-call budget pressure, failure transcripts (before attempt 9)

**Status:** accepted, implemented before attempt 9 (2026-09-06).

**Evidence (attempt 8, live route).** All three proposals died as
`NativeProposalError: agent exited without proposal_finish` (107/91/111 tool calls). The receipt
trails (`<sandbox>-remote/remote-receipts.jsonl`) pin the mechanism:

- prop-1 (38 delivered requests) and prop-3 (52 delivered requests): the NEXT request's response
  was discarded by the post-hoc budget check —
  `budget stop: 4164820 tokens / 606457 µUSD would exceed the cap` (prop-1),
  `4107189 tokens` (prop-3) — against `REMOTE_PROPOSER_BUDGET.maxTotalTokens = 4_000_000`. The
  children were fully staged, so the discarded response was most plausibly the final writes or
  the `proposal_finish` submission itself. The error ends the upstream DSH loop silently
  (`kick()` swallows turn errors; `whenIdle()` resolves), so the runner sees "exited without
  proposal_finish".
- prop-2 (45 delivered requests, 3.69M cumulative tokens — under the cap): the final response was
  delivered and contained no tool calls (a text-only response returns `kind: 'completed'` and the
  loop exits). The model simply ended in prose instead of invoking `proposal_finish`.

The shared root cause: the tree-v2 protocol has the model author full child source trees through
`proposal_write_child` with inline content, and the DSH session re-sends the entire tool history
on every request. A full 2–3-child proposal lands at ~3.7–4.2M cumulative tokens — exactly where
the 4M cap sits — and nothing in the loop exerts pressure to submit before hitting the wall.

**Decisions.**

1. _Token-cap headroom (proposer remote gateway)._ `REMOTE_PROPOSER_BUDGET.maxTotalTokens`
   4_000_000 → 6_000_000. Three worst-case proposals (3 × 6M = 18M) stay inside the frozen
   run-level `budget.proposerTokens = 20_000_000`. `maxCostUsdMicros` stays 4_000_000 ($4.00) —
   observed cost was ~$0.57 per proposal, so cost was never the binding constraint. The post-hoc
   check stays HARD (fail closed): if it ever fires again, it still discards the just-paid
   response rather than exceeding the declared cap; with the pressure below, it is an emergency
   brake, not the normal termination path.
2. _Tool-call budget pressure (native proposal tools, TCB-owned)._ `NATIVE_PROPOSAL_TOOL_BUDGET`
   freezes two boundaries: a soft reminder at 72 calls (every list/read/write result then carries
   a trailing note: N of 96 used, finish the minimum and call `proposal_finish`) and a hard
   refusal at 96 calls (`proposal_list_files`/`proposal_read_file`/`proposal_write_child` then
   fail with an error telling the model to submit now). `proposal_finish` is exempt at every
   count. Attempt-8 authoring took 91–111 calls, so the reminder fires mid-authoring and the
   refusal is just above the observed band; worst-case sessions (~110 requests of ~250K
   context) stay under the 6M token cap. The recorded-policy path is untouched (it has no live
   model and already terminates deterministically).
3. _Prompt hardening._ The native proposal instruction now states that a plain-text final answer
   ends the run in failure — only a `proposal_finish` tool call can succeed — and names the
   bounded tool-call budget. This is the prop-2 fix: prose endings become impossible to miss.
4. _Failure transcripts._ `runNativeProposal` writes the full session-event chronology (plus the
   audits and the error) to `work/failure-transcript.jsonl` before throwing
   `NativeProposalError`, and the error message names that path. Attempt 8 was diagnosed from
   receipt correlation alone because the transcript was only written on success; rule 7 requires
   failed trials to stay attributable, and the session events are the only complete record of
   what the model did.

**Why this is not a protocol shrink (rule 9).** The controller's validation and the run-level
budget ledger are unchanged; the cap raise keeps 3 × 6M ≤ the frozen 20M proposer-token budget,
and the cost cap is untouched. The tool-call budget is an envelope constraint inside TCB-owned
tools — a model that ignores it produces an attributable tool error, not a silently repaired
proposal. Considered and deferred: multi-file `proposal_write_child` batching and diff-based
child authoring (protocol churn that would cut re-sent history at the cost of a new authoring
surface); revisit only if the pressure band proves too tight in production.

**Disclosure:** implemented behind contract tests pinning the budget constants, the reminder
text and its trigger count, the refusal boundary, the `proposal_finish` exemption, the
plain-text-ends-in-failure instruction line, and the failure-transcript shape. No upstream
(harbor/tb/deepseek-harness) change.

## ADR-036 — proposal_finish receives deep-frozen tool-call arguments; TCB finalization deep-copies before mutating (during attempt 9)

**Status:** accepted, implemented during attempt 9 (2026-09-06).

**Evidence.** Attempt 9's failure transcripts (`work/failure-transcript.jsonl`, ADR-035 D4)
showed the ADR-035 tool budget working as designed — the models stopped wandering and called
`proposal_finish` 31× (prop-1) and 10× (prop-2) — and every single call died with
`Error: Cannot assign to read only property 'analysisReceipt' of object '#<Object>'`.
The upstream DSH session deep-freezes every appended message (`deepFreeze` on
`assistant/message`), which freezes the tool-call arguments the proposal tool receives. The
ADR-034 finalizer mutates that bundle in place (it rebuilds analysis/proposal receipts and the
candidate-intent parent evidence), so the first write throws in strict mode. The models retried
with different bundles, got the same cryptically-worded error, and exhausted the 64-request
gateway cap (prop-1) or ended in prose (prop-2). The ADR-034 contract tests could not catch
this: they pass ordinary mutable objects; only the real runtime's freeze boundary can.

**Decision.** The `proposal_finish` native tool is the transport boundary (the same boundary
ADR-034 already uses for finalization); it now hands the TCB finalizer a private deep copy
(`structuredClone`) of the model's bundle instead of the frozen argument object. The raw frozen
tool-call event stays in the session transcript, so the audit trail is unchanged; the finalizer
still runs before the shape check, and the controller still re-verifies independently. v1
envelopes and the recorded-policy path are untouched (no freeze boundary exists there; the
recorded policy authors its own bundles).

**Why this is not a protocol shrink (rule 9).** No validation is weakened: `parseProposalOutput`
still runs on the finalized copy, and the controller's `assertTreeV2ReceiptDocument` /
`validateProposalBundle` re-verify everything independently. The copy is the minimum change
that lets an immutable input meet a mutating finalizer; rejecting the frozen bundle instead
would fail every live proposal by construction.

**Disclosure:** implemented behind a contract test that deep-freezes the model bundle
(recursively) and asserts submission still succeeds, plus the existing ADR-034 fixture tests.
No upstream (harbor/tb/deepseek-harness) change.

## ADR-037 — modeComponents names parent-existing modules only; the TCB finalizer enforces the projection contract at the submit boundary (after attempt 10)

**Context.** Attempt 10 (first run with the ADR-036 submit fix) produced the first complete
live submissions: all three proposals called `proposal_finish` once and returned ok — the
freeze wall is gone. All nine children then died at the controller's `diffBoundary` with one
shared rejection class: `tree-v2 contract rejected: parent target solve references missing
file src/<child-added module>.ts`. The child candidate-intents listed the modules the children
ADD (`src/adaptive-rejection-sampler.ts`, `src/cancel-async-tasks.ts`, `src/db-wal-recovery.ts`
and variants) inside `runtime.modeComponents`, alongside the parent's `src/index.ts` and
`src/strategy.ts`. The contract (`assertTreeV2Child`) projects every modeComponent path over
the PARENT tree — a path missing there fails closed — because modeComponents names the parent
files whose production bytes the child CHANGES; modules the child adds are established by the
added-file diff and named in `tests.mechanism`.

The semantics exists nowhere a model can see it: the candidate-intent JSON Schema carries no
description for `modeComponents`/`componentPaths`, and the proposer prompt never mentions the
rule. The model's natural reading — copy the parent's candidate.json shape and list every
module that participates in the mode — is exactly what all nine children did, and the model
did read the staged `parent-files.json` (transcript evidence: the full parent file list was
in the session), so this is not an information-access failure but a semantics gap. Worse, the
rejection lands only after the whole proposal returns ok: zero in-loop feedback, so the model
cannot fix it within the session and every attempt loses its entire proposal budget to one
unknown rule. This is precisely the un-attributable failure class rule 7 forbids accumulating.

**Decision.** (1) The TCB finalizer (`finalizeTreeV2Bundle`, the same ADR-034 submit boundary)
now enforces the projection contract against the staged parent source view and the written
child trees, per child, before repairing receipts: every modeComponent path must match the
production pattern, exist in the parent view, and exist in the child tree; target modes must
show a production-byte change at the listed paths; preserved modes must show none; `src/index.ts`
must be modified by every child. Failures throw `TreeV2FinalizationError` with the exact child,
mode, and path plus the fix guidance, which the DSH session feeds back to the model as a tool
result — the model can correct the intent and retry `proposal_finish` in the same session.
The wiring (`proposer/tools.ts`) reads the TCB-staged `parent-files.json` and the parent files
themselves into a `parentSourceFiles` map passed to the finalizer; a missing staging artifact
fails the finalization closed (never a silent skip). (2) The candidate-intent schema gains
descriptions on `modeComponents`/`componentPaths` stating the parent-membership rule. (3) The
proposer prompt states the rule explicitly and names `parent-files.json` as the source of
truth. The controller's independent `assertTreeV2Child` re-verification is unchanged and
remains authoritative; the boundary check is early, attributable feedback, not a second
authority — same outcome class as a controller rejection, surfaced while the model can act.

**Why not reject at the controller only (no boundary check).** Every tree-v2 live attempt so
far has failed wholesale to one silent contract rule at a time (ADR-034 receipts, ADR-035
budget wall, ADR-036 freeze, now modeComponents): each cycle costs a full paid run with zero
in-loop feedback. The boundary check converts the NEXT unknown-rule rejection into a fixable
tool error inside the session it was authored. Scope is the observed class plus the two
adjacent projection rules (byte-change/byte-match, component-root modification) that share the
same data; the added-file/added-test diff checks stay controller-side until observed.

**Why not a prompt-only fix.** All nine children failed identically while holding the exact
parent file list in-session; the rule is non-obvious (the parent's own intent lists the files
it owns). Prompt text alone cannot make an authoring error attributable or fixable in-loop;
the boundary check makes the failure local, precise, and retryable at zero extra cost.

**Amendment (same day, before attempt 12): the boundary check also enforces the tests naming
contract.** Attempt-10 evidence shows the class queued behind modeComponents: prop-1/prop-2
named preservation tests (`tests/*.preservation.spec.ts`) without writing them, and the
controller's `tests reference missing test file` / `child must add a declared mechanism test`
checks would reject those children next. The finalizer now additionally requires every
`tests.mechanism`/`tests.preservation` path to match `tests/*.spec.ts`, to exist in the child
tree, and (mechanism only) to be an ADDED file — the parent view already in hand decides
added-status. A malformed `modeContract` also fails attributably instead of crashing the
boundary. The prompt gains the same naming rule.

**Disclosure:** implemented behind contract tests replaying the attempt-10 fixture (a
parent-missing modeComponent path), plus the inverse (child-missing), byte-change, byte-match,
pattern, and component-root cases, the tests-naming classes, a malformed modeContract, and a
missing parent view; the existing ADR-034 fixtures are updated to carry a parent source view.
No upstream (harbor/tb/deepseek-harness) change.

## ADR-038 — TCB candidate-test feedback at the proposal_finish boundary: the model sees the parent's failing tests in-session (after attempt 11)

**Context.** Attempt 11 (2026-09-06, run root `dsh-tree-v2-k3-live-SHBwcZ`, 4607s,
`NO_ADMISSIBLE_CHILD`) validated ADR-036/037 end-to-end: prop-1 submitted once with zero tool
errors, every child intent was contract-clean, and all six children passed `diffBoundary`.
All six then died at the NEXT layer, `typeLintUnit`, with one shared rejection: the parent's
own baseline spec failed `tests/candidate.spec.ts (5 tests | 5 failed)` in ~25ms per child.

Post-hoc reproduction against the surviving build tree pins the byte-level cause: every child
mounted its new mechanism as a SECOND top-level plugin in `src/index.ts` —
`ctx.plugin(strategyPlugin, config)` **plus** `ctx.plugin(newMechanismPlugin, config)`. The
parent baseline `candidate.spec.ts` is an exact-surface identity test (`mounted` must equal
`['strategyPlugin']`, exactly one section/tool/skill per mode, exactly 3 effects, "registers
nothing beyond the declared surfaces"). The second plugin blows every count, so all five
assertions fail; the children's OWN added mechanism tests passed (3/3) — the model's specs
validate the new module in isolation, not the parent-surface preservation contract. The fix a
compliant child needs (route the new module through the EXISTING strategy component instead of
mounting a new plugin) is trivial, but the model never learns it: the proposal sandbox has no
exec tool, so the model authors TypeScript and vitest specs blindly, and `typeLintUnit` runs
only after submission, controller-side, with zero in-loop feedback. This is exactly the
feedback-void class ADR-037 closed at `diffBoundary`, now one layer deeper. Attempt 11 spent
~77 paid minutes to discover a fact the builder computes in about one second.

**Decision.** (1) **Boundary test check** (main fix): after the ADR-037 structural checks pass,
`finalizeProposal` runs the SAME checks `typeLintUnit` runs — oxlint then vitest over the
merged parent+child tree — before returning the bundle. Execution is controller-side: a new
request kind `candidate-tests` on the existing Gate-8 model gateway socket (`remote-gateway.ts`
dispatches by `type`), handled by staging the merged view in a throwaway directory and running
the pinned toolchain through the same `runSandboxed` subprocess the builder uses. A failure
returns to the worker as a `ToolError` carrying the ANSI-stripped, truncated output with the
child name, so the model can fix the offending files and retry `proposal_finish` in the same
session. The worker-side implementation is a dependency-light socket client
(`proposer/remote-tests.ts`, one connection per request — the `remote-model.ts` pattern) added
to `WORKER_RUNTIME_FILES`; the merged view is `parentSourceFiles` (already in hand from
ADR-037) plus the child's written tree. (2) **Prompt amendment**: the proposer prompt states
the surface-preservation rule — the parent's baseline spec asserts the exact mounted surface;
new mechanisms must route through the existing strategy component, never as an added
top-level plugin. (3) The controller's own `typeLintUnit` re-verification is unchanged and
remains authoritative; the boundary run is early, attributable feedback, not a second
authority.

**Safety and cost bounds.** Candidate code executes only in the throwaway sandboxed subprocess
(never in the worker or controller processes — rule 4). The merged view carries only source
files; the runner symlinks the PARENT CAPSULE's `node_modules/` into the staged tree (the
child's dependency closure is by contract the parent's — package.json is fixed), so vitest
collects real tests rather than zero. The gateway refuses `candidate-tests` outright when the
real runner would have no dependency root (fail closed; injected runners in tests are exempt).
The controller re-verifies every
parent-file byte in the sent merged view against its staged parent view before running, so the
model cannot smuggle parent-file edits into the test run. Test runs use their own request
counter and write no model receipts — the receipt chain (`req-N` sequence) stays model-call
only, and `verifyRemoteReceipts` is untouched; the tool-error text itself lands in the
transcript as evidence. Per-session budget: 12 test runs, output truncated to 2000 chars,
180s/60s subprocess timeouts (the builder's own numbers), and file-count/byte caps on the sent
view. Recorded (gateway-less) routes skip the check — the controller gates still apply, and
the boundary check is feedback for the only route that can use it (networked live proposals).

**Why not an exec tool in the proposal sandbox (proposal_run_tests).** Strongest feedback
loop, but a new tool surface: cost control, toolchain availability inside the worker runtime
tree, and another capability to audit. The boundary check reuses capabilities that already
exist on the controller side (sandboxed subprocess, pinned oxlint/vitest, the gateway socket)
and extends the ADR-037 pattern one layer. Escalate to a bounded exec tool only if boundary
feedback proves insufficient (e.g., the model exhausts its retry budget without converging).

**Why not prompt-only.** Attempt-10 precedent: 9/9 children failed identically while holding
the exact evidence in-session. The rule ("your change must not alter the parent's mounted
surface") is knowable in principle, but only a test run makes a violation attributable and
fixable in-loop at zero extra model cost.

**Why not controller-only (status quo).** Every tree-v2 live attempt so far has failed
wholesale to one silent contract layer at a time (ADR-034/035/036/037, now typeLintUnit):
each cycle costs a full paid run with zero in-loop feedback.

**Disclosure:** implemented behind contract tests (gateway: merged-view verification,
parent-byte tamper refusal, ok/fail replies, sequence isolation; tools: runner invocation per
child with the merged view, ToolError on failure, budget cap, runner-absent skip) plus the
existing pipeline refactor extraction (builder `type-lint-unit` helpers, no behavior change).
The attempt-12 launch is the user's to run; this ADR pre-registers what attempt 12 validates:
children that fail the parent's baseline tests get the failure back as an in-session tool
error and converge or exhaust their retry budget inside the proposal, instead of dying
silently at the builder. No upstream (harbor/tb/deepseek-harness) change.

## ADR-039 — Boundary must mirror admission + the runtime fingerprint must see mounted content (after attempt 12)

**Context.** Attempt 12 (2026-09-06, run root `dsh-tree-v2-k3-live-xjXLQM`, ~45 min, $1.73,
trials=6 expansions=3, `NO_ADMISSIBLE_CHILD`). ADR-038 validated end-to-end: prop-1's first
`proposal_finish` returned the real vitest output as a tool error (its own mechanism assertion
was wrong), the model fixed the spec and resubmitted green; the parent baseline's 5/5
exact-surface tests passed in every proposal. But three NEW controller-side gates fired — one
per expansion — each invisible in-loop:

1. **prop-1 (2/2 children)**: `candidate manifest rejected the child:
/runtime/modeComponents/propose: must NOT have fewer than 1 items {"limit":1}` — the model
   wrote an empty propose array; the ADR-037 projection check passes vacuously on empty arrays,
   and the full candidate-manifest schema runs only controller-side (`validate.ts`).
2. **prop-2 (2/2 children)**: `candidate scan rejected the child: package/missing at <root>:0;
patch/missing at <root>:0` — the submitted child trees carried no `package.json` /
   `cordis.patch.yml`. The boundary test run passed because the merged view's PARENT side
   supplied those bytes; the builder scans the child's own tree, which lacks them.
3. **prop-3 (2/2 children)**: builder `mockReplay`: `target mode solve Loader fingerprint did
not change` — the children followed the ADR-038 prompt exactly (fold a directive into the
   existing solve-mode section, no new registrations), and their own mechanism tests passed,
   but `treeV2RuntimeFingerprint` hashes only section NAMES and registry NAMES
   (`sections.afterBoot` is `string[]`), so content-only evolution can never satisfy the
   target-mode contract. This is a structural conflict: the parent baseline spec pins the
   mounted names (exactly one plugin/section/tool/skill, 3 effects) while the tree-v2 contract
   demands the fingerprint change — under the name-only fingerprint those two gates are
   jointly unsatisfiable without adding registry entries (which break the parent spec).

**Decision.** (1) **Fixed-file presence at the boundary** (prop-2): `finalizeTreeV2Bundle`
requires `package.json` and `cordis.patch.yml` present in each child tree, byte-identical to
the parent view (they are "keep fixed" files; the parent bytes are in hand from ADR-037). A
gap fails the finalization with the exact file name and the fix ("write the parent's bytes via
proposal_write_child"). (2) **Schema at the boundary** (prop-1): the gateway-side candidate-tests
runner validates the child's `candidate.json` with the same `validateManifest('candidate')`
call `validate.ts` uses and reports the schema errors verbatim. (3) **Content-sensitive
fingerprint** (prop-3, contract): the probe report gains an additive `sectionSurfaces` field
(`{name, order, text}[]` for candidate sections — the stub's `snapshot()` already carries the
text), and `treeV2RuntimeFingerprint` hashes those objects plus the registry names. Both
parent and child fingerprints in a run come from the same code, so the comparison stays
self-consistent; text-only evolution now counts as a real target-mode change. (4) **Surface
compare at the boundary** (prop-3, feedback): the candidate-tests runner additionally mounts
the merged child view and the parent view through the SDK testkit in sandboxed subprocesses
(the exact harness pattern the parent baseline spec uses) and compares the per-mode mounted
record — section name/order/text plus tool/skill names — against the child's declared
modeContract: every target mode's record must differ, every preserved mode's must be
identical. Failures name the mode and the missing delta. (5) **Prompt amendment**: with this
parent (only `src/index.ts` + `src/strategy.ts` production files, and `src/index.ts` must be
modified by contract) a byte-preserved mode is structurally impossible — children must target
BOTH modes and make BOTH mounted surfaces observably different (fold a per-mode directive
into the solve section AND the propose section); and the fixed files must be written into
each child tree.

**Amendment (during implementation): identity masking in the fingerprint.** The first
builder-suite run after the content-sensitive fingerprint rejected a byte-identical
preserved-mode child: `preserved mode propose Loader fingerprint changed`. Root cause: the
SDK's documented section pattern embeds `config.candidateId` in the text, and the parent and
the child mount under DIFFERENT ids — raw text hashing breaks every preserved-mode contract
on identity alone. `treeV2RuntimeFingerprint` therefore takes the caller's own candidate id
and masks its occurrences in section text with a fixed sentinel before hashing (the pipeline
passes its own `candidateId` at both fingerprint sites). Identity is fixed content, not an
evolvable mechanism; content beyond identity still moves the fingerprint (pinned by a
contract test: same text modulo id → equal; id-equal text plus a directive → different).

**Why not a wider fingerprint (tool descriptions, effects).** Section text is the primary
observable the solver actually sees; tool/skill names are already covered. Descriptions and
effect counts are asserted by the parent baseline spec, and dragging them into the contract
fingerprint would just re-create the same name-pinning conflict one level down.

**Why the boundary compare uses the testkit, not a real Loader boot.** A faithful mockReplay
prediction would require compiling the child bundle, assembling a capsule and booting it —
the builder's own stages, minutes per child per retry. The testkit mount exercises the same
`candidate.register` path through the SDK the Loader boots, and the real probe stays the
authoritative gate at mockReplay. Residual gap (agent/session events and workflows, which the
testkit does not model) is accepted and pre-registered: a child may pass the boundary and
still fail mockReplay on those surfaces — the controller still fails closed, and the class is
reported for the next ADR if observed.

**Disclosure:** implemented behind contract tests (finalize: fixed-file missing/differing;
gateway runner: schema violation verbatim, target-mode surface unchanged, preserved-mode
surface changed, parent-mount parity; contract: fingerprint content sensitivity + identity
masking; probe: `sectionSurfaces` additive shape through the real Loader) plus a real
attempt-12 view smoke, which ran both directions: the prop-3 child as-written fails the new
boundary with `tree-v2 target mode propose mounted surface did not change` (exactly the
feedback the model would now receive in-session), and the same child with a directive folded
into the propose section text passes the whole boundary (`oxlint clean; candidate tests
passed`). Attempt 13 validated it: all three classes became in-session tool errors (below).
No upstream (harbor/tb/deepseek-harness) change.

## ADR-040 — Solver usage is receipt-anchored; the trial-shape envelope mirrors the protocol (after attempt 13)

**Context.** Attempt 13 (2026-09-06, run root `dsh-tree-v2-k3-live-sMVV0K`, ~116 min, $2.67,
trials=14 discovery=6 expansions=2, `K_REACHED` / `STABLE_ITERATION_VERIFIED`). The
algorithm goal was achieved for the first time: 4 non-baseline nodes admitted across two
expansions (2 per expansion, both fed by real failure-pool signals), 2 lineage levels, and
the stable-demo stop fired. ADR-039 validated: the three attempt-12 rejection classes became
in-session tool errors — every proposal submitted schema-valid manifests with the fixed
files in every child tree, and content-sensitive target-mode fingerprints passed. But the
run FAILED on three evidence gates, all in the usage/shape accounting layer:

1. **`trialCountWithinThePreRegisteredEnvelope`**: the check encoded the envelope as
   `trials === discovery + expansionAttempts × coldStartTrials`. That formula is a wrong
   encoding of the protocol (specs/03 §6): cold starts are per ADMITTED node (`q0=1`, 4
   here), and the UCB-Air evaluation branch runs ordinary Thompson trials (4 here):
   14 = 6 discovery + 4×1 cold start + 4 ordinary. The formula can only hold when every
   expansion admits exactly one node AND no ordinary evaluation ever runs — contradictory
   to the spec's own expand-vs-evaluate rule. (It failed on attempt 12 too, for a different
   shape: 6 ≠ 6 + 3×1.) The caps all held: 14 ≤ taskTrials=15/maxSolverTrials=15, 6 ≤
   maxDiscoveryTrials=12.
2. **`agentUsageReportedToHarbor (dsh-60a0b2d0…/db-wal-recovery__zRyukfw)`**: the trial
   hit `AgentTimeoutError` at 45 min (pinned `[agent].timeout_sec` 900 × the adapter's
   constant `AGENT_TIMEOUT_MULTIPLIER` 3.0). Upstream Harbor's timeout path discards the
   agent's report — `agent_result` lands all-null (no usage, `metadata.acp.initialize`
   null) even though the gateway recorded 25 requests / 262,250 tokens for that job. The
   adapter's `participationOf` maps (exception + missing initialize record) to
   `never-initialized` — false here: the receipt chain proves the agent ran.
3. **`receiptUsageMatchesSettlement`**: receipts 16,831,542 vs settled 16,569,292 — the
   diff is exactly the timed-out trial's 262,250. The collect-time zero-usage branch
   (participation heuristic) zero-settled a live trial; a zero settle is rejected by the
   ledger ("never silently free" — ADR-030), so the tokens vanished from the budget. The
   fail-closed null-check did not fire because the branch produced `0`, not `null`.

The timeout trial itself is a legitimate solver failure (active for 45 minutes, task
unsolved — a real failure-pool signal), not an infra class; only its attribution broke.

**Decision.** (1) **Receipt-first zero branch** (harbor-provider collect): the zero-usage
solver block applies only when the VERIFIED receipt chain has `requests === 0` (or the
file is missing with the never-booted classification — the honest zero of K=10 attempt 1).
A verified chain with `requests > 0` always yields its figures, regardless of the
participation heuristic; a missing chain for a participation-`ran` trial keeps the existing
fail-closed throw. The gateway chain is TCB-side and content-addressed — it is the
authority; Harbor's capsule report is a cross-check where it exists. (2) **Envelope formula
mirrors the protocol**: `trials === discovery + admittedNonBaseline × q0 + ordinary`
(ordinary ≥ 0), `discovery === discoveryBatchSize`, `trials ≤ taskTrials` and
`≤ maxSolverTrials`, `discovery ≤ maxDiscoveryTrials`,
`admittedNonBaseline ≤ kTarget + shortlistSize − 1` (the wave-snapshot overshoot bound:
expansion is legal while admitted < K, and one wave can admit at most `shortlistSize`),
`proposal-calls === expansionAttempts`. The formula is a pure function in
`tree-v2-live-profile.ts`, contract-tested against both attempt-12 and attempt-13 shapes.
(3) **Usage gate amendment**: `agentUsageReportedToHarbor` becomes two checks —
`receiptChainCoversEveryLiveTrial` (every live trial has a verified chain with
`requests > 0`, unless the trial never initialized the agent AND the chain is empty/missing)
and `harborUsageReportedWhenCapsuleCompleted` (Harbor's `agent_result` must carry positive
usage whenever the capsule completed its report — `metadata` non-null). Killed trials are
exempt from the Harbor check by construction, with the kill visible in `exception_info`
and the chain as the attribution authority; the record script logs which trials were
exempted and why. This preserves the pre-registered intent (no trial with real spend goes
unattributed; the capsule report stays checked wherever upstream makes it possible) without
mutating Harbor's raw result.json post-hoc.

(4) **Terminal stop-reason list** gains `NO_ADMISSIBLE_CHILD`: specs/03 §7
names it the sole protocol result once the frozen consecutive-expansion-failure
cap trips, but the record-script list omitted it — attempt 12's legitimate
`NO_ADMISSIBLE_CHILD` stop was mis-scored as an unregistered state alongside
the envelope false negative.

**Why not backfill Harbor's result.json.** Overwriting the raw job record after the fact
would turn the capsule-vs-gateway cross-check into gateway-vs-gateway (circular) and break
append-only evidence. Harbor's nulls stay visible in the evidence copies; the chain carries
the attribution.

**Why not capsule self-termination before the timeout boundary.** A graceful self-close
would change trial semantics (the verifier would run on whatever state exists at T−ε and
could turn timeouts into rewards) — that changes outcomes, not just attribution. The
hard-kill envelope stays; only the accounting is fixed.

**Disclosure.** Implemented behind contract tests: provider collect of a killed-trial
fixture (AgentTimeoutError + null metadata + non-empty receipts) returns the full
receipt-derived figures; the never-booted honest zero now requires a FAILED chain
(missing file); the envelope pure function accepts attempt-12's shape
(6 discovery, 0 admitted, 3 expansions) and attempt-13's shape (14 = 6 + 4×1 + 4) and
rejects cap/overshoot/discovery/proposal violations; the amended gates classify a killed
live trial as chain-covered (chain ahead of the never-initialized heuristic, pinned by a
dedicated contract test), a capsule-completed trial with null usage as a failure, and
`NO_ADMISSIBLE_CHILD` as registered. Attempt 14 re-runs the same RUN_ID / MASTER_SEED /
profile; this ADR pre-registers what it validates: all evidence gates pass on a
`K_REACHED` run whose failed trials carry full attribution.
No upstream (harbor/tb/deepseek-harness) change. `record-gate8-solve-smoke.ts`
carries its own copy of the pre-ADR-040 Harbor-usage gate; it is not exercised
by the tree-v2 live runs and is left untouched until a Gate 8 smoke re-run
makes it an acceptance consumer.

## ADR-041: k10 live envelope — funded multi-batch discovery and `NO_ADMISSIBLE_TASK` are legal terminal shapes

**Status.** Accepted (2026-09-06).

**Context.** The K=10 real-solver live run (the scale rehearsal before K=80) exercises two
frozen protocol paths the K=3 attempts never reached, and both would have mis-scored a
legal run at the record gate: (1) `discoverFailures` freezes the failure pool only at a
batch boundary that contains a real failure — an all-success first batch honestly funds a
second one inside `maxDiscoveryTrials` — but the ADR-040 envelope required
`discovery === discoveryBatchSize` exactly; (2) the driver's frozen `StopReason` union
emits `NO_ADMISSIBLE_TASK` when every admitted candidate has tried every pool handle, a
state a 60-trial search over a small frozen pool can genuinely reach, but the registered
terminal stop-reason list omitted it.

**Decision.** (1) **Envelope discovery condition becomes a funded-multiple check**:
`discovery` must be positive, `≤ maxDiscoveryTrials`, and divisible by
`discoveryBatchSize`. A partial batch, zero, or past-the-cap discovery still fails closed.
The K=3 envelopes are unchanged in effect for the observed shapes (6 and 12 are both legal
for k3; 5, 7, 13 stay rejected). (2) **`NO_ADMISSIBLE_TASK` joins
`REGISTERED_TERMINAL_STOP_REASONS`** — it is a deterministic search-exhaustion state in
the frozen driver union, not a crash; mis-scoring it would repeat the attempt-12
`NO_ADMISSIBLE_CHILD` false failure (ADR-040). (3) **The k10 run prepares both funded
discovery batches (12 tasks)** of offline verifier images at launch, so an all-success
first batch continues honestly instead of scheduling unprepared tasks. A third batch is
protocol-forbidden by the specs/04 §4.1 hard cap; 12 all-pass stops
`NO_REAL_FAILURE_SIGNAL` (registered).

**Correction before first launch (same day).** The k10 profile's original
`maxDiscoveryTrials=48` (carried over from the v1-era Gate 8 pilot) is not schema-legal
under tree-v2: `schemas/run.config.schema.json` caps the field at `maximum: 12`, citing
specs/04 §4.1's hard cap. The first launch attempt's `init` rejected the generated config
fail-closed (RUNNER_EXIT=1, zero spend, no trial launched) — exactly the intended
behavior. The profile is amended to the spec cap (`maxDiscoveryTrials: 12` = the two
funded stable-demo batches); the schema is untouched. The k10 rehearsal therefore
exercises the implemented discovery machinery (12-cap) plus the 60-trial search envelope;
the separate pre-launch baseline freezing for K=10/K=80 benchmark profiles (specs/04
§4.2) remains out of scope and stays a K=80 pre-registration item.

**Disclosure.** Contract-tested in `tree-v2-live-profile.test.ts` before implementation:
k3 discovery 12 accepted / 13 rejected / 7 rejected; k10 discovery 12 (2 funded batches)
accepted / 18 rejected (past the spec cap); `NO_ADMISSIBLE_TASK` registered. No upstream
change. The K=10 live run (`tree-v2-k10-live`, profile k10) is the first consumer of
these amendments.

**Live validation (2026-09-06, k10 attempt 1).** The run recorded fully green
(RUNNER_EXIT=0, `failures: []`) and stopped `NO_ADMISSIBLE_TASK` at trials=14,
discovery=6, expansions=4, admittedNonBaseline=4 — the amendment scored the stop
correctly instead of the attempt-12-class false failure. The run also quantified a
structural supply gap: UCB-Air needs `N ≥ (admitted+1)^(5/3)` (~54 trials for K=10),
but evaluation supply caps at discovery + children × poolSize (= 26 with the frozen
2-task pool), so K=10 is unreachable under the stable-demo discovery — the gap
specs/04 §4.2's benchmark baseline freezing exists to close, and that machinery is
unimplemented. No further paid K=10/K=80 runs until it lands (ADR-042).

## ADR-042: Benchmark baseline freeze (specs/04 §4.2) + UCB-Air calibration preflight (specs/03 §2)

**Status.** Accepted (2026-09-06).

**Context.** K=10 attempt 1 (the first benchmark-profile rehearsal) stopped
`NO_ADMISSIBLE_TASK` at 14 trials with a fully green record. Quantified against the frozen
driver semantics (N = all completed observations; expansion iff `N^0.6 >= T`, `T` =
baseline + admitted children, `alpha = 0.6` frozen): the K-th admission needs
`N >= K^(5/3)` (K=10 → 47), but the evaluation supply caps at
`D + children × poolSize` — with the stable-demo discovery's 2-task pool that is
`6 + 10×2 = 26`, structurally short (pool ≥ 5 would barely work). The rehearsal also
surfaced two frozen-arithmetic facts: (1) specs/03 §7 defines `N` as _ordinary development
trials_, but the literal reading dead-starts the search — the first expansion gate
(`N ≥ 1`) can never fire because no child exists before an expansion and the baseline has
already exhausted the pool, so no ordinary trial can ever run; the driver's
all-observations semantics is the exercised one (validated by the K=3 green run and
traceable in the attempt-1 expansion cadence). (2) The k80 profile's 252-trial envelope
can never reach K=80: the final gate needs `N >= 80^(5/3) ≈ 1485.3`, ceil 1486 — and
specs/03 §2 mandates that calibration REJECT such a run, not launch it.

**Decision.** (1) **specs/03 §7 `N` definition corrected** to "completed development
trials (all observations: discovery + cold start + ordinary)" with an ADR-042 note; the
driver semantics is frozen as the protocol. (2) **`search.benchmarkBaseline` config**
(schema addition, optional, absent for stable-demo): `{ taskCount, attemptsPerTask,
batchSize }`. When present, the driver runs the full baseline matrix — the first
`taskCount` observed handles in frozen ceremony order, attempts `1..attemptsPerTask`,
batches of `batchSize` (waves `baseline-<a>-<b>-<w>`, crash-resume idempotent exactly
like discovery) — and freezes the failure pool at the END: pool = tasks with zero
successful attempts; empty pool stops `NO_REAL_FAILURE_SIGNAL`; infra-dead observations
fail closed (ADR-028). The stable-demo 12-cap discovery is untouched (specs/04 §4.1 is
stable-demo-only evidence, `FAILURE_DISCOVERY_SAMPLE`). (3) **K=10 profile pre-registers
`benchmarkBaseline { taskCount: 24, attemptsPerTask: 1, batchSize: 6 }`** — expected pool
≈ 9.6 at the observed ~40% baseline failure rate; supply `24 + 10×P ≥ 47` for P ≥ 3, with
margin. Its `maxDiscoveryTrials=12` becomes dormant (documented). (4) **Calibration
preflight (specs/03 §2)**: a pure `calibrateSearch` — `minimumTrials =
ceil(K^(5/3)) + q0 × shortlistSize` (final-wave cold-start bound); the run is rejected
before any paid launch unless `maxSolverTrials >= minimumTrials` AND `taskTrials >=
minimumTrials`; with a benchmark baseline also `taskCount <= observed handles`,
`taskCount × attemptsPerTask + K × q0 <= maxSolverTrials`, and the best-case pool supply
`D + K × taskCount >= minimumTrials`. The current k80 profile (252 < 1486) is REJECTED
by this check — spec-mandated; its envelope amendment is a separate ADR and is NOT
silently resized here. (5) **Record envelope**: profiles with `benchmarkBaseline` check
`discoveryTrials === taskCount × attemptsPerTask` exactly (the pre-registered matrix),
replacing the ADR-041 funded-multiple rule for that profile class. (6) The K=80
60-task matrix (observed 48 + guard 12, attempts ≥ 2 per specs/04 §4.2) additionally
needs the `dev-guard` wave split and concealment path — deferred to the K=80 ADR; the
K=10 baseline is observed-only.

**Why in-run phase and not a separate run.** "另行冻结" (§4.2) prohibits reusing
stable-demo evidence and requires the benchmark baseline to exist before proposals; a
durable frozen matrix + pool inside the benchmark run satisfies both, and a later ADR
can split it into a reusable cross-run artifact with §4.4-style identity verification
if needed.

**Why zero-success pool membership.** With `attemptsPerTask > 1`, a task the baseline
solves at least once is solvable by the baseline and is not a search target; §4.1's
single-attempt failures are the A=1 special case of the same rule.

**Disclosure.** Contract tests first: calibration golden values (K=10 → 47, K=80 →
1486, stable-demo K=3 → 9 within its 15-trial envelope), k80-profile rejection,
matrix-bound and best-case-supply rejections; driver freeze tests (batch/wave
determinism, crash/resume at every boundary, empty-pool `NO_REAL_FAILURE_SIGNAL`,
infra-dead fail-closed); envelope benchmark variant; schema + `--set` wiring. No
upstream change. K=10 attempt 2 is the first consumer.

## ADR-043: Proposal-saga receipts enter the recorder evidence copy set

**Status.** Accepted (2026-09-07).

**Context.** K=10 attempt 2 stopped `STOPPED:NO_ADMISSIBLE_CHILD` after three
consecutive all-reject expansions (8 children admitted over 5 successful expansions,
then a rejection wall). The post-mortem needs to know WHICH rejection mode fired —
empty proposal, all duplicate, all no-new-mechanism, all build reject, or abandoned
intent — but the recorder's copy set (per-trial artifacts, run-manifest, drive-report,
tree-v2-migration, verifier-image-receipt, image-prefetch) contains NOTHING from the
proposal saga. The disambiguating receipts all live in the scratch run root: the
content-addressed object store (`objects/sha256/`, holding the proposal validation
summaries with per-child rejected reasons, proposal bundles, transcripts, gateway and
remote receipts, normalized trials, admission receipts — 1.4 MB for the whole K=3 run),
the per-sandbox worker results (`controller/sandboxes/prop-N/work/worker-result.json`),
`search-state.json` (expansion counters, rebuild rejections, abandoned intents) and
`failure-pool.json` — and ADR-029 deletes that scratch root on success. Attempt 2's
own receipts are therefore unrecoverable; the gap predates this session (the k3
recorder has the same copy set) and violates rule 7's auditability for the proposal
saga. K=3 roots survive in scratch only because their records predate ADR-029.

**Decision.** The recorder copy set (k3 and k10 record scripts, shared helper
`scripts/lib/evidence-copy-set.ts`, no TCB change — the object store already contains
these receipts) additionally preserves, before the scratch deletion:

1. Every object-store file, flat-named `object-<sha256>` at the artifacts top level.
   The redaction scan (rule 8) walks `artifactsDir` top level only, so flattening keeps
   the scan unchanged while the digest file names stay self-authenticating.
2. `search-state.json` and `failure-pool.json` verbatim.
3. Per-expansion `worker-result.json` as `<actionId>-worker-result.json` (boot facts,
   DAC probes, worker verdict — the one sandbox fact the store does not persist).

**Why the object store rather than the sandbox dirs.** `controller/sandboxes/` weighs
hundreds of MB (staged capsule inputs) and its evidence-relevant files are already
collected into `objects/sha256/` by the controller as CONTROLLER_INTERNAL artifacts;
the validation summary object carries the per-child rejected reasons, which is exactly
the field that disambiguates duplicate vs no-new-mechanism vs bundle reject. The
rejected children's source trees themselves stay scratch-only (they were never
admitted, so they are not artifacts of record; their hashes ride the summary).

**Why worker-result.json separately.** `putSandboxArtifacts` stores transcript,
gateway receipts, proposal.json and remote receipts — but not the worker-result
manifest; its DAC-probe and boot verdicts are the per-expansion safety facts and are
small.

**Disclosure.** Contract test first (`scripts/tests/evidence-copy-set.test.ts`) pinning
the copy set against a synthetic run root, then both record scripts consume the
helper. Attempt 2's rejected-proposal receipts remain unrecoverable and the expansion
mode classification for attempt 2 stays inference-based; attempt 3 is the first run
whose proposal saga is fully preserved. No upstream change.

## ADR-044: Prior-rejection feedback — every expansion reads this run's rejected children + reasons

**Status.** Accepted (2026-09-07).

**Context.** K=10 attempt 2 died `STOPPED:NO_ADMISSIBLE_CHILD`: 5 successful
expansions admitted only 8 of ≤24 proposals (rejection throughout) and the last 3
expansions were 100% rejected. The surviving K=3 roots show the same failure family —
attempt 12's two all-reject expansions were `candidate scan rejected the child:
package/missing; patch/missing` (children omitting the fixed package.json and
cordis.patch.yml) and `candidate manifest rejected the child: modeComponents`
projection violations. The structural cause: **each expansion is a fresh roll** — the
proposer reads the parent tree, the failure pool and the archive catalog, but NEVER
the validator's verdicts on its own previous proposals. A model that converges on a
rejected shape repeats it until the frozen consecutive-failure cap fires. ADR-038 fed
the parent's failing TESTS back in-session; nothing feeds back the proposal REJECTION
reasons (duplicate mechanism, no-change child, candidate-scan findings, manifest
violations, bundle errors, failure reasons) — the exact acceptance criteria missed.

**Decision.** (1) **Durable rejection record**: `searchState.proposalRejections`
(optional, normalized to [] — same pattern as rebuildRejections), one entry per
expansion with any rejected child or failure: `{ actionId, rejected: [{childName,
reason}], batchErrors }`, reasons truncated to 300 chars, entries capped at the last
16, merged idempotently by actionId in the SAME saveSearchState write as the
expansion counters (a crash never leaves a half-append). (2) **Staged input**: the
driver passes the history into every proposal request; the supervisor stages it as
`input/prior-rejections.json` (deterministic from state, controller-owned input like
archive-catalog.json — dev-observed verdicts about the proposer's own output, no
sealed data, no label change). (3) **Prompt**: the native proposal instruction (the
live route) and the remote wire-protocol section name the file as a readable root and
instruct the model to treat every listed reason as a hard constraint — do not repeat
a rejected shape. The recorded v1 policy is untouched (deterministic; reads no new
inputs).

**Why in-run state, not the archive.** The rejections describe THIS run's proposal
saga; the archive catalog holds admitted dev-observed candidates only, and a rejected
child is never admitted, so there is nowhere else durable for it. The cap and
truncation keep the staged file far under the 512 KiB tool-read cap (16 × (3 × 300 + 300) ≈ 19 KiB worst case).

**Why the reasons, not the rejected source trees.** The validator text is the
acceptance criterion the child missed; the trees themselves stay scratch-only
(ADR-043 records the verdicts; the trees were never admitted artifacts).

**Disclosure.** Contract tests first: the pure record/doc builders (idempotent
merge, cap, truncation), the driver wiring (a failed expansion's record lands in
search-state and reaches the NEXT expansion's request — extended from the existing
NO_ADMISSIBLE_CHILD freeze test, no new paid-shaped test), real-sandbox staging
(prior-rejections.json lands in the sealed input), and the live-route prompt text.
TCB change (driver + controller request + supervisor staging + TCB prompt); no
upstream change. K=10 attempt 3 is the first consumer.

## ADR-045: K=80 formal envelope amendment (alpha 0.8, 30h wall clock, 400-trial envelope)

**Status.** Accepted (2026-09-07).

**Context.** ADR-042's calibration preflight REJECTS the k80 profile (252-trial
envelope): at the frozen default `alpha=0.6` the final gate needs
`N >= ceil(80^(5/3)) = 1486` (minimumTrials 1501), which no feasible wall clock can
fund. Attempt 3 measured the live pace at 1447 s/trial-slot (60 trials / 21698 s at
concurrency 4); at concurrency 8 a 16h window fits only ~318 slots, while the formal
K=80 run's mandatory trial floor is matrix 98 + cold starts 240 + tournament +
sealed (25-45h). ADR-042 (6) explicitly deferred the k80 amendment to a separate ADR
rather than silently resizing. User-confirmed decisions (2026-09-07): amend the wall
clock, pre-register alpha=0.8, adopt the 49×2 matrix, and defer guard/tournament
scope.

**Decision.** (1) **Alpha pre-registered at 0.8 for the formal k80 profile**
(`ucbAirAlphaPerMille: 800`, a new per-profile field): final gate
`ceil(80^1.25)=240`, minimumTrials 255 — below the mandatory floor, so the search
pace is driven by q0=3 cold starts and evaluation depth is covered by the deferred
tournament. specs/03 §2's ban on ad-hoc alpha changes is untouched (a pre-registered
ADR amendment is the compliant path; the calibration rejection clause itself is
unchanged — at 0.6 the k80 shape still fails closed). (2) **Wall-clock objective
explicitly amended 16h → 30h** (`wallClockMinutes: 1800`) for the formal K=80 run,
with disclosure; ADR-031's hold at 16h is superseded, the `$500` objective (specs/00
§6.3) is unchanged. (3) **Envelope**: `maxSolverTrials 252→400`, `taskTrials 252→400`,
`solverTokens 504M→800M` (preserves the taskTrials × 2M invariant),
`proposalCalls 20→60` (~50 expansions at attempt 3's observed ~1.67 admitted /
expansion), `proposerTokens 20M→60M`, `concurrentTrials 4→8` (the dedicated CLI
flag's existing 1..8 cap; not a `--set` key). `kTarget/q0/shortlistSize/proposalWidth`
= 80/3/5/3 unchanged; `maxDiscoveryTrials=12` dormant, same as k10. (4)
**benchmarkBaseline**: the live profile carries the interim observed-only
`{ taskCount: 39, attemptsPerTask: 2, batchSize: 8 }`; this ADR pre-registers the
full **49×2** matrix (39 observed + 10 guard = every ≤1800s-eligible development
task), explicitly amending specs/04 §4.2's "60 tasks" with disclosure. (5)
**Deferrals** (no paid K=80 launch until all land, each its own ADR): dev-guard wave
split + concealment (SAFETY_ABORTED), tournament/champion, schema
`benchmarkBaseline.taskCount` 48→49, and the k80 record script (symmetric to k10,
validating the four new fields). Until then the pre-registered profile has no launch
path — fail-closed by construction.

**Calibration arithmetic** (contract-tested): alpha=0.8 → finalGate 240,
minimumTrials 255 ≤ 400 ✓; matrix bound 39×2 + 80×3 = 318 ≤ 400 ✓; best-case pool
supply 78 + 80×39 = 3198 ≥ 255 ✓; preflight ceremony check 39 ≤ observed split 39
(exactly at the bound) ✓.

**Cost disclosure** (attempt-3 measured ~$0.14/trial): search 400 × $0.14 ≈ $56 +
proposer ≈ $15 → ~$71; deferred tournament (~300 trials ≈ $42) and sealed (budget
pre-registered in a later ADR) keep the total well under the $500 objective.

**Pre-registration.** With `maxSolverTrials === taskTrials` the driver reports
`TRIAL_CAP` (checked before budget failures) when the k80 search exhausts its
400-trial envelope.

**Why not 16h.** The floor is arithmetic, not pacing optimism: matrix 98 + 240 cold
starts alone is 338 slots; at the measured 1447 s/slot × concurrency 8 that is ~17h
before any tournament or sealed trial. Claiming a 16h objective while the protocol
demands more mandatory trials would violate rule 9's fail-closed mandate; the ADR
amends the objective instead of silently shrinking the protocol.

**Disclosure.** Contract tests first: calibration goldens at alpha=0.8 (240/255,
matrix 78, bestCaseSupply 3198) and the retained 0.6 rejection (1486/1501 vs 400);
preflight acceptance against the 72-handle live population; profile pinning of every
new field and their `--set`/`--concurrent-trials` arg carriers; k3/k10 keep the
frozen defaults (the new profile fields are optional and absent = byte-identical
args). specs/00 §6.3, specs/03 §2 and specs/04 §4.2 carry ADR-045 amendment notes.
No upstream change; no paid K=80 launch path exists until the deferred items land.

## ADR-045 amendment (2026-09-07): interim 39×2 scale rehearsal authorized

**Status.** Accepted (2026-09-07, user decision).

**Context.** The user asked to start the K=80 run. ADR-045's fail-closed state
meant no launch path existed (no k80 record script). Three options were
presented — minimal path (record script + amendment + labeled rehearsal),
full deferral list first, or unregistered hand-assembly — and the minimal
path was chosen.

**Decision.** (1) `scripts/record-tree-v2-k80-live.ts` lands (symmetric to
k10): it validates that alpha=0.8, proposalCalls=60, proposerTokens=60M,
concurrentTrials=8 and the 39×2×8 matrix all freeze verbatim into the run
config, and it records the ADR-043 evidence copy set. (2) The interim
observed-only 39×2 run is authorized as a LABELED scale rehearsal:
`formal:false` in the evidence documents, development evidence only, no
promotion path (rule 6). (3) The ADR-045 deferral list is unchanged — the
formal 49×2 guard-inclusive run stays blocked on its own ADRs. (4)
Pre-registration: RUN_ID=`tree-v2-k80-live`, MASTER_SEED=
`tree-v2-k80-live-master-seed-1`, the frozen k80 envelope (400/400/800M,
alpha=0.8, 60/60M, concurrency 8, wall clock 30h), expected terminal states
{K_REACHED, TRIAL_CAP, NO_ADMISSIBLE_CHILD, NO_ADMISSIBLE_TASK,
NO_REAL_FAILURE_SIGNAL, BUDGET_EXHAUSTED}, cost realistic ≈ $71 / worst
≈ $353 < $500.

**Why this does not shrink the protocol.** Rule 9: the formal protocol
(49×2, guard, tournament) is untouched — the rehearsal is additional
development evidence under the formal search envelope, explicitly labeled
non-formal in its own STATUS document, and no rehearsal green light can
promote (rule 6).

**Disclosure.** Contract pins first: k80 envelope shapes (78-matrix
exactness, 400-trial cap, wave-snapshot overshoot bound 84) and the
concurrentTrials=8 freeze in the validated config; the script type-checks
and the confirmation gate refuses without `DSH_TREE_V2_LIVE_CONFIRM=confirm`
(smoke-verified, no paid effect). No upstream change.

## ADR-045 amendment follow-up (2026-09-07): rehearsal terminated, direct formal path

**Status.** Accepted (2026-09-07, user decision).

**Context.** After launch the user re-evaluated the rehearsal: it shares the
formal envelope and flow, so a rehearsal success could not count as formal
(rule 6 — no intermediate green light promotes) and the formal run would
re-execute the search anyway. The ~$71 insurance was judged not worth a 30h
duplicate; the user chose to land the ADR-045 deferral list and run the
formal 49×2 K=80 directly.

**Decision.** (1) The interim 39×2 rehearsal was terminated by SIGTERM during
the live-search phase: 8 harbor jobs recorded, 3 trials in flight,
search-state `expansionAttempts=0`, no trial verdict recorded; full process
tree and containers torn down; run root `dsh-tree-v2-k80-live-Eyxq2j`
preserved under `/root/vibe/dsh/scratch/`. In-flight token spend was tiny
(sub-$1, no attributable results). (2) Rehearsal evidence keeps
`formal:false`, no promotion (rule 6). (3) Path change: implement the
deferral list — dev-guard waves + concealment (SAFETY_ABORTED),
tournament/champion, sealed pre-registration, schema
`benchmarkBaseline.taskCount` 48→49, formal record script + 49×2
pre-registration — then launch the formal K=80 run. (4) The formal protocol
is untouched: 49×2 matrix, guard channel, tournament, sealed reveal, +5pp
gate (rule 9).

## ADR-046 (2026-09-07): dev-guard baseline waves + concealment + information-flow monitor

**Status.** Accepted (2026-09-07, user-approved plan: direct formal path).

**Context.** Deferral item 1 of ADR-045. The formal 49×2 matrix (specs/04 §4.2)
is 39 observed + 10 guard, but the driver never plans a `dev-guard` wave
(all waves hard-coded `'dev-observed'`, driver.ts), the `SAFETY_ABORTED` phase
exists in the reducer with no emitter, and `HarborProvider.launch` throws on
`attempt !== 1` — the matrix's second attempt would crash at launch.

**Decision.**
1. `freezeBenchmarkBaseline` plans the matrix as two contiguous segments in
   frozen ceremony order: the 39 observed handles, then the 10 opaque guard
   ids (`guard-01`…`guard-10`, split `'dev-guard'`, action ids
   `eval-<short>-guard-NN-aN`). Waves keep the `baseline-<attempt>-<batch>-<wave>`
   shape. The provider resolves guard ids via its TCB guardMap; no guard
   identity ever reaches the driver.
2. Guard outcomes are recorded with `observation.split='dev-guard'` and
   trajectory label `DEV_GUARD`; the failure pool stays observed-only
   (guard zero-success tasks are excluded). Rationale: the pool doubles as
   the proposer evidence feed — a guard handle in the pool would hit the
   export label check (export.ts `assertLabelsAllowed`) and hard-crash, not
   leak. Guard outcomes enter the selector only during tournament coverage
   (ADR-047), matching specs/05 §10 `selector.read`.
3. Bounds move from observed-only to observed+guard inclusive: driver
   baseline bound and preflight `searchCalibrationCheck` accept
   `taskCount ≤ observedHandles.length + guardOpaqueIds.length` (49 legal,
   50 rejected). Schema `maximum: 48 → 49` rides in ADR-049.
4. Information-flow monitor: new `src/iteration/info-flow-monitor.ts`.
   Canaries are deterministic per (master seed, run, principal) via the
   existing `deriveCanaryTokens` (proposer/canary.ts): one per guard task
   (`guard:<opaqueId>`), plus a `sealed:sweep` set. Each guard trial's
   normalized evidence embeds its canary so downstream copies carry it.
   Three surfaces: (a) every evidence export passes the canary set into
   `createEvidenceExport` — a hit refuses the export; (b) every proposal
   result — `validateProposalBundle` scans worker-result/proposal/child
   sources; (c) terminal sweep over controller journal payloads before
   drive-report and before any CANDIDATE_LOCKED transition. A hit escalates
   to run-level abort: `controller.changePhase('SAFETY_ABORTED')` (legal
   edge from SEARCHING/CALIBRATED/PREFLIGHT), new `StopReason
   'SAFETY_ABORTED'`, drive-report records it, `info-flow-monitor.json`
   stores fingerprints only (never tokens). Lineage is invalidated
   (specs/05 §15 S3: new run ID required; no resume).
5. `HarborProvider.launch` relaxes the `attempt !== 1` throw: per-attempt
   idempotency keys (`eval-<candidate>-<task>-aN`) are already unique, and
   one Harbor job = one task × one attempt remains the paid identity; a
   second attempt is its own job. The existing fail-closed test flips to
   assert per-attempt keys are legal; malformed request shapes stay
   rejected.
6. Contract-first, including the information-flow tests specs/03 §15 names
   as a paid-run precondition: sealed/guard canary injected into a proposal
   worker result → forced SAFETY_ABORTED; canary in export bytes → refusal
   + abort; canary in journal summary → terminal sweep abort.

**Spec notes.** specs/04 §7 gains a pool-observed-only implementation note;
specs/05 §10 gains the monitor implementation pointer.

## ADR-047 (2026-09-07): tournament + champion triple-hash lock

**Status.** Accepted (2026-09-07, user-approved plan: direct formal path).

**Context.** Deferral item 2a of ADR-045. specs/03 §11 defines the
tournament but no driver code exists: nothing emits `dev-champion`,
`candidate.locked`, or the CANDIDATE_LOCKED phase.

**Decision.**
1. After `search()` returns `K_REACHED` and only when
   `config.profile === 'terminal-bench-formal'`, the driver runs the
   tournament (new pure module `src/selection/tournament.ts`):
   - eligibility: admitted candidates with ≥ `minEligibilityTrials` (12)
     completed observations and complete artifacts; baseline always eligible;
   - shortlist: `q10(Beta(1+s,1+f))` via the existing `drawNodeThompson`
     (selection/thompson.ts) on a new dedicated `'tournament'` RNG stream,
     hash-fixed tie-break (`sha256(candidateId || masterSeed || counter)`
     descending), receipt-journaled;
   - degradation per specs/03 §11: 1..4 eligible → all enter; 0 eligible →
     q10-ordered top-up to 12 if tournament budget allows, else
     `NO_DEVELOPMENT_IMPROVEMENT`; insufficient top-up budget → same, no
     sealed contact;
   - coverage plan: 6 nodes (baseline + shortlist) × 49 dev tasks × 1
     attempt = 294 trials, waves `tournament-<nodeIdx>-<batch>-<wave>` via
     the existing evaluation saga (resumable, exactly-once); observed tasks
     run `dev-observed`, guard tasks run opaque `dev-guard` — this is where
     guard outcomes enter the selector (specs/03 §11 step 4);
   - scoring: task-weighted paired delta over the coverage attempts,
     `Delta = (1/49) Σ d_i`; 90% cluster-bootstrap LCB (cluster = task,
     fixed seed, ≥100 000 resamples) via new `src/selection/bootstrap.ts`
     on the existing `'bootstrap'` RNG stream;
   - champion: highest LCB among baseline + shortlist (specs/03 §10
     tie-break). Baseline wins or winner delta ≤ 0 →
     `NO_DEVELOPMENT_IMPROVEMENT`, no sealed contact.
2. Champion lock: freeze `candidate-lock.json`
   {winnerId, sourceHash, archiveSha256, runManifestHash,
   tripleHash = sha256(source||capsule||manifest), sealedPlanHash}; emit in
   order `candidate.status.changed 'dev-champion'` → `candidate.locked`
   (reducer one-shot) → `candidate.status.changed 'locked'` →
   `run.phase.changed 'CANDIDATE_LOCKED'`. Selector/proposer permanently
   disabled from CANDIDATE_LOCKED (reducer edges). Crash-safe: resume sees
   the phase or lock and skips/idempotently replays the transition.
3. `NO_DEVELOPMENT_IMPROVEMENT` becomes a new reducer terminal phase
   (EARLY_TERMINALS + SEARCHING edge) so a resume can never re-enter
   search.
4. Reporting: `StopReason` += `'NO_DEVELOPMENT_IMPROVEMENT' |
   'CHAMPION_LOCKED' | 'SAFETY_ABORTED'` (SAFETY_ABORTED rides ADR-046);
   `DriveReport` += tournamentTrials/championId/championLockHash/shortlist;
   `status` and `audit` CLI commands surface the champion lock read-only
   and verify candidate-lock.json against `state.locks.candidateLock`.

**Spec notes.** specs/03 §11 gains implementation notes (coverage plan
49-task for the ≤1800s population, guard participation in the tournament
selector, degradation receipts).

## ADR-048 (2026-09-07): sealed plan pre-registration (23×5×2, phased wall budget)

**Status.** Accepted (2026-09-07, user decision on phased wall budget
2026-09-07 + user-approved plan).

**Context.** Deferral item 2b of ADR-045. Two normative tensions resolved
explicitly: (1) specs/04 §8/§9 write the sealed plan as 29 tasks ×
`k_sealed` — the pinned-89 nominal split — while the frozen ≤1800s
eligibility policy (specs/04 lines 5-12) yields 23 sealed tasks for the
live 72-task population; (2) ADR-045's 30 h wall-clock target cannot
contain search + tournament + sealed (ADR-045's own note estimated
25-45 h for the forced trial volumes).

**Decision.**
1. **sealed = 23, disclosed.** The formal K=80 sealed confirmation runs on
   the 23 sealed tasks of the 72-task ≤1800s-eligible population;
   `Delta = (1/23) Σ d_i` over paired task means. specs/04 §9's `(1/29)`
   is the pinned-89 nominal and is not silently changed — this ADR is the
   explicit reconciliation (rule 9: no silent shrink; the eligibility
   policy is the frozen authority for every sealed run).
2. **k_sealed = 5** — specs/04 §8 default, no low-power disclosure needed.
3. **Sealed plan** (`sealed-plan.json`, frozen at candidate lock): 23 tasks
   × 5 attempts × 2 sides (baseline + locked champion) = 230 trials;
   task/attempt-interleaved random order on a new `'sealed-plan'` RNG
   stream; independent trial seeds; no intermediate-reward branching
   (specs/04 §4.3).
4. **Sealed evaluator is a new CLI subcommand**
   (`dsh-evolve sealed-evaluate --run-root --sealed-store --sealed-plan
   --candidate-lock-hash`), invoked by the formal record script after the
   driver ends at CANDIDATE_LOCKED. The driver keeps `sealedAccess:false`
   (schema const untouched); the sealed store is persisted 0600 root-only
   outside the evidence tree and never enters the controller journal
   except the single reveal event. Artifacts carry the SEALED label; the
   verdict gates are specs/00 §6.2 (Delta ≥ 0.05, CI95.lower > 0,
   completeness 100%, critical findings 0) → `SEALED_PROMOTED`;
   point-estimate pass with CI crossing 0 → `PROMISING_NOT_CONFIRMED`;
   else `SEALED_REJECTED`; integrity failures → `PROTOCOL_INVALID`. Reveal
   is one-shot (`sealed.revealed` reducer event); a runner-up is never
   tested (specs/03 §12).
5. **Phased wall budget (user decision 2026-09-07):** search 1800 min
   (ADR-045 envelope) + tournament 960 min = run-config
   `wallClockMinutes` 2760 (≤ schema max 2880), with the tournament phase
   checked against its own 960 min sub-budget inside the driver; sealed
   720 min lives in `sealed-plan.json` (pre-registration document, not a
   schema field). Realistic total ≈ 50-55 h, ceiling ≈ 65 h, across three
   processes. specs/00 §6.3 is explicitly amended again (16 h → 30 h →
   phased totals) with full disclosure; the $500 goal is untouched.
6. **Budgets.** Search: ADR-045 envelope (usd ≈ $71 realistic within the
   500 000 000 µUSD run cap, solverTokens 800 M, 400 trials). Tournament:
   ≤ 360 trials inside the run's `taskTrials` 760 / `solverTokens` 1 520 M
   (760 × 2 M) / usd envelope. Sealed: 230 trials ≈ $33, 460 M tokens,
   pre-registered in sealed-plan.json. Total ≈ $144-160 < $500 (≥ 20%
   reserve).

**Spec notes.** specs/04 §8/§9 gain the 23-vs-29 reconciliation notes;
specs/00 §6.3 wall-clock text is amended per decision 5.

## ADR-049 (2026-09-07): schema 48→49, terminal-bench-formal profile, formal record script, 49×2 pre-registration, launch authorization

**Status.** Accepted (2026-09-07, user-approved plan: direct formal path;
launch authorized per standing user authorization once all gates are green).

**Context.** Deferral items 3 and 4 of ADR-045: the schema still caps
`benchmarkBaseline.taskCount` at 48, the profile enum has only
`stable-demo`, and no formal record script exists.

**Decision.**
1. **Schema** (`schemas/run.config.schema.json`): `taskCount` maximum
   48 → 49 (description updated); `profile` enum +=
   `'terminal-bench-formal'`; new optional `search.tournament`
   {`minEligibilityTrials` 1..100 default 12, `coverageAttemptsPerTask`
   1..3 default 1, `maxTrials` 1..1000, `bootstrapResamples`
   100000..1000000 default 100000} — required when profile is formal
   (semantic check); `taskTrials` must cover `maxSolverTrials +
   tournament.maxTrials`; `sealedAccess` stays `const:false` (sealed
   evaluation lives in the sealed-evaluate subcommand, ADR-048). New
   `--profile` CLI flag.
2. **k80 profile** (`scripts/lib/tree-v2-live-profile.ts`):
   `benchmarkBaseline` becomes {taskCount: 49, attemptsPerTask: 2,
   batchSize: 8} + tournament fields; init args emit `--profile
   terminal-bench-formal` and the tournament `--set` carriers.
3. **Formal record script** `scripts/record-tree-v2-k80-formal-live.ts`
   (cloned from the rehearsal script): fresh RUN_ID `tree-v2-k80-formal`,
   MASTER_SEED `tree-v2-k80-formal-master-seed-1`; verifier-image
   allowlist = 39 observed + 10 guard real names (the script legitimately
   holds the sealed store for offline image building; the driver still
   sees only opaque ids); sealed store persisted 0600 outside evidence;
   `scope.formal:true`; `REGISTERED_TERMINAL_STOP_REASONS` extended with
   NO_DEVELOPMENT_IMPROVEMENT / SAFETY_ABORTED / CHAMPION_LOCKED + the four
   sealed verdicts; new checks (champion lock present and matching, sealed
   plan pre-registered, guard/sealed leak scans, reveal one-shot, canary
   absence receipts); then invokes `sealed-evaluate` and archives sanitized
   evidence (sealed aggregates only). Envelope checker becomes per-phase:
   search trials ≤ 400, tournament ≤ 360, discovery == 98, total ≤ 760.
4. **Pre-registration (formal run).** Identity: RUN_ID
   `tree-v2-k80-formal`, MASTER_SEED
   `tree-v2-k80-formal-master-seed-1`, profile
   `terminal-bench-formal`, tree-v2 migration resultsInherited:false,
   deepseek-v4-flash routes, concurrency 8. Search: K=80/q0=3/shortlist=5/
   width=3, alpha 0.8 (finalGate 240, minimum 255), maxSolverTrials 400,
   proposalCalls 60, proposerTokens 60M, baseline 49×2×8 = 98 trials.
   Tournament: eligibility ≥12, coverage 1/task, 294 trials, maxTrials
   360, 90% LCB 100 000 resamples. Budget: usd 500 000 000 µUSD,
   taskTrials 760, solverTokens 1 520 M, wallClockMinutes 2760. Sealed:
   23×5×2 = 230 trials, 720 min, ≈ $33, 460 M tokens (ADR-048). Honest
   totals: ≈ 924-1026 trials, ≈ $144-160 < $500, wall ≈ 50-55 h (ceiling
   ≈ 65 h). Terminal states: K_REACHED/CHAMPION_LOCKED,
   NO_DEVELOPMENT_IMPROVEMENT, TRIAL_CAP, BUDGET_EXHAUSTED,
   NO_REAL_FAILURE_SIGNAL, NO_ADMISSIBLE_CHILD, NO_ADMISSIBLE_TASK,
   SAFETY_ABORTED + the four sealed verdicts.
5. **Launch authorization.** Once all gates are green and this
   pre-registration is committed, the formal run launches with
   `DSH_TREE_V2_LIVE_CONFIRM=confirm` per standing user authorization; the
   launch commit hash is recorded in the STATUS document.

**Spec notes.** specs/04 §4.2 gains the note that the dev-guard wave
machinery landed (ADR-046), making the 49×2 matrix runnable.
