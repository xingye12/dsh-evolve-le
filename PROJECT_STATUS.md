# Project status

**当前权威状态：`SPEC_DOCS_IMPORTED`; `NO_IMPLEMENTATION`; `NO_EVIDENCE`; `ALL_GATES_PENDING`**
**更新时间：2026-08-28（Asia/Tokyo）**

## Claim boundaries

- 本仓库目前只有规范与文档，没有任何实现代码、测试、运行产物或 evidence。
- 没有 baseline、没有真实闭环、没有 sealed 结果；不得声称已提升、可部署、无 reward
  hacking 或达到 SOTA。
- `specs/07-implementation-plan.md` 的 Gate 0–8 全部未开始。文档 checkbox 与前代项目的
  通过记录都不是本仓库的完成证据。

## 2026-08-28 repository bootstrap

- 本仓库由前代项目 `dsh-self-evolving`（GitHub `timwhitez/dsh-self-evolving`，源 HEAD
  `6324afd`）的规范与文档复制建立，作为**重新实现**的基线；项目名统一重命名为
  `dsh-evolve-le`，GitHub 仓库同步由 `xingye12/dsh-evolve-plugin` 改名为
  `xingye12/dsh-evolve-le`。
- 复制范围：`specs/00–07`、`docs/`（含 audits）、`CLAUDE.md`/`AGENTS.md`、`CONTRIBUTING.md`、
  `provenance.lock.json`。未复制：前代实现代码（`packages/`、`benchmark-adapters/`、
  `scripts/`）、`schemas/`、`evidence/` 运行产物。
- 因此前代文档中的 Gate ACCEPTED、v0.1/v0.2 发布、npm 发布等状态声明**在本仓库一律不
  成立**：其支撑 artifact 不在本仓库。`docs/audits/` 与 `CHANGELOG.md` 仅作为前代历史
  参考保留；由于重命名，其中出现的 `dsh-evolve-le` 字样实际指前代 `dsh-self-evolving`
  的工作。
- `provenance.lock.json` 记录的上游 pin（deepseek-harness `47f9438`、harbor `ac398bb`、
  terminal-bench `d28711d`）仍是本仓库实施时必须重新建立的 external checkout 基准；
  前代文档中的 `../deepseek-harness/...` 相对链接需按该 lock 建立 checkout 后才能解析。

## Next

- 按 `specs/07-implementation-plan.md` 从 Gate 0 开始：pinned provenance + 真实 Loader
  lifecycle；每个 gate 产生实现、自动测试、真实 runtime evidence 与本文件更新。
