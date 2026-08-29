# Changelog

All notable changes are recorded here. This project uses semantic versioning for public releases.

> **前代历史（2026-08-28）**：`Predecessor records` 之下的所有条目均来自前代项目 `dsh-self-evolving`
> （`timwhitez/dsh-self-evolving`，HEAD `6324afd`），因文档重命名显示为 `dsh-evolve-le`。
> 本仓库是重新实现；npm 上的 `@dsh-self-evolving/*` 包与前代仓库对应，与本仓库无关。
> 本仓库的版本与条目从这里开始。

## 0.1.0-rc.1 - 2026-08-30

首个发布候选（Gate 0–7，MIT）。此前实现与证据以 gate 为单位合入，本条目只列发布面变化。

- 实现门 0–6 全部随证据验收：真实 Cordis Loader 准入、candidate SDK、Terminal-Bench 2.1
  Harbor provider、durable controller（hash-chain journal + snapshot + 预算账本）、agentic
  proposer（uid+netns 沙箱）、单 CLI 闭环、K=3 多代崩溃/恢复稳定性证明
  （`STABLE_ITERATION_VERIFIED`，SIGKILL drill 与 resume 终态逐字节一致）。
- 开源发布面：MIT LICENSE（根文件与全部 package 清单统一）、README（中英）、
  architecture/quickstart/configuration/troubleshooting/evidence/operations 文档重写为当前实现。
- 发布产物与扫描（`pnpm release:artifacts`，全部作用于已提交树）：source tarball、
  sha256 checksums、SPDX 2.3 SBOM、依赖许可证 allowlist 扫描、secret 模式扫描、UTF-8 校验。
- 可安装性证明（`pnpm install:verify`）：干净 profile 上 `--frozen-lockfile` 安装 → build →
  真实 Loader 冒烟 → 默认配置 K=3 demo → 快照全删后由 journal 重建同一终态 → `resume`
  重导出 drive report → audit 全绿 → 卸载。
- 工具链：pnpm `gate7` 链（build/test/lint/format:check/provenance/upstream/UTF-8 + 发布证据）。
- 尚未发生 sealed 揭盲；不声称任何 benchmark 提升。

## Predecessor records

## Unreleased

- Published `@dsh-evolve-le/candidate-baseline`, `@dsh-evolve-le/candidate-sdk`, and
  `@dsh-evolve-le/core` to npm; `core` installs with
  `dsh plugin --profile headless add @dsh-evolve-le/core@0.2.3`.
- Enriched the npm metadata for `@dsh-evolve-le/core` (repository, homepage, keywords, package README).
- Made the npm install path the recommended README quick start, added npm badges and ecosystem links, and
  synchronized the Chinese/English documentation.
- Replaced the stale “does not publish a standalone npm package” quickstart text with the pinned-source rationale
  and documented the profile-bundle runtime variables.

## 0.2.0 - 2026-08-15

- Renamed the project, package scope, CLI, service, protocol identities and release artifacts to
  `dsh-evolve-le`.
- Preserved v0.1.1 Git history and immutable run evidence as predecessor records.
- Switched the default provider to DeepSeek official Responses with an env-only credential and `store=false`.
- Added a low-consumption fixed-replay effectiveness gate with target-mode change and control-mode preservation.
- Moved candidate tests and the trusted import policy into proposal-time validation, with an explicit durable
  target/preserved runtime-mode contract.
- Verified a real official-model child as `ENGINEERING_EFFECT_VERIFIED`; this is not a benchmark score claim.
- Added English/Chinese README switching, a documentation index, reproducible public CI, community templates, and
  Markdown quality gates for the public repository.
- Added content-addressed external-reference bootstrap and a scheduled latest-DSH compatibility channel while
  preserving reproducible pinned installs.

## 0.1.1 - 2026-08-15

- Added schema-v2 bounded multi-file candidate trees, deterministic proposal slots and exact tree-diff admission.
- Added exact-parent Loader proposal mode, immutable raw evidence citations and retained bounded proposer tools.
- Added candidate-owned sandbox tests, double builds, dual-mode Loader probes and self-contained capsules.
- Added mechanism-outcome feedback, capability request ledgers and crash-safe exactly-once recovery receipts.
- Added the schema-11 `v011-stable-demo` CLI profile and compatible Chat Completions tool-call translation.
- Added exact parent-candidate trajectory, normalized-trial, analysis and mechanism-outcome bindings for descendants.
- Added actionable semantic/build rejection feedback, TypeScript syntax preflight and bounded retry correction.
- Verified a fresh real K=3 lineage with three admitted multi-file candidates and injected launch-boundary recovery.
- Made release-readiness checks work from no-Git source archives using a fail-closed embedded tracked-file inventory.

The scoped capability is `AUTONOMOUS_PLUGIN_DEVELOPMENT_VERIFIED`. No Terminal-Bench improvement, sealed promotion,
leaderboard or SOTA result is claimed.

## 0.1.0-rc.1 - 2026-08-14

- Added real Cordis Loader, deterministic candidate builder and self-contained evaluation capsules.
- Added Harbor/Terminal-Bench ACP provider, fail-closed normalizer and exact usage reconciliation.
- Added durable hash-chain controller, budget ledger, provider saga and process crash recovery.
- Added networkless DSH proposer with a locked Zen-compatible DeepSeek route.
- Added the bounded `stable-demo` CLI profile with `init`, `doctor`, `run`, `resume`, `status` and `audit`.
- Added source-archive installation, verifiable no-Git source identity, SPDX SBOM, checksums and Apache-2.0 license.
- Defined K=10/K=80, sealed and full-set work as optional post-release benchmark profiles.

No Terminal-Bench improvement, sealed promotion, leaderboard or SOTA result is claimed.
