# Troubleshooting

Everything here fails closed: a check that cannot prove safety is a failure, not a warning. Start
with `doctor` and `audit`; both list every failed check and exit non-zero. Credential values are
never printed.

## `doctor` reports a `✗`

Fix the named prerequisite and rerun. `doctor` performs no paid model or solver request. Typical
findings:

| Finding                                  | Cause / fix                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Harbor binary missing / wrong version    | install the pinned Harbor (`0.21.0`) and pass `--harbor-bin` at init                                   |
| Docker daemon unreachable                | start Docker; trial containers must be able to pull/build                                              |
| Artifact endpoint unreachable            | the endpoint host/port recorded in the config must be reachable from trial containers                  |
| Credential file missing or mode ≠ `0600` | `chmod 0600` the file; the path was frozen at init                                                     |
| Tasks root invalid                       | `--tasks-root` must point at the extracted Terminal-Bench 2.1 task set (89 task dirs with `task.toml`) |

## `init: run already exists`

`init` never overwrites. To start over, move or delete `runs/<run-id>/` deliberately (it is your
evidence) or choose a new `--run-id`.

## `run`/`resume` exits non-zero mid-run

This is not data loss. Every completed observation is already in the journal. Re-run the same
command (`resume`); the controller replays the journal from the latest valid snapshot and continues
without re-spending completed trials. The Gate 6 evidence proves SIGKILL-at-observation-N and
resume reach a byte-identical terminal state.

## `status` shows `stopReason: null`

`stopReason` and the phase summary come from `drive-report.json`. If that file (or the snapshots)
was deleted, `status` still reconstructs and prints the controller `stateHash` and observation count
from the journal; run `resume` once to re-derive the report without re-running anything. The
restore drill in `pnpm install:verify` exercises exactly this path.

## `audit` fails on `manifest` / `split-ceremony-rederives` / `failure-pool-hash` / `drive-report-state-hash`

- `manifest` mismatch ⇒ `run.config.json` was mutated after init; restore it or start a new run.
- `split-ceremony-rederives` / `failure-pool-hash` ⇒ the frozen split or pool files were edited;
  these are audit artifacts — restore them from backup.
- `drive-report-state-hash` ⇒ the report disagrees with a journal replay; trust the replay, rerun
  `resume`, and treat the discrepancy as a reportable bug.

## Terminal states that are NOT failures

| State                                | Meaning                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `STABLE_ITERATION_VERIFIED`          | K reached ∧ all children pool-evaluated ∧ depth ≥ 2                        |
| `BUDGET_EXHAUSTED`                   | a frozen budget limit hit — by design fail-closed                          |
| `MAX_CONSECUTIVE_EXPANSION_FAILURES` | proposer could not produce admissible children; kept, not retried silently |

## A trial result is missing / corrupt / timed out

It counts as a failure by rule 7 of the project charter; failed trials stay in the archive catalog
and Harbor job logs. Only pre-registered, reward-independent infrastructure categories may be
retried. Do not delete failed trials to "clean up" — that is the exact behavior the evidence chain
exists to prevent.

## Fresh install problems

`pnpm install:verify` is the reproduction script for the whole documented install path; run it first
when something install-shaped breaks (`--frozen-lockfile` mismatch ⇒ Node/pnpm version drift vs
`provenance.lock.json`). `pnpm upstream:check` verifies the pinned upstream checkouts are untouched.
