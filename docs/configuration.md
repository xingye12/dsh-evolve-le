# Configuration

`dsh-evolve init` writes `runs/<run-id>/run.config.json` — a private, no-replace document that is
frozen at init and hash-checked (`configHash`) on every later command. It contains no credential
values: routes reference a `credentialFile` path, and the file's contents never enter the config,
the journal, logs or evidence. Changing an identity or limit requires a new run directory and run
ID; `init` refuses to overwrite.

`--set key=value` (repeatable) overrides the numeric search/budget defaults at init time only.

## Native DSH runtime lock

The built-in admission pipeline requires a prebuilt DeepSeek Harness catalog. Materialize the pinned
upstream with `pnpm setup:source`, copy it to an external build directory so the pinned checkout
remains read-only, then inspect the built copy from this repository:

```bash
NATIVE_DSH_CATALOG="$(mktemp -d)"
cp -a deepseek-harness/. "$NATIVE_DSH_CATALOG"/
(cd "$NATIVE_DSH_CATALOG" && pnpm install --frozen-lockfile && pnpm build)
pnpm native-dsh:inspect --catalog-root "$NATIVE_DSH_CATALOG" --output native-dsh.lock.json
```

Pass the resulting absolute catalog path and `dependencyClosureSha256` to `dsh-evolve init` using
`--native-dsh-catalog-root` and `--native-dsh-closure-sha256`. The hash is re-derived before each
candidate admission; a missing, mutable, or mismatched closure fails closed before a worker or paid
trial is launched.

## Frozen document (schema `stable-demo`, schemaVersion 1)

| Field          | Default                | Meaning                                                                         |
| -------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `runId`        | (from `--run-id`)      | durable identity; also the journal's `runId`                                    |
| `profile`      | `stable-demo`          | the only profile in v0.1                                                        |
| `masterSeed`   | (from `--master-seed`) | root of all derived randomness (canaries, split ceremony); treat it as a secret |
| `sealedAccess` | `false`                | must stay `false`; sealed unblinding is a separate one-time ceremony (specs/05) |

### `search` (defaults from `specs/03 §2`)

| Field                             | Default | Meaning                                                                            |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `kTarget`                         | `3`     | children per expansion; `K_REACHED` when the pool holds kTarget evaluated children |
| `proposalWidth`                   | `3`     | candidates a proposer child may emit per expansion                                 |
| `coldStartTrials`                 | `1`     | baseline trials before the first comparison                                        |
| `ucbAirAlphaPerMille`             | `600`   | AIR-UCB exploration weight (per-mille)                                             |
| `shortlistSize`                   | `2`     | pool shortlist handed to the proposer                                              |
| `maxSolverTrials`                 | `15`    | hard cap on solver trials for the run                                              |
| `maxDiscoveryTrials`              | `12`    | hard cap on discovery trials                                                       |
| `discoveryBatchSize`              | `6`     | deterministic discovery batch size per tick                                        |
| `maxConsecutiveExpansionFailures` | `3`     | terminal `MAX_CONSECUTIVE_EXPANSION_FAILURES` threshold                            |

### `budget` (fail-closed; enforced by the ledger)

| Field              | Default                                        | Meaning                |
| ------------------ | ---------------------------------------------- | ---------------------- |
| `usd`              | `500_000_000` µUSD (= $500 acceptance ceiling) | total spend ceiling    |
| `proposerTokens`   | `20_000_000`                                   | proposer token ceiling |
| `proposalCalls`    | `20`                                           | proposer call ceiling  |
| `taskTrials`       | `max(maxSolverTrials, 15)`                     | trial ceiling          |
| `wallClockMinutes` | `960` (= 16 h acceptance ceiling)              | wall-clock ceiling     |

Exhausting any limit is the terminal state `BUDGET_EXHAUSTED`, not a retryable error.

### `modelRoutes` / `proposerRoute`

Two route shapes exist, both with explicit pricing used by the budget ledger:

- `dsh-evolve-le/recorded-proposer` (default, `provider: "recorded"`) — the recorded/deterministic
  proposer route; no network, no credential file required.
- `deepseek/zen-compatible` (`provider: "zen-compatible"`) — optional networked route; requires a
  `credentialFile` (mode `0600`) and `--credential-file` at init.

Route fields: `contextWindowTokens`, `maxOutputTokens`, `inputUsdMicrosPerMTok`,
`outputUsdMicrosPerMTok`. Prices are part of the frozen identity: repricing means a new run.
The live `deepseek/zen-compatible` route defaults to a 1,000,000-token context and
`maxOutputTokens: 131072`; this value is frozen into the route plan and solver receipts.

### `benchmark` (terminal-bench-2.1)

| Field                           | From                    | Meaning                                                                                                                                          |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tasksRoot`                     | `--tasks-root`          | Terminal-Bench 2.1 task set directory (89 tasks)                                                                                                 |
| `baselineSourceDir`             | `--baseline-source`     | seed candidate package (normally `packages/candidate-baseline`)                                                                                  |
| `harbor.bin` / `harbor.version` | `--harbor-bin` / pinned | Harbor binary path and pinned version (`0.21.0`)                                                                                                 |
| `harbor.jobsRoot`               | `--jobs-root`           | Harbor job directories (kept as audit artifacts)                                                                                                 |
| `harbor.concurrentTrials`       | `--concurrent-trials`   | concurrent wave/job limit (live solver defaults to `4`)                                                                                          |
| `harbor.prefetchImages`         | live solver default     | warm task Docker images; receipt is `image-prefetch.json`, hash-bound in the run manifest                                                        |
| verifier image repair           | live-pilot default      | build run-scoped derived images with pinned verifier dependencies and no test-time `uv`/PyPI bootstrap; receipt is `verifier-image-receipt.json` |
| `artifactEndpoint`              | detected/pinned         | host/port for task artifacts                                                                                                                     |

For a live solver job, the trusted adapter reads that task's `[agent].timeout_sec`. Harbor's
uniform `agent_timeout_multiplier=3` supplies the hard agent-phase ceiling. The capsule receives
that effective ceiling in `DSH_SOLVE_AGENT_TIMEOUT_MS` and uses `effective ceiling - 300 seconds`
as its own wall clock, preserving a fixed teardown reserve. `[verifier].timeout_sec` controls the
separate verifier phase and does not change the solver deadline. A missing or malformed task
timeout fails the launch before a paid reservation.

## Environment variables

| Variable                               | Effect                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DSH_EVOLVE_CRASH_AFTER_OBSERVATION=N` | crash drill: the CLI SIGKILLs itself after the Nth observation; used by the Gate 6 resume-equivalence evidence |
| `HARBOR_BIN`                           | fallback for the Harbor binary path during scripted drills                                                     |

## Validation

`init` validates before writing: integer sanity for every numeric field, `sealedAccess === false`,
zen-compatible routes must carry a `credentialFile`, and paths must exist. `run`/`resume`/`status`
re-derive `configHash` and refuse a mutated config. The JSON Schema is
`schemas/run.config.schema.json` (id `…/run.config.schema.json`).

### Agent Debugger v4

New configurations created with an Agent Debugger route freeze
`agentDebugger.protocol: "v4"` and its TrajDebug profile. Development wave
commits now publish per-trial reports and candidate overviews before the next
search decision. Detect, State and Recover each reserve attribution calls,
tokens, USD and wall time independently; retries are disabled for these calls.
Token reservations conservatively use the UTF-8 input byte ceiling, and wall
settlement consumes the reserved request timeout. The first journal timestamp anchors elapsed wall time across restarts, including downtime. Known unused token/USD
reservation is released. Skips, unavailable debugger and ambiguous requests
remain visible in reports; the evaluation failure still counts.

The proposal request fixes `overviewDigest` and `observationWatermark`. Its v4
failure index includes the parent's baseline/discovery/search development
failures beyond the frozen scoring pool; guard, tournament, sealed and other
lineages are excluded. The JSON/Markdown overview and every trace shard are
immutable objects referenced by journal publications. No mutable view is needed
for recovery.

Configurations without an explicit v4 protocol retain the legacy v3 debugger
and v2 renderer for historical audit/replay. To use v4, initialize a fresh run
or pre-register a successor; editing an old manifest or resuming old evidence
under the new protocol is forbidden. This implementation does not automatically
pay to backfill historical diagnoses.

For a local engineering smoke with new evidence paths:

```sh
DSH_GATE2_EVIDENCE_DIR="$PWD/evidence/debugger-v4/harbor-smoke" pnpm e2e:gate2
node --import tsx/esm scripts/record-debugger-v4-smoke.ts
```

The second command projects the retained real Harbor trial through immutable
shards and the debugger lifecycle with no model configured. It records explicit
skips and zero paid diagnostic calls, not a live diagnosis-quality result.

A retained local SIGKILL matrix (fixture model responses, no paid requests) can
be recorded into a fresh evidence directory with:

```sh
node --import tsx/esm scripts/record-debugger-v4-crash.ts
```
