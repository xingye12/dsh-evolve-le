# Project status

**当前权威状态：`GATE0_IMPLEMENTED`（6/6 测试 + 机器可验证 evidence）；`GATE1_IMPLEMENTED`（95/95 测试 + `pnpm gate1` 全绿 + 机器可验证 evidence）；`GATE2_IMPLEMENTED`（124/124 测试 + `pnpm gate2` 全绿 + 真实 Harbor job evidence）；`GATE3_IMPLEMENTED`（228/228 测试 + `pnpm gate3` 全绿 + 10 例 SIGKILL fault-matrix evidence）；`GATE4_IMPLEMENTED`（282/282 测试 + `pnpm gate4` 全绿 + 真实 uid+netns proposal sandbox E2E evidence）；`GATE5_8_PENDING`; `NO_BASELINE`; `NO_CLOSED_LOOP`; `NO_SEALED_RESULTS`**
**更新时间：2026-08-29（Asia/Tokyo）**

## Claim boundaries

- 本仓库已实现 **Gate 0**（provenance 机器校验 + 真实 Cordis Loader lifecycle spike）、
  **Gate 1**（candidate SDK + 十阶段可信 admission builder + 离线 capsule + ACP E2E）、
  **Gate 2**（Terminal-Bench provider 纵切片：真实 Harbor job 在 pinned `extract-elf` 上经
  inline ACP binary distribution 运行真实 capsule，normalizer/idempotency/verifier-mode
  探针全部机器断言）、**Gate 3**（durable controller core：状态层、单写者
  saga/recovery、SIGKILL fault matrix、Cordis service unload flush）与 **Gate 4**
  （agentic proposal 纵切片：label 过滤 evidence export + canary、model gateway +
  受限 tool 层 + recorded proposer policy、一次性 uid+netns proposal sandbox、
  controller proposal saga + replay 验证 + bundle 校验 + 子代导入与重建）。Gate 1 的
  `admitted` 只证明 **safety-runnability**；Gate 2 的全绿只证明
  **单 task 评测管线成立且 replay capsule 得到诚实的 reward 0**；Gate 3 的全绿只证明
  **崩溃一致性状态机成立（FileProvider 假体）**；Gate 4 的全绿只证明
  **单次 proposal 闭环在合成 failure trace 上成立且沙箱/注入/canary 边界被机器断言**
  ——都**不是**性能验收。
- mock replay 仍是确定性 system-prompt 分节回放，**不是** recorded-LLM 回放；Gate 1 曾把
  recorded-LLM 回放与 DSH 生产闭包 runner 归到 Gate 2，实际 Gate 2（`specs/07` §4）范围是
  provider 纵切片、不含 runner 替换 —— 该项顺延至 runner 相关的后续 Gate，此处显式记录，
  不算静默缩水。
- Gate 4 的 proposer policy 是 **recorded 确定性策略**（model gateway adapter 槽位的参考
  实现），不是真模型 proposer；真实模型路由仍属后续 gate。
- 没有 baseline 分数、没有演化闭环、没有 sealed 结果；不得声称已提升、可部署、
  无 reward hacking 或达到 SOTA。
- `specs/07-implementation-plan.md` 的 Gate 5–8 全部未开始。前代项目的通过记录不是本
  仓库的完成证据（见 2026-08-28 节）。

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

## Next

- Gate 5（`specs/07` §7）：development split 真实闭环 —— Harbor provider 适配
  `BenchmarkProvider` 接口（复用 Gate 2 JobConfig/ledger/normalizer）、controller 规划
  development wave、子代评测 + selection/archive admission；sealed 路径仍不触。
- Gate 4 后续接线（显式记录，不静默）：真模型 proposer 路由（替换 recorded policy 的
  adapter 槽位）、proposer 预算维度并轨到整轮 $500/16h 预算模型。
- 顺延项（显式记录，不静默）：recorded-LLM 回放、DSH 生产闭包 runner、真实模型 capsule
  的 set_model 广告、development split 真实闭环（依赖 Gate 3 状态机与 Gate 4 budget）。
