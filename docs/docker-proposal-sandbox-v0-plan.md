# Docker 候选生成沙箱 v0 实现计划

> 状态：Draft，待实现。本计划替代原先继续补全 Docker proposal supervisor 的实施路线。
> 本轮只实现候选源码生成阶段的 Docker 隔离；评估、构建、准入沿用外部可信流程。
> 计划本身不证明沙箱已可用，也不产生候选准入或性能结论。

## 1. 目标与边界

参考 DGM `self_improve` 的结构：一次 attempt 一个一次性容器，容器内修改源码，导出产物，
停止并清理容器，后续验证与评估在容器外的独立流程中进行。

最终调用形态：

```text
现有 propose 调用
  → 冻结父代源码、development 输入、模型路由和本次限额
  → Docker 内真实 Cordis Loader + native AgentLoop 修改 candidate package
  → 外部捕获不可变 source snapshot
  → 停止并清理容器
  → 将 snapshot 交回既有可信 builder / validator / admission 流程
```

生成成功只表示源码产物完整且本次执行已清理，不表示构建、测试或准入成功。
生成结果本身没有 admission 权限；其中的源码可以经独立可信验证后成为候选。
不要求先恢复旧的完整 supervisor 才能使用这些源码。

本轮不做：

- proposal 容器中的 online tests、finalizer 或 validator 编排；
- benchmark trial sandbox、sealed、selection、promotion 改造；
- owner 崩溃后续跑、generation 接管或自动重跑 attempt；
- 通用 session 框架、后台 janitor service、数据库或队列；
- K=3 工程运行门或完整旧 supervisor 的升级路线。

## 2. 必须保留的边界

- 一次 attempt 只创建一个 proposal 容器，不自动重启或重跑。
- 候选代码不装入长期运行的 controller；容器内运行真实 Loader/native AgentLoop。
- 非 root、只读根文件系统、只读输入、无网络、无凭据、无 Docker socket、无 host 执行 fallback。
- 模型经外部 gateway；凭据只在可信进程内使用，不进入容器、配置、CAS、日志或结果。
- 候选持久源码产出只限声明的 candidate package；`/tmp`、HOME 等允许有界临时写入。
  TCB、父代输入和宿主文件不可写，临时目录内容不能被混入候选源码。
- 固定镜像与执行入口，冻结输入、路由、参数和限额，复用现有 CAS 与执行证据。
- 保留单 attempt 的 owner lock、deadline、CPU/内存/PID/输出限额和模型预算。
- 缺失、损坏、超时或不可归因默认失败；失败记录保留，不以自动重试替换。
- 正常路径必须清理；异常路径尽力清理并保留可信登记，供显式 `sweep` 补清理。

## 3. 本机 WSL Docker profile（ADR-079，用户明确授权）

使用显式冻结的 `security.profile: local-generation/v1`，直接在本机 Docker Engine 运行。
不要求 AppArmor 或宿主 delegated cgroup v2，不修改内核、daemon 或上游。
保留 seccomp、非 root、cap-drop/no-new-privileges、只读根与输入、无网络与凭据、受限挂载、
有界 tmpfs，以及 Docker 内存/swap/CPU 速率/PID 限额和外部 wall timeout。
不声称累计 CPU 时间、memory peak 或 cgroup event 计量；以 Docker 实际 inspect/状态证明限制与终止。
旧严格 profile 不自动改变，validator 和 benchmark 不继承此策略。
详见 [ADR-079](adr/0003-local-docker-generation.md)。

## 4. 实现策略：薄编排，复用原语

新增一个薄的 proposal runner，直接组合已有模块：

- 输入：`proposal-input.ts` / `input-manifest.ts` / worker config；
- 执行：`docker-engine.ts` / `docker-policy.ts` / `docker-executor.ts` / `linux-host.ts`；
- 能力：`action-broker.ts` / `rpc.ts` / `shell.ts` / worker client；
- 模型：`model-gateway.ts` / replay transport / `upstreamChatCompletion`；
- 证据与清理：snapshot、execution evidence、completion、owner、reservation ledger。

不新写 Docker 客户端，不在本轮增加一套预算账本或执行状态机。
复用模块已有的持久化机制，但不新增恢复运行消费者。

**不以抽取 `ProposalWorkerSession` 为前置条件，不要求旧 supervisor 改用新抽象。**
旧的未完成 supervisor 路线冻结，保留现有代码和失败记录，不在本轮补齐其验收。
实现中如需调整共享原语，只做实际消费者所需的最小变化并运行相关回归；
不为未来可能的复用提前搭框架。

文件按实际职责组织，预计需要 runner、live dispatch 适配、结果契约及薄 CLI；
清理逻辑优先复用 executor，只有必要时再拆文件。不以文件数、行数或抽象层数作为验收指标。

## 5. 输入、工具与执行流程

### 5.1 输入契约

复用冻结的 `ExecutionSpec` 和 input manifest，绑定：

- attempt / execution / parent / 预分配 child 身份；
- 父代源码、development export 和固定 worker 依赖闭包；
- 镜像 digest、固定 command、安全策略和资源上限；
- 模型路由、参数、token/费用限制和原始 deadline。

只选择一个地方负责 `composeProposalInputs`；runner 消费已冻结输入，不在执行中重新生成
另一份身份。配置拒绝 sealed/DEV_GUARD、凭据和未声明字段。
并发能力不在本轮扩展；现成 reservation admission 若是 executor 前提则直接复用。

### 5.2 正常路径

1. 校验配置、冻结输入和平台；付费请求之前完成 preflight。
2. 取得 attempt 的 owner lock；已有启动记录的 attempt 拒绝再次运行，只允许读取或清理。
3. 物化只读输入和有界工作区，准备 gateway/RPC/证据接收后启动容器。
4. 固定 worker 通过真实 Loader/native AgentLoop 使用文件、shell、model、snapshot、finish 工具。
5. 本 profile 从工具列表和提示词中隐藏 `test-child`；RPC 端同样拒绝该能力，不伪造测试反馈。
6. `proposal_finish` 对选定 child 通过外部 `quiesceSnapshot` 捕获源码；
   broker 的 finalize 只做必要的结构与身份核验、传递快照，不调用旧 finalizer 或测试。
7. 提交后撤销模型与工具权限，停止容器，不再等待新的模型调用。
8. collect → cleanup → 核验资源释放 → 写结果；只有成功且清理完成的结果可交给外部流程。

多 child 行为沿用已有分配上限，不新增并发调度。测试最小路径只需一个 child。
多 child 的结果绑定各自不可变快照，不宣称是跨目录同时捕获的事务快照。

### 5.3 失败路径

- preflight / 输入失败：不启动容器，不发付费请求，记录失败原因。
- create / start / worker / 模型失败或超时：停止、尽力收集、清理，不自动重跑。
- 没有合法 finish 或快照：不得成功；可保留诊断源码但不交给后续准入消费者。
- 清理失败：记录 `INCOMPLETE` 和待清理登记；阻止本次结果被采用。
- owner 崩溃：本 attempt 不续跑、不补发模型；通过 `sweep` 停止并清理残留。
- 结果发布失败：保留已写证据，不凭宿主工作目录推断成功。

失败但清理已确认可以记录 `FAILED`；执行、费用或清理无法确定时记录 `INCOMPLETE`。
不确定状态不能升级为成功。

## 6. 模型访问

先用现有零费用 replay 验证执行链路；缺少响应即失败，禁止回退 live。
随后增加薄的 live dispatch 适配，调用已有 `upstreamChatCompletion`，保留消息、工具调用及
usage 的语义，沿用冻结路由和 `ActionModelGateway` 的预算预留与结算。

v0 固定上游请求 `maxAttempts=1`，避免 `upstreamChatCompletion` 内部重试造成额外请求或费用。
单次请求超时受剩余 attempt deadline 约束。模糊计费保留为 ambiguous，不按零费用结算，
不自动再次 dispatch；不承诺跨进程精确费用或 provider 侧取消已经发生的计费。

凭据通过独立 credential file 读取，校验可信所有者、仅所有者可读写、普通文件、单链接、大小上限。
不放进 CLI 参数值或冻结配置；下游错误只保留经过清理的诊断，不序列化原始请求 header。
用假凭据扫描配置、日志、CAS 产物和结果，验证无泄漏。

## 7. 结果与外部交接

使用独立结果协议，例如 `dsh-evolve-le/proposal-generation-result/v1`：

```ts
interface ProposalGenerationResult {
  protocol: 'dsh-evolve-le/proposal-generation-result/v1'
  admission: 'NONE'
  outcome: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INCOMPLETE'
  specDigest: string
  execution: ObjectRef | null
  completion: ObjectRef | null
  submission: ObjectRef | null
  diagnostic: ObjectRef | null
}
```

- 失败发生在 create/collect 之前时允许相应 ref 为 `null`，不构造伪 execution/completion。
- `SUCCEEDED` 必须具有可验证 execution、submission、源码快照与 cleanup completion；
  核对 spec、parent、child、artifact membership，不仅检查字段非空。
- completion 复用已有要求 `CLEANED` 的独立证明；清理未完成时不得生成成功 completion。
- 结果写入 CAS，本地 `result.json` 仅作可重建指针。删除工作目录后仍能读回。
- Archive/selection 不直接采用该结果或 submission 作为 admission。
- propose 的可信交接层验证成功结果后，将 snapshot 放入既有 builder/validator 输入；
  必要的源码规范化、构建、测试和 admission 全部由外部既有流程决定。
- 失败或未完成结果不交接、不自动重试；记录保留在原 attempt 下。

最小结果不新增 validator 字段、重复的 cleanup 布尔值或另一套 model usage 摘要；
模型账本与清理细节通过原 execution artifacts 读回。
协议和 schema 以实际契约测试固定，复用现有 submission 的源码清单验证逻辑；生成阶段使用独立的 `generation-submission/v1`，
保留尚未规范化的 tree-v2 语义字段，不要求模型生成 receipt digest。普通 submission 消费者必须拒绝
该协议，外部可信规范化之后才能进入原候选验证路径。

## 8. 快照与清理

成功源码仅通过现有 `host.quiesceSnapshot` 捕获，绑定 execution/child/spec。
pause 失败则失败；宿主 exporter 继续执行路径、符号链接、文件类型、大小和范围检查。
快照捕获期间冻结容器及外部写入能力，不能仅靠工具日志判断没有其他 writer。

正常和异常路径共用 executor 的 stop/collect/cleanup，释放容器、挂载和 reservation。
不使用 `--rm`、auto-restart、全局 prune，不新增后台清理服务。

提供显式 `sweep` 命令：

1. 枚举本 runner 的可信 attempt 登记，结合已有 `dsh.*` Docker labels 确认身份；
   不为此另建一套 label 命名体系。
2. 尝试取得该 attempt 的同一把 owner lock；拿不到锁就跳过，禁止抢清理活执行。
3. 根据可信 spec/registry 核对精确容器身份与挂载路径，再停止、收集可用诊断并清理。
4. 即使容器已不存在，也检查并清理残留挂载和 reservation。
5. 写追加式清理收据，不改写原成功/失败记录，不重新启动 worker 或模型。

label、PID 或 grace period 都不能单独授权删除宿主路径；缺少可信登记时报告人工处理，
不扩大扫描与删除范围。自动启动 sweep 后置，不作为本轮交付门。

## 9. 三个交付门

### 门 1：真实 Docker 产物链路

- 用 ADR 记录对旧 Docker 实施路线的替代范围及仍适用的边界；同步修正规范中明确冲突的
  实施要求，不把“将来恢复完整 supervisor”保留为隐含前提。不修改参考上游。
- 在本机通过 local-generation/v1 preflight 和实际限制检查。
- 先写输入/结果与生命周期契约测试，再实现薄 runner。
- 一次 replay：容器 → 真实 Loader/AgentLoop → 修改源码 → finish → CAS snapshot → cleanup。
- 删除宿主工作目录后成功结果仍可验证；无 Archive 写入。

未通过真实平台和产物链路，不进入 live。

### 门 2：真实模型与失败清理

- live dispatch 适配，单请求单次 dispatch，假凭据泄漏测试与预算拒绝测试。
- 一次显式授权的真实模型 attempt 产出可读回源码并确认清理。
- 验证超时、worker 失败、pause 失败、cleanup 失败与重复启动拒绝。
- 真实杀死 owner，使用 `sweep` 清理原容器、挂载与 reservation，不发新模型请求。

不要求全边界 crash/replay 矩阵，因为本 profile 不支持恢复运行；
但真实 owner 崩溃后的停止和清理必须有证据。

### 门 3：接回现有 propose

- 将 Docker runner 接入明确选择的新 proposal backend/profile，冻结新的运行身份。
- 成功源码进入既有可信 builder/validator/admission 路径；已有后续门不被绕过。
- 集成测试证明生成失败、证据损坏或清理未完成均不会被采用。
- 未经外部验证的生成结果没有 admission；外部验证失败保留拒绝证据。
- 更新 `PROJECT_STATUS.md`，只声明有 artifact 支持的状态。

门 1 可独立交付用于调试；完成门 3 才能称为“已接入候选生成流程”。
不把 standalone 探针的成功当作最终交付。

## 10. 测试与变更控制

测试集中于实际边界，不为模块拆分或装配顺序单独扩张测试体系：

- 契约：输入身份/标签/凭据拒绝、成功结果完整性、失败结果可读回。
- 隔离负例：不能写 TCB/只读输入/宿主文件，路径穿越与符号链接不能混入源码导出；
  允许临时目录写入。源码清单不能替代实际写权限测试。
- 生命周期：超时/异常清理、重复启动拒绝、cleanup 失败阻断采用、sweep 不碰活 owner。
- 模型：请求/费用上限、无隐式重试、ambiguous 保留、凭据不进入序列化产物。
- 真实 Docker/Loader E2E：replay 成功路径及 owner 崩溃清理；再做一次 live 成功路径。
- 集成：snapshot 进入既有可信验证流程，失败不产生 admission。

共享代码有改动时运行相应已有回归；完成交付前运行 build 和仓库要求的相关检查。
真实 Docker 测试和付费 live 测试分别显式开启，避免 replay 探针意外发起付费请求。
全量测试串行运行，记录既有失败与新增回归，不删除、skip 或伪装旧 supervisor 红项。
旧 supervisor 集成失败不冒充新 backend 的验收结果；只有实际适用的新流程测试才支持新结论。

本轮不预估精确行数或固定工期。先完成门 1，根据真实阻塞估算剩余工作；
遇到平台适配、通用框架重构或新的恢复协议需求时先检查是否超出本计划范围。

## 11. 历史实现切片（2026-11-01，严格 profile 尚未验收）

本节保留上一切片记录。其平台阻塞和 live 禁用状态已由 ADR-079 及本机后续实现取代。

已提供薄 runner、独立 config/result 契约和固定 CLI，复用现有 executor、broker、gateway、
CAS 快照和 cleanup。冻结 worker config 必须包含 `generationOnly: true`。
生成提交使用 `generation-submission/v1`，允许 tree-v2 原始语义字段尚未规范化；
普通 submission 消费者拒绝该协议。后续门 3 必须在可信私有副本中规范化后再验证，
不能把 raw draft 直接当成正常 proposal 或 admission。

构建后入口：

```bash
pnpm build
node packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js run /absolute/private-config.json
node packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js read /absolute/private-config.json
node packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js sweep /absolute/private-config.json
```

配置协议为 `dsh-evolve-le/proposal-generation/v1`，见
[`proposal.generation.schema.json`](../schemas/proposal.generation.schema.json)。
配置必须是 root-owned、私有、有大小上限的普通文件；输入由既有 `composeProposalInputs`
生成，禁止手工拼造摘要。`run` 与 `sweep` 自动进入同一把 kernel flock；锁被占用时返回 75。
`sweep` 第一版只接受一个显式配置，避免全局扫描，并检查配置与已有 effect receipts；
没有 effect receipts 的失败不冒充清理成功。

本地 `generation-result.json` 是独立 CAS result 的指针。`run` 不恢复历史 attempt；
重复调用拒绝，只允许 `read` 或显式 `sweep`。当前入口只启用零费用 replay；
`live` 明确拒绝，Controller/backend 接线尚未启用。

实际平台报告见
[`platform.json`](../evidence/docker-generation-20261101/platform.json)：
当前主机 cgroup v1，AppArmor 不可用。本机 local profile replay、真实容器隔离/Loader/清理成功路径、
真实 owner 崩溃清理尚未通过，不能称门 1 已完成，更不能称已接入实际候选生成流程。

## 12. 本机实施入口（ADR-079）

本机已完成真实 Docker/Loader replay、文件/shell 修改、快照与清理、owner-kill/sweep、
wall timeout，以及实际 Controller 外部验证/准入交接与重复消费测试。
新 run 通过 `--proposal-docker-profile /absolute/profile.json` 显式选择后端；
配置冻结 `proposalSandbox` 和单次 dispatch 路由，不再要求远程主机。
实现与命令见 [本机 runbook](docker-local-proposal-runbook.md)。
模型账本汇总作为 `generation-accounting/v1` CAS artifact 供实际 Controller 预算消费者使用；
它与 execution/spec 绑定，不作为候选提供的 authority。生成草稿仍须外部规范化/验证。
实时模型与最终回归状态以 PROJECT_STATUS 和对应 evidence 为准。
