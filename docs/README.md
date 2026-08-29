# Documentation

This index separates normative specifications, operator guidance, evidence, and historical records. Start with the
short path that matches your task.

> **注**：本仓库是前代项目 `dsh-self-evolving`（`timwhitez/dsh-self-evolving` @ `6324afd`）规范的
> 重新实现基线。`docs/audits/`、`CHANGELOG.md` 的 `Predecessor records` 部分与各 release/migration
> 文档记录的是**前代项目**的状态，不构成本仓库证据；当前可声称的状态一律以
> [`PROJECT_STATUS.md`](../PROJECT_STATUS.md) 为准。

## Get started

| Document                              | Use it for                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------- |
| [Quickstart](quickstart.md)           | Clone → install → `install:verify` → first real Terminal-Bench iteration   |
| [Configuration](configuration.md)     | The frozen `run.config.json`: search, budget, routes, benchmark, overrides |
| [Troubleshooting](troubleshooting.md) | Fail-closed diagnoses, terminal states, and safe recovery                  |

## Understand the system

| Document                                          | Use it for                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Architecture overview](architecture-overview.md) | Trust zones, packages, iteration lifecycle, durability model                                            |
| [DSH integration](dsh-integration.md)             | Source-verified Cordis and Loader contracts                                                             |
| [DSH upstream policy](upstream-policy.md)         | Accepted pin, latest compatibility channel, and promotion workflow                                      |
| [Research basis](research-basis.md)               | Papers, prior systems, adopted mechanisms, and corrected assumptions                                    |
| [Architecture decisions](decisions.md)            | ADRs and trade-offs                                                                                     |
| [`specs/00`–`specs/07`](../specs/)                | Normative product, architecture, candidate, algorithm, evaluation, safety, evidence, and gate contracts |

## Operate and audit

| Document                                                | Use it for                                                |
| ------------------------------------------------------- | --------------------------------------------------------- |
| [Operations](operations.md)                             | Stop, backup, restore, rollback, and uninstall            |
| [Evidence guide](evidence-guide.md)                     | What each receipt proves and does not prove               |
| [Terminal-Bench runbook](terminal-bench-2.1-runbook.md) | Harbor/TB integration and optional benchmark profiles     |
| [Project status](../PROJECT_STATUS.md)                  | Current accepted state, quarantines, and claim boundaries |

## Releases and migration

| Document                                                 | Use it for                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| [v0.1 release gates](v0.1-release-gates.md)              | This repository's gate table and paid-solver envelope            |
| [Predecessor: v0.2 release gates](v0.2-release-gates.md) | Historical predecessor gates (not this repository)               |
| [Predecessor: v0.2 migration](migration-v0.2.md)         | Historical rename record (not this repository)                   |
| [Phase checklist](phase-todolist.md)                     | Execution checklist derived from `specs/07`                      |
| [Audit index](audits/README.md)                          | Predecessor versioned gate and incident evidence                 |
| [Changelog](../CHANGELOG.md)                             | `0.1.0-rc.1` onward for this repo; older entries are predecessor |

## Document authority

When records conflict, use this precedence:

1. frozen run manifest and content-addressed receipts;
2. normative files in `specs/`;
3. operational documents in `docs/`;
4. README and historical discussion.

Historical audits intentionally retain predecessor names, paths, failures, and claim wording. Do not modernize them
in place; add a successor record.
