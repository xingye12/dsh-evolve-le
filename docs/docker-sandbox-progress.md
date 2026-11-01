# Docker proposer implementation progress

Updated 2026-11-01. This is an implementation checkpoint, **not** the acceptance
verdict. The user goal remains the complete usable sandbox described by the
[implementation contract](../../docs/dsh-evolve-le-docker-sandbox-implementation.md).

## Implemented components

- [ADR-077](adr/0001-docker-proposal-execution.md) and specs/02, 05, 06, 07 record
  the new trust boundary, protocols and fresh-run requirement. Legacy defaults
  have not been silently migrated.
- [Execution contracts](../packages/dsh-evolve-le/src/execution/types.ts) and published
  JSON schemas reject mutable image references, privileged paths/options,
  invalid quantities, writable input, validator gateway and guard/sealed inputs.
- [Docker Engine transport](../packages/dsh-evolve-le/src/execution/docker-engine.ts)
  uses bounded Unix HTTP, absolute timeouts and strict Docker stream decoding.
  [Policy](../packages/dsh-evolve-le/src/execution/docker-policy.ts) checks actual
  create/inspect values, including exact seccomp content, private namespaces,
  read-only /dev, environment, mounts and limits. Omitted Docker false defaults
  are normalized only for writable bind mounts, verified against the real daemon.
- [Executor](../packages/dsh-evolve-le/src/execution/docker-executor.ts) has the
  prepare/start/reconcile/cancel/collect/cleanup lifecycle, independent resource
  admission, CPU-total watchdog, persistent monotonic boot clock and manifest
  adoption. Its orchestration tests use a simulated Engine/host; this is not a
  production host acceptance test.
- [Linux host](../packages/dsh-evolve-le/src/execution/linux-host.ts) implements
  required platform checks, bounded host tmpfs, retained cgroup parent, frozen
  snapshot capture and registered cleanup. It has not run on a compatible host.
- [Source capture](../packages/dsh-evolve-le/src/execution/snapshot.ts),
  [file capabilities](../packages/dsh-evolve-le/src/execution/files.ts) and
  [evidence](../packages/dsh-evolve-le/src/execution/evidence.ts) use descriptor
  anchors/no-follow, reject links and special files, bound reads, preserve CAS
  bytes and publish manifests last. Unit tests cover changed source, limits,
  link escapes, corrupt refs and failure/cleanup separation.
- [Action broker](../packages/dsh-evolve-le/src/execution/action-broker.ts),
  [IPC](../packages/dsh-evolve-le/src/execution/rpc.ts),
  [invocations](../packages/dsh-evolve-le/src/execution/invocations.ts) and
  [worker client](../packages/dsh-evolve-le/src/execution/worker-client.ts) supply
  shared mutation serialization, durable tool arguments/results, child allocation,
  snapshot/submission binding and no blind repetition of ambiguous effects.
  Finalization preserves raw tree-v2 receipt completion before full shape checks.
- [Model gateway](../packages/dsh-evolve-le/src/execution/model-gateway.ts) reserves
  worst-case tokens/USD before dispatch, reconstructs action usage on reopen,
  reuses completed logical requests and retains unknown dispatch as AMBIGUOUS.
  It currently has replay-provider tests; paid provider wiring is still pending.
- [Standard shell adapter](../packages/dsh-evolve-le/src/dsh/container-shell-plugin.ts)
  subclasses the pinned DSH ShellExecutor through actual Cordis Loader. Native
  AgentLoop discovers and calls standard bash through external IPC; background
  and escalation fail, unload restores inventory. New native-proposal/v2 options
  stop before another model request after submission and count shell activity
  toward recovery eligibility. Historical v1 defaults stay unchanged.
- [Foreground shell](../packages/dsh-evolve-le/src/execution/shell.ts) uses Docker
  exec, a fixed environment and externally frozen PID/start-time censuses. Real
  Engine probes verify shared edits, RO input and whole-container termination
  when a background child remains. This is not complete hostile-process proof.

- The [Docker native worker](../packages/dsh-evolve-le/src/bin/docker-proposer-worker.ts)
  and [trusted overlay](../packages/dsh-evolve-le/src/execution/composition.ts) now
  connect the real Loader/AgentLoop to the external broker/model capabilities.
  A real Docker replay probe passes model → file edit → same-container shell
  edit → externally paused snapshot → bound submission with no extra model
  dispatch. It uses an engineering fixture and a reduced Engine probe profile;
  it does not bypass the production platform gate or establish admission.

## Latest implementation and verification checkpoint

- `model-ledger/v1` freezes accounting configuration and records CAS intent
  witnesses outside the request directory before dispatch. Missing requests,
  missing indexes and config drift fail closed. Recovery of started executions
  requires an existing ledger; full trusted journal loss remains unresolved.
  Request/options are copied and revocation is rechecked after reservation.
  [Regression](../evidence/docker-sandbox-20261031/model-ledger-tests-4.json)
  passes 25/25; [real native Docker replay](../evidence/docker-sandbox-20261031/model-ledger-worker-tests-1.json)
  passes the file/shell/snapshot flow. These do not establish live-provider hard
  budget enforcement, which remains disabled and required.


- Explicit `collectProposalSupervisor` persists revocation and requires matching
  recorded execution effects before restarting the fixed owner for stop/export/
  cleanup. Revoked owners skip model transport initialization. Executor
  `prepare(..., { existingOnly: true })` rejects empty receipt history before
  allocation/create; proposal recovery selects this mode after cancellation.
  [Regression evidence](../evidence/docker-sandbox-20261031/proposal-collection-tests-2.json)
  passes 14/14, including simulated CREATED-target recovery with zero starts.
  [Real detached preflight probe](../evidence/docker-sandbox-20261031/proposal-launch-tests-5.json)
  rejects collection without effects. Real running-container collection and
  non-destructive live reattachment remain unverified; this is not full recovery
  acceptance.


- [Standalone config](../packages/dsh-evolve-le/src/execution/proposal-config.ts),
  [launcher](../packages/dsh-evolve-le/src/execution/proposal-launcher.ts) and
  [fixed owner composition](../packages/dsh-evolve-le/src/execution/proposal-process.ts)
  now use frozen, credential-free configuration, private no-follow files and
  actual kernel flock. Shared host validation remains common with validators.
  [Zero-priced replay transport](../packages/dsh-evolve-le/src/execution/replay-transport.ts)
  follows durable model-intent sequence across reopen; live fallback is refused.
  [Component tests](../evidence/docker-sandbox-20261031/proposal-launch-components-2.json)
  pass 5/5. [Actual detached process test](../evidence/docker-sandbox-20261031/proposal-launch-tests-4.json)
  preserves preflight failure CAS, performs no model dispatch, rejects config
  drift/blind relaunch and a symlink store before CAS writes. Missing failure
  indexes do not erase owner/execution history. This is an INCOMPLETE engineering
  bootstrap, not successful production execution. Explicit orphan reconcile,
  live provider hard-budget/credential acceptance and controller integration
  remain required; replay does not replace these gates.


- [Execution completion proof](../packages/dsh-evolve-le/src/execution/completion.ts)
  binds the original immutable bundle to an appended cleanup chain. Reservation
  release now precedes the new CLEANED event; failed release remains retryable
  across reopen. Old cleanup events cannot supply the new guarantee. The
  [proposal result/v2 reader](../packages/dsh-evolve-le/src/execution/proposal-result.ts)
  verifies execution/spec/outcome, cleanup and CAS submission artifact membership
  after work directories disappear. Supervisor no longer calls Archive admission;
  the controller must perform that transaction after handoff verification. New
  schemas reject legacy/extra admission fields. [Tests](../evidence/docker-sandbox-20261031/proposal-result-cleanup-5.json)
  pass 16/16, with simulated Engine/host lifecycle and an actual temporary-FS
  ELOOP cleanup falsification. These are contracts, not real-host cleanup or
  standalone launcher/controller acceptance.


- Online-test cancellation now persists revocation before waiting for in-flight
  preparation, serializes owner-local plan publication/cancellation reconciliation,
  and rechecks cached adoption/feedback. [CAS-boundary race test](../evidence/docker-sandbox-20261031/proposal-test-cancel-race-3.json)
  pauses pair publication while cancellation arrives; no missed plan may proceed
  and INCOMPLETE remains unconfirmed. Broker checks revocation after async
  testing/finalization and before submission, and audit rejects cross-execution
  source splicing. [Component regression](../evidence/docker-sandbox-20261031/proposal-cancel-fence-2.json)
  passes 9/9. This does not establish actual crash-boundary or platform acceptance.


- [Online snapshot tests](../packages/dsh-evolve-le/src/execution/proposal-tests.ts)
  now consume the native Docker `proposal_test_child` capability and the
  supervisor's normalized finish snapshots. Two independent validator domains
  explicitly select the shared ledger's test pool. Persistent intent/result and
  cancellation retain failures, diagnostics and CAS graphs. Identical immutable
  requests reuse one plan/results across main/recovery; feedback never admits.
  [Component tests](../evidence/docker-sandbox-20261031/proposal-online-unit-2.json)
  pass 21/21; [real subprocess tests](../evidence/docker-sandbox-20261031/proposal-online-tests-2.json)
  preserve both preflight failures. [Real native Docker failure gate](../evidence/docker-sandbox-20261031/proposal-online-worker-tests-4.json)
  sees online feedback, rejects main and recovery finish, makes seven replay
  requests and zero submissions, then exits unsuccessfully. [CAS audit](../evidence/docker-sandbox-20261031/proposal-online-worker-cas-audit.json)
  reads 6433 refs, verifies one shared test plan/test pool and container removal.
  This proves engineering failure handling, not production positive validation
  or Archive admission. Cumulative action resource hard limits remain open.
- Executor child cancellation now starts before the parent domain is killed,
  but child confirmation cannot delay that kill. Evidence writes remain serial;
  unconfirmed child cleanup fences parent cleanup and survives reopen. A real
  callback-blocking regression observes the kill event before releasing child
  cancellation. Confirmation is bounded; no stopped/cleaned success is inferred
  from timeout.


- [CAS snapshot finalizer](../packages/dsh-evolve-le/src/execution/proposal-finalizer.ts)
  is now the supervisor's concrete finish consumer. It binds intent to spec/input,
  validates child sources, normalizes tree-v2 receipts only on private copies,
  captures new immutable snapshots, and retains original/normalized/intermediate
  sources plus intent/result/failure receipts in execution artifacts. Reopen
  adopts verified results without model/candidate/admission replay. The original
  deadline applies. [Contract/schema tests](../evidence/docker-sandbox-20261031/proposal-finalizer-6.json)
  pass 25/25. [Real worker replay](../evidence/docker-sandbox-20261031/proposal-finalizer-worker-tests-1.json)
  submits a v1 proposal through this consumer. This does not prove production
  tree-v2 multi-child admission or actual crash-boundary recovery; those gates,
  the online-test/admission services and standalone launcher remain open.


- [Proposal input composition](../packages/dsh-evolve-le/src/execution/proposal-input.ts)
  now freezes the real parent runtime/source, separately selected worker, native
  worker config and standard evidence export/catalog paths. It shares runtime
  identity/Node/dependency checks with validator composition. The supervisor
  derives parent and child allocations from the input graph, verifies command,
  execution/model/limits binding and rejects mismatches before dispatch.
  [CAS replay](../evidence/docker-sandbox-20261031/proposal-input-tests-5.json)
  preserves the old validator input digest and rejects parent/dependency/export
  drift. [Real Docker worker](../evidence/docker-sandbox-20261031/proposal-input-worker-live-2.json)
  consumes these frozen inputs through Loader/AgentLoop, replay model, file and
  standard bash, then externally captures a submission snapshot. Three model
  calls, one submission and zero exit; [retained CAS refs](../evidence/docker-sandbox-20261031/proposal-input-worker-2.json)
  include logs, model/tool receipts, snapshot and inspect.
  [CAS audit](../evidence/docker-sandbox-20261031/proposal-input-worker-cas-audit.json)
  reads back 3318 refs and verifies this engineering container no longer exists. This is an engineering
  profile, not production executor acceptance or Archive admission. Standalone
  proposal launch/provider/finalizer/controller consumers remain incomplete.
- Durable cancellation now covers validator/group intent fanout, proposal
  pre-start/poll/RPC gates, and cleanup fencing across executor reopen when child
  stop is unproven. [Tests](../evidence/docker-sandbox-20261031/proposal-cancellation.json)
  are component tests; real production detached group cancellation remains open.


- [Persistent reservations](../packages/dsh-evolve-le/src/execution/reservation-ledger.ts)
  use a separate kernel-flocked transaction process and durable per-execution
  receipts. Real concurrent subprocesses verify one proposal slot, independent
  test capacity and reservation restoration after reopen.
- [Owner generations](../packages/dsh-evolve-le/src/execution/owner.ts) require
  the supervisor to hold its actual kernel flock before claiming or reclaiming
  a stale action socket. A real SIGKILL test checks no live-owner takeover,
  subsequent generation fencing and socket replacement by the new owner.
- [Stream receiver](../packages/dsh-evolve-le/src/execution/stream.ts) persists
  bounded worker events and stderr into CAS and detects sequence gaps, partial
  frames and changed replay bytes. [Supervisor composition](../packages/dsh-evolve-le/src/execution/supervisor.ts)
  now connects Engine observation, gateway, broker, shell, executor and resource
  ledger. It is provisional: no production launcher/controller integration yet.
- [Submission reader](../packages/dsh-evolve-le/src/execution/submission.ts)
  verifies the external marker, complete proposal, execution/spec/child bindings
  and every referenced source file. Broker recovery restores the submitted gate;
  Linux export consumes this reader. Unknown tool effects and model accounts
  prevent reopening capabilities. Socket close is concurrent/idempotent.
- Model receipt replay validates request digests, frozen route/reservation,
  integer sequences, nonnegative usage, exact calculated cost and overrun status.
  Corrupt/negative receipts are rejected rather than changing recovered budgets.
- [Offline image builder](../scripts/build-sandbox-images.ts) constructs two
  pinned-base profiles without candidate source/evidence. pnpm links retain
  their relative targets; core dependency aliases remain in the locked store.
  These are local engineering images; release provenance/SBOM/platform binding
  and AppArmor acceptance remain unfinished.
- [Validator worker](../packages/dsh-evolve-le/src/bin/validator-worker.ts) runs
  the existing full builder using the read-only parent capsule dependency
  closure. Two fresh Docker containers passed all ten stages and returned
  matching source, bundle and capsule hashes in the
  [engineering probe](../evidence/docker-sandbox-20261031/validator-4.json),
  with [test report](../evidence/docker-sandbox-20261031/validator-tests-4.json).
  That first probe compared builder-reported hashes. The subsequent
  [external export probe](../evidence/docker-sandbox-20261031/validator-5.json)
  independently captures all capsule files with bounded no-follow reads,
  reconstructs canonical tar/gzip and bundle bytes, verifies source metadata,
  trusted runner inventory, Node binary, dependency closure, install manifest,
  checksums, composition and runtime stubs, then commits artifacts to CAS.
  [Real Docker results](../evidence/docker-sandbox-20261031/validator-tests-5.json)
  also reject post-export drift and verify retained refs. The local retained
  CAS is `evidence/docker-sandbox-20261031/validator-cas/` (binary payloads are
  deliberately not Git source). [CAS replay](../evidence/docker-sandbox-20261031/validator-replay-2.json)
  reopens both receipts and reconstructs/revalidates a stopped output without
  rerunning candidate or model work. The shared runner inventory leaves the
  capsule tar unchanged from the previous probe (`7eebe476…`).
  This proves static artifact integrity, not the truth of arbitrary worker
  lifecycle claims: `ARTIFACTS_VERIFIED` is distinct from Archive admission.
  The production validator execution/lifecycle receipts and controller consumer
  are still required. Both probes use the explicitly reduced engineering
  platform profile, not production acceptance.
  Earlier startup/link and non-root config-write failures remain in reports
  `validator-tests-1.json` through `validator-tests-3.json`.
- [Frozen input manifests](../packages/dsh-evolve-le/src/execution/input-manifest.ts)
  and [schema](../schemas/execution.input.schema.json) bind every read-only
  non-gateway mount to bounded CAS inventories without an identity cycle.
  Materialization uses private staging, fsync and rename, preserves immutable
  bytes after the original source changes, and refuses to overwrite drifted
  trees. Physical root ownership/read-only modes, paths, hashes, sizes and
  executable modes are reverified before Docker start. A contract test proves
  verification failure results in zero start calls. Linux host copies inputs
  after resource admission and includes their complete artifact graph on export.
  Validator supervisor/v2 requires the manifest in spec inputs and rejects v1;
  proposal supervisor composition also requires this binding.
  [Real frozen-input worker probe](../evidence/docker-sandbox-20261031/frozen-input-live-1.json)
  runs the native Loader/AgentLoop, file/shell edits and snapshot-bound finish
  from CAS-materialized read-only inputs after the unmounted original changes.
  This remains a reduced engineering Docker profile. Validator source/parent/
  runtime composition and proposal input composition are now implemented;
  complete production platform acceptance remains pending.
- [Validator input composition](../packages/dsh-evolve-le/src/execution/validator-input.ts)
  selects immutable child and parent snapshots, checks proposal ID/spec digest,
  child allocation, parent capsule/source identity, pinned Node and dependency
  bytes, and combines the selected runtime closure with a separately frozen
  worker inventory. Guard/sealed refs are rejected. The original capsule remains
  unchanged in CAS; the execution closure has its own input manifest.
  [Composition probe](../evidence/docker-sandbox-20261031/validator-7.json)
  passes all ten stages in two fresh containers, external export and CAS reopen.
  [Offline input replay](../evidence/docker-sandbox-20261031/validator-input-replay.json)
  reconstructs the identical input manifest with the stricter spec binding.
  The first composed probe failed on non-root cleanup of copied 0555 dependency
  directories; [its failure](../evidence/docker-sandbox-20261031/validator-tests-6.json)
  is retained. The builder now makes only its scratch dependency directories
  writable, retaining file bytes/modes and the closure digest; input stays sealed.
- The latest local image recipe excludes baseline package metadata, generated
  Vitest/Vite caches and package-manager install state. Source context exclusion
  checks passed and the [new image metadata](../evidence/docker-sandbox-20261031/executor-images-8.json)
  is retained. [Fresh-image composed validation](../evidence/docker-sandbox-20261031/validator-8.json)
  and [test report](../evidence/docker-sandbox-20261031/validator-tests-8.json)
  pass both full builders and external verification with unchanged capsule hash.
  These remain engineering images; release/SBOM/platform/AppArmor gates remain.
- [Validator pair plans](../packages/dsh-evolve-le/src/execution/validator-pair.ts)
  now freeze two distinct execution IDs/workspaces, their input/profile/allocation
  refs and the original parent deadline. Arguments are cloned before async I/O;
  a regression verifies caller mutation cannot change an authorized plan.
  Readback rechecks source/spec/child binding, the exact generated configs,
  independent domains and allocation bodies. Scheduling launches at most the
  next unfinished slot and checks actual kernel flock ownership before resuming
  a missing supervisor. The [real pair launch probe](../evidence/docker-sandbox-20261031/validator-pair-launch.json)
  starts both standalone preflight failures sequentially, preserves both failure
  refs, collects FAILED and adopts the same aggregate idempotently. Success
  collection requires both complete verified supervisor results and matching
  source/bundle/capsule/archive refs; its `ARTIFACTS_MATCHED` status is explicitly
  separate from Archive admission. Successful production pair orchestration,
  group cancellation and the proposal consumer are not yet accepted.
- [Validator supervisor](../packages/dsh-evolve-le/src/execution/validator-supervisor.ts),
  [launcher](../packages/dsh-evolve-le/src/execution/validator-launcher.ts),
  [result reader](../packages/dsh-evolve-le/src/execution/validator-result.ts) and
  [fixed process entry](../packages/dsh-evolve-le/src/bin/docker-validator-supervisor.ts)
  now compose a separate kernel-flock owner with persistent reservations,
  streaming observation, original executor deadlines, verified export, bundle
  collection and cleanup. Config has a closed shape, fixed worker argv, no
  provider credentials and immutable publication; host state directories reject
  symlink/writable ancestors before config/log creation. Terminal results are
  verified and adopted without rerunning work. A PID/result-file existence
  alone is never completion. [Real process tests](../evidence/docker-sandbox-20261031/validator-launcher-3.json)
  verify owner PID, production preflight refusal on this host, readable failure
  CAS, no blind relaunch, config drift and corrupt/false-success result rejection.
  A successful production validator lifecycle still needs a compatible host;
  proposal launcher and controller scheduling consumers remain pending;
  CAS input composition is implemented, as recorded above.
- Executor now records late `failure-intent` durably and restores failure/cancel
  intent before collect. A regression first reproduced a log-gap failure after
  normal stop turning into SUCCEEDED after reopen; it now remains FAILED with
  the original reason. Stream observers retain failure without an unhandled
  rejection killing the owner before its catch/collection path.
- Linux host now consumes the validator export verifier in its production
  `export` method. Frozen spec inputs must contain the source snapshot and its
  parent execution must match; a live process domain rejects export. Verified
  receipts and complete source/capsule refs join execution artifacts, while
  invalid/missing outputs fail and bounded worker diagnostics remain artifacts.
  [Host export replay](../evidence/docker-sandbox-20261031/validator-host-replay.json)
  exercises this consumer against the retained real capsule and rejects a
  missing snapshot binding; its resource sampler is simulated, not platform
  acceptance. Proposal export keeps its separate submission authority.
- ADR-077/specs/05 freeze `workspaceExecution: validator-exec/v1` for validator
  workspace execution of the packed runtime. Proposal workspace and every work
  mount remain noexec; a missing/misapplied profile refuses preflight. Mount
  intent/receipt records the selected mode; actual tmpfs flags are verified.
- The builder now atomically replaces its working-copy TypeScript configuration
  instead of writing through a frozen source inode; non-root validator and
  inode-preservation regression checks cover this correction.

The [latest component report](../evidence/docker-sandbox-20261031/tests-11.json)
records 77/77 passing tests, including real Loader and kernel-flock subprocess
checks. It excludes the separately recorded live Docker tests. The
[builder/gateway/upstream regression](../evidence/docker-sandbox-20261031/builder-regression.json)
adds 32 passing tests. [Checkpoint receipt](../evidence/docker-sandbox-20261031/checkpoint-2.json)
records these reports and the local image metadata with content hashes.

## Remaining work before the goal can be complete

1. Finish strict semantic receipt validation for the new model/tool records,
   replay source artifact reconstruction, export of failed/partial work, and
   reentrant adoption of a tmpfs mount whose ownership receipt was interrupted.
2. Complete the existing image build contexts with pinned release manifests, the
   AppArmor policy and compatibility probes. Integrate the validator and proposal input composition consumers and bind actual
   platform/security versions to the execution spec before start.
3. Finish trusted staging and parent child-tree seeding for the implemented
   native Docker worker/composition; wire broker/model/stream receiver into a separate
   supervisor process, and propagate cancellation and model budget revocation.
4. Integrate the implemented kernel ownership, persistent reservations and
   event receiver with the remaining proposal launcher and scheduling consumers; complete janitor/reconcile and all crash boundaries.
5. Integrate the composed full ten-stage validator worker with proposal test/finalize/admission consumers and production executor,
   immutable snapshots, online tests and normalization/finalization. Independently
   connect the implemented external export verifier and immutable receipts to
   both clean validator executions before any admission.
6. Integrate proposer runner, controller launch/recovery/collect/admission,
   status/audit/doctor and fresh-profile config/manifest. The existing controller
   still uses the legacy worker-result path; it must not be presented as the
   new Docker completion authority.
7. Complete real Loader-in-container/model/file/shell/subagent/recovery/unload,
   timeout/setsid/double-fork/cancel, resource/credential/network, concurrent
   snapshot/half-write/drift, daemon/host/gateway faults, and actual SIGKILL
   replay at intent/dispatch/snapshot/export/commit/admission/cleanup boundaries.
8. Run the requirement-by-requirement completion audit, including all success,
   rejection, duplicate and failure refs retrievable from CAS. Only then enable
   and claim a usable production sandbox.

## Current host and evidence

The [doctor artifact](../evidence/docker-sandbox-20261031/doctor.json) observes
Docker 29.3.1/API 1.54 on WSL2 5.15, cgroup v1 and no AppArmor kernel interface.
Production preflight correctly rejects this host. No daemon or kernel settings
were changed. A compatible Linux host is needed for the final production gates;
there is still substantial code work that can proceed locally.

[First regression report](../evidence/docker-sandbox-20261031/tests.json) includes
77 passed and one legacy skip. It includes three real Engine probes, actual
Cordis Loader/native AgentLoop shell composition and existing native capability
regressions. [Subsequent component report](../evidence/docker-sandbox-20261031/tests-2.json)
adds broker, model-gateway and schema tests. [Latest worker/component report](../evidence/docker-sandbox-20261031/tests-3.json)
includes the Docker worker replay probe. These are component engineering
results, not a complete sandbox, benchmark improvement or sealed result.

The native closure used by Loader tests was materialized with the production
assembler into `/tmp/dsh-docker-native-closure`, digest
`c783df9247be693047751382c9e4bcd69b0ea0a7539408898474499511fe3c81`.
It is test preparation, not the new frozen production capsule.
