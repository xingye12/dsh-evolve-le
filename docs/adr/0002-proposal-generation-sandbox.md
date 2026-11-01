# ADR-078: Docker sandbox only for candidate source generation

Status: accepted for implementation, 2026-11-01, by the user's explicit request to implement
[the simplified plan](../docker-proposal-sandbox-v0-plan.md).

This supersedes ADR-077's implementation roadmap for new proposal generation runs. Keep its
Docker containment, external snapshot authority and credential boundaries. Freeze the old
unfinished supervisor path; completing it is not a prerequisite for this backend.

Use one disposable Docker container per attempt with the real Cordis Loader/native AgentLoop.
A thin owner composes existing execution primitives. It captures immutable source snapshots,
stops and cleans the container, then hands successful source to the existing external trusted
normalization/build/validation/admission pipeline. Generation itself never authorizes admission.
Do not run online tests, finalizer or validator orchestration inside this runner. The frozen
worker field `generationOnly: true` hides testing from tool discovery and the owner rejects the
capability at RPC. Historical configurations without the field retain their original semantics.

New contracts are proposal-generation/v1 configuration and proposal-generation-result/v1.
Success requires the existing execution bundle, independently verified CLEANED completion and
bound generation-submission/v1/source artifacts. Generation submissions preserve raw tree-v2
semantic fields without requiring model-authored receipt digests. Legacy submission consumers
reject this protocol; external normalization must precede candidate validation. Pre-create and unclean failures allow null refs and cannot
be adopted. Results are CAS objects with a local no-clobber pointer. Source may be independently
validated later; it is not permanently excluded from the candidate pipeline.

Do not resume a crashed worker or automatically retry an attempt/model request. Keep the
existing owner lock, limits, deadline and gateway accounting. Explicit sweep takes the same
kernel lock, checks the frozen configuration and existing effects, cancels and cleans without
launching a worker/model. It appends a cleanup receipt and does not rewrite the original result.
The initial CLI targets one explicit configuration, avoiding a global scan or daemon.

Target compatible Linux cgroup v2 + AppArmor hosts; no reduced profile, host fallback, daemon
reconfiguration or upstream changes. Current WSL2/cgroup v1 preflight failure is a real blocker.
The first implementation slice supports replay only. Enable live dispatch and controller wiring
only after the real compatible-host replay gate, following the three delivery gates in the plan.
No score, admission, deployment or usable-sandbox claim follows from component tests.
