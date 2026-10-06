# SWE-Bench Pro offline attribution evaluation

Protocol: `dsh-evolve-le/swepro-attribution-evaluation/v1` (ADR-071).
This evaluates critical-step localization on retained public trajectories. It does not
execute a coding task, change a candidate, reveal Terminal-Bench sealed data, or measure repair efficacy.

The 2026-10-05 baseline run freezes `methods:["single-pass"]` and 32768 output tokens.
The separately authorized v4 run freezes `methods:["v4"]` and 65536 output tokens in
`evidence/swepro-attribution/v4-64k-20261005-v1.config.json`. Both retain the $20 ceiling,
6-hour wall limit and 180-second request timeout. v4 uses the current production window,
cropping, validation, unknown-state and selection behavior; Recover remains excluded from
localization. The different output caps prevent a same-parameter algorithm comparison.
`scripts/audit-swepro-v4.ts RUN_ROOT` verifies source/input/label identities and replays all
retained Detect and State responses locally to reproduce each report and final prediction.
Run this after all 86 predictions are committed, then use score mode to verify the final
metrics digest without any model calls. Its 86-case fixture covers supported selection,
rejected findings and incomplete-context abstention.

Use the 86 English files in `TrajDebug/data/trajerrbench/en/swebenchpro`. Each represents a distinct
task and has a zero-based assistant critical-step label. Lengths are 58–180 messages (median 117):
47 trajectories have at most 120 messages and 39 have more. Chinese/English pairs are one population.
Nine records lack a taxonomy label; module accuracy uses the remaining 77 only.

The adapter exposes only message role/content and assistant identity. It preserves message indices
and never passes annotation, extra metadata, or a task description from metadata to the model.
Captured system/user messages supply requirements. No verifier evidence is fabricated; the observed
final event supplies terminal evidence when sufficient. The original release JSON is retained in
controller-internal objects, isolated from every model request.

Compare one single-pass localization request against the unmodified v4 Detect → Cluster → State →
Select flow. Recover is intercepted with an explicit empty suggestion result and no network request;
this is a localization-only evaluation profile, not a new production debugger protocol. The baseline
uses the same quoted finding validation and subsequent final-event anchor checks. It does not gain
knowledge from gold labels or v4 results. Both methods share the frozen route, output cap, raw visible
information, per-case calls/tokens/USD envelope and request timeout. The baseline can read full input
within its envelope; v4 applies its existing display cropping and window rules. Omitted content is
auditable. Methods alternate order across the sorted cases; execution is serial.

Primary metric is exact original-message step match / 86. Null, missing, malformed, failed, uncertain
and budget-skipped results remain in the denominator. Also report answered accuracy and coverage,
Wilson 95% intervals, length strata, v4 validated-finding recall, selected-module accuracy and paired
bootstrap difference (10,000 task samples, seed 20261005). `complete` means both methods have a
record for all 86 cases; inspect status counts because completion does not imply every model call
succeeded. Budget depletion is disclosed and never reclassified as a successful full-budget comparison.
No relaxed-step metric is used as the headline. Annotation agreement does not establish explanation
validity: human blind review of matched and unmatched cases is a separate, manually authored artifact.

## Run

Create an external evaluation configuration with `datasetRoot` and a `profile` matching
[`offline-evaluation-profile.schema.json`](../schemas/offline-evaluation-profile.schema.json).
Freeze an explicitly selected route and total cost ceiling. A typical profile uses 524288 input bytes,
32768 output tokens, temperature 0, 180000 ms timeout, 16 calls / 2000000 tokens / 1000000 µUSD per
case-method, 21600 wall seconds, and 10000 bootstrap samples. These are ceilings, not expected costs.
The run wall limit includes downtime and checks the request timeout before each serial call; model
calls/tokens/USD use the existing controller ledger. Prices are frozen accounting assumptions; receipts
identify whether token usage was model-reported. Unknown charges consume the full reservation.

On 2026-10-05 the [provider pricing page](https://api-docs.deepseek.com/quick_start/pricing/)
states that the old `deepseek-v4-flash` ID is served by V4.1-Flash. The current example uses the
supported `deepseek-flash` name and the peak cache-miss/output upper rates ($0.30/$1.20 per M
tokens). Accounted cost is conservative frozen-price usage, not an invoice or cache-discount estimate.
The dated provider declaration is retained separately; API aliases can change underneath a provider,
so record any observed version discrepancy and do not claim an immutable model snapshot.

```bash
pnpm eval:swepro --config /path/to/evaluation.json --out /path/to/new-run --mode prepare
pnpm eval:swepro --config /path/to/evaluation.json --out /path/to/new-run --mode live \
  --credential-file /path/to/owner-only.key
pnpm eval:swepro --config /path/to/evaluation.json --out /path/to/new-run --mode score
```

Prepare and score do not read credentials or call a model. Live resumes the same frozen manifest.
For a baseline-only run, set `profile.methods` to `["single-pass"]` before preparation. Its completion
denominator is 86 case-method records; v4 is never invoked and the paired comparison is null.
Omitting `methods` preserves the original two-method evaluation. Changing the selected methods
requires a new run identity; do not append v4 results to a frozen baseline-only run.
Changing data, code, route, caps or prices requires a new output root/run identity. Uncertain
launched requests are failed and never paid again. Completed requests and reports replay without
network effects. The manifest pins data hashes, source snapshots, production TypeScript, the CLI,
lockfile and provenance lock. Credential values never enter the manifest, prompt, journal or log.

`metrics.json`, `predictions.jsonl` and `manifest-ref.json` are rebuildable convenience views.
The journal/object store is authoritative and retains per-stage inputs/outputs/usage, v4 reports,
gold-label manifest and metrics versions. Evaluate fixtures before any paid run; never report fixture
scores as model accuracy. Review benchmark annotations independently before making stronger causal claims.

### 墙钟到期后的独立补测

65,536 的六小时批次完成 80 条，case-081–086 全部为 `run-wall-clock` 跳过且没有任何付费
action。为完成用户要求的 86 条，使用新的 run identity 和新的六小时冻结信封补测这 6 条，
共享费用上限仍为 $20；已结算的原批次费用从补测可用预算中扣除。原批次的 `BUDGET_LIMITED`
记录保持不变。补测选择与 reward/定位结果无关，不重试已付费失败；部分付费的跳过会拒绝进入
该脚本，避免隐式重付。

```sh
node --import tsx/esm scripts/complete-swepro-v4.ts \
  --predecessor evidence/swepro-attribution/v4-64k-20261005-v1 \
  --out evidence/swepro-attribution/v4-64k-20261005-tail-v1 \
  --mode live --credential-file /absolute/owner-only/key
```

先用 `--mode prepare` 冻结补测输入和来源；`--mode score` 不读凭据、不调用模型。
补测 `metrics.json` 只描述 6 条；`combined-metrics.json` 和其内容寻址引用描述完整 86 条，
明确绑定两批次的 manifest/metrics digest、替换的未执行 ID 和合计费用。该合并结果是
延长墙钟后的完整执行结果，不是原六小时信封的结果。原始 80 条报告位于 predecessor，
其余 6 条位于补测目录；两批次分别运行 `scripts/audit-swepro-v4.ts` 验证完整报告重放。

## Advisory citation profile (ADR-072)

Current offline v4 runs use the advisory citation profile recorded in the manifest's
`debuggerProfile`: failureMode has no length ceiling, and Detect/State text mismatch
is an audit flag rather than a rejection. Prompts request concise failure modes and
faithful excerpts or paraphrases. Unmatched anchors preserve the model's claimed
quote and referenced index; actualQuote, field and span offsets are null. They do
not establish semantic agreement with the evidence. If a selected instance uses
unmatched citations its evidenceSufficiency is insufficient, even with a non-null
criticalFailure. Structural indices, source/actor/time and lifecycle checks remain.

Use a fresh root and runId after this change. The prior 86-case reports and 0/86
score remain historical strict-profile results. Do not resume them with changed
source or present a replay under relaxed rules as a new live accuracy result.
Single-pass baseline validation remains strict; a future comparison must disclose
that acceptance contracts differ. Controller configs generated now explicitly set
`agentDebugger.profile.citationPolicy: advisory`; legacy configs without that field
retain strict behavior. No paid evaluation was started by this change.

## Model-judgment State profile and local comparison (ADR-073)

New generated configs explicitly freeze statePolicy=model-judgment; old configs
without the field remain strict. State retains the model's valid lifecycle
classification. Non-final failure observations are allowed, cropping is an audit
flag, and missing/invalid support is kept in evidenceIssues instead of clearing
the classification. Prompts ask for anchors where available and limitations.
Unknown model states remain unknown; fixed instances without a claimed residual
irreversible/budget-debt influence do not become critical causes.

Run the no-network comparison with:

```sh
node --import tsx/esm scripts/revalidate-swepro-state.ts
```

It reads immutable 86-case source manifests, reports and State request/output
objects from the completed main/supplement batches; verifies digest/identity;
keeps Detect findings and instances fixed; applies the shared production State
validator and deterministic selector. Results are separate objects and rebuildable
views in evidence/debugger-state-rules. Strict lifecycle replay must match the
original reports. It does not open historical controllers for writes, send model
requests, run Recover or assess newly admitted Detect candidates. The output is
a post-hoc rule ablation, not a new live accuracy evaluation.

### Full-trajectory runs (ADR-074)

New v4 runs freeze `debuggerProfile.trajectoryPolicy=full-trajectory`. Detect is
one request per trajectory with all redacted events and uncropped fields. State
also reads the complete events/tests/terminal context. The eight-finding cap and
State/selection rules remain. Oversized requests are retained as input-envelope
budget skips. Use a new run/root after this source change; old 86-case metrics and
post-hoc fixed-pool comparisons do not measure this mode. No paid rerun is implied.
