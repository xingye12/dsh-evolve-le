# Changelog

All notable changes are recorded here. This project uses semantic versioning for public releases.

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
