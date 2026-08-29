# Quickstart

From a clean clone to a verified install, then to a real Terminal-Bench iteration. Every command
below is also executed end-to-end on a fresh profile by `pnpm install:verify`.

## Supported environment

- Ubuntu 24.04 x86_64 (also verified on WSL2), Node.js ≥ 22.19 (24.x used in CI drills),
  pnpm ≥ 11.7, Docker with a working daemon
- Network access to the npm registry, and to the Harbor/Terminal-Bench sources pinned in
  `provenance.lock.json` for `setup:source`

## 1. Install and build

```bash
git clone https://github.com/xingye12/dsh-evolve-le.git && cd dsh-evolve-le
pnpm install
pnpm setup:source      # materialize pinned upstreams (read-only) + Terminal-Bench source
pnpm build
pnpm provenance:check  # upstream commits/versions/toolchain match the lockfile
pnpm test              # full unit + E2E suite (fake provider; no paid calls)
```

Preflight note: `pnpm install:verify` additionally proves the _tarball_ path — extract, install with
`--frozen-lockfile` into a clean HOME/pnpm-store, build, Loader smoke, K=3 demo, snapshot-loss
restore, uninstall.

## 2. Verify the install (no credentials, no paid calls)

```bash
pnpm install:verify
```

This drives the fake-provider K=3 demo on the default stable-demo config and checks
`STABLE_ITERATION_VERIFIED`, then executes the restore drill (all snapshots + drive report deleted,
identical state reconstructed from the journal) and an uninstall.

## 3. Real Terminal-Bench iteration

Prerequisites (checked by `doctor`, fail-closed):

- a Terminal-Bench 2.1 tasks directory — `pnpm setup:source` materializes the pinned source under
  `.references/`; extract it and point `--tasks-root` at the extracted task set
- Harbor on `PATH` (pinned version `0.21.0`), a reachable Docker daemon, and an artifact endpoint
- a credential file for the proposer route, mode `0600` (its value is never logged or copied into
  evidence)

```bash
CLI="node packages/cli/lib/main.js"

$CLI init \
  --runs-root ./runs \
  --run-id my-first-run \
  --master-seed "$(openssl rand -hex 16)" \
  --tasks-root /path/to/terminal-bench-2.1 \
  --baseline-source packages/candidate-baseline \
  --jobs-root ./runs/jobs \
  --credential-file /path/to/proposer.key \
  --harbor-bin "$(command -v harbor)"

$CLI doctor --run-root ./runs/my-first-run    # must be all ✓ before spending anything
$CLI run   --run-root ./runs/my-first-run     # terminal-bench provider is the default
```

`init` freezes `run.config.json` and refuses to overwrite an existing run. `run` is idempotent with
`resume`: re-invoking after a crash replays the journal and continues; nothing is re-spent.

## 4. Watch and audit

```bash
$CLI status --run-root ./runs/my-first-run   # phase, stopReason, state hash, observation count
$CLI audit  --run-root ./runs/my-first-run   # manifest/split/pool/archive/report reconciliation
```

Stop semantics: the run ends `STABLE_ITERATION_VERIFIED` only when K is reached, every child is
pool-evaluated and lineage depth ≥ 2. Any other exit (`BUDGET_EXHAUSTED`,
`MAX_CONSECUTIVE_EXPANSION_FAILURES`, …) is a real terminal state, not a retryable glitch.

## 5. Read the evidence

Everything the run produced lives under `runs/<run-id>/`:

```text
runs/my-first-run/
  run.config.json        frozen config (identity + budget + routes)
  split-ceremony.json    development/sealed split commitment (sealed stays inaccessible)
  failure-pool.json      frozen development task pool
  archive-catalog.json   admitted candidates with per-task tallies
  drive-report.json      last tick summary (stopReason, trials, budget, citations)
  harbor-ledger.jsonl    one line per Harbor job
  controller/            journal/, snapshots/, candidates/<id>/, objects/sha256/…
```

See the [evidence guide](evidence-guide.md) for what each artifact proves. When you are done,
[operations](operations.md#uninstall) documents rollback and uninstall — both are executed paths,
not just prose.

## Next steps

- [Configuration](configuration.md) for every field `init` freezes and how to override search and
  budget parameters with `--set`.
- [Architecture overview](architecture-overview.md) for the trust boundary and durability model.
- [Terminal-Bench 2.1 runbook](terminal-bench-2.1-runbook.md) for the fixed Harbor/TB facts.
