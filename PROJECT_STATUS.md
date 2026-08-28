# Project status

**当前权威状态：`GATE0_IMPLEMENTED`（6/6 测试 + 机器可验证 evidence）；`GATE1_IMPLEMENTED`（95/95 测试 + `pnpm gate1` 全绿 + 机器可验证 evidence）；`GATE2_8_PENDING`; `NO_BASELINE`; `NO_CLOSED_LOOP`; `NO_SEALED_RESULTS`**
**更新时间：2026-08-29（Asia/Tokyo）**

## Claim boundaries

- 本仓库已实现 **Gate 0**（provenance 机器校验 + 真实 Cordis Loader lifecycle spike）与
  **Gate 1**（candidate SDK + 十阶段可信 admission builder + 离线 capsule + ACP E2E）。
  Gate 1 的 `admitted` 只证明 **safety-runnability**（可构建、可加载、可干净卸载、扫描清白），
  **不是**性能验收。
- mock replay 是确定性 system-prompt 分节回放，**不是** recorded-LLM 回放；recorded-LLM 回放
  与 DSH 生产闭包随 Gate 2 runner 落地（见下）。
- 没有 baseline 分数、没有真实评测闭环、没有 sealed 结果；不得声称已提升、可部署、
  无 reward hacking 或达到 SOTA。
- `specs/07-implementation-plan.md` 的 Gate 2–8 全部未开始。前代项目的通过记录不是本
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

## Next

- Gate 2（Terminal-Bench provider vertical slice，`specs/07` §4）：TypeScript Harbor
  provider、recorded-LLM 回放 + DSH 生产闭包 runner、development split 真实闭环。
