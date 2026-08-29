# Evidence interpretation

Everything a run claims is on disk under `runs/<run-id>/` (and mirrored, content-addressed, into
`evidence/` by the gate recorders). This table says what each artifact proves — and what it does
**not** prove. Reading it honestly is the point of the project: no artifact below demonstrates a
benchmark improvement.

## Run artifacts

| Artifact                                               | What it proves                                                                                         | What it does not prove                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `run.config.json` (+ `configHash`)                     | frozen identity, routes, search and budget for exactly one run; mutation is detectable                 | provider availability, model behavior             |
| `split-ceremony.json`                                  | the development/sealed split commitment re-derives deterministically from the master seed              | that the sealed set is representative             |
| `failure-pool.json` (`poolHash`)                       | the development task pool was frozen before any candidate reward existed                               | benchmark score of any kind                       |
| `controller/journal/events-*.jsonl`                    | ordered, tamper-evident (`previousHash`/`eventHash`) record of every controller action                 | external job correctness by itself                |
| `controller/snapshots/state-<seq>-<hash>.json`         | checkpoint of the fold at `seq`; valid only if replay of the prefix matches its hash                   | anything beyond `seq`                             |
| `controller/budget-ledger.jsonl`                       | idempotent µUSD/token/call/trial reservations, spend and release                                       | market prices beyond the frozen schedule          |
| `archive-catalog.json`                                 | which candidates were admitted, their source hashes, parents, per-task tallies; failed trials retained | sealed-split performance                          |
| `drive-report.json`                                    | last tick's stopReason, trials, lineage depth, budget totals, citation digests                         | that the run was "good" — only that it reconciles |
| `harbor-ledger.jsonl` + `controller/candidates/<id>/…` | each trial's job id, sandbox, and artifacts are attributable                                           | solver intent                                     |
| `controller/objects/sha256/…`                          | every referenced blob is content-addressed; exports are self-contained                                 | blob provenance beyond the hash                   |

## Gate evidence (`evidence/gate*/`)

Each accepted gate records `STATUS.json` (PASS + the exact commit) plus the gate's own artifacts —
e.g. Gate 6 ships `stable-iteration.json` (crash drill + resume equivalence + citations) and the
Harbor `jobs/` logs including failures. `PROJECT_STATUS.md` is the index of what may be claimed;
anything not there is not claimed.

## The four states, and why a green one is not the next one

Archive admission, development champion, sealed promotion and full-set leaderboard are four
different states (`specs/06`). A candidate admitted to the archive (development evidence) has
**no** standing on the sealed split. As of v0.1.0-rc.1 no sealed unblinding has occurred, so no
document in this repository carries sealed-split evidence.

## Verification you can run yourself

```bash
node packages/cli/lib/main.js audit  --run-root runs/<run-id>   # reconcile the whole run
node packages/cli/lib/main.js status --run-root runs/<run-id>   # stateHash + observationCount
```

`audit` re-derives the manifest hash, the split ceremony, the failure-pool hash, archive capsules
and the drive-report state hash from the journal — the same reconciliation the gate recorders use.

## Retention rules

- The filesystem is the source of truth; derived indexes may be rebuilt but never become the only
  copy.
- Failed trials and their logs are kept (rule 7).
- Credentials never appear in any artifact; only their file paths (and never their contents) are
  recorded.
