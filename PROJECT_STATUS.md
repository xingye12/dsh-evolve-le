# Project status

**当前权威状态：`GATE0_IMPLEMENTED`（6/6 测试 + 机器可验证 evidence）；`GATE1_IMPLEMENTED`（95/95 测试 + `pnpm gate1` 全绿 + 机器可验证 evidence）；`GATE2_IMPLEMENTED`（124/124 测试 + `pnpm gate2` 全绿 + 真实 Harbor job evidence）；`GATE3_IMPLEMENTED`（228/228 测试 + `pnpm gate3` 全绿 + 10 例 SIGKILL fault-matrix evidence）；`GATE4_IMPLEMENTED`（282/282 测试 + `pnpm gate4` 全绿 + 真实 uid+netns proposal sandbox E2E evidence）；`GATE5_IMPLEMENTED`（348/348 测试 + `pnpm gate5` 全绿 + 真实 CLI/Harbor 开发集闭环 evidence）；`GATE6_IMPLEMENTED`（351/351 测试 + `pnpm gate6` 全绿 + 默认 profile 真实 crash/resume K=3 稳定迭代 evidence）；`OPEN_SOURCE_V0_1_RELEASE_CANDIDATE`（Gate 7：351/351 测试 + `pnpm gate7` 全绿 + fresh-profile install/restore/uninstall 实测 evidence）；`GATE8_REMOTE_ROUTE_WIRED`（370/370 测试 + 真实模型 proposal 冒烟 evidence：live deepseek-v4-flash 经 TCB proxy 完成 1 次 proposal、3 子代全部过 trusted builder 重建）；`GATE8_PILOT_RECORDED`（377/377 测试 + specs/07 §10 pilot profile evidence：K=10 预注册 baseline 冻结 + 真实模型 proposal + 3 子代 cold-start，13 trials、23 392 µUSD、3763s，机器断言全绿；search/sealed/official profiles 未运行）；`NO_SEALED_RESULTS`**
**更新时间：2026-08-30（Asia/Tokyo）**

## Claim boundaries

- 本仓库已实现 **Gate 0**（provenance 机器校验 + 真实 Cordis Loader lifecycle spike）、
  **Gate 1**（candidate SDK + 十阶段可信 admission builder + 离线 capsule + ACP E2E）、
  **Gate 2**（Terminal-Bench provider 纵切片：真实 Harbor job 在 pinned `extract-elf` 上经
  inline ACP binary distribution 运行真实 capsule，normalizer/idempotency/verifier-mode
  探针全部机器断言）、**Gate 3**（durable controller core：状态层、单写者
  saga/recovery、SIGKILL fault matrix、Cordis service unload flush）、**Gate 4**
  （agentic proposal 纵切片：label 过滤 evidence export + canary、model gateway +
  受限 tool 层 + recorded proposer policy、一次性 uid+netns proposal sandbox、
  controller proposal saga + replay 验证 + bundle 校验 + 子代导入与重建）与 **Gate 5**
  （产品化迭代闭环：版本化 run config、split ceremony、CMP/Thompson/UCB-Air selection、
  Harbor `BenchmarkProvider` 适配、preflight + iteration driver、`dsh-evolve` CLI 六命令，
  一条命令走完 propose → build → 真实 Loader → Harbor 评测 → normalize → Archive commit，
  全程由真实 Terminal-Bench 2.1 task 的真实 Harbor trial 驱动）与 **Gate 6**（稳定 K=3 迭代：
  默认 stable-demo profile 下确定性批冻结 failure pool、3 个唯一子代跨 2 层 lineage 且各完成
  冻结 pool 上的 cold-start 评测、一次真实 SIGKILL 后 resume 到同一终态、全程 exactly-once，
  机器断言 `STABLE_ITERATION_VERIFIED`）与 **Gate 7**（开源 v0.1 release candidate：
  MIT 统一、发布 tarball（`git archive HEAD`，560 文件）+ sha256 checksums + SPDX 2.3 SBOM
  （81 packages）+ 依赖许可证 allowlist（75/75）+ secret 模式扫描（0 命中）+ UTF-8 校验
  （0 违例），干净 profile（全新 HOME/XDG/pnpm-store）`--frozen-lockfile` 安装 → build →
  真实 Loader 冒烟 → 默认配置 K=3 demo `STABLE_ITERATION_VERIFIED` → **实测** prior-state
  restore（journal 折叠 == 中途快照哈希）、快照全删重建、resume 重导出、journal 字节不变、
  audit 全绿与卸载全部实测，公开文档重写为当前实现）。Gate 1 的
  `admitted` 只证明 **safety-runnability**；Gate 2 的全绿只证明
  **单 task 评测管线成立且 replay capsule 得到诚实的 reward 0**；Gate 3 的全绿只证明
  **崩溃一致性状态机成立（FileProvider 假体）**；Gate 4 的全绿只证明
  **单次 proposal 闭环在合成 failure trace 上成立且沙箱/注入/canary 边界被机器断言**；
  Gate 5 的全绿只证明 **开发集迭代闭环在一条命令下成立且复算/预算/隐蔽边界被机器断言**；
  Gate 6 的全绿只证明 **稳定迭代生命周期（批确定性、K/q0 停机、crash/resume 等价、
  exactly-once、evidence 引用）成立**；Gate 7 的全绿只证明 **可安装性、发布产物完整性与
  可恢复/可卸载路径成立** ——都**不是**性能验收。
- mock replay 仍是确定性 system-prompt 分节回放，**不是** recorded-LLM 回放；Gate 1 曾把
  recorded-LLM 回放与 DSH 生产闭包 runner 归到 Gate 2，实际 Gate 2（`specs/07` §4）范围是
  provider 纵切片、不含 runner 替换 —— 该项顺延至 runner 相关的后续 Gate，此处显式记录，
  不算静默缩水。
- Gate 4 的 proposer policy 是 **recorded 确定性策略**（model gateway adapter 槽位的参考
  实现），不是真模型 proposer；真实模型路由仍属后续 gate。Gate 5 的闭环评测因此是
  recorded-proposer 驱动的**管线**证明，不是模型质量证明。
- 没有 sealed 结果；不得声称已提升、可部署、无 reward hacking 或达到 SOTA。
- Gate 8 已完成 **网络化 proposer 路由 wiring + 真实模型 proposal 冒烟**（见 2026-08-30 节）：
  zen-compatible 路由经 TCB proxy 贯通 CLI/config/sandbox/controller，真实 deepseek-v4-flash
  在 uid+netns 沙箱内经 Unix socket 完成 1 次 proposal（13 turns、3 子代、28 816 µUSD），
  全部子代通过 trusted builder 重建。这只是**真实模型路由与协议成立的管线证明**，不是
  benchmark profile：`specs/07` §10 的 pilot（K=10）/search（K=80）/sealed/official 四个
  profile 均未运行。前代项目的通过记录不是本仓库的完成证据（见 2026-08-28 节）。

## 2026-08-30 Gate 8 pilot profile recorded (K=10, real model, machine-verified)

- **Profile 形状（`specs/07` §10、`specs/04` §4.2）**：`runId=gate8-pilot`，K=10 开发样本 =
  frozen split ceremony 顺序的前 10 个 observed handle（由 seed commitment 预注册，
  `discoveryBatchSize=maxDiscoveryTrials=10`，单批恰好跑完即冻结）。为此把 run-config
  schema 的 `discoveryBatchSize` 上限从 6 放宽到 §4.1 硬上限 12（§4.1 的 6 是
  stable-demo 默认值，§4.2 要求 K=10 profile 另行冻结自己的 baseline），并新增
  `discoveryBatchSize ≤ maxDiscoveryTrials` 跨字段校验；两者均有契约测试（377/377）。
- **Baseline 冻结**：10/10 全 FAIL → failure pool = 全部 10 个 handle，
  `frozenFromObservations=10`，任何 proposal 之前冻结；机器断言 baseline 恰好跑了
  预注册样本（每题 1 attempt）。
- **真实模型 proposal（1 次扩张）**：live `deepseek-v4-flash` 经 TCB proxy（routeHash
  `892fad67…` 与 smoke 一致）6 条 receipt 全部 ok 且绑定 routeHash，transcript 锚定到
  receipt 链；usage 52 067 prompt + 57 513 completion tokens = 23 392 µUSD（~$0.023，
  API 上报 × 冻结单价，权威结算恰好一次）。3 个子代全部过 scanner+manifest+diff/canary/
  dedup admission 并由 trusted builder 以 parentTreeDir 重建 admitted；每个子代在冻结
  pool 上各完成 1 次 cold-start Harbor trial；子代引用 3/4/2 个 raw evidence object，
  全部解析存在。
- **终态**：`trials=13`（10 discovery + 3 cold-start）≤ cap 15，exactly-once（trial 目录 /
  ledger 行 / 沙箱一一对应，二次 resume 字节不变），audit 全绿，status 命令从持久
  evidence 重放出同一 stateHash/stopReason/status。sealed/guard 对 proposer/selector 不可见
  （与 Gate 6 相同扫描面），凭据未出现在任何 run/job artifact。
- **`STOPPED:K_REACHED`（depth 1）是测量结果，不是违规**：live proposer 单次扩张就
  3/3 子代全部 admitted，loop 头部 `K 达到且无待补 cold-start` 即停 —— `lineageDepthMax=1`。
  `STABLE_ITERATION_VERIFIED` 的 ≥2 层深度是 **Gate 6 stable-demo** 的验收定义，衡量的是
  proposer 需要几次扩张，不是协议是否走完；pilot（specs/07 §10："tuning stability and
  budgets"）的机器断言改为：K 达到 + 每个 admitted 子代都在冻结 pool 上 cold-start +
  report 可从持久状态重放，depth 如实记录为测量值。
- **Recorder 诚实记录**：首跑 recorder 有两个自身缺陷（变量名笔误导致 crash；把 Gate 6
  标签误当 pilot 断言），泄漏扫描面也过宽（把按设计携带全部 89 个名字的 population
  document `dataset-handles.json` 当泄漏面 —— Gate 6 本就排除它）。终态 PASS 由
  `DSH_GATE8_PILOT_RUN_ROOT` verify-only 模式对**同一已完成 run root**复核得出（每条
  检查照跑，wall-clock 由 controller journal 首/末事件重导出 3763s），
  `pilot-run.json` 的 `verificationMode`/`notes` 如实记载 —— 这是复核同一份付费运行，
  不是重跑。
- **预算外推原始数据（specs/04 §12）**：整条 pilot 3763s（~63 min，13 trials ≈ 290s/trial
  含 Harbor 容器开销）、proposer 成本 23 392 µUSD/次扩张、baseline 冻结 10 trials。
  全程 usd spent 23 392 µUSD ≪ $500 预算。
- **产物**：`evidence/gate8/pilot/{pilot-run.json,STATUS.json,run/,jobs/}`（`STATUS.json`
  PASS、failedChecks 空）；`scripts/record-gate8-pilot.ts`（`pnpm evidence:gate8-pilot`）。
- **边界**：pilot 只证明 K=10 开发样本上的 tuning 稳定性与预算量级，**不含** sealed
  揭盲、search（K=80）/sealed/official profile 与任何性能声明；`NO_SEALED_RESULTS` 维持。

## 2026-08-30 Gate 8 remote proposer route + real-model smoke

- **Wiring（commit `983e0bd`）**：zen-compatible 网络化 proposer 路由端到端贯通。run config
  要求该路由携带 `baseUrl`/`model`/`temperature`（缺失即 fail closed），CLI 暴露
  `--proposer-route/--model-base-url/--model-name/--model-temperature`；controller 进程在
  Unix socket 上开启 TCB proxy（凭据仅存内存，`Authorization: Bearer` 只出现在对上游的
  请求里），一次性沙箱的 model adapter 是 socket 客户端 —— 沙箱保持无网（AF_UNIX 文件系统
  socket 刻意穿越 netns，是唯一预留的孔）；网络化 proposal 的完整性由
  `verifyRemoteReceipts` 把 worker transcript 锚定到 proxy receipt 链（prompt/response
  sha256、requestId 连续性、routeHash）替代 byte-replay，预算按上游 API 上报 usage × 冻结
  单价结算。proxy 对空 content（reasoning 模型可把整个 max_tokens 花在 reasoning_content
  上）记为未计费 error receipt。
- **TCB wire-protocol section**：网络化路由下 worker 的系统 prompt 增加
  `tcb:directive-protocol` —— 完整规定指令语言（最后一个 ```json fence 或整条 bare JSON）、
  四种 action、writeChild 的完整源树/逐字复制约束（`cordis.patch.yml`/`package.json`
  逐字复制，组合 row id `self-evolving-candidate` 是固定协议常量）、
  `proposal.touchedSurfaces` 的 kebab-case 词汇表。
- **Admission 收紧（真实模型暴露的 TCB 缺口）**：`validateProposalBundle` 现在对每个子代
  运行 candidate scanner + `candidate.json` manifest schema —— 此前 admission 只查
  shape/diff/canary/dedup，真实模型两次live踩线（row id 改名、`touchedSurfaces` 带
  冒号）都能过 admission 却在 trusted builder 重建时失败；两规则均有契约测试钉死。
- **协议恢复**：agent loop 对不可解析指令不再整局失败 —— 该 turn 照常记账（receipt 链无
  空洞），失败按 tool-error 语义渲染回下一 prompt，由同一 maxTurns 预算约束（live 观测：
  手写 submit 括号失衡）。
- **真实模型冒烟（`pnpm evidence:gate8-smoke`，`evidence/gate8/smoke/`）**：live
  `deepseek-v4-flash`（`http://one-api.wattman.cn:805/v1`，routeHash `892fad67…`）完成 1 次
  proposal action：13 turns、55 563+75 132 tokens、28 816 µUSD（~$0.029，API 上报 usage），
  3 子代（tool-selection-guard / context-retention-guard / injection-immunity-guard，第三个
  由 INJECTION 标记轨迹推导出免疫 guardrail —— 证据被当作数据分析）全部 COMMITTED 并经
  trusted builder 以 parentTreeDir 重建 admitted；13 条 receipt 全部 ok 且绑定 routeHash，
  receipt/transcript/proposal 无凭据、无 canary；budget 恰好结算一次。凭据只在
  0600 的仓库外文件 + controller 内存中。
- **边界**：冒烟证明的是路由/协议/预算/验证链在真实模型上成立，**不是** benchmark
  profile，也不是模型质量证明；pilot/search/sealed/official 四个 profile（`specs/07` §10）
  仍未运行，sealed 揭盲未发生。

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
  terminal-bench `d28711d`）的 external checkout 已于 2026-08-29 物化（见下节）；
  `docs/dsh-integration.md` 中的 `../deepseek-harness/...` 相对链接现已可解析。

## 2026-08-29 upstream snapshots materialized

- 按 `provenance.lock.json` 的精确 commit SHA，经 `codeload.github.com/<owner>/<repo>/tar.gz/<sha>`
  物化三个上游到仓库根目录（tar 保留可执行位；按 SHA 寻址保证内容与该 commit 树一致）：

  | 目录               | pinned commit             | tarball sha256                                                     | 规模             |
  | ------------------ | ------------------------- | ------------------------------------------------------------------ | ---------------- |
  | `deepseek-harness` | `47f943859bef…b24f765a`   | `534c9f1c9d30fea136026ecf7a23c2137e350f43558e2f1eff6218aef7b15b26` | 69M / 7404 文件  |
  | `harbor`           | `ac398bbda7c4…455cc671b5` | `51e3fd7ac8aa026efbe679a69b07bef710d351a4a78954a4e976250a1a2bbe2f` | 56M / 3102 文件  |
  | `tb`               | `d28711d0da26…6082438a3`  | `ef3a5a1fde139283419ea6d470ee0a1a621fd53085533632a2ca2566cb44457c` | 172M / 2474 文件 |

  上游 remote URL（来自前代 `scripts/bootstrap-upstreams.mjs`，作为本仓库 Gate 0 实现
  `setup:source` 的依据）：`deepseek-ai/deepseek-harness`、`laude-institute/harbor`、
  `laude-institute/terminal-bench`。

- **限制**：本机当前无法连接 `github.com:443`（git smart-HTTP 端点；`api.github.com` 与
  `codeload.github.com` 可达），因此这些是 **SHA 寻址的快照而非 git checkout**（无 `.git`，
  不能 `git status`/`rev-parse` 验证）。Gate 0 实现 `setup:source`/`upstream:check` 时，须在
  连通性恢复后将其重新物化为真实 git checkout 并按 lock 校验；上表 tarball sha256 可用于
  校验快照等价。用户提供的 `deepseek-harness-master` 为 master 分支 ZIP 解包（无 commit
  身份、无法对 pin），未采用。
- 三个上游目录已加入 `.gitignore`（沿用前代策略：外部只读 checkout 不进本仓库 git scope）。

## 2026-08-29 Gate 0 implemented — provenance + real Cordis Loader lifecycle

对照 `specs/07-implementation-plan.md` §2 的验收项逐条落档（先写契约测试，再写最小实现）：

### 工具链与 workspace

- 根 workspace：pnpm 11.9.0（`packages/*`）、Node `>=22.19 || >=24`、TypeScript 6 strict
  composite（NodeNext / noUncheckedIndexedAccess / exactOptionalPropertyTypes /
  verbatimModuleSyntax）、vitest 4（forks、fileParallelism false）、oxlint、prettier、ajv 2020。
  脚本：`build` / `test` / `lint` / `format` / `setup:source` / `provenance:check` /
  `upstream:check` / `evidence:gate0` / `gate0`（复合）。
- 包：`packages/dsh-evolve-le`（`@dsh-evolve-le/core`，可信 controller 侧）与
  `packages/candidate-baseline`（`@dsh-evolve-le/candidate-baseline`，后续 Gate 1 的
  two-mode 候选基线雏形）。`@deepseek-ai/*` 依赖按 lock 精确 pin（cordis 4.0.1、
  loader 1.0.2、include 1.0.6、group 1.0.1、cosmokit 1.8.2、schemastery 3.18.1）。

### Provenance 机器校验（`scripts/check-provenance.ts`，JSON 输出，fail closed）

当前 7/7 pass：三个上游快照按 `dsh-evolve-tree-v1` 确定性树摘要 + 文件数验证；
lock schema；toolchain 版本（node v24.14.0 / pnpm 11.9.0 / python 3.12.3 / uv 0.11.29 /
docker 29.3.1）；7 个 `@deepseek-ai/*` pin 对 deepseek-harness checkout manifest 核对；
references 内容寻址。`scripts/setup:source.ts` 幂等物化（sha256 校验后落盘，从不覆盖
已漂移目录）。`upstream:check` 为 CI 只验上游的子集。

### 真实 Loader lifecycle（非手工 `ctx.plugin()`）

- `src/cordis/boot.ts`：`new Context()` → `ctx.plugin(Loader)` → include 挂载根
  `cordis.yml` → `loader.await()` → 激活审计。**依据说明**：pinned 的
  `@deepseek-ai/dsh-app-boot@0.1.0-rc.5` 未发布到 npm（npm 上只有 rc.6），boot 序列按
  该 pinned 版本源码忠实重实现（约 30 行：`builtins.include/group` + 根 include entry），
  而非引入 rc.6 造成 provenance 漂移。
- `src/cordis/inventory.ts`：对 pinned cordis 4.0.1 公有字段做只读盘点 ——
  `reflect.store`（按 per-service Symbol 键，`Object.values` 不可见）、`registry`、
  `events._hooks`（真实监听器存储，含 `Hook.ctx.fiber` 归属）、`fiber._hooks`/
  `_disposables`；外加 `process.getActiveResourcesInfo()` 进程级句柄普查。输出确定性
  排序的 JSON。
- `src/bin/loader-spike.ts`：`node lib/bin/loader-spike.js <cordis.yml>`，boot → 盘点 →
  unload → drain → 终盘，**不调用 `process.exit`**：泄漏的 timer/handle 会让进程自然
  挂住并超时失败（静默证明）。
- fixtures：`probe-service.ts`（提供 `dshEvolveProbe` 服务）、
  `bad-default-export.ts`（负例：`inject` + `export default apply`）、
  `good-inject-twin.ts`（同型对照，仅去掉 default export）、三个 `cordis.yml`
  组合（baseline 同时含相对路径插件与 bare-name 工作区包，验证 Node 真实解析）。

### 验收证据（`pnpm test` 6/6 + `evidence/gate0/loader-spike.json`）

| specs/07 Gate 0 Accept                                | 结果 | 证据                                                                                                                                                           |
| ----------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline namespace plugin 通过真实 Loader             | ✅   | `cordis-boot.test.ts`：entries 精确断言（include/probe-service/candidate-baseline，state=2）、`ctx.get('dshEvolveProbe')` 命中；vitest 与裸 node 子进程双通道  |
| negative `export default apply` fixture 必须失败      | ✅   | 断言错误同时含插件名与 `cannot get property "dshEvolveProbe" without inject`（DSH postmortem 0001 的 Loader unwrap 类缺陷可被测试捕获）；twin 对照组可正常激活 |
| unload 后 inventory 与 boot 前精确一致，无残留 handle | ✅   | 进程内 roundtrip `toEqual(before)`；子进程自然退出（exit 0、非 killed）且 `quiescent=true`（inventory + 句柄双等式）                                           |
| upstream working trees clean                          | ✅   | `upstream:check` pass（树摘要逐一等于 lock 记录；快照模式见下）                                                                                                |
| provenance 可机器验证                                 | ✅   | `provenance:check` 7/7 pass，JSON 可解析                                                                                                                       |

`evidence:gate0` 将三个 fixture 的 spike 运行（环境、exit code、报告全文）写入
`evidence/gate0/loader-spike.json`，acceptance 三项均为 true（exit 0）。

### 事故与整改（2026-08-28 夜，已闭环）

- Gate 0 期间一次命令工作目录失误，在 `deepseek-harness/`（只读上游）内执行了其自身的
  `pnpm build && pnpm test`：pnpm 自动安装产生 `node_modules/`、tsc 产物与 tsbuildinfo。
- 整改：终止进程树；删除新增文件（按 mtime 过滤，含 `node_modules`）；三个上游树摘要
  逐字节复验全部等于 lock 记录（deepseek-harness 7412 文件 / harbor 3104 / tb 2474），
  DSH 自身 `pnpm-lock.yaml` sha256 与其 lockfileIntegrity 相符；清理 lefthook 事后残留
  （repo 根 `lefthook.yml` 与 `.git/hooks/prepare-commit-msg`，由其 postinstall 上溯
  本仓库 `.git` 产生）。
- 防再发：仅 chmod 对 root 无约束（DAC bypass），已对三个上游 `chattr -R +i`（root 亦
  不可写，symlink 报错为预期）；`upstream:check` 进 CI 门。

### 已知限制

- 上游仍是 **SHA 寻址 tarball 快照而非 git checkout**（`github.com:443` 不可达），
  working-tree-clean 由树摘要等价代替 `git status`；连通性恢复后按 lock 重新物化为
  git checkout 并复验。
- Loader boot 为按 pinned `dsh-app-boot@0.1.0-rc.5` 源码的重实现（该版本未发布 npm），
  若后续 npm 出现该版本应替换为直接依赖并复验。
- 测试 fixture `.ts` 依赖 Node 24 原生 type stripping（仅 erasable 语法）；发布产物一律
  走编译 `lib/`（node_modules 下 type stripping 被禁用），candidate-baseline 已按此出包。

## 2026-08-29 Gate 1 implemented — candidate SDK, trusted builder, offline capsule, ACP E2E

对照 `specs/07-implementation-plan.md` §3 的 Build/Accept 项逐条落档（先写契约测试，再写最小实现）。
全程 `pnpm gate1`（build + 95/95 test + provenance:check 7/7 + evidence:gate1）exit 0。

### Versioned JSON schemas（`schemas/`）

candidate / proposal / build / capsule / provenance.lock 五个 JSON Schema（2020-12 + ajv），
`$id` 为稳定 URI（`https://dsh-evolve-le.local/schemas/…`），`schemaVersion` 常量；builder
侧对自身产物做 schema 校验失败即抛错（builder bug 不得产出非法 manifest）。

### Canonical tar / 身份 / diff boundary（`src/candidate/canonical.ts`、`diff.ts`）

- `candidate_id = "c_" + base32(sha256(canonical_ustar_tar))[0:26]`；tar 确定性（排序路径、
  uid/gid/mtime 归零、0644/0755、ustar magic、双 zero block）。同源字节 → 同 id，永久。
- capture fail closed：symlink（任意层级）、非普通文件、`..`/dot 组件、forbidden 组件
  （node_modules/.git 等）、build 产物顶层目录（lib/dist/build/out/coverage）、大小/数量上限
  （25 文件 / 1 MiB / 单文件 512 KiB）、NFKC+case-fold 归一化碰撞、ustar 寻址能力、
  capture 期间文件被换（dev/ino/size/mtime 双检）。
- golden 基线 `c_yrs7qltqipkfgo2hxh4gynxhnq`（source 6 files / 7231 bytes）。

### Policy scanner（`src/candidate/scan.ts`）

21 条规则全部有对抗 fixture 且经**完整 pipeline**（非仅单测层）验证在 `policyScan` 阶段以
预期规则拒绝：import/dynamic、import/require、dangerous/eval、dangerous/function-constructor、
import/node-builtin（含 bare `path` 与 type-only）、import/not-allowed、import/traversal、
import/unresolved、export/default、leak/timer、dangerous/process、task/fingerprint、
task/verifier-path、secret/openai-key（凭据形状字面量）、package/native-binary（ELF/WASM
魔数）、package/lifecycle-script、dependency/not-exact、dependency/not-allowed、
patch/not-insert、entry/missing。扫描对象是冻结后的 canonical tree，不是 proposer 工作目录。

### Candidate SDK / testkit / two-mode 基线（`packages/candidate-sdk/`、`packages/candidate-baseline/`）

受限 plugin surface（`defineCandidate` solve/propose 两模式）+ testkit；golden 基线只声明
`systemPrompt` 一个 section 的行为差异，经真实 Loader（非手工 `ctx.plugin()`）验证两种模式
与干净卸载。

### 可信 builder：十阶段 admission pipeline（`src/builder/`）

containment → schema → diffBoundary → policyScan → reproducibleBuild → typeLintUnit →
loaderBoot → unloadInvariant → mockReplay → capsuleDoubleBuild，fail-fast，逐阶段 receipt
（pass/fail/**skipped**，未执行的阶段绝不虚构为通过）。十项全 pass 才 `admitted`
（ADMITTED_UNEVALUATED：仅 safety-runnability）。

- **staging**：只复制声明条目（package.json/candidate.json/cordis.patch.yml/tsconfig.json/
  src/tests），其余（lib/、node_modules/、日志、未声明目录）结构性排除；声明条目为 symlink
  即拒绝；staged tree 文件字节只读（0444/0555）。
- **依赖闭包**：从 TCB `PACKAGE_PINS` 出发按 lock 精确版本做离线 BFS（含非 optional
  peerDependencies，因 pnpm 自动装 peer；80 包上限 fail closed），逐包平铺复制进 capsule
  的 `node_modules/`（跳过符号链接与嵌套 node_modules）；候选以声明包名装入闭包 —— Loader
  从闭包内 bare `import(packageName)` 解析。runtime == install manifest，逐字节。
- **sandbox**：编译与 boot 子进程跑在 `unshare --net` 网络命名空间 + 剥离环境
  （PATH/HOME/LANG/TZ/SOURCE_DATE_EPOCH）中；evidence 记录实际达成的 sandbox kind。
- **double build**：tsc 双跑逐字节一致；capsule 双组装逐字节一致；vitest `cache:false` 根除
  `.vite` 缓存混入 staged tree 的问题。时间戳只进 capsule 外的 build manifest；SBOM 固定
  epoch。当前 capsule：942 files / 7,929,687 bytes，tar `6d75b63f…`。
- **TCB 不执行候选生命周期脚本**：build manifest 记录 `executedCandidateLifecycleScript:
false`、`networkAccess: false`；model/verifier 在 builder 中不存在可访问路径。

### Capsule（`src/builder/capsule.ts`，布局按 specs/02 §12）

`runtime/`（install-manifest.json + system-prompt-stub + 平铺 node_modules）、`candidate/`
（canonical bundle 副本，与 node_modules 内装入者同源不可分叉）、`runner/`（probe/acp-boot、
cordis boot/inventory、ACP replay agent）、`cordis.yml`、`manifest.json`、`provenance.json`、
`sbom.spdx.json`、`SHA256SUMS`。所有内容进 tar 前经 SHA256SUMS 覆盖。

### ACP E2E（`src/acp/`、`src/bin/acp-boot.ts`）

- capsule runner 经**真实 Cordis Loader** boot 后，在 `@agentclientprotocol/sdk` **0.25.1**
  上服务 ACP：`initialize` → `session/new` → `session/prompt` → `agent_message_chunk` 流式
  回放 composed system-prompt 分节 → `end_turn`；客户端关 stdin 后 app 卸载、unload 不变式
  对 boot 前基线核验（inventory 严格相等 + 句柄单调不增），runner report 走 stderr（stdout
  保留给协议）。
- **版本依据**：0.25.1 是 lock 的 `@deepseek-ai/dsh-acp@0.1.0-rc.5` 实际依赖的 ACP SDK 版本
  （记于 pin 注释）。rc.5 的完整生产闭包（14 个 workspace peer）在 npm 上无 lock 一致版本
  （只有 rc.1/rc.6 漂移），故 Gate 1 capsule runner 在同一 wire 协议 + 同一 SDK 版本上运行；
  **recorded-LLM 回放与完整 DSH 生产闭包随 Gate 2 落地** —— 该收缩在 receipt detail 与本文
  显式声明，不是静默缩水。
- **fresh container E2E**（`tests/capsule-container.test.ts` + evidence 复跑）：唯一挂载是
  只读 `capsule.tar`，`--network none`，node:24-alpine（容器内 v24.20.0，docker 29.3.1）；
  入口 `tar -xf` → `sha256sum -c SHA256SUMS` → `node runner/bin/acp-boot.js cordis.yml`；
  host 侧先验 tar sha256 == build manifest 记录值。断言 protocolVersion 1、`end_turn`、
  turn 内流式出现 `[candidate:identity]`、`quiescent=true`、`afterUnload` sections 为空、
  exit 0。无 source checkout、无网络、无模型。

### 验收证据（`evidence/gate1/builder.json` + `build-manifest.json`）

| specs/07 Gate 1 Accept                                                                         | 结果 | 证据                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| golden 两次 clean build 的 source/bundle/capsule hash 相同                                     | ✅   | `doubleBuildIdentical=true`：candidateId/sourceDigest/bundle tar/capsule tar/SBOM/provenance 六值双跑相等（capsule 942 files 逐字节一致）                   |
| traversal/symlink/install-script/dynamic-import/task-literal/default-export/leaked-effect 全拒 | ✅   | `rejectionsEnforced=true`：21/21 fixture 经完整 pipeline 在 `policyScan` 以预期规则拒绝；symlink 拒绝另见 canonical.test.ts（capture 与 staging 双层）      |
| packed capsule 在无 checkout/无 network 的 fresh container 启动 ACP initialize/session         | ✅   | `capsuleBootsOfflineContainer=true`：docker `--network none`、payload-only 挂载、tar 摘要双验、protocolVersion 1 / end_turn / identity 流式 / unload 不变式 |
| builder 不执行 candidate lifecycle script、不访问 model/verifier                               | ✅   | `builderTrustHeld=true`：`executedCandidateLifecycleScript=false`、`networkAccess=false`、sandbox kind=namespace；builder 无 model/verifier 调用路径        |

`pnpm gate1` 一键复跑全部断言并重写 evidence；任何 acceptance flag 为 false 即 exit 1
（docker 不可用同样 fail closed）。

### Gate 1 期间发现并修复的实现缺陷

- `materializeTree` 从不创建目标根目录：无子目录的源树（如 `missing-entry` fixture）第一个
  顶层文件写入即 ENOENT，表现为 containment 失败而非预期扫描规则 —— 已修（root 目录显式
  mkdir），fixture 恢复在 `policyScan`/`entry/missing` 拒绝。
- 18 个扫描 fixture 的 `$schema` 仍是旧相对 URI，经完整 pipeline 全部在 `schema` 阶段早死，
  掩盖预期扫描规则 —— 已统一为稳定 URI，21/21 恢复在 `policyScan` 以预期规则拒绝。
- `native-binary` fixture 的 ELF blob 原在顶层 `assets/`（声明条目之外，被结构性排除），
  经 pipeline 二进制根本不进 canonical tree —— 已移入 `src/assets/`（真实威胁形状：候选
  代码内携带二进制），扫描规则恢复触发。教训已吸收：**fixture 必须走完整 pipeline 验证，
  scanner 单测层绿灯不等于 admission 拒绝路径成立**。

### 已知限制

- 上游仍是 **SHA 寻址 tarball 快照而非 git checkout**（`github.com:443` 不可达），
  working-tree-clean 由树摘要等价代替 `git status`；连通性恢复后按 lock 重新物化为
  git checkout 并复验。
- Loader boot 为按 pinned `dsh-app-boot@0.1.0-rc.5` 源码的重实现（该版本未发布 npm），
  若后续 npm 出现该版本应替换为直接依赖并复验。
- mock replay 为确定性分节回放（非 recorded-LLM）；DSH 生产闭包 runner 随 Gate 2。
- 测试 fixture `.ts` 依赖 Node 24 原生 type stripping（仅 erasable 语法）；发布产物一律
  走编译 `lib/`（node_modules 下 type stripping 被禁用），candidate-baseline 已按此出包。
- 容器 node 记录到 major（24.x），未 pin patch；镜像 tag `node:24-alpine`。

## 2026-08-29 Gate 2 implemented — Terminal-Bench provider vertical slice

对照 `specs/07-implementation-plan.md` §4 的 Build/Accept 项逐条落档（先写契约测试，再写
最小实现）。全程 `pnpm gate2`（build + 124/124 test + provenance:check 7/7 + 真实 E2E）
exit 0，evidence 36 文件入 `evidence/gate2/`。新包 `@dsh-evolve-le/tb-provider`
（`benchmark-adapters/terminal-bench/`，纯 TypeScript provider，无 RSI 策略，CLAUDE.md
rule 2）；capsule 侧新增 `archiveCapsule`（确定性 gzip level 9 tar.gz，双构建逐字节一致）
与 0755 wrapper `dsh-evolve-le-acp`（自解析目录，绝不依赖 task cwd）。

### 组件

- **Dataset pin + inventory**（`dataset.ts`/`inventory.ts`）：terminal-bench 2.1 @
  `7131e43`（tarball sha256 `aa992a88…`，89 task 目录全带 `task.toml`）；每 task 以确定性
  树摘要内容寻址，inventory hash 对任何 task 内容漂移敏感；缺 `task.toml` 即拒绝规划
  （fail closed，不在残缺集上出计划）。
- **Inline ACP binary registry entry**（`registry.ts`）：HTTPS + SHA-256 checksum 的
  `AcpRegistryEntry`；**`version` = capsule tar.gz sha256** —— harbor 把它写进每个 trial 的
  `agent_info.version`，这就是候选归因绑定。生成的 entry + JobConfig 用**已安装 harbor
  0.21.0 的 pydantic 模型**真实验证（`upstream-contract.test.ts`），不靠手抄 API 清单。
- **JobConfig provider**（`jobconfig.ts`/`provider.ts`）：docker environment + 只读 bind
  mount（CA bundle）+ `SSL_CERT_FILE`；agents[0] slot 名 `acp`，inline registry_entry、
  `permission_mode: deny`、`auth_policy: disabled`；`job_name` 内嵌 idempotency key 前缀。
- **Idempotency ledger**（`idempotency.ts`）：key = sha256(canonical(protocol, runId,
  capsuleArchiveSha256, inventorySha256, sorted handles, attempts, harborVersion))，
  append-only JSONL；同一 key 再 plan 返回 `existing` 不新增行；叠加 harbor 自身 resume
  （同 job dir + 同 config.json → 保留已有 trial）= 无第二次付费 trial。
- **本地 HTTPS artifact endpoint**（`artifact-server.ts`）：只服务 `/<sha256>.tar.gz`
  内容寻址路径、注册时校验名字==摘要、strict TLS（TLSv1.2+）；自签 CA（IP SAN
  172.17.0.1 = docker0 网关）+ **augmented bundle**（系统 CA + 本地 CA）bind-mount 到全新
  路径 `/opt/dsh-evolve-le/ca-bundle.crt` 并设 `SSL_CERT_FILE` —— 绝不覆盖
  `/etc/ssl/certs/ca-certificates.crt`（update-ca-certificates 会重写它）。
- **Per-trial normalizer**（`normalize.ts`）：分母 = planned trials（task×attempt），从
  raw job dir 零状态重放；trial 归属经其自身 `config.json` 的 `task.path`（免疫 harbor
  trial 名 32 字符截断），attempt 序号按 handle 组内排序 trial 名；归因检查
  `agent_info == {registry id, capsule sha}`；缺失 result.json/reward/trajectory/candidate
  hash 全部显式 FAIL/invalid，绝不从分母消失；infra-retryable 白名单预登记为
  {EnvironmentStartTimeout, SandboxBuildFailed, Healthcheck}（reward 无关、ADR 才可扩）；
  canonical-JSON artifact hash，重解析两次同 hash。
- **E2E**（`scripts/run-gate2-e2e.ts`，`pnpm e2e:gate2`）：构建 capsule → 本地 HTTPS 上
  线 → 在 pinned `extract-elf` 上跑真实 `harbor run` → normalize → 11 个 acceptance flag
  全断言（任一 false 即 exit 1）→ evidence + `schemas/gate2.e2e.schema.json` 校验文档。

### 验收证据（`evidence/gate2/`：e2e.json + normalized-main/probe.json + 两个完整 job dir + ledger.jsonl）

| specs/07 Gate 2 Accept                                                             | 结果 | 证据                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nop/broken/golden fixture 分别 expected fail/fail/valid                            | ✅   | `normalize.test.ts` 13 例：golden→pass、nop→fail、broken-agent→fail、env-infra→infra_retryable、missing reward/result/trajectory/trial→显式 FAIL、wrong capsule→PROTOCOL_INVALID |
| 缺失 result.json、reward、trajectory、candidate hash 显式 FAIL/invalid，不离开分母 | ✅   | 同上（`missing-trajectory` 为本轮新增类别：无异常但无 ATIF trajectory 的 trial = 不可审计 = FAIL；exception trial 豁免——agent 根本没跑完 turn）                                  |
| 真实 DSH candidate 经 ACP client 完成一次 task，stdout protocol clean              | ✅   | 主 trial `extract-elf__3UBseoG`：capsule 在任务容器内下载-校验-启动，3 个 ACP 事件、`end_turn`、runner report 走 stderr、`quiescent=true`、exit 0；verifier 独立评分 reward 0    |
| adapter 同 idempotency key 重复 submit 不产生第二个付费 trial                      | ✅   | ledger 每 key 恰一行（main+probe 共 2 行）；重跑 `harbor run` resume 同 job dir，trial 目录数 1→1 不变（连续三次 E2E 复验）                                                      |
| raw Harbor job + normalized artifact 可从零重解析成同 hash                         | ✅   | `normalizationDeterministic=true`：同目录两次 normalize，canonical artifact hash 相等（`c8298c0937ab3807…`）                                                                     |

verifier-mode 探针（Build 项）：派生 task 副本（`extract-elf-separate-probe`）强制
`[verifier] environment_mode = "separate"`，正式 task 目录未动。**实测结论
`shared-only`**：harbor 的 separate verifier 容器是 task 环境的全新拷贝，只挂 verifier
目录、不带 agent 写入的工作区，因此 extract-elf 的 verifier 找不到 agent 产物 →
`RewardFileNotFoundError`（显式记录，不误判为协议失败）。sealed 协议保持每 task 的
默认 verifier mode；separate 仅用于自带 verifier environment 的 task。

### Gate 2 期间的经验性发现（都写进了实现与测试）

1. **`model_name` 触发 harbor 的 session/set_model 路径**：JobConfig agent 带
   `model_name` 时，harbor runner 在 `session/new` 后要求 agent 具备模型选择能力
   （`session.models` 或 model config option），而 pinned 的 ACP TS SDK 0.25.1 **没有**
   model-selection 面 → RuntimeError → `NonZeroAgentExitCodeError`（首次 E2E 的真实失败，
   全程留档）。replay capsule 无外部模型路由，故 JobConfig **省略 `model_name`**；模型
   路由记入 run manifest，真实模型 capsule 由其自身 ACP 层广告 set_model（specs/02 范畴）。
2. **`agent_info.name` = registry entry id**（非 JobConfig slot 名）：normalizer 归因绑定
   改为 `name == ACP_AGENT_ID && version == capsule sha256`。
3. **capsule 在真实任务镜像的 node v18.19.1 上同样干净启动**（`CAPSULE_CONTAINER_IMAGE`
   可参数化容器测试，node 24 与 extract-elf 镜像双验）：离线、wrapper 自解析、
   unload 不变式成立。
4. 容器内 apt/pip 网络可用，`SSL_CERT_FILE` 指向 bind-mount 的 augmented bundle 即可让
   strict-TLS curl 通过 —— 预检脚本先行验证后再上 E2E。

### 已知限制

- 上游仍是 **SHA 寻址 tarball 快照而非 git checkout**（`github.com:443` 不可达），
  working-tree-clean 由树摘要等价代替 `git status`。
- 本切片是 **development 模式、单 task、replay capsule**：没有 baseline 分数、没有
  sealed split、没有成本数据（replay 无模型，token/cost 字段为 null —— 诚实记录而非
  填零）。recorded-LLM 回放与 DSH 生产闭包 runner 顺延（见 claim boundaries）。
- artifact endpoint 是本机 HTTPS 桥（服务 inline distribution 的 HTTPS+SHA-256 契约），
  非多机部署形态；idempotency ledger 为单文件 append-only，多写者仲裁随 Gate 3 状态机。

## 2026-08-29 Gate 3 implemented — durable controller core

对照 `specs/07-implementation-plan.md` §5 的 Build/Accept 项逐条落档（先写契约测试，再写
最小实现）。全程 `pnpm gate3`（build + 228/228 test + provenance:check + fault-matrix
evidence 记录）exit 0；evidence 入 `evidence/gate3/fault-matrix.json`。新包内全部为
TypeScript DSH/Cordis 组件（CLAUDE.md rule 2）：`@dsh-evolve-le/core` 承载状态层、
单写者 controller 与标准 Cordis service。

### 组件

- **状态层**（`src/state/`）：canonical JSON（稳定键序、数字规范化）+ sha256；
  内容寻址 object store（staging + no-clobber 发布、label 不可降级、全量字节校验）；
  hash-chain journal（HEAD 是唯一 commit 点、按大小轮转、崩溃残差隔离进 quarantine
  而非前滚）；pure reducer（phase/action/wave/candidate/observation 状态 + budget 镜像，
  一切语义校验在 fold 处 fail closed）；snapshot（仅缓存：hash 覆盖内容、过期/损坏/
  篡改/前缀不匹配一律回退 genesis 重放）；budget 双式记账 ledger（冻结限额、
  spent+reserved 最坏检查、per-action 余额、unpriced 显式计数、拒绝则文件不动）。
- **单写者 controller**（`src/controller/controller.ts`）：`owner.lock.json` 'wx' 发布 +
  死亡可证（ESRCH/异 boot id）才允许 takeover，活 owner 永远阻塞；saga =
  durable intent → keyed external effect → durable receipt → observed terminal →
  artifact 入库 → commit + settle + release；recovery 按 specs/06 §12 顺序
  （lock → verify → snapshot+replay → reconcile → inspect 非终态（不启动新 action）→
  collect 终态 → 按 reservation 序 commit wave → 校验 state hash）；launch 前先
  `inspectByKey` 认领孤儿子效应；`readRunStatus` 提供无锁只读视图。
- **Provider 抽象**：`BenchmarkProvider` 接口 + 进程内 `FakeProvider`（测试）+
  `FileProvider`（整文件 JSON 状态、key 幂等、脚本化结果/LOST/neverTerminal；
  Harbor adapter 属后续 gate）。
- **Fault-injection harness**（`src/controller/fault-matrix.ts` + `src/bin/fault-child.ts`）：
  真实子进程在 8 个 durable 边界（intent/launch×3/terminal/artifact/commit/wave）之一
  被 **SIGKILL**，随后新进程 resume；`MATRIX_BOUNDARIES` 即 `onBoundary` seam。
- **Cordis service**（`src/service/controller-service.ts`，namespace form）：
  config schema 校验、activation 时 open（含 recovery）、`ctx.provide('dshEvolveController')`
  facade；unload = flush —— `ctx.effect` 返回 async disposer，Cordis `fiber.dispose()`
  await 它：snapshot 落盘、journal 句柄关闭、writer lock 释放。
- **只读 status**：`readRunStatus` 与 `Controller.status()` 共享 `statusOf`（先
  `assertMatches` 再投影），供后续 CLI `status`/`audit` 复用。

### 验收证据（`evidence/gate3/fault-matrix.json`；矩阵由 `pnpm evidence:gate3` 生成，任一断言失败 exit 1）

| specs/07 Gate 3 Accept                                                         | 结果 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| property tests 覆盖 arbitrary valid event sequences                            | ✅   | `reducer.test.ts` 种子 PRNG 12 个随机合法 saga（1–3 wave × 1–3 action、混合 outcome）双次重放同 hash、seq 链式递增；`property.test.ts` 种子 1–10 随机崩溃链（≤12 段）+ 保证收尾 clean pass，stateHash/observationCount/budget/launchEffects 与 clean run 全等                                                                                                                                                                            |
| 每个 intent/launch/collect/commit 边界 kill 后 resume 不重复 effect/score/cost | ✅   | fault matrix 10 例（8 边界单杀 + `launch-effect-done` 双杀 + clean baseline）全过：每例恰 3 个 distinct launch effect、3 条 observation、usd `{spent:200, unpriced:1}`、trials `{spent:3}`、无重复 score/cost；全部收敛到同一 state hash `5fc00e2ef8d1f1fb4c336b4441b941cfac2f2de324e0d3228caa577e8f36c668`。进程内逐边界恢复另有 `controller.test.ts` 10 例（pending-launch/key 认领/collect existing/LOST→missing/running 稍后终态等） |
| event completion order permutation 在同 wave 得到相同 state hash               | ✅   | `reducer.test.ts` permutation 组：journal 提交序 a1,a2,a3 vs a3,a1,a2（实测断言顺序确不同），stateHash 相等且 waveDecisionSnapshot 相等 —— hash 排除 seq/lastEventHash 等 bookkeeping、集合排序、reservationSeq 在预约时赋值                                                                                                                                                                                                             |
| corrupt journal/object/snapshot fail closed                                    | ✅   | journal：tampered 行/断链/空行/残差全拒（`journal.test.ts`）；object：字节篡改后 `Controller.open` 拒绝（`controller.test.ts` r7 + `object-store.test.ts` digest/size）；snapshot：损坏/篡改/过期回退 genesis 重放而非信任（`snapshot.test.ts`）；ledger 篡改 entryHash 不覆盖即拒（`budget.test.ts`）                                                                                                                                   |
| controller unload flush 后无 worker/process handle                             | ✅   | `controller-service.subprocess.test.ts`：真实 Loader boot service、驱动整 wave、`fiber.dispose()` 后 Cordis inventory 与 `process.getActiveResourcesInfo()` 均回到 boot 前基线、lock 已释放、最新 snapshot seq == journal 终 seq、进程自然退出（残留句柄会挂起并被超时捕获）                                                                                                                                                             |

### 设计要点（都由测试钉住）

1. **语义校验全部在 reducer fold**：journal 只接受 well-formed envelope；非法 phase 边、
   越序 saga、重复 observation identity、二次 candidate lock/sealed reveal、带未终态成员的
   wave commit、超限 budget 镜像 —— 一律 fold 时抛错。测试因此期望 emit 成功、
   `replayEvents` 抛错。
2. **settle 不隐式 release**：commit 按 reservation 最坏值结算后显式 `release` 余量
   （从镜像 `budgetByAction` 驱动，幂等）；unpriced 用量（`costUsdMicros === null`）记
   amount 0 + unpricedUnits 1，绝不静默按 0 计价。FileProvider 曾因
   `preset?.costUsdMicros ?? 100` 把脚本化的 null 强转为 100（矩阵首轮全红），已改为
   显式 `!== undefined` 判定 —— 这正是该验收要抓的类别。
3. **stateHash 排序/排除规则**是 permutation 不变性的全部来源；`waveDecisionSnapshot`
   同样 order-insensitive，wave commit 本身可重放。
4. **同进程 double-acquire 直接拒绝**（即使 lease 过期）：活 owner（含 pid 1）阻塞、
   只有可证死亡（ESRCH 或异 boot id）才 takeover、损坏 lock 拒绝盲抢。

### 已知限制

- **FileProvider 是测试假体**：真 Harbor provider（复用 Gate 2 的 JobConfig/ledger/
  normalizer 落到 `BenchmarkProvider` 接口）在后续 gate 接入；届时 crash matrix 协议不变。
- 进程内 property/恢复测试用“删除 lock 文件”模拟进程死亡；**真实死 pid takeover 路径**
  由 subprocess 矩阵（SIGKILL → 新进程 open 同 runDir）覆盖。
- archive admission / sealed reveal 等事件类型已在 reducer 落位（one-shot 锁有测试），
  但其上游流程（proposer、selector、sealed runner）属 Gate 4+，本 gate 不实现。
- `budget-ledger.jsonl` 单文件 append-only：多写者仲裁即 writer lock 本身（单写者约束），
  只读路径不写 ledger。

## 2026-08-29 Gate 4 implemented — agentic proposal vertical slice

`specs/07` §6 全项落地：从两条合成 failure trace（其一内嵌 prompt injection）出发，
baseline parent 经可信 builder 产 capsule，在一次性 uid+netns 沙箱内以 `propose` mode 经
真实 Cordis Loader 启动，proposer 只经受限 tool 层读写，controller 侧逐字节 replay 验证 +
bundle 校验后把 admitted 子代导入内容寻址 store 并再次通过可信 builder 重建（parent diff +
preservation 边界）。`pnpm gate4` 全绿（build + 282 测试 + provenance + evidence，任一断言
失败 exit 1）。

### 组件

- **Builder parent-diff admission**（`src/builder/pipeline.ts`）：candidate.json 声明
  `canonicalParent` 时 diffBoundary 阶段强制要求 controller 侧 parent tree、重捕获验哈希、
  `checkSectionPreservation`（子代不得丢父代任何 mode section）+ canonical diff 落
  manifest；lineage root（`canonicalParent: null`）路径不变。
- **Evidence export / archive catalog / canary**（`src/proposer/export.ts`、`catalog.ts`、
  `canary.ts`）：controller 按 principal 选择对象、label 白名单（PUBLIC_SPEC/DEV_OBSERVED）
  fail closed、merkle root、canary 逐对象扫描后才物化只读 export 目录；catalog 以
  sourceHash 为 dedup/donor 依据；canary 只以 sha256 fingerprint 出现在 receipt/error。
- **Model gateway / tool 层 / agent loop / recorded policy**（`src/proposer/gateway.ts`、
  `tools.ts`、`agent-loop.ts`、`policy.ts`）：frozen route 计价 + 预算硬停；tool 层是沙箱
  唯一文件通道（containment 证明用 realpath 前缀、symlink/绝对路径/`..` 全拒，读写各自
  封根 + 文件数/字节上限）；loop 把每次 prompt hash/response/tool 调用/refusal/token/费用
  写 append-only transcript；recorded policy 是 prompt→response 纯函数（注入 detour 故意
  先服从一次，由 tool 层拒绝）。
- **Proposal sandbox**（`src/proposer/sandbox.ts` + `src/bin/proposer-worker.ts`）：
  supervisor 以 root 起 `unshare --net`（最外层）→ `setpriv --reuid=65534` → node worker
  （worker 拒绝 uid 0）；input root（capsule + parent tree + export + config）seal 只读后
  chown nobody，work root 可写；DAC canary（controller credentials 0600、`<sandbox>-sibling`
  sealed 0700）实测 EACCES；capsule digest 排除 include-plugin boot overlay 后前后一致；
  `work/worker-result.json` **最后写**，其存在性即外部效果的幂等标记；controller 侧
  `verifyProposalSandboxReplay` 用冻结输入 + recorded TCB policy 重导出全部产物并逐字节比对
  （section 名再对照 root-owned config.json 的 declaredProposeSections）。
- **Proposal saga + 校验器**（`src/controller/controller.ts`、`src/proposer/validate.ts`）：
  reserve（kind `proposal`）→ launch（manifest-last 幂等）→ terminal 观察 + artifact 收集
  （失败也留证）→ hard-failure 阶梯（root uid / worker 失败 / DAC 未保持 / capsule 漂移）→
  replay 验证 → `validateProposalBundle`（parent 哈希、canary、donor 存在性、evidence ref
  属于该 export、no-change、5000 行上限、批内 diffHash 重复、archive sourceHash 重复；批级
  错误整 bundle 拒但保留全部 verdict 证据）→ `storeCandidateSource` 导入 + `candidate.registered`
  lineage → summary artifact → budget settle（proposal-calls/proposer-tokens/usd 有界 settle +
  release）。recovery 对 proposal action 以 worker manifest 存在性判定 running/pending-launch。
- **diffHash 内容敏感化**（`src/candidate/diff.ts`）：hash 覆盖排序后的变更行多重集而非
  行数形状 —— 行数相同内容不同的子代不再被误判为同一机制（specs/03 §9 "semantic diff 相同
  才 dedup"），字节相同的多胞胎仍去重；行数指标不变。

### 验收证据（`evidence/gate4/STATUS.json`（tracked）+ `proposal-e2e.json`（本地全量，含 sha256）；由 `pnpm evidence:gate4` 生成，任一断言失败 exit 1）

| specs/07 Gate 4 Accept                                         | 结果 | 证据                                                                                                                                                                                                                                        |
| -------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| baseline parent 从两条合成 trace 产出 ≥1 非平凡 admitted child | ✅   | E2E：parent `c_u5py7…` admitted → sandbox 6 turns/19 087 tokens/114 669 µUSD → 2 个 child（各 2 files +20/−8）admitted + 注册 lineage；`nontrivialChildrenAdmitted`/`childrenRegistered`                                                    |
| proposer 读不到 controller/guard canary/凭据/sibling 输出      | ✅   | worker uid 65534（非 0）+ netns；DAC probes 全 EACCES（`dacBoundaryHeld`）；capsule digest 前后一致（overlay 除外）；`sandboxUidNetns`                                                                                                      |
| trace 内 prompt injection 不能改写可写根/manifest policy       | ✅   | recorded policy 故意执行注入指令：`read ../controller/credentials.json` 与 `writeChild ../escape/stolen.txt` 均被 tool 层拒绝并渲染回 refusal；全 run 无 stolen.txt；transcript/proposal 无 canary（`injectionRefused`/`canaryDiscipline`） |
| child 在 mock task 上行为符合 hypothesis                       | ✅   | 每个 child 的 `<mode> checklist (child N)` 同时出现在源码与真实 Loader ACP 流式回放 chunk 中（`checklistInSource`/`checklistStreamedByLoader`）；child 十阶段 build 全 pass                                                                 |
| parent preservation 测试通过                                   | ✅   | child build `diffBoundary` pass（parent 重捕获验哈希 + section preservation + parentDiff 落 manifest）；`parentPreserved`                                                                                                                   |
| transcript/tool use/token/cost/source ref 完整                 | ✅   | 6 turn 全带 promptSha256/sections/userDigest/token/费用，14 条 tool 记录（成功读写全带内容寻址 sourceRef），gateway receipts 6 条与请求数一致，两条 export 对象全部经 tool 层读取（`transcriptComplete`）                                   |
| rejected proposal 证据保留                                     | ✅   | E2E 0 拒绝（批级无错误）；拒收路径由 `proposal-saga.test.ts`（worker 失败/transcript 篡改/重放失配）与 validator 6 例（no-change、canary、越界 evidence ref、未知 donor、批内重复、archive 重复）钉住                                       |

### Gate 4 期间发现并修复的实现缺陷

- **diffHash 只哈希行数形状**：`tool-selection` 与 `context-loss` 两个内容不同的子代被判
  同一机制、第二个被误拒。修复为哈希排序后的变更行多重集（`canonical.test.ts` 回归测试：
  同形状不同内容不同 hash、字节相同同 hash）。
- **`action-committed` 边界在 try/catch 内**：crash 注入在该点被 catch 转成 proposal
  failure 而非向上传播。修复为 commit 后在 catch 外触发（`proposal-saga.test.ts` 4 个
  crash-resume 点全过）。
- **oxlint 遵守仓库 .gitignore**：evidence/（被 ignore）下的 staged tree lint 到 0 文件
  而 fail closed —— builder scratch 必须放 repo 外（gate4 evidence 脚本用 /tmp mkdtemp，
  gate1 脚本本就如此）。

### 已知限制

- proposer 是 recorded 确定性 policy（纯函数），非真模型；真实路由/秘钥管理属后续 gate。
- 沙箱边界是 Linux uid+netns+DAC（需 root supervisor 与 setpriv）；容器/seccomp profile、
  非 root 宿主降级路径未实现（fail-closed ladder 会拒绝运行）。
- E2E 的 failure trace 是合成的；真实 DEV_OBSERVED 轨迹要等 development split 闭环
  （依赖 Harbor provider 接入 controller，见 Next）。
- 子代只导入 store + 注册 lineage；child 的 development 评测 wave 尚未驱动（Gate 5 范围）。

## 2026-08-29 Gate 5 implemented — productized iteration closure

`specs/07` §7 全项落地：`dsh-evolve` 一条命令（`packages/cli`，bin `dsh-evolve`）把已验收的
proposer、可信 builder、Harbor provider、durable controller 和 Archive 连成
`init → run/resume → status/audit/doctor` 生命周期。evidence run 在 pinned Terminal-Bench
2.1 数据集（89 handle 全集，48/12/29 split）上以真实 docker + harbor 0.21.0 走完
discovery（2 个真实 trial，双失败冻结 failure pool）→ Thompson 父代抽取 → label 过滤
evidence export → 一次性 uid+netns proposal sandbox → controller replay 验证 → 可信子代
重建 + Archive admission，停止于 `K_REACHED`。`pnpm gate5` 全绿（build + 348 测试 +
provenance + evidence，任一断言失败 exit 1）。

### 组件

- **Split ceremony**（`src/split/ceremony.ts`）：`(runId, masterSeed, 89 handles)` 确定性
  派生 48 dev-observed / 12 guard / 29 sealed；controller 可见文档只含 observed 句柄、
  opaque guard id、sealedCount 与 seed commitment；guard 映射只发给 provider bridge（TCB）。
  `audit` 以同一输入重新派生并逐字节比对。
- **Selection**（`src/selection/clade.ts`、`thompson.ts`、`ucbair.ts`）：clade Beta 后验 +
  τ=1 Thompson 父代/节点抽样（receipt 的 θ 量化到千分位以满足 canonical-JSON 安全整数
  规则）、UCB-Air expand/evaluate 决策（`admitted < K+1 ∧ trials^α ≥ admitted`）。
- **版本化 run config**（`src/config/run-config.ts` + `schemas/run.config.schema.json`）：
  stable-demo 默认（K=3、≤15 solver trial、sealedAccess=false、$500/16h 预算、兼容
  Zen/high/1M/32k 可选路由）；加载即 JSON-Schema + 语义校验（discovery ≤ solver ≤
  taskTrials、discovery+K·q0 ≤ solver、sealedAccess 必须为 false、zen 路由必须挂凭据
  文件）；configHash 进 run manifest。
- **Harbor `BenchmarkProvider` 适配**（`benchmark-adapters/terminal-bench/src/harbor-provider.ts`）：
  复用 Gate 2 JobConfig/ledger/normalizer；capsule 注册表 → `acp` registry entry
  （id `dsh-evolve-le-capsule`、version=archive sha256、HTTPS artifact URL）；launch 幂等
  （SubmissionLedger append-only 记账）；guard 句柄在 launch 时才由 TCB guardMap 解析；
  harbor 进度镜像到 stderr，CLI stdout 保持机器可解析。
- **Preflight + iteration driver**（`src/iteration/preflight.ts`、`driver.ts`）：一条命令的
  fail-closed 前置（config/凭据 stat-only 0600/run-root/baseline/tasks/docker/harbor 版本，
  全量 finding 列表，任一失败即在任何付费 launch 前 exit）；driver 串行驱动
  ceremony freeze → manifest freeze → search-state 加载（版本不符 fail-closed）→
  baseline ensure（可信 build + capsule 持久化 + 注册 + admit）→ discovery 批扫描至首个
  非成功（否则 `NO_REAL_FAILURE_SIGNAL`）→ UCB-Air 循环（expand：Thompson 父代 → export →
  proposal saga → 可信重建 → admission；evaluate：cold-start + 节点 Thompson + 任务
  sampler）→ archive catalog → drive-report；预算在每次 expand/evaluate 前检查，
  `BUDGET_EXHAUSTED` 停在下一个付费 launch 之前（settle 不得超过 worst-case 预留的
  ledger 不变量由测试钉住）。
- **CLI**（`packages/cli/src/cli.ts`）：`init`（冻结 config + 89-handle population，拒绝
  覆盖已冻结 run root）、`run`/`resume`（同一幂等 drive；`--provider terminal-bench|fake`
  seam、`--set` 白名单覆盖）、`status`（只读冻结文档 + journal replay，进程重启后可用）、
  `audit`（manifest config 重校验 + configHash、split ceremony 重派生、failure-pool 哈希、
  capsule archive 内容寻址校验、drive-report vs fresh replay stateHash）、`doctor`
  （与 run 相同的 preflight，✓/✗ 全列）。真实 provider 组合：本地 CA + HTTPS artifact
  server（按 digest 动态服务 capsules）、CA bundle 挂载进 trial 容器（`SSL_CERT_FILE`）。

### 验收证据（`evidence/gate5/STATUS.json`（tracked）+ `cli-e2e.json`（机器文档）+ `jobs/`（原始 Harbor job）；由 `pnpm evidence:gate5` 生成，任一断言失败 exit 1）

| specs/07 Gate 5 Accept                                                                | 结果 | 证据                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一条命令走完 propose → build → 真实 Loader → Harbor 评测 → normalize → Archive commit | ✅   | `run --run-root …` 单命令 685s 停在 `K_REACHED`：2 个真实 Harbor trial（`adaptive-rejection-sampler`、`break-filter-js-from-html`，均诚实失败 → pool 2）→ 1 次真实 proposal sandbox（`controller/sandboxes/prop-1`）→ 子代 `c_u5py7…` 可信重建 + Archive admission（catalog 2 entries）     |
| 无效 config / 缺失凭据 / Docker/Harbor 不可用 / 预算耗尽在付费 launch 前失败          | ✅   | sealedAccess=true 的 tampered config → exit 2；删除 0600 凭据 → doctor `✗ credential:` + run exit 2；两者均无 controller/、无 run-manifest.json、jobs 目录为空（`failClosedBeforeAnyHarborJob`）；预算耗尽由 driver 单测钉住（`BUDGET_EXHAUSTED`：0 sandbox、0 新 launch、settle 记账精确） |
| 重复 submit/resume 不复制 proposal、trial、score 或 cost                              | ✅   | resume 后 controller journal 逐字节相同、harbor-ledger 行数相同、Harbor trial 目录数相同、drive-report 逐字节相同（4 项独立断言）                                                                                                                                                           |
| CLI status 全部来自持久证据、进程重启后可用                                           | ✅   | 新进程 `status`：controller replay observationCount=trials、stateHash 与 drive-report 一致、stopReason/admitted 一致（`statusFromDurableEvidenceAfterRestart`）                                                                                                                             |
| selector/proposer 仍读不到 guard/sealed 材料                                          | ✅   | sealed 分配不出现在任何冻结文档/exports/controller/objects/jobs（`sealedAssignmentNeverOnDisk`）；guard 真名不出现在 exports/controller/objects 与全部选择文档（`guardInvisibleToProposerAndSelector`）；population 文档只含 89 全集、无分配提示（`populationDocCarriesNoAssignment`）      |
| 逐 trial 可归因                                                                       | ✅   | 2/2 Harbor trial 的 per-trial config.json `agent.kwargs.registry_entry` = `dsh-evolve-le-capsule` + 本次 run 的 capsule archive sha256（`trialsAttributedToCapsuleArchive`）                                                                                                                |
| 预算记账精确                                                                          | ✅   | `task-trials` spent=trials=2、`proposal-calls` spent=expansions=1、usd spent=74 223 µUSD、proposer-tokens spent=14 805、全维度 reserved=0（`budgetAccountingExact`）                                                                                                                        |

### Gate 5 期间发现并修复的实现缺陷

- **`defaultRunConfig` overrides 交叉泄漏**：共享 overrides 对象整展进 `search`，
  `--set kTarget=1 --set usd=…` 这类混合覆盖会把预算键漏进 search 文档而被 schema 拒绝
  （budget 侧此前已修，search 侧漏了）。修复为双侧白名单逐键拷贝（新单测覆盖混合覆盖）。
- **harbor 进度污染 CLI stdout**：provider 把 harbor 子进程 stdout 直接写进
  `process.stdout`，evidence 脚本 `JSON.parse(run.stdout)` 被 `1/1 Mean: 0.000 ━━━` 行
  打断。修复为镜像到 stderr（job dir 自带 job.log 的持久副本不变）。
- **settle ≤ 预留是 ledger 不变量**：构造预算耗尽用例时发现 settle 金额不得超过该 action
  的 worst-case 预留（`budget: settle 400000 exceeds reserved 66666`）——这是设计内
  不变量，测试改为按预留上界构造（并显式注释），未放宽 ledger。

### 已知限制

- proposer 仍是 recorded 确定性 policy；闭环证明的是管线与边界，不是模型质量。
- evidence profile 显式冻结为 K=1、2 discovery trial（最小真实闭环）；stable-demo 默认
  K=3/≤15 trial 未在真实 Harbor 上全量跑（属 Gate 6 的稳定迭代证明范围）。
- kTarget=1 时子代在 admission 后即停（与 fake-provider 契约测试钉住的行为一致）；
  子代的 development 评测 wave 要等 evaluate 分支被触达（K 提高后自然发生）。
- discovery trial 均为诚实失败（agent 非零退出、reward 0）——recorded proposer 无法真正
  解题，这正是 Gate 4 已知限制在数据集上的体现；真实模型路由属后续 gate。

## 2026-08-29 Gate 6 implemented — stable K=3 iteration with crash/resume

**目标（`specs/07` §8）**：在 stable-demo 默认 profile（无 `--set` 覆盖）下，用全新 development-only
run 证明稳定 K=3 迭代：确定性批扫描冻结 failure pool → 3 个唯一子代跨 ≥2 层 lineage、每个子代在
冻结 pool 上完成 q0 cold-start 评测 → 一次真实进程崩溃后 resume 到同一终态 → 全程 exactly-once。
产出 `STABLE_ITERATION_VERIFIED`（仅工程生命周期声明，不含分数/质量声明）。

### 实现（契约测试先行）

- **K/q0 停机语义**（`driver.ts`）：K 达成不再停在 admission —— 每个已 admit 子代必须完成
  q0=1 次来自冻结 pool 的 cold-start 评测后循环才允许停（`specs/03` §"达到 K 后只允许
  evaluation"）；`STABLE_ITERATION_VERIFIED` iff K_REACHED ∧ 非 baseline 子代数 ≥ kTarget ∧
  lineageDepthMax ≥ 2 ∧ 每个子代在 pool 上有评测。`DriveReport` 新增 `status`、`lineageDepthMax`。
- **discovery 批确定性**（`driver.ts`）：批扫描按冻结 ceremony 顺序切批（`discovery-N` wave、
  成员重校验、批边界先查冻结再付新批钱）；resume 从批内成员逐一续跑而非重付整批；
  `NO_REAL_FAILURE_SIGNAL` 在冻结顺序耗尽且零失败时触发（不得在候选结果后挑任务）。
- **崩溃演练缝**（`cli.ts`）：`DSH_EVOLVE_CRASH_AFTER_OBSERVATION=N` —— 第 N 个 `eval-*`
  observation 确实落账（budget settle + journal commit 之后）即 `SIGKILL` 自杀；生产 run 永不设置。
  driver/controller 透传 `onBoundary`。
- **确定性 canary**（`proposer/canary.ts`）：`deriveCanaryTokens(masterSeed, runId, principal, n)`
  —— HMAC-SHA256 派生、TCB 外不可猜、同 (seed, run, principal) 跨 crash/resume 与同种子重放稳定。
  此前随机 canary 经 export manifest 的 `canaryAbsence.tokenFingerprints` 污染整条下游 digest 链
  （transcript → export digest → 子代 source digest → candidateId → Thompson 种群顺序），导致
  崩溃与 reference 终态哈希发散。
- **recorded proposer 溯源锚**（`proposer/policy.ts`）：子代 `src/index.ts` 追加引用本次 proposal
  export 实例（`derived from evidence export <exportId>`）的 provenance 注释 —— 同一父代的不同
  export 实例产出不同子代（真实演进语义）；同状态重复展开仍按 duplicate 记 expansion failure。
  修复前：同一父代恒定产出字节相同子代 → K=3 时 Thompson 重抽已展开父代 → 连续 duplicate →
  `NO_ADMISSIBLE_CHILD` 提前停机。
- **崩溃/恢复等价契约测试**（`tests/iteration/driver.test.ts`）：reference 全程 vs 崩溃双胞胎
  （同一 run-root 路径、同一 tick 时钟）逐字段断言终态一致：stopReason/status/stateHash/
  admitted/lineageDepthMax/trials/discoveryTrials/expansionAttempts/failurePool/observations/
  budget、外部效应数（launch 效应 == trials、sandbox 数 == expansionAttempts）。折叠态内嵌
  sandbox 绝对路径（`externalJobId`），故等价性在同一路径下断言 —— 该前提在测试中显式固化。
- **CLI 契约**（`packages/cli/tests/cli.test.ts`）：run/resume/status 期望更新为 K=3/q0 语义。

### 验收证据（`evidence/gate6/STATUS.json`（tracked）+ `stable-iteration.json`（机器文档）+ `jobs/`（原始 Harbor job）；由 `pnpm evidence:gate6` 生成，任一断言失败 exit 1）

| specs/07 Gate 6 Accept                                                                                 | 结果 | 证据                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全新 development run、确定性批（≤12 observed）、proposals 前冻结 pool、不做候选后挑题                  | ✅   | 默认 config（kTarget=3、discoveryBatch=6、≤12）；第 1 批 6 个 trial 全部诚实失败后批边界即冻结 pool（6 handle，`frozenFromObservations=6`）`configIsDefaultStableDemo`/`poolFrozenFromDiscoveryOnly`                                                            |
| 自动 admit 3 个唯一子代、跨 ≥2 层 lineage                                                              | ✅   | 3 次 expansion（prop-1/2/3 sandbox）admit 3 个唯一子代，lineageDepthMax=2（`threeUniqueChildrenAdmitted`/`twoLineageDepthsAtLeast`/`catalogDepthsMatchReport`）                                                                                                 |
| 每个子代在冻结 pool 选出的一个 task 上评测                                                             | ✅   | 3 个子代各 1 次 pool 任务 cold-start trial（trials=9=6 discovery+3 评测；`everyChildColdStartedFromFrozenPool`）                                                                                                                                                |
| 一次真实外部效应后的进程崩溃 + resume 到同一终态                                                       | ✅   | `DSH_EVOLVE_CRASH_AFTER_OBSERVATION=1` → SIGKILL（1 个 Harbor trial dir、1 个 committed eval action、无 failure-pool/drive-report、无 sandbox）；`resume` 复用同 run root 到 `K_REACHED`/`STABLE_ITERATION_VERIFIED`（`crashDrillWasARealProcessKill` 等 5 项） |
| exactly-once proposal/evaluation/cost + 完整 raw refs + hash-chain replay + normalized Harbor evidence | ✅   | Harbor trial dir 数 == trials == ledger 行数 == 9、sandbox 数 == expansion 数 == 3、二次 resume 逐字节不变（journal+budget ledger+report）；`audit` 全绿；9/9 trial 的 config.json registry_entry = `dsh-evolve-le-capsule` + 本次 archive sha256               |
| proposer 引用历史 raw evidence；reject/runtime fail/infra retry/duplicate 由 fixtures 覆盖             | ✅   | 3 个子代 candidate.json `proposal.evidenceRefs` 共 19 条全部解析到 `objects/sha256/<2-hex>/` 内容寻址对象（`childrenCiteHistoricalRawEvidence`）；故障路径由 driver 契约测试钉住                                                                                |
| 不声称分数提升/champion/sealed 访问/leaderboard                                                        | ✅   | `STABLE_ITERATION_VERIFIED` 为工程生命周期声明；sealed 分配全文扫描零出现（`sealedAssignmentNeverOnDisk`）、guard 不可见（`guardInvisibleToProposerAndSelector`）、budget reserved 全零                                                                         |

### Gate 6 期间发现并修复的实现缺陷

- **同父代确定性子代导致 K=3 不可达**（见上，exportId 溯源锚修复）。
- **随机 canary 破坏跨 resume digest 链**（见上，`deriveCanaryTokens` 修复）。
- **测试时钟随机性放大**：journal `occurredAt` → state hash → export id → 子代 id → Thompson
  顺序，测试改用共享 tick 时钟；折叠态内嵌绝对路径 → 崩溃等价测试固定同一路径执行。

### 已知限制

- proposer 仍是 recorded 确定性策略；本 gate 证明的是稳定迭代生命周期，不是模型质量。
- 全部 discovery/子代 trial 均为诚实失败（reward 0）——recorded proposer 无法真正解题（Gate 4
  已知限制在默认 profile 下的体现）；真实模型路由属后续 gate。
- 崩溃演练只在 committed-observation 边界（确定性安全点）触发；任意 I/O 点的崩溃一致性由
  Gate 3 fault matrix 覆盖。
- 跨 resume 等价性以同 run-root 路径为前提（折叠态内嵌绝对 sandbox 路径）；该前提已写入契约测试注释。

## 2026-08-30 Gate 7 — 开源 v0.1 release candidate（`OPEN_SOURCE_V0_1_RELEASE_CANDIDATE`）

- **范围**（`specs/07` §9）：可安装的开源 v0.1 release candidate —— 不要求 benchmark 提升。
- **工具链**：`pnpm release:artifacts`（tarball/SBOM/checksums/扫描，全部作用于
  `git archive HEAD` 的**已提交树**）、`pnpm install:verify`（fresh-profile 安装演练）、
  `pnpm gate7`（build + test + lint + format:check + provenance:check + upstream:check +
  evidence:gate7）。
- **发布产物**：`release/dsh-evolve-le-0.1.0-rc.1-src.tar.gz`（560 文件，sha256
  `25ea5241e5aee3be…`，内容寻址进 evidence）；75 个依赖许可证全部在 OSI/permissive
  allowlist 内、0 个无许可证；SPDX 2.3 SBOM 81 packages；secret 模式扫描 0 命中
  （9 类 token 形状，刻意不做熵值启发 —— 仓库本身充满 sha256 摘要）；UTF-8 全量校验
  0 违例。
- **License**：MIT（根 LICENSE 重写 + 全部 package.json 统一声明）；SECURITY 版本表、
  CHANGELOG `0.1.0-rc.1` 条目、README（中英）与 docs 六篇重写为当前实现。

### 验收证据（`evidence/gate7/STATUS.json`（tracked）+ `release-candidate.json`（机器文档）+ `checksums.sha256` + `sbom.spdx.json`；由 `pnpm evidence:gate7` 生成，任一断言失败 exit 1；source commit `377e602`）

| specs/07 Gate 7 Accept                                                                | 结果 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 干净 fresh-profile 按文档命令安装，随后真实 Loader 与 K=3 demo smoke                  | ✅   | 全新 HOME/XDG/pnpm-store + `--frozen-lockfile` 安装（17s）→ build → `loader-spike` 真实 Loader quiescent（`pnpmInstallFrozenLockfile`/`pnpmBuild`/`realLoaderQuiescent`）→ 默认 stable-demo 配置 K=3 demo（57s）`K_REACHED`/`STABLE_ITERATION_VERIFIED`（trials=9、discovery=6、expansions=3、admitted=3、depth=2、pool=3）                                                                                                                                               |
| 公开 README/架构/quickstart/config/troubleshooting/evidence 解读文档                  | ✅   | tarball 内 15 个公开文档逐个 `shipped:*` 断言（README 中英、LICENSE、CHANGELOG、CONTRIBUTING、SECURITY、CODE_OF_CONDUCT、docs 六篇 + TB runbook）；文档内容重写为当前实现（无 schema 12/13、stable-demo 旧 config 等前代内容）                                                                                                                                                                                                                                            |
| 用户选定的 OSI license + CONTRIBUTING/SECURITY/code of conduct/release notes          | ✅   | MIT（用户选定）；根 LICENSE 为 MIT 正文、root manifest `license: MIT`（`licenseIsMit`/`manifestLicenseMit`）；治理文件 shipped 断言；CHANGELOG `0.1.0-rc.1` 条目                                                                                                                                                                                                                                                                                                          |
| source tarball/package、SBOM、provenance、checksums、依赖/许可证扫描、secret/泄露扫描 | ✅   | tarball 由 `git archive HEAD` 生成且 `tarballFromHeadCommit`==当前 HEAD；SPDX 2.3 SBOM 81 packages；`checksums.sha256` 全产物；75/75 依赖 allowlisted、0 无许可证；secret 0 命中；UTF-8 0 违例（`releaseArtifactsBuilt` 等 8 项）                                                                                                                                                                                                                                         |
| 全量 unit/E2E/typecheck/lint/format/provenance/upstream-clean/UTF-8 套件通过          | ✅   | `pnpm gate7` 全绿：tsc -b（typecheck）+ vitest 351/351 + oxlint 0 error + prettier --check + `provenance:check`（含 upstream 只读校验）+ 上述 UTF-8 扫描                                                                                                                                                                                                                                                                                                                  |
| rollback/uninstall 与一次 prior-state restore 实测（不止文档）                        | ✅   | `priorStateRestoredFromJournal`（profile 自带 reducer 折叠 journal 至 seq 157 == 中途快照哈希）+ 删除**全部**快照与 drive-report 后 `terminalStateReconstructedAfterSnapshotLoss`（status 重建同一 stateHash）+ `driveReportReDerivedAfterLoss`（resume 重导出，`K_REACHED`/`STABLE_ITERATION_VERIFIED`）+ `journalUnchangedByRestore`（journal 字节不变，非空校验）+ `auditGreenAfterRestore` + `uninstallRemovesEverything`（整 profile 删除后无残留）；16/16 checks 绿 |
| 扫描对象即发布对象                                                                    | ✅   | `committedTreeClean`：记录前断言工作树干净（仅 evidence/gate7 与 gitignored release/ 例外），tarball 与扫描均基于同一 commit —— 未提交的 recorder 输出不可能进入发布树                                                                                                                                                                                                                                                                                                    |

### 已知限制（Gate 7）

- 发布状态是**工程可安装性**声明：不包含任何 sealed 揭盲、分数提升、champion 或 leaderboard。
- fresh-profile demo 用 fake provider（合成 89 任务）与默认配置 —— 真实 Terminal-Bench 运行
  需按 `docs/quickstart.md` 提供 tasks root、Harbor 与 artifact endpoint；真实 provider 的
  K=3 证据已由 Gate 6 记录。
- tarball 未附 git 历史（`git archive`）；provenance 以 commit sha + `provenance.lock.json`
  锚定（tarball 内含）。
- 发布通道当前是源码 tarball；npm 发布不在 Gate 7 范围（specs/07 未要求）。

## Next

- Gate 8（`specs/07` §10，**可选**）：连续 Terminal-Bench 提升 profiles（K=10 pilot、K=80
  search、一次性 sealed 确认、官方 89×≥5 评测）—— 需另行授权的预算；未开始。
- Gate 4 后续接线（显式记录，不静默）：真模型 proposer 路由（替换 recorded policy 的
  adapter 槽位）、proposer 预算维度并轨到整轮 $500/16h 预算模型。
- 顺延项（显式记录，不静默）：recorded-LLM 回放、DSH 生产闭包 runner、真实模型 capsule
  的 set_model 广告。
