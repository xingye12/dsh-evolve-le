# Architecture overview

This is the architecture of the implemented system (v0.1.0-rc.1), not a plan. Normative details live
in [`specs/01-architecture.md`](../specs/01-architecture.md); this page is the readable map.

## One loop, four trust zones

```text
            TRUSTED (controller process)                 UNTRUSTED (one-shot, per candidate)
┌──────────────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ CLI (dsh-evolve init/run/resume/status/…)    │   │  proposer child  (uid+netns sandbox) │
│  └─ controller: journal, reducer, snapshots  │──▶│    └─ bounded candidate tree writer   │
│  └─ budget ledger (µUSD/tokens/calls/trials) │   │  builder → real Cordis Loader        │
│  └─ archive admission + canary derivation    │   │    └─ candidate plugin lifecycle     │
│  └─ Harbor evaluator client (TB 2.1 provider)│   └──────────────────────────────────────┘
│  └─ fail-closed normalizer                   │        ▲ reads/writes ONLY its candidate
└──────────────────────────────────────────────┘        │ package; TCB is not writable
        │ hash-chained journal + sharded object store   │
        v                                                │
   evidence/ (append-only, content-addressed) ◀──────────┘ sealed split stays inaccessible
```

- **The controller is the only durable writer.** Everything on disk — journal segments, snapshots,
  the object store, the archive catalog — is written by the trusted controller and can be
  re-derived by replaying the journal.
- **Candidates never load into the controller.** Each proposal runs in a one-shot child with its own
  uid and network namespace; the candidate bundle is launched through the real Cordis Loader
  (`packages/dsh-evolve-le` loader-spike path), not `node:vm` and not an in-process mock.
- **The evaluator is a TCB member.** Harbor runs Terminal-Bench 2.1 tasks; results are normalized
  fail-closed (missing/corrupt/timeout ⇒ failure; failed trials are kept).

## Packages

| Package                             | Role                                                                                                                       | Trust             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `packages/dsh-evolve-le`            | controller core: journal, reducer, snapshots, budget, proposer policy, archive, candidate store, Loader spike, TB provider | trusted           |
| `packages/cli`                      | `dsh-evolve` command surface (init/run/resume/status/audit/doctor)                                                         | trusted           |
| `packages/candidate-sdk`            | the narrow, versioned surface a candidate may program against                                                              | boundary          |
| `packages/candidate-baseline`       | the seed candidate every run starts from                                                                                   | untrusted payload |
| `benchmark-adapters/terminal-bench` | TypeScript Harbor provider; no RSI policy inside                                                                           | trusted           |
| `scripts/`                          | provenance checks, gate evidence recorders, release/fresh-install tooling                                                  | build-time        |
| `schemas/`                          | manifest/event/evidence JSON Schemas                                                                                       | contract          |
| `evidence/`                         | recorded gate evidence (append-only, content-addressed)                                                                    | audit             |
| `specs/`                            | normative specification set (`00`–`07`)                                                                                    | source of truth   |

## Iteration lifecycle (what `run` actually does)

1. **Preflight** — `doctor`-equivalent checks; any failure lists every problem and exits non-zero
   before any paid launch.
2. **Replay** — the journal is folded (from the latest valid snapshot) into controller state; the
   state hash is checked against the snapshot chain.
3. **Stop evaluation** — the K/q0 stop semantics from `specs/03`: the run is
   `STABLE_ITERATION_VERIFIED` iff `K_REACHED` ∧ every child pool-evaluated ∧ lineage depth ≥ 2 ∧
   children ≥ kTarget.
4. **Propose** — deterministic discovery batch selection, then proposer children (uid+netns
   sandboxes) write bounded candidate trees; canary tokens are HMAC-derived per run+principal so
   divergent randomness is detectable.
5. **Admit** — deterministic builder → one-shot real Loader sandbox → pool evaluation on the
   development split; archive admission is separate from champion selection.
6. **Record** — every action lands in the hash-chained journal; snapshots checkpoint the fold;
   `drive-report.json` summarizes the tick with budget totals and citations.

## Durability model

- **Journal** — append-only JSONL segments (`controller/journal/events-*.jsonl`); each event carries
  `previousHash`/`eventHash`; `audit` re-derives everything from genesis.
- **Snapshots** — `controller/snapshots/state-<seq>-<hash>.json`; a snapshot is valid only if its
  hash matches a replay of the journal prefix. Deleting every snapshot is a supported state loss:
  `status`/`resume` reconstruct identical state from the journal alone (exercised by
  `pnpm install:verify`).
- **Objects** — content-addressed blobs under `objects/sha256/<2-hex>/<digest>`; exports carry their
  own copy so an export directory is self-contained.
- **Crash drills** — `DSH_EVOLVE_CRASH_AFTER_OBSERVATION=N` makes the CLI SIGKILL itself after the
  Nth observation; resume must reach a byte-identical terminal state (Gate 6 evidence).

## What is deliberately NOT here

- No second controller wrapping DSH, no Python agent bridge, no `node:vm` sandbox.
- No database or queue: the filesystem is the evidence source of truth; derived indexes are
  rebuildable.
- No sealed-task access in the development loop: the 29-task sealed split is frozen in
  `split-ceremony.json` and cannot influence proposer, selector or archive before candidate hashes
  freeze (specs/05).
