# dsh-evolve-le 与 dsh-self-evolving 对比及迁移报告

**比较快照：2026-09-03（Asia/Shanghai）**

- 当前仓库：`/root/vibe/dsh/dsh-evolve-le`
- 参照实现：`/root/vibe/dsh/evolve/dsh-self-evolving`，比较时 `HEAD=d0f3c80`。

本报告同时记录本轮实现的第一阶段改动。当前仓库仍是 `NO_SEALED_RESULTS`；本报告不构成性能、部署、安全性或 SOTA 结论。

## 结论

两个项目在可信控制器、一次性候选进程、内容寻址证据、Harbor/TB 适配和开发/guard/sealed 隔离的目标上相近，候选实际运行的 DSH 深度却不同。

当前仓库原先只允许候选贡献 `systemPrompt.section()`，随后由自写 ACP 代理循环消费提示。候选的装载确实经过 Cordis Loader，但 solve/propose runtime 不是上游 DSH agent/tool/skill 组合。参照项目的 v0.1.1 路径在真实 DSH agent scope 内安装工具，允许候选演进为多文件 Cordis component，并将候选测试、策略扫描与 materialization receipt 纳入提案闭环。

本轮将当前候选 SDK、baseline、manifest、真实 Loader probe 与 admission unload gate 扩展为支持 candidate-owned `tools` 与 `skills`，recorded proposer 亦能产生实际变更这些能力的子代：tool/skill capability 名称保持稳定，但其描述、恢复指导和 manifest strategy surface 会随 child 改变。`src/dsh/native-composition.ts`、`native-proposal-runner.ts` 和 `acp/native-solve-agent.ts` 统一通过 `ctx.agents.create()`、scoped setup、session events、原生 `ctx.tools.register()` 与 owner dispose 驱动 DSH；模型侧按 DSH message/tool-call 协议经可信 gateway 转发并写审计哈希。运行时包名/版本也登记为显式 TCB pins。旧 ACP/directive loop 仍仅作为兼容路径保留；显式 native ACP 在完整 live model gateway 或 native 依赖闭包缺失时 fail-closed，不会冒充原生 DSH。

## 功能矩阵

| 维度             | 当前仓库（本轮后）                                                                                        | dsh-self-evolving                                                                     | 差异                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| 可信边界         | journal、controller saga、builder、split、Harbor adapter、预算在 TCB；候选一次性进程                      | canonicalization、admission、archive/evidence、runtime route 在可信侧                 | 原则一致；当前 crash/replay 与 TB 闭环更完整 |
| 候选加载         | `packages/candidate-baseline/src/index.ts` 为 namespace Cordis plugin，`candidate-probe.ts` 走真实 Loader | `packages/candidate-v011-baseline/src/index.ts` 同为 namespace Cordis plugin          | 都不是 `node:vm`，边界一致                   |
| baseline runtime | 候选可注册 prompt/tool/skill；native solve/propose 分别经 `ctx.agents.create()`，candidate setup 与 solve 工具均在 agent scope 安装；packed capsule admission 已跑完 deterministic native AgentLoop + candidate tool dispatch | proposer 在 DSH agent/session/LLM composition，工具在 agent scope 安装 | 主运行路径与 baseline AgentLoop/tool scope 已验；完整 ACP stdio transport/cancellation 与 live route E2E 仍待验证 |
| 可演化表面       | prompt、tools、skills 有定义/schema/Loader receipt/unload；协议预留 event/session/workflow                | v0.1.1 强制新 module + `ctx.plugin()`，工具驱动多文件代码和测试                       | 当前未 materialize event/session/workflow    |
| SDK              | 依赖无关的 `defineCandidate()`，约束命名、大小和 effect ownership                                         | canonical tree、scan、builder、resource domain、v011 admission/capsule/receipt        | 当前缺少版本化多文件 contract                |
| proposer         | 兼容路径仍有自写 `agent-loop.ts`、`gateway.ts`、`tools.ts`；native 路径以 `native-proposal-runner.ts` 启动 agent，并在 scope 注册 proposal tools | `runner.ts` 用 `ctx.agents.create()`；`v011-tools.ts` 用 `defineContentToolFixture()` | deterministic packed proposal tool loop 已验；真实 policy/materialization 与 live ACP 工具/取消仍待验收 |
| 子代生成         | recorded policy 复制树、修改源码/manifest，controller canonicalize/rebuild                                | 模型受限工具读写验证，要求 production module、root mount、candidate tests             | 当前机制较简单                               |
| 证据与准入       | 10-stage builder、真 Loader、unload、ACP replay、archive/controller evidence                              | tree digest、proposal/materialization/admission receipts、post-finish binding         | 可吸收 child receipt 粒度                    |
| benchmark        | TB 2.1 Harbor provider、真实 job、participation、sealed 边界                                              | SDK/proposer/search 分包，亦有 TB adapter                                             | 当前评测与失败归因更靠前，不等于能力已提高   |

## 代码比较

### 候选与 baseline

改动前，当前 `packages/candidate-sdk/src/index.ts` 只有 `promptSection` builder，`packages/candidate-baseline/src/index.ts` 的 solve/propose 只改 `candidate:*` prompt section。

参照项目有旧 baseline 与 v0.1.1 baseline：

- `/root/vibe/dsh/evolve/dsh-self-evolving/packages/candidate-baseline/src/index.ts`
- `/root/vibe/dsh/evolve/dsh-self-evolving/packages/candidate-v011-baseline/src/index.ts`

v0.1.1 baseline 采用 namespace-form Cordis component、`inject = ['systemPrompt']` 与 `ctx.systemPrompt.section()`。它本身并不等于完整策略演化；关键扩展来自它的多文件 child contract 和 DSH proposer tool loop。

本轮将当前 `ModeBehavior` 扩为 `promptSection`、`tools`、`skills`：

- `CandidateToolDefinition`、`CandidateSkillRegistration` 与 DSH registry 结构对齐。
- tool 名称必须是 `candidate_*`，skill 名称必须是 `candidate-*`，且有数量、描述、内容上限。
- 每项经 `ctx.effect()` 注册，Fiber unload 时释放。
- `packages/candidate-sdk/src/testkit.ts` 记录三类注册，候选测试可直接断言生命周期。
- baseline 注册 `candidate_strategy_snapshot` 与 `candidate-strategy-review`，而 model adapter、verifier、dataset、budget、protocol 仍归 TCB。

因此当前 baseline 不再是纯 prompt harness。但 admission probe 的 tool/skill service 仍是 TCB stub，不能声称候选工具已经在 upstream DSH dispatcher 中执行。

### Manifest、收据与卸载

当前 `schemas/candidate.manifest.schema.json` 原有 `runtime.newToolNames` 而没有 skill 声明或策略生命周期字段。本轮新增：

- `runtime.newSkillNames`；
- `proposal.strategySurfaces`，限定为 `system-prompt`、`tools`、`skills`、`agent-events`、`session-events`、`workflow`；
- baseline 的 `requiredServices`、tool/skill 名称和 strategy surface 声明。

`packages/dsh-evolve-le/src/bin/candidate-probe.ts` 在真实 Loader boot/unload 前后记录 section、tool、skill inventory。`packages/dsh-evolve-le/src/builder/pipeline.ts` 比较 manifest 与真实注册，并将 tool/skill 残留视为 unload invariant 失败。这比 source-text assert 强，但 inventory 仍来自 `probe/system-prompt-stub.ts`，尚未检验原生 `@deepseek-ai/dsh-tools` 或 `@deepseek-ai/dsh-skill` registry。

参照项目的等价/更强能力分布在：

- `packages/candidate-sdk/src/capsule.ts`、`builder.ts`、`source-snapshot.ts`；
- `packages/candidate-sdk/src/v011/contract.ts`、`admission.ts`、`tree.ts`；
- `packages/candidate-sdk/schemas/v011.*.schema.json`。

它分别为候选树、迁移、提案、analysis、materialization、admission 建立版本化 receipt。当前 build manifest 和 controller journal 已强，但 child strategy change 尚缺同颗粒度的 materialization receipt。

### Proposer 与工具调用

当前实现：

- `packages/dsh-evolve-le/src/proposer/agent-loop.ts` 解析 JSON directive 并调度。
- `packages/dsh-evolve-le/src/proposer/tools.ts` 直接实现受限 list/read/write。
- `packages/dsh-evolve-le/src/proposer/gateway.ts` 固定 model route 与 accounting。
- `packages/dsh-evolve-le/src/proposer/policy.ts` 是可重放 recorded proposer。
- `packages/dsh-evolve-le/src/proposer/sandbox.ts` 提供 uid/netns/process 一次性隔离。

这些安全和可重放控制应保留，但 agent turn、tool selection、tool-result rendering 都是项目私有协议。

参照实现：

- `packages/dsh-self-evolving-proposer/src/runner.ts` 用 `ctx.agents.create()`、`SessionId`、`createUserMessage`、`installModelSelection`。
- `packages/dsh-self-evolving-proposer/src/v011-runner.ts` 在 scoped setup 内安装 proposal tools。
- `packages/dsh-self-evolving-proposer/src/v011-tools.ts` 用 `defineContentToolFixture()`，随后 `ctx.tools.register()`。
- 它要求新 namespace Cordis module、root `ctx.plugin()`、candidate-owned mechanism/preservation tests、`validate_child`、`finish_proposal`。

本轮在 `proposer/protocol.ts` 加入 optional `strategySurfaces`。对包含 baseline tool/skill 的父候选，recorded policy 的前两个 child 分别修改 tool 描述或 skill 指导内容，同时保留稳定 capability 名称并同步重写 `candidate.json`。其他父候选保留 prompt fallback。子代 source、manifest、proposal intent 因此一致，真实 Loader probe 可拒绝不一致 child。这是 recorded policy 的最小、可验证扩展，不替代 v0.1.1 的模型驱动多文件 materialization。native runtime 的调用边界已集中在 `dsh/native-composition.ts`，避免新代码再次直接构造私有 loop。完整 native closure 的 packed capsule 现已以确定性 adapter 驱动 `proposal_list_files`、`proposal_write_child`、`proposal_finish`，并验证 3 对 session tool events、1 次受限 backend write 和 clean unload；这只覆盖 runtime dispatch，不替代真实 policy 或 child admission。

### Solve runtime 与 DSH 的含义

`bin/acp-boot.ts` 仍先经真实 Loader 装载候选，但 live Terminal-Bench solve route 会从 CLI 经
Harbor job config 将冻结的 native provider/model/max-tokens 传入 capsule，并创建
`acp/native-solve-agent.ts` 的 scoped DSH agent。它以 `ctx.agents.create()` 启动 upstream agent loop，
在 setup 中加载 `candidateStrategySetup`，并以 `ctx.tools.register()` 安装 ACP-backed
`solve_exec`、`solve_read`、`solve_write`。`dsh/native-llm-adapter.ts` 把 DSH messages、tool schemas 和
tool calls 经可信 solve gateway 转为上游模型协议；ACP 只承接 initialize/prompt/cancel 和终端生命周期。
其中 `solve_exec` 已绑定 agent `AbortSignal`，取消时只执行一次 kill、等待退出并释放句柄；已取消的读写
调用会在进入 ACP 前失败。

因此 native solve turn 已不是项目的极简 directive loop。任何 live gateway route 都必须有完整 native
DSH composition、冻结的 provider/model 与 live solve gateway；只有 agent spine、没有模型 adapter，或没有
native composition 时均在 ACP 启动前失败，绝不退回 compatibility loop。兼容 replay 保留给离线 capsule；
兼容 live loop 只保留给显式设置 `DSH_COMPATIBILITY_LIVE=1` 的历史/测试 profile，Harbor/CLI 不会注入该变量。
native closure `sha256:49fc9cd46e2468f382a28eb47bd817d0384615a11c35399f8cf13c300b8ce533`
（56 packages）已被 staged 到 baseline capsule：真实 Loader 中的 deterministic adapter 先发出
`candidate_strategy_snapshot`，AgentLoop 完成一对 native `tool/call` / `tool/result`，并在 session
event 和 clean unload 后才通过 admission。这证明完整依赖闭包、agent scope、candidate tool dispatch
和 session evidence 都在 packed capsule 内运行。proposal capsule 也已用相同 closure 完成 bounded
list/write/finish dispatch 与 unload admission。solve capsule 则在相同 closure 内以
`createNativeSolveAgent()` 实际调度 `solve_exec`、`solve_read`、`solve_write`：47 个 session events、
3 对 tool call/result，以及各一次 ACP facade terminal/read/write effect 后 clean unload。该 in-process
facade admission 不等于完整 ACP stdio request/cancel transport；取消语义仍只有 native tool 单元测试，
也不能将这些 admission 证据扩大为 live solve 或全量 benchmark runtime 已验收。

### 策略演化范围

`specs/00-product-contract.md` 已允许 prompt、tool schema/presentation/candidate-owned tools、context selection、memory/state、event/session/tool-result listeners、workflow/subagent/retry/recovery/completion policy。此前实现仅有 prompt；本轮覆盖 tool/skill registration，并在协议登记 event/session/workflow，避免再次将 prompt-only 固化为数据模型。

不可演化的 TCB 维持不变：model route/adapter、verifier、TB dataset/split/scorer、controller、budget、sandbox policy、网络/凭据边界、Harbor provider。

## 迁移路线

| 优先级    | 改动                                                                                                                         | 依据                                                             | 验收                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| P0 已完成 | tool/skill 声明、命名约束、effect ownership、manifest、Loader/unload receipt                                                 | 当前 SDK/probe/builder                                           | unit + 真 Loader + builder；无 unload 残留                             |
| P0 进行中 | solve/propose runtime 迁至真实 DSH composition 与 `ctx.agents.create()`                                                      | `dsh/native-composition.ts`、`native-proposal-runner.ts`、`acp/native-solve-agent.ts`；参照 proposer `runner.ts` | scoped lifecycle、solve candidate tool dispatch、solve tool-to-ACP-facade dispatch 与 proposal list/write/finish packed-capsule turns 已验；完整 ACP stdio/cancellation E2E 待验收 |
| P1 进行中 | `defineTool`/`defineContentToolFixture`、`ctx.tools.register()` 替换私有 proposer tool execution，保留 sandbox 路径/预算策略 | `dsh/native-proposal.ts`、`acp/native-solve-tools.ts`；参照 `v011-tools.ts` | scoped registration、预算计数和 backend 路由已实现；确定性 complete closure Loader injection 已验，仍需真实 policy/materialization E2E |
| P1        | 版本化多文件 child contract：新 component、root `ctx.plugin()`、candidate tests                                              | 当前 proposer/builder；参照 `v011/contract.ts`、`v011-runner.ts` | child test、policy scan、Loader、post-finish tree digest 均通过        |
| P1        | `strategySurfaces` 演进为 executable capability catalog                                                                      | schemas、SDK、builder receipt                                    | allowlist、resource budget、mode preservation、runtime receipt         |
| P2        | context/memory/event/session/workflow/subagent 策略模块                                                                      | 新 candidate SDK submodules                                      | crash/replay、mode isolation、TCB write protection、资源上限           |
| P2        | child-level materialization/admission receipt                                                                                | schemas、evidence、controller archive                            | source、proposal、tests、Loader/artifact 全内容寻址绑定                |

### Runtime 迁移约束

1. 锁定 `dsh-agent`、`dsh-session`、`dsh-llm`、`dsh-tools`、`dsh-skill` 与 Cordis 的精确闭包到 TCB capsule manifest/SBOM；候选不得替换。
2. `ctx.agents.create()` 继续在候选一次性 process/container 内执行；controller 绝不 mount candidate。现有 uid/netns、clock、output caps 必须保留。
3. ACP 只把 initialize/prompt/cancel 转换为 DSH session/agent 生命周期，不能重新实现 tool selection；deadline/participation evidence 仍归可信侧。
4. 候选只在 agent Fiber 内获得 SDK 声明的 scoped tool/skill/component；TCB tool/model/credential services 不给候选可写引用。
5. mutation 必须声明 target/preserved modes；未命中模式的 tool/skill/listener inventory、prompt 与 event side effects 必须与 parent Loader replay 一致。

## 本轮改动与验证

- `packages/candidate-sdk/src/index.ts`：tools、skills、策略限制、effect-owned 注册。
- `packages/candidate-sdk/src/testkit.ts`、`tests/harness.test.ts`：三类贡献的记录、验证和释放。
- `packages/candidate-baseline/src/index.ts`、`candidate.json`、`tests/candidate.spec.ts`：baseline DSH strategy。
- `schemas/candidate.manifest.schema.json`：skill 与 `strategySurfaces` schema。
- `packages/dsh-evolve-le/src/probe/system-prompt-stub.ts`、`bin/candidate-probe.ts`、`builder/pipeline.ts`：Loader inventory/unload evidence。
- `packages/dsh-evolve-le/src/proposer/protocol.ts`、`policy.ts`、`tests/proposer.test.ts`：strategy intent 和 baseline child tool/skill mutation。
- `packages/dsh-evolve-le/src/dsh/native-*.ts`、`acp/native-solve-*.ts`、`bin/acp-boot.ts`、`solver/gateway.ts`：native agent composition、agent-scoped solve tools、结构化 model/tool-call gateway 与 fail-closed ACP route。

已通过 `pnpm build`；native composition、proposal、LLM adapter、solve gateway、live solve 与 Harbor route
propagation 的定向回归共 6 个测试文件、60 项通过；全量回归 48 个测试文件、495 项通过；`pnpm lint` 无 error
（既有 warning 保留）。`pnpm provenance:check --silent` 的 upstream snapshot、package pins、reference/content、
lock/schema 检查通过，但本环境中其子进程读取 `pnpm --version` 时返回空 stdout，toolchain/versions 项无法确认
（交互式 `pnpm --version` 为 11.9.0）；`git diff --check` 通过。这证明 SDK、manifest、probe、builder、proposer
与 native route 的契约一致。随后 baseline native capsule 在完整的 56-package closure 中经真实 Loader
验证了 `ctx.agents.create()`、候选 agent-scope tool dispatch、session events 和 unload；另一 deterministic
native solve probe 还验证 3 个 `solve_*` DSH tools 对 ACP facade terminal/read/write 的实际 dispatch。两项
probe 均采用无网络、无凭据 adapter，不触及 benchmark；它们不验证完整 ACP stdio/cancellation、live
gateway 或 sealed evaluation，也没有性能结论。
