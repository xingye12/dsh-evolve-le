# 07 — Implementation and acceptance plan

**Status:** normative execution plan  
**Rule:** no paid/full-scale work before the previous gate has artifacts

## 1. Delivery strategy

项目按垂直闭环验收，不按“先写完所有 services 再集成”。每个 gate 都必须产生：实现、自动测试、
真实 runtime evidence、已知限制和 `PROJECT_STATUS.md` 更新。文档 checkbox 不是完成证据。

估时按一名熟悉 TypeScript/DSH/Harbor 的工程师给出，包含测试和修复，不包含云队列等待：

| Gate | Outcome                                   |                         Estimate |
| ---- | ----------------------------------------- | -------------------------------: |
| 0    | pinned provenance + real Loader lifecycle |                         1–2 days |
| 1    | candidate contract + reproducible capsule |                         3–5 days |
| 2    | Harbor ACP smoke + trusted normalization  |                         3–5 days |
| 3    | journal/reducer/archive/budget crash-safe |                         5–8 days |
| 4    | proposal sandbox + one child end-to-end   |                         4–7 days |
| 5    | productized iteration CLI closure         |                         1–3 days |
| 6    | stable K=3 real iteration proof           |            1–2 days plus runtime |
| 7    | open-source v0.1 release candidate        |                         1–2 days |
| 8    | optional continuous benchmark profiles    | separately budgeted post-release |

当前交付目标是 Gate 7 开源 release candidate；K=80 与 benchmark 提分不再决定项目是否完成。

## 2. Gate 0 — Provenance and Cordis lifecycle spike

### Build

- 初始化当前目录为项目 Git scope（若用户授权），将三个上游作为 external pinned checkouts，而非嵌套
  可编辑代码；
- 定义 root workspace、strict TypeScript、formatter/lint/test 和 schema toolchain；
- 生成 `provenance.lock.json`：DSH/Harbor/TB source、paper、Node/pnpm/Python、container、model catalog；
- 创建最小 `@dsh-evolve-le/candidate-baseline` bundle 和真实 `cordis.yml` fixture；
- 实现无模型 Loader boot → service/tool/listener inventory → unload → quiescence check。

### Accept

- baseline namespace plugin 通过真实 Loader，不能只有手工 `ctx.plugin()`；
- 故意加 `export default apply` 的 negative fixture 必须失败，证明测试能捕获 Loader unwrap；
- unload 后 inventory 与 boot 前精确一致，无 process/timer/open handle；
- upstream working trees clean；provenance 可机器验证。

### Stop if

当前 DSH API 与 spec 不符，先更新 `docs/dsh-integration.md`/ADR；不得用 `any`/mock 绕过。

## 3. Gate 1 — Candidate SDK and builder

### Build

- versioned JSON schemas：candidate/proposal/build/capsule manifests；
- canonical tar/hash、diff boundary、dependency/import/task-fingerprint scan；
- candidate SDK types/testkit，two-mode baseline candidate；
- deterministic builder sandbox、double build、SBOM、capsule launcher；
- packed bundle install + real Loader + mock replay E2E。

### Accept

- golden candidate 两次 clean build 的 source/bundle/capsule hash 相同；
- traversal/symlink/install-script/dynamic-import/task-literal/default-export/leaked-effect fixtures 全拒；
- packed capsule 在无 source checkout/无 network 的 fresh container 启动 DSH ACP initialize/session；
- builder 不执行 candidate lifecycle script，不访问 model/verifier。

## 4. Gate 2 — Terminal-Bench provider vertical slice

### Build

- TypeScript provider 生成 Harbor job config 和 inline ACP binary registry entry（HTTPS + SHA-256）；
- immutable artifact endpoint 或 provider-supported equivalent；
- `extract-elf` task 的真实 Harbor job；
- per-trial normalizer、planned inventory、ACP/ATIF/DSH/cost reconciliation；
- shared/separate verifier compatibility probe，不私自更改正式 task contract。

### Accept

- Nop/broken/golden fixture 能分别产生 expected fail/fail/valid result；
- 缺失 `result.json`、reward、trajectory、candidate hash 都显式 FAIL/invalid，不从分母消失；
- 真实 DSH candidate 通过 ACP client 完成一次 task，stdout protocol clean；
- adapter 重复 submit 同 idempotency key 不产生第二个付费 trial；
- raw Harbor job + normalized artifact 可从零重新解析成同 hash。

## 5. Gate 3 — Durable controller core

### Build

- `@dsh-evolve-le/core` bundle/service、config schema、single writer；
- object store、hash-chain journal、pure reducer、snapshot；
- candidate/archive/observation state、budget double-entry ledger；
- provider saga/idempotency/reconcile 和 read-only status command；
- fault-injection harness。

### Accept

- property tests 覆盖 arbitrary valid event sequences；
- 每个 intent/launch/collect/commit 边界 kill 后 resume，不重复 external effect/score/cost；
- event completion order permutation 在同 wave 得到相同 state hash；
- corrupt journal/object/snapshot fail closed；
- controller unload flush 后无 worker/process handle。

## 6. Gate 4 — Agentic proposal vertical slice

### Build

- proposal sandbox filesystem/network/model gateway policy；
- parent candidate `propose` mode through real DSH Loader；
- label-filtered evidence export/catalog，raw historical files on demand；
- proposal output protocol、width/diversity/dedup/donor provenance；
- builder handoff 和 rejected proposal evidence。

### Accept

- baseline parent 从两条 synthetic failure traces 生成至少一个 nontrivial admitted child；
- proposer 无法读取 controller、guard/sealed canary、credentials 或 sibling output；
- trace prompt injection fixture 不能改变 writable root/manifest policy；
- child 在 mock task 上行为符合 hypothesis，parent preservation tests 通过；
- proposal transcript/tool use/token/cost/source refs 完整。

## 7. Gate 5 — Productized iteration closure

### Build

- connect the accepted proposer, candidate builder, Harbor provider, durable controller and Archive behind one CLI;
- add versioned config plus `init`, `run`, `resume`, `status`, `audit` and `doctor` commands;
- default to the stable demo profile (`K=3`, no sealed access, at most 15 solver trials);
- keep credentials in root-readable external files and preserve the compatible Zen/high/1M/32k route;
- retain CMP/Thompson/UCB-Air, split/sealed and statistics modules as optional benchmark capabilities.

### Accept

- one command reaches propose → build → real Loader → Harbor evaluate → normalize → Archive commit;
- invalid config, missing credential, unavailable Docker/Harbor or budget exhaustion fails before paid launch;
- repeat submit/resume does not duplicate proposal, model trial, score or cost;
- CLI status comes entirely from durable evidence and works after process restart;
- selector/proposer still cannot access guard/sealed material.

## 8. Gate 6 — Stable K=3 iteration proof

Use a fresh development-only run. Run baseline failure discovery in deterministic batches of at most 12 observed
tasks. Freeze the resulting failure pool before proposals. If no real failure exists, stop as
`NO_REAL_FAILURE_SIGNAL`; do not choose tasks after candidate results.

### Accept

- autonomously admit 3 unique candidates across at least two lineage depths;
- evaluate each candidate on one task selected from the frozen baseline-failure pool;
- inject one real process crash after an external effect and resume to the same terminal state;
- exactly-once proposal/evaluation/cost, complete raw refs, hash-chain replay and normalized Harbor evidence;
- proposer cites historical raw evidence; build reject/runtime fail/infra retry/duplicate remain covered by fixtures;
- no score improvement, champion, sealed access or leaderboard claim is required.

Successful status is `STABLE_ITERATION_VERIFIED`. It is an engineering lifecycle claim only.

## 9. Gate 7 — Open-source v0.1 release

### Accept

- clean fresh-profile install using documented commands, followed by real Loader and K=3 demo smoke;
- public README/architecture/quickstart/config reference/troubleshooting and evidence interpretation docs;
- user-selected OSI license, CONTRIBUTING, SECURITY, code of conduct and release notes;
- source tarball/package, SBOM, provenance, checksums, dependency/license scan and secret/leak scan;
- full unit/E2E/typecheck/lint/format/provenance/upstream-clean/UTF-8 suites pass;
- rollback/uninstall and one prior-state restore are executed, not only documented.

Gate 7 produces `OPEN_SOURCE_V0_1_RELEASE_CANDIDATE`; it does not require benchmark improvement.

### tree-v2 protocol upgrade acceptance

- candidate identity is a multi-file Cordis component with a `ctx.plugin()` root and candidate-owned
  mechanism/preservation tests;
- all six strategy surfaces are executable, bounded, declared per mode, Loader-visible and
  effect-owned on unload; the capability catalog equals their exact declared union;
- v2 proposal admission resolves four named parent digests and rejects legacy bare-hash substitution;
- trusted protocol selection keeps legacy lineages replayable and requires v2 output after a tree-v2
  parent admission; the choice and parent mechanism digest are durable request/sandbox facts;
- target/preserved modes pass production-byte and isolated Loader-fingerprint checks;
- the eight strict schemas, canonical receipt digests and proposal-to-admission cross-links validate;
- a v1 migration receipt sets `resultsInherited: false`; the new identity is rebuilt, readmitted and
  reevaluated before it can receive any lifecycle status based on results.

## 10. Gate 8 — Optional continuous benchmark profiles

Gate 8 is post-release and never blocks v0.1:

- `pilot`: K=10 sampled development run for tuning stability and budgets;
- `search`: K=80 formal development search with signed manifest;
- `sealed`: one locked champion, paired 29×k confirmation and frozen bootstrap analysis;
- `official`: only after sealed promotion, 89×≥5 full-set/maintainer submission.

Each profile gets a fresh run lineage and retains the original split, budget, no-adaptation and claim boundaries.
Repeated small development runs may improve the harness over time; sealed results never feed the same run back into
selection. Skipping Gate 8 must be reported as `BENCHMARK_PROFILES_NOT_RUN`, not as failure of the open-source tool.

Gate 8 的公开 acceptance verifier 只有在真实 profile producer 已生成 versioned receipts、可信 artifact-store
reader、外部 signature authority、journal/action replay 和 immutable launch-manifest reconstruction 后才能
启用。在此之前，synthetic consistency tests 可以保留，但 public verdict 必须固定 fail closed，不能把内部
自洽 envelope 报告为 promotion/full-set/release evidence。

## 11. Test matrix

| Layer                     | Fast CI                     | Integration                      | Paid/slow            |
| ------------------------- | --------------------------- | -------------------------------- | -------------------- |
| Schemas/reducer/algorithm | unit/property/golden        | crash subprocess                 | none                 |
| Candidate                 | AST/type/unit               | real Loader + packed capsule     | replay model         |
| ACP/provider              | config/normalizer fixtures  | local Harbor `extract-elf`       | real solver smoke    |
| Safety                    | static/canary/path fixtures | sandbox escape/permission probes | audit sample         |
| Evaluation                | synthetic paired data       | mini job completeness            | baseline/sealed/full |

任何 paid test 都应先有 replay/mock twin。Mock green 只证明工程 contract，不证明 benchmark capability。

## 12. CI gates

每个 PR 最少：

```text
format/lint/typecheck
schema compatibility
unit + property tests
real Cordis Loader E2E
packed capsule offline boot
journal crash/replay suite
normalizer fixture suite
security policy fixtures
docs links + AGENTS/CLAUDE byte equality
upstream worktrees unchanged
```

Nightly 执行 container/sandbox/Harbor smoke；weekly 执行 dependency/SBOM/provenance refresh report，但不
自动改变 formal run pins。

## 13. Change control

改以下任何项需要 ADR + protocol version bump：candidate editable surface、TCB trust boundary、split sizes/
labels、primary metric/promotion gate、missing/retry semantics、CMP/UCB-Air formula、model route、task digest、
verifier mode 或 budget scope。

实现细节可在同 protocol version 内修改，但若可能影响 candidate behavior、score 或 evidence，需要新
baseline/new run。Docs 不能 retroactively 改释义让已有结果合规。

## 14. First concrete implementation action

先完成 Gate 0 的最小 Loader fixture：baseline namespace plugin、bundle patch、真实 boot/unload inventory
test 和 negative default-export fixture。它是后续 candidate/codegen/benchmark 的共同地基。

## Debugger v4 acceptance (ADR-070)

Require parent isolation, all-failure report coverage, empty/all-success overviews, forged/future quote rejection, unknown and repaired/debt abstention, >192 event preservation, budget skip and crash/replay contracts. Run TypeScript, unit/contract, real Loader, Harbor extract-elf and crash checks; retain actual receipts. No diagnosis-quality or benchmark claim follows from engineering verification.

## Offline attribution acceptance (ADR-071)

Require label/metadata noninterference, exact source-step round-trip, fixed denominator,
malformed/failed/budget-skipped visibility, deterministic confidence intervals, equal per-case
envelopes, immutable source/route manifest, no-network preparation/scoring and real SIGKILL
replay of stage/report publication. Paid scoring requires fixture twins; preserve all phase
inputs/outputs and usage receipts. An offline localization score is not a benchmark solve improvement.

### Advisory citation acceptance (ADR-072)

Require formatting/paraphrase acceptance, uncapped failureMode, truthful null
spans on unmatched evidence, matched-span preservation, structural/future
reference rejection, distinct-event unmatched clustering, report schema checks,
remote prompt contracts, controller profile freezing and crash/replay checks.
No paid model or benchmark rerun is implied by implementing this profile.

### Model-judgment State acceptance (ADR-073)

Test non-final failure support, active preservation under cropping, fixed lifecycle
preservation without mandatory anchors, evidence issue visibility, invalid identity
and enum rejection, legacy strict replay, profile freezing and shared production
validation/selection in a read-only State-rule ablation. Preserve Loader and
crash/replay contracts; no paid model rerun is needed for this engineering change.

### Full-trajectory debugger profile (ADR-074)

New runs freeze trajectoryPolicy=full-trajectory: one Detect request sees all
redacted events, original indices, tests, terminal facts and input coverage;
State sees all events/tests/terminal without field truncation or reduced context.
Detect still proposes at most eight findings; Cluster/State/Select/Recover remain
separate. An oversized request is explicitly budget-skipped with input-envelope,
never silently split or truncated. Earlier-reference chronology remains enforced.
Old manifests/configs without this policy retain windowed replay semantics.
Require full-context cross-boundary evidence, mixed-source index preservation,
oversized-input no-call, new-profile freezing, Loader and crash/replay tests.
Changed source/profile requires a fresh identity; no historical paid score rewrite
or attribution-quality improvement claim follows from implementation.

### Native capability acceptance (ADR-075)

Require contract tests plus the real production Loader for automatic compaction,
child candidate/task-tool inheritance, aggregate usage/evidence, count/concurrency/
step limits, parent cancellation and quiescent unload. Cover both proposal and
solve. Preserve existing crash/replay checks and run real Harbor extract-elf
smoke for adapter changes. No paid benchmark or sealed claim follows from these
engineering checks.

### Controlled event acceptance (ADR-076)

Verify the supported event projection, read-only bounded facts, exactly-once
waterfall delegation, failure/overflow behavior and foreign-session filtering.
Real production Loader tests must register callbacks through the actual SDK,
observe solve/proposal/child invocations and checkpoint effects, and unload to a
quiescent inventory. Preserve cancellation and crash/replay regression checks.
