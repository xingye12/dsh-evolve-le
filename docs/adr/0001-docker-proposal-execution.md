# ADR-077: Disposable Docker proposal execution and external snapshot authority

Status: accepted for implementation, 2026-10-31. Supersedes the broker-only writer choice in the earlier Docker design; historical executions retain their original meaning.

Use one Docker proposal container per authorized expansion attempt. The native DSH AgentLoop, recovery session, foreground subagents, file tools and foreground bash share its bounded writable workspace and action budget. A project-owned ShellExecutor adapter delegates to the external executor using Docker exec; candidate code receives neither Docker access nor provider credentials. This preserves normal coding-agent workflows without duplicating AgentLoop or modifying upstream.

External consistent source snapshots, independent validators and controller commits own identity and admission. The external executor freezes all writers before capture, records immutable CAS artifacts, monitors the original deadline and resources, and owns idempotent cleanup. Shell and Agent share permissions and gateway visibility; tool logs do not constitute a complete OS audit. If shell descendant termination, containment or required resource controls cannot be proved, fail closed rather than falling back to host execution.

New contracts are execution/v1, execution-receipt/v1, execution-bundle/v1, source-snapshot/v1 and proposal-shell/v1. Docker proposal composition uses native-dsh/v4, native-capabilities/v3, proposer-tools/v2, native-proposal/v2 and proposal-sandbox/v2; existing versions remain for historical replay and cannot silently acquire shell. Proposal/v2 candidate semantics stay unchanged and are bound by the new execution spec. Enabling the backend requires a fresh frozen profile, closure, baseline and run identity. No historical score or admission is inherited.

See the [implementation requirements](../../../docs/dsh-evolve-le-docker-sandbox-implementation.md) and specs/02, 05, 06, 07. Both image profiles, strict inspect, independent validator, real Loader, cancellation, hostile shell, crash/replay and CAS audit gates must pass before claiming usable. cgroup v2 and required LSM/OCI enforcement are preconditions of the production profile; an incompatible host may run contract tests but cannot silently relax that profile.

The proposal workspace and all `/work` mounts remain `noexec`. A validator
that boots the packed capsule from its build workspace requires the explicitly
frozen policy field `workspaceExecution: validator-exec/v1`; only that validator
workspace may use `exec`, still `nosuid,nodev` and with the same isolation and
resource gates. Missing or mismatched authorization rejects before start. This
is a new-run policy choice, not a relaxation of the proposal profile.

Frozen read-only input trees use execution-input/v1 inventories with no spec
back-reference, avoiding an identity cycle. The spec includes the manifest ref;
trusted owners materialize its CAS bytes atomically and reverify before start.
Validator supervisor/v2 requires this ref; v1 configurations remain historical
and are rejected by the new entrypoint rather than silently migrated.

Implementation clarification (2026-11-01): proposer-tools/v2 exposes
`proposal_test_child` only for the Docker capability backend, routing an
externally captured immutable snapshot to independent validator executions.
Historical native backends without this capability retain their existing tool
set. Online validator profiles explicitly select the independent `test` resource
pool; their feedback and ARTIFACTS_MATCHED receipts never authorize Archive
admission. Finalization tests consume the normalized snapshot, not live source.

Completion handoff clarification (2026-11-01): proposal supervisor result/v2
hands execution, independent execution-completion/v1 cleanup proof and immutable
submission refs to the controller. It does not perform Archive admission or
publish admission refs. The controller must verify this handoff before its own
admission transaction. Result/v1 is not silently adopted as v2. CLEANED is
recorded only after owned resources and the resource reservation are released.

Standalone bootstrap checkpoint (2026-11-01): proposal-supervisor/v1 is a closed,
credential-free launch configuration with content-addressed route/runtime refs.
The current standalone transport accepts only frozen zero-priced model-replay/v1;
live provider dispatch remains disabled until its pre-dispatch hard token/cost
ceiling is verified. This replay bootstrap does not replace the live-provider
acceptance requirement. Kernel flock establishes the owner. Failure diagnostics
are INCOMPLETE evidence, never completion or automatic authorization to rerun a
model. Lost owner/execution history requires explicit reconciliation; that recovery
consumer and controller integration remain implementation gates.

Explicit collection checkpoint (2026-11-01): collection is an operator/controller
request to revoke, stop, export and clean the existing attempt. It requires
matching spec plus recorded execution receipts, uses the original fixed owner
and never authorizes a new worker/model. Revoked bootstrap skips model transport
initialization and requests recovery-only executor preparation. Empty history
fails before resource allocation/create. This does not replace the separate
requirement to reattach a running execution while preserving its deadline, or
resolve full trusted-directory loss. Production recovery acceptance is pending.

Model ledger checkpoint (2026-11-01): model-ledger/v1 adds a frozen header and
CAS intent witness index outside the request directory. Missing history/config
drift fails closed; started executions require the old ledger on recovery.
No uncommitted legacy account is implicitly initialized or migrated. Durable
reservation precedes dispatch and revocation is checked again afterwards.
This guards local accounting loss, not full controller-journal loss or live
provider pre-dispatch token enforcement; live transport stays disabled.
