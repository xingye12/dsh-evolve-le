# ADR-079: Local Docker candidate generation on WSL

Status: accepted for implementation, 2026-11-01, explicitly authorized by the user.
Supersedes ADR-078's compatible-host prerequisite for the source-generation backend.

Use the frozen security profile `local-generation/v1` for proposal generation on the local
Linux Docker Engine, including WSL2/cgroup v1. This is an explicit execution contract, not
an automatic downgrade of the older delegated-cgroup/AppArmor policy. Legacy profiles retain
their checks. Do not modify the host kernel, Docker daemon, or reference upstreams.

Retain non-root uid, read-only root and input, no external network, no credentials or Docker
socket, ALL capabilities dropped, no-new-privileges, pinned default-deny seccomp, bounded tmpfs
workspace/work/tmp/shm, file/output caps, Docker memory/swap/CPU-rate/PID limits and owner wall
clock timeout. Existing owner, CAS, broker, pause/snapshot and cleanup primitives are reused.
AppArmor and host delegated cgroup v2 are not prerequisites of this profile. CPU-time totals,
memory-peak and cgroup event accounting are not claimed; Docker hard limits and elapsed wall
clock own resource enforcement. Process-domain termination is observed via Docker container
state/PID namespace, rather than a retained host cgroup. Foreground shell census still detects
leftover descendants, and any uncertain termination fails the attempt.

Only generation-only proposal containers may select this profile; validators and benchmark
execution do not inherit it. Freeze the profile and parameters in policy/spec/config artifacts
and select fresh run identity. Missing Docker limit/seccomp support fails before model calls.
No privileged container, writable TCB, broad host mount, host execution fallback or retry.

Acceptance uses the actual local Engine, real Cordis Loader/native AgentLoop, source and shell
mutation, negative filesystem/network/credential checks, immutable snapshots and cleanup, plus
owner-kill/sweep and timeout cases. Then enable the bounded single-dispatch live adapter and
connect the generated snapshot to the existing external trusted validation/admission pipeline.
These are engineering claims only, with no benchmark, deployment or sealed-result implication.
