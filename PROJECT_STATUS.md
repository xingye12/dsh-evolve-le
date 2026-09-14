# Project status

**当前权威状态：`GATE0_IMPLEMENTED`（6/6 测试 + 机器可验证 evidence）；`GATE1_IMPLEMENTED`（95/95 测试 + `pnpm gate1` 全绿 + 机器可验证 evidence）；`GATE2_IMPLEMENTED`（124/124 测试 + `pnpm gate2` 全绿 + 真实 Harbor job evidence）；`GATE3_IMPLEMENTED`（228/228 测试 + `pnpm gate3` 全绿 + 10 例 SIGKILL fault-matrix evidence）；`GATE4_IMPLEMENTED`（282/282 测试 + `pnpm gate4` 全绿 + 真实 uid+netns proposal sandbox E2E evidence）；`GATE5_IMPLEMENTED`（348/348 测试 + `pnpm gate5` 全绿 + 真实 CLI/Harbor 开发集闭环 evidence）；`GATE6_IMPLEMENTED`（351/351 测试 + `pnpm gate6` 全绿 + 默认 profile 真实 crash/resume K=3 稳定迭代 evidence）；`OPEN_SOURCE_V0_1_RELEASE_CANDIDATE`（Gate 7：351/351 测试 + `pnpm gate7` 全绿 + fresh-profile install/restore/uninstall 实测 evidence）；`GATE8_REMOTE_ROUTE_WIRED`（370/370 测试 + 真实模型 proposal 冒烟 evidence：live deepseek-v4-flash 经 TCB proxy 完成 1 次 proposal、3 子代全部过 trusted builder 重建）；`GATE8_PILOT_RECORDED`（395/395 测试 + specs/07 §10 pilot profile evidence（2026-08-31 重录，首记录作废）：K=10 admitted 达成（12 子代、4 次真实模型扩张、depth 4、0 拒绝/0 abandoned）、50 trials participation ran=50/0 infra 伪装、90 712 µUSD、13 386s、37 条机器断言全绿；search/sealed/official profiles 未运行）；`TREE_V2_K3_LIVE_RECORDED`（2026-09-06 attempt 14：K=3 admitted 达成、trials=14、RUNNER_EXIT=0、record failures=[]、$2.04、evidence artifacts 落盘 evidence/tree-v2/k3-live/；depth-1 形态，stable-demo depth-2 全绿记录未产出）；`TREE_V2_K10_LIVE_RECORDED`（2026-09-07 attempt 3：STOPPED:TRIAL_CAP@trials=60、admittedNonBaseline=10/10 达成、expansions=6（连续失败 0）、$8.41、21698s、record failures=[]、evidence 落盘 evidence/tree-v2/k10-live/；ADR-043/044 首次生产验证通过；K_REACHED 未达——最后 2 子代冷启动在 60-trial 上限时 pending；attempt 2 的扩张墙未重演；`NO_SEALED_RESULTS`**
**更新时间：2026-09-10（Asia/Shanghai）**

## 2026-09-13 repair24 terminal diagnosis；successor-only recovery fix（未启动）

`tree-v2-k80-formal-repair-24` 已在 SEARCHING 阶段以
`STOPPED:NO_ADMISSIBLE_CHILD` 终止：`drive-report.json` / `search-state.json` 共同记录
45 个 admitted non-baseline candidate、365 observations、13 次 expansion，且最后三次
连续 expansion failure 已到冻结的 `maxConsecutiveExpansionFailures=3`。这三个 action
（`prop-11`、`prop-12`、`prop-13`）的 native proposal worker 都在写入 child 文件后因
`agent exited without proposal_finish` 失败；原始 failure transcript 表明先前的
“recovery turn”被追加到同一 native session，而该 session 的模型 token/cost 上限已耗尽，
故恢复回合立即再次 budget-stop。它们不是 Harbor trial 或候选评测的可重试基础设施失败。

后继源码将这一次恢复改为一个新的、内容寻址的 native DSH session；共享的仅是受限
proposal tool state 和 child staging root，两个 session 的 events 和 recovery session ID
都持久化进同一 transcript。`pnpm exec tsc -b --pretty false` 与
`packages/dsh-evolve-le/tests/native-proposal.test.ts` 9/9 通过。该改动会改变 proposer
执行，因此 repair24 的 terminal state、manifest、失败计数和证据均不得改写或 resume；如要
继续，必须预注册 successor，并逐一证明 45 个 candidate/capsule 和已完成 observation 的
identity、solver route、task/verifier、scorer、split、budget 语义完全兼容后才能导入。
尚未创建 successor、未启动任何新的 Harbor job 或模型调用，也没有 tournament/sealed 结论。

## 2026-09-13 repair26 WSL 重启中断后的恢复（用户授权「恢复repair26」，已恢复运行）

`tree-v2-k80-formal-repair-26`（从 repair-24 45/50 恢复启动）在 prop-1 三子代全部
admitted（48/50）后于 2026-09-13 09:26 被宿主机 WSL 重启杀死：record 脚本与 controller
进程消失、无终态 verdict，journal 冻结在 02:37（7 个 trial job 在飞、orphaned）。
恢复前校验（全部通过后才启动）：journal 全链（2000 事件，eventHash 不变式 canonical
JSON、previousHash 链与 HEAD 完全一致，seg1 merkleRoot 与 closed.json 一致）；stale
lock（pid 2344102、bootId 9f26fca9 ≠ 当前）；search-state 非终态
（expansionAttempts=1、consecFail=0）。启动器为 presearch-import checkout
`/root/vibe/dsh/scratch/dsh-evolve-le-presearch-import`（HEAD e4cb68a，主仓库的
record 脚本只有 repair3–6），`DSH_TREE_V2_FORMAL_VARIANT=repair26` +
`DSH_TREE_V2_LIVE_CONFIRM=confirm`，未设 `TREE_V2_TRIAL_CONTAINER_PROXY`（冻结配置
trialContainerProxy 为 null，设置会触发一致性检查安全停止）；日志追加到
`k80-formal-repair26-launch.log`。恢复结果：doctor 通过后 `run`（幂等 resume）接管，
seg2 封口、seg3 开启，锁由新进程（CLI pid 9640、新 bootId）重取，搜索循环恢复
cold-start 规划，0 条 FAILED。7 个 orphaned trial 按 rule 7 默认记失败；2 个带
finished_at 的走 row-6 receipt-without-commit 重取。无 tournament/sealed 结论；
30 分钟监督汇报已恢复。

**终态（2026-09-13 12:17 CST）**：`STOPPED:NO_ADMISSIBLE_CHILD` —
trials=410（discovery 14、导入 365、live 45）、admittedNonBaseline=48/50、
expansionAttempts=4、tournament=0，恢复后运行 9721s，终值 ~$113.71。
prop-1 成功（3 子代准入达 48/50）；prop-2（tool calls=50）、prop-3（66）、
prop-4 全部以与 repair-24/25 相同的模式失败："agent exited without
proposal_finish"（native proposer 写出 children 文件后未发 proposal_finish，
prop-4 的 3 个 children 名为 edit-readback-breaker、variant-loop-breaker、
verification-gap-breaker，failure-transcript 均在 sandboxes/prop-N/work/）。
consecFail 触顶 3/3。record 脚本自身 post-check FAILED：
trialDirsMatchReportIncludingTournament（38 dirs vs 45 live）、
receiptUsageMatchesSettlement（32,731,773 vs 34,568,858）、
oneTokenFilePerTrial（43 vs 45，2 个 pre-reboot token 文件缺失）。scratch
与 evidence 保留在 `/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-26`；
不得改写。proposer 批量错误已是连续三个 K=50 run（repair-24/25/26）的
决定性死因，repair-27 若启动须先修复该模式。

## 2026-09-13/14 repair27 终态（用户授权启动；BUDGET_EXHAUSTED 于 tournament 中段）

`tree-v2-k80-formal-repair-27`（K=50，2026-09-13 ~14:59 CST 由用户授权启动，
presearch checkout HEAD `e78f97d`「compact native proposal recovery」修复了
proposer 死因；导入 repair-26 全部 410 观测与 49 capsules，身份兼容性校验通过）。
**该修复一次验证成功**：prop-1 产出 3 子代全部 admitted（51/50），
`K_REACHED` 触发——这是 K=50 系列第一个达成 K 的 run；expansionAttempts=1、
consecutiveExpansionFailures=0，无 rebuild rejection。

Tournament（baseline + 5 强 shortlist × 49 任务 = 294 场，短list 经
HMAC-SHA256 抽签冻结，receipt 落 journal）按节点顺序执行：
baseline 27/49（55.1%）、`c_y2vhojev…` 31/49（63.3%）、`c_c5cyx2ud…` 28/49
（57.1%）、`c_jabosn6c…` 24/49（49.0%）、`c_g65rjtqg…` 30/49（61.2%），
第 6 个节点 `c_gvspit6u…` 只完成 12/49（7 solved）。

**终态（2026-09-14 07:10 CST）**：`STOPPED:BUDGET_EXHAUSTED` —— wall-clock
预算在最后一节点覆盖中途耗尽（运行 61901s ≈ 17.2h；tournament 起于 14:47，
ADR-048/058 的 search-share 扣完后 tournament 壁钟预算到顶，属合法 SEARCHING
边缘）。trials=419（discovery 14、导入 410、live 9）、admittedNonBaseline=51/50、
tournament=257/294。**champion 判定（paired-delta + 90% cluster-bootstrap LCB）
未运行**：无 champion、无 sealed promotion、不得宣称任何 development/sealed
改善。实际结算 $36.96（task-trials 266；导入 410 不重复计费）。

record 脚本 post-check FAILED 3 项（与 repair-26 的 3 项不同）：
trialCountWithinThePreRegisteredEnvelope（liveTrials=9 的口径与 trial 总量不闭合，
envelope 复核问题连续第 4 个 run 出现）、attributionCallsSettledWithinBudget: null、
attributionTokensSettledWithinBudget: null。scratch 与 evidence 保留在
`/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-27`；不得改写。
主要教训：K 达成后 tournament 294 场的 wall 预算远超预留，下一 successor 若
要跑完 tournament，须把 search-share 之外的 tournament 壁钟预算上调或缩减
coverage；慢任务（break-filter-js-from-html、count-dataset-tokens、rstan-to-pystan、
extract-moves-from-video、torch-pipeline-parallelism 等反复逼近 1h solve-agent
超时上界）是 wall 消耗的主因。

## 2026-09-14 repair30 启动与 WSL 重启恢复（用户授权；tournament 延续，运行中）

tree-v2-k80-formal-repair-30（用户授权启动，launcher checkout
`/root/vibe/dsh/scratch/dsh-evolve-le-repair28` @ 4d82fbe，variant repair30）
是 ADR-090/091 的 frozen tournament 延续：import 携带 repair-27 的 419 开发
观测 + 257 tournament 观测（--include-tournament）、52 capsules、同一 frozen
shortlist（y2vhojev、c5cyx2ud、jabosn6c、g65rjtqg、gvspit6u）+ baseline；
gvspit6u 从 12/49 续跑。k80Repair30 profile 将 tournament 壁钟份额提到 24h
（wallClockSearchMinutes=3600 / wallClockMinutes=5040，taskTrials=960），
针对 repair-27 BUDGET_EXHAUSTED 的修正。终态尚未来临：champion
paired-delta + 90% cluster bootstrap LCB 需在 gvspit6u 49/49 后运行，结果
待 drive-report.json 落盘后记录。

2026-09-14 11:28:56 WSL 重启中断了 mid-wave-2（tournament-5-2-1）的运行。
用户授权恢复（「帮我恢复repair30的运行」）：journal 3599 事件全链哈希校验
通过（own-hash、previousHash 链、段 merkleRoot、HEAD 全部一致）、stale lock
按 bootId 判定后接管、run 身份与协议输入复核一致（runId/masterSeed 未变、
trialContainerProxy 保持 null 未设代理、checkout 4d82fbe 干净）。11:32:43
以 detached 方式重启（record PID 3835），lock 重新获取（bootId b3d750fe），
12 个 wave-2 trial 容器重启，journal 增长 3599→3758，0 FAILED。

2026-09-14 15:33 CST 终态：STOPPED:NO_DEVELOPMENT_IMPROVEMENT（fail closed，非
预算死亡）。tournament 294/294 全覆盖、0 failed；短名单终分：baseline 28/49、
y2vhojev 33/49、g65rjtqg 32/49、c5cyx2ud 30/49、gvspit6u 30/49、jabosn6c
26/49。paired-delta + 90% cluster-bootstrap LCB（100000 resamples，rng.drawn
bootstrap 收据已入账）：y2vhojev 均值 +10.2pp baseline 赢得
champion tournament。sealed评测结果：y2vhojev 78/115、baseline 66/115



用户要求将后继 live solve ceiling 提升至 150，并把 proposer 从被动的 prompt
文本变更转向可执行策略变更。实现新增 `k80Repair6` / `repair6` 独立 identity：
gateway request cap 与 capsule turn cap 均为 150；每 trial 的 2M token、$0.30、
Harbor wall-clock、总 trial 与总预算边界不变且继续 fail-closed。tree-v2 successor
admission 不再要求修改 `src/index.ts` 或双 mode prompt；对暴露
`candidate-workflow:solve-policy` 的 parent，多 child batch 至少包含一个 executable
workflow child，prompt/tool/skill/event 实验仍可作为 sibling。真实 native ACP probe
把实际注入的 checkpoint count/digest 纳入 solve runtime fingerprint，因此
strategy-only delta 可以被验证。

后续实现补充（同一未启动 successor 源码）：candidate tool 可声明受限
`strategy.autoInvoke` facet；native solve TCB 每个 pre-step 最多自动执行四个 facet，
只传入 content-free strategy context。TCB 还实际发射
`candidate:agent/pre-step`、`candidate:session/start` 与 `candidate:session/end`，并在 native probe 写出
workflow/tool/agent-event/session-event invocation counts。候选没有获得 ACP、文件、网络、
verifier、controller、route 或预算权限；其它 candidate event 名仍只是声明，未被伪装为可用。
截至本次源码检查，`pnpm exec tsc -b --pretty false` 及覆盖 SDK、native agent、tree-v2
contract/profile 的 focused Vitest **92/92** 已通过；这仍只是 successor 实现验证。

启动（2026-09-10 ~11:44，用户授权「用新的配置，开启repair6」）：已以冻结 commit
`fd2129a70a1301311ff51c65d0ae930a33fb6e8b`、`DSH_TREE_V2_FORMAL_VARIANT=repair6` 和
显式 paid gate 启动；launcher PID `1714207`，日志
`/root/vibe/dsh/scratch/k80-formal-repair6-launch.log`，scratch
`/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-6/`。启动前 12 路容器 egress
preflight 已通过；记录时正构建 offline verifier image，尚未 init、baseline 或产生付费模型调用。
repair5 的 manifest、预算与证据完全未改写。不得据此宣称 child success 或任何
development/sealed 改善。

## 2026-09-10 repair5 启动记录（用户授权，已点火；尚无 init/run 结论）

启动门核对：预注册提交 `597def3`（ADR-064/065 + k80Repair5 profile，工作树干净）；
`pnpm build`（tsc -b）绿；全量 vitest 绿 **804 passed / 29 skipped（71 文件，~415s，
退出码 0）**；真实 Loader E2E 单独复跑 **17/17**；credential 0600（默认
zen-compatible.key）；egress 代理 172.17.0.1:17897 HTTP 200；fwd 容器 Up；harbor CLI
0.21.0（/root/.local/bin/harbor）在位；evidence 根 `evidence/tree-v2/k80-formal-repair-5/`
空闲（无既有 record 可覆盖）；docker 网络仅剩 7 个（ADR-064 已清 18 个陈旧 TB network）。

scratch 根已存在一次 01:51–01:54 中途死亡的尝试产物（提取至部分任务、无 launcher log）；
record 脚本固定路径且各步骤幂等，本次启动对提取做幂等补完（89 upstream → 72 eligible
与冻结排除集一致），无需清理。

启动（2026-09-10 ~02:10，用户授权「点火启动」）：
`DSH_TREE_V2_FORMAL_VARIANT=repair5 DSH_TREE_V2_LIVE_CONFIRM=confirm` +
持久 `TMPDIR=/root/vibe/dsh/scratch/tmp` + setsid nohup + disown；launcher PID
1029226（setsid fork 后），launch log
`/root/vibe/dsh/scratch/k80-formal-repair5-launch.log`。记录时已确认：paid gate 通过、
提取幂等完成、verifier 镜像构建进行中（49 dev + 23 sealed）。该记录只说明 run 已启动；
**尚无 init/doctor/run、baseline、search/admission 或效能结论，也未产生任何付费调用
（镜像构建在付费 trial 之前）**。

## 2026-09-09 repair3 已停止；repair4 启动前预注册（历史记录）

用户要求停止 repair3 后，已向其专属 `setsid` 进程组 PGID 10597 发送 `SIGTERM`，并确认
launcher、CLI controller 和活跃 proposer worker 均已退出。`repair3` 的 scratch、run manifest、
journal 和 evidence 都保留在原路径，未删除、改写、重放或晋升其部分结果；该 run 是未完成/取消的
formal search，**没有新的 development 或 sealed 结论**。

新的 `k80Repair4` 已单独预注册：RUN_ID `tree-v2-k80-formal-repair-4`、MASTER_SEED
`tree-v2-k80-formal-repair-4-master-seed-1`、evidence 根
`evidence/tree-v2/k80-formal-repair-4/`、scratch 根
`/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-4/`。它保留 repair3 的 49×1×12 baseline、
400/360 formal envelope、12-way concurrency 与 16M attribution budget，但冻结后继 runtime：
solve-policy v2、native proposer `maxTurns=48`、Agent Debugger `maxOutputTokens=32,768`
（524,288-byte input / 180,000-ms timeout）。80 个 attribution call 的完整信封预留为
13,107,200 token，仍在 16M 内。record 脚本必须以
`DSH_TREE_V2_FORMAL_VARIANT=repair4` 选择该 identity；paid confirmation gate 未给出，**未启动
任何 repair4 付费调用**。

## 2026-09-10 repair4 infrastructure failure；repair5 已预注册、未启动

repair4 的 baseline 结束后发现 14 个 Harbor `RuntimeError` 在 agent 启动前因 Docker Compose
无法创建 bridge network 而失败（`all predefined address pools have been fully subnetted`）；另有一个
pre-agent `NetworkConnectionError`，因为 Harbor installed ACP agent 在 trial 内执行 `apt-get update`
时 Debian mirror 超时。它们按 repair4 冻结 retry policy 仍是 FAIL，不能事后删除、改分或重试；因此
repair4 已按用户授权 `SIGTERM` 停止，scratch/journal/Harbor 原始结果完整保留，**没有 development /
sealed 结论，且不得 resume**。

已移除 18 个无容器连接的旧 Terminal-Bench compose network（其它服务 network 未动），并新增两项
TCB 前置防线：live provider preflight 在付费前实际 allocate+release 全 `concurrentTrials` 数量的
bridge network，失败即 `docker-network-capacity` fail-closed；v4 derived verifier/task image 在预处理时
装入 Harbor ACP 固定 bootstrap 依赖，并只在 Harbor 的 noninteractive root 环境下 bypass 两条固定 apt
调用，普通 agent 的 `apt-get` 仍执行真实二进制。非付费 doctor 已实测 12 个 bridge probe 全部
allocate/release 成功；真实 `qemu-startup` 派生镜像已从其声明的 Debian snapshot 构建，并在
`--network none` 下完成这两条调用及 `import acp`，bullseye Python 3.13 runtime 亦能在该 glibc 2.31
镜像启动。

`k80Repair5` 已独立预注册：RUN_ID `tree-v2-k80-formal-repair-5`、MASTER_SEED
`tree-v2-k80-formal-repair-5-master-seed-1`、evidence 根
`evidence/tree-v2/k80-formal-repair-5/`、scratch 根
`/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-5/`。保留 repair4 的 49×1×12/K=80/12-way
预算和 v2 observation、48-step proposer、32k debugger；因 TCB/derived image 变化，它必须运行新的
baseline，repair4 结果仅供审计。**尚未启动 repair5，也未产生 repair5 付费调用。**

预注册验证：tree-v2 profile + recorder concealment 47 tests 通过；`pnpm exec tsc -b` 通过。
这不证明 debugger 已在真实模型返回 JSON，也不证明子代成功率或 development/sealed 分数改善；仍需
repair5 的常规 preflight 与新的 paid baseline。

## 2026-09-10 Agent Debugger v2：短 trace ID 修复（repair5 尚未启动）

repair4 的首个非空 debugger 调用因 `unknown diagnosticTraceDigest` 被拒绝。已核实 controller 的请求中
确有 10 个有效 digest；问题在 v1 设计要求模型逐字回填 71 字符的 `sha256:` 标识，单字符转录差异就会使
有效诊断整体 fail-closed，而非 evidence 丢失。修复后，TCB 按 digest 排序为本次调用生成 `trace-001` 等
短暂 alias；模型只接收 alias 与 diagnostic bundle、只返回 `traceId`，TCB 验证后映射回真实 digest 写入
归因 artifact。模型请求不再含真实 digest；unknown/repeated alias 或不存在的 event/test anchor 仍 fail-closed。

Agent Debugger artifact protocol 升为 v2。repair4 保持冻结审计证据；repair5 尚未启动，故其预注册源码直接
采用 v2，但启动前仍须提交以冻结源码身份。验证通过：attributor HTTP 契约覆盖无 digest prompt、正确映射、
伪造短 ID 与伪造 anchor 拒绝；durable iteration attribution 路径、`pnpm exec tsc -b` 通过。这只证明协议
可靠性，不证明 live model 的诊断质量或子代成功率。

**启动记录（2026-09-09，用户授权）**：以独立 session 启动
`DSH_TREE_V2_FORMAL_VARIANT=repair4` + `DSH_TREE_V2_LIVE_CONFIRM=confirm`
的 `record-tree-v2-k80-formal-live.ts`（launcher PID 622816）。启动日志已依次确认 pinned
task extraction、offline verifier image build、`dsh-evolve init`、`doctor`，并进入
`dsh-evolve run`。冻结 `run.config.json` 已核对为 repair4 的 runId/masterSeed、Agent Debugger
`maxOutputTokens=32768`、`attributionTokens=16000000`、`attributionCalls=80` 与
`wallClockSearchMinutes=3600`。该记录只说明 run 已启动；尚无 baseline/search/admission 或效能结论。

## 2026-09-09 repair3 搜索观察与后继修复（历史观察；run 已停止、未改写）

运行中的 `tree-v2-k80-formal-repair-3` 保持原 manifest、journal 和 evidence；本次只修改
工作树，**不会注入、重启、停止或改写该 run**。截至观察时，前 4 次 Agent Debugger action
均为已结算的 empty-content 失败（每次用尽冻结的 8,192 completion-token 信封），因此没有
admitted `failure-attribution+json`；proposer 使用的是普通 failure index、raw trajectory 和
diagnostic bundles，而不是 debugger 诊断。原始证据仍完整保留，问题是归因调用的输出信封被
过大的历史 trace 批次耗尽。

另发现 native proposer 的单一 DSH session 未把 profile 的 `maxTurns=24` 绑定到
`agent/pre-step`，故不能限制 session 内的模型/工具步骤；以及 native prompt 没有明说
solve-policy 的唯一输入是 `{ protocol, turn, step }`，使子代错误地设计为依赖工具历史、写入数、
deliverable/verifier/controller 状态的门控（该状态在 runtime 中不存在）。

后继 runtime 修复记录于 ADR-061：native proposal 现有 48-step fail-closed pre-step 上限；prompt
明示真实 workflow 协议；debugger 对单请求保留所有能放入冻结输入信封的 trace，并将后继默认
输出信封由 8,192 提至 32,768 token；完整 trace inventory 仍照常导出。repair3 的 8,192-token
profile 保持冻结不变。

**ADR-062 后继 solve-policy 修复**：此前子代虽由真实 Loader 装载，但其 workflow 只收到
`{protocol,turn,step}`，而多种 gate 读取并不存在的 retry/output/deliverable 字段，故在 live solve
退化。后继协议升至 `candidate-solve-policy/v2`：TCB 在不暴露命令、路径、文件/终端内容或
verifier/controller/budget 的前提下，提供 prior-tool 的计数、动作类型、粗粒度 exec outcome、连续重复
exec 与写后未 exec 摘要。候选仍只能输出 bounded checkpoint。此为新 runtime/new run 的协议变更，
repair3 不改写或重评。验证：scanner 新增 unavailable-state 拒绝契约；native tool/agent 测试覆盖
内容不泄露、v2 input、重复 exec/写后 exec 摘要；targeted 49 tests、`pnpm exec tsc -b`、真实 Loader
subprocess 2/2 均通过。native live-solve E2E 因本机未设置其显式 integration gate 而跳过，尚未形成
新的 paid live efficacy 结论。
已通过 targeted Vitest（native-proposal、agent-debugger、feedback、iteration/driver）与
`pnpm exec tsc -b`。这只验证后继代码路径；必须以新的冻结 run 的 paid attribution smoke
验证真实模型能返回 JSON，不能把它当作 repair3 或子代成功率已提升的证据。

## 2026-09-09 ADR-057：repair3 单次 baseline 与 failure pool 冻结（未启动）

用户授权为新的 repair3 search run 将 baseline 从 49×2（98 次）暂时改为 **49×1（49 次）**：
`k80Repair3` 是独立预注册 profile，保留 K=80 的 search/tournament/budget 包络，并冻结
`concurrentTrials=12`、`benchmarkBaseline={taskCount:49,attemptsPerTask:1,batchSize:12}`。repair2
的 `k80` 49×2 profile、run manifest、trial verdict 与 failure pool 均未改写或复用。

pool 语义不变：完成矩阵后，zero-success task 进入 pool；在 A=1 下这正是「唯一一次 baseline
attempt 真实失败即入池」。缺失、损坏或 infra-dead 仍 fail closed，不能把非能力事实静默当失败样本。
该 49×1 仅是有明确标签的 search 成本校准，不能替代原正式 K=80 的 49×2 稳定性证据或用于该项达标声明。
尚未启动 repair3，也没有产生新的付费 trial。

repair3 冻结启动参数（预注册）：RUN_ID `tree-v2-k80-formal-repair-3`、MASTER_SEED
`tree-v2-k80-formal-repair-3-master-seed-1`、profile `k80Repair3`；evidence 根
`evidence/tree-v2/k80-formal-repair-3/`；scratch 根
`/root/vibe/dsh/scratch/dsh-tree-v2-k80-formal-repair-3/`。ADR-056 debugger 随 repair3 冻结：
route `deepseek/zen-compatible`、maxOutputTokens 8 192、requestTimeoutMs 180 000、
maxInputBytes 524 288（与 TCB 冻结默认逐字一致）；`attributionCalls=80`（≤ proposalCalls 60
加余量）、`attributionTokens=16 000 000`（≥ 80 次 × 完整信封预留 139 264 token/次）。
ADR-058：`wallClockMinutes=4560`、`wallClockSearchMinutes=3600`（搜索 60h；tournament
960min / sealed 720min / $500 / +5pp 不变）。
record 脚本新增门：冻结 config 的 agentDebugger/attribution 必须与 profile 逐字一致；
run 结束后 attribution 两维必须 settled 且不超预算。

**启动门记录（2026-09-09）**：预注册提交 `82dbbe8`
（`82dbbe8bafd2e2ec159353d713bd8c33990f74af`，49 files / +4662 −437）；`tsc -b`
通过；vitest 全绿 785 passed / 29 skipped（71 files，~6.5min）；真实 Loader E2E
单独复跑通过（loader-spike subprocess + candidate-sdk harness，17 tests）；
环境门：credential 0600、pinned tarball/CLI/native DSH lock/harbor 就绪、fwd 容器
Up、17897 egress 代理在听、repair-3 scratch/evidence 无冲突。**尚未启动**
（等用户确认；repair-2 残留孤儿容器 `extract-moves-from-video__rwkwsap__env-main-1`
已按用户指令停掉）。

## 2026-09-09 ADR-058：repair3 搜索相位墙钟 1800 → 3600 分钟（未启动）

用户指令：搜索墙钟改到 60h。依据是 ADR-054 wave 构造修复后的节奏推算——每 3-child 周期
≈ 1.6–2.2h，80 children ≈ 27 周期 ≈ 45–60h；ADR-048 冻结的 30h 搜索相位会在 ~25–40
children 处以 BUDGET_EXHAUSTED 终止（repair-2 即此路径，12/80 停止）。

**改动**：repair3 搜索份额 1800 → 3600 min；run-config 信封 `wallClockMinutes` 2760 →
4560（3600 搜索 + 960 tournament）。搜索份额成为可选预算字段 `wallClockSearchMinutes`
（缺省 = ADR-048 冻结的 1800，`k80` 49×2 profile 逐字不变）；driver 的 tournament 墙钟
预算 = wallClockMinutes − wallClockSearchMinutes。schema wallClockMinutes 上限 2880 →
4560；record 脚本进程包装 47h → 77h、scope.phasedWallClock 冻结 3600/960/720（总
5280min）、冻结 config 门新增 wallClockSearchMinutes 逐字比对。tournament 960min、sealed
720min、$500 与 +5pp 门不变。这是 specs/00 §6.3 的第三次显式修订（ADR-045、ADR-048 之后），
未静默缩小协议（rule 9）；60h 是投影上界，run 仍可能在 K=80 前合法 BUDGET_EXHAUSTED。

**启动门记录（2026-09-09）**：修订提交 `a9b04b3`（13 files / +219 −32，凭据扫描 0 匹配）；
`pnpm build`（tsc -b）通过；vitest 全绿 787 passed / 29 skipped（71 files，~6.7min）；
真实 Loader E2E 单独复跑通过（17 tests）；diff 自查仅含 ADR-058 改动（无 codex 并发产物）。
**尚未启动**（等用户确认）。

## 2026-09-09 ADR-059：付费 Harbor smoke 预注册 + sealed one-shot 处置接受（smoke 已授权）

用户两项裁决（2026-09-09）：

1. **付费 harbor smoke 跑一下**——正式启动前先执行一个预注册的最小付费 live run，
   验证完整 tree-v2 trial 路径端到端可用（真实 Harbor job → tree-v2 baseline capsule →
   17897 egress 代理 → TCB gateway → 真实 deepseek-v4-flash route → 任务自带 verifier →
   receipt chain settle）。
2. **接受 sealed one-shot 路径在 repair-3 的处置**——repair-3 沿用 ADR-048 已预注册的
   one-shot 处置（CANDIDATE_LOCKED 后 sealed 一次性揭盲、绝不测第二名）；不新增门，
   本文档只记录接受。

**smoke 预注册（新 profile `treeV2Smoke`，scripts/lib/tree-v2-live-profile.ts）**：
K=1、coldStartTrials 1、shortlistSize 2、maxSolverTrials 4、maxDiscoveryTrials 1、
discoveryBatchSize 1、proposalWidth 2、taskTrials 4、wallClockMinutes 120、
solverTokens 8 000 000、concurrentTrials 1、benchmarkBaseline
{taskCount:2, attemptsPerTask:1, batchSize:1}（冻结 ceremony 的前两个 observed handle）。
无 tournament / sealed / debugger（stable-demo profile 类）。合法终止态
K_REACHED（trials=3：2 矩阵 + 1 冷启动）或 NO_REAL_FAILURE_SIGNAL（trials=2：矩阵全成、
pool 空）。最坏 ≈ 4 trials：solver 单试次被冻结 gateway 独立封顶（48 requests / 2M tokens /
$0.30）→ $1.20，加一次真实 proposal（proposalCalls=20、proposerTokens=20M 上限）。

**ADR-059 修订（2026-09-09，attempt 1 事后）**：attempt 1 在 doctor 的
`search-calibration` 门停止，**零付费调用**——`best-case pool supply 2 < minimumTrials 3`
（1×1 矩阵供不起 final expansion gate：minimumTrials = finalGate 1 + q0×shortlist 2 = 3，
供给 = 矩阵 1 + K×taskCount 1 = 2）。fail-closed 预检按设计拒绝了未校准的预注册。
修订：矩阵 2×1（供给 2+2=4 ≥ 3）；shortlistSize 保持 2（schema 下限）。record 脚本的
verifier allowlist 改由 `benchmarkBaseline.taskCount` 派生（1×1 草稿曾按 discoveryBatchSize
截取）。终止形态相应改为 K_REACHED(3) / NO_REAL_FAILURE_SIGNAL(2)。

身份与证据：RUN_ID `tree-v2-smoke-live-1`、MASTER_SEED `tree-v2-smoke-live-1-master-seed-1`、
evidence `evidence/tree-v2/smoke-live-1/`（smoke-live-run.json + STATUS.json，kind
`smoke-live-run`）。record 脚本 `scripts/record-tree-v2-smoke-live.ts`（k3 脚本克隆）：
付费门（DSH_TREE_V2_LIVE_CONFIRM=confirm）、credential 0600 门、scratch mkdtemp
（`dsh-tree-v2-smoke-live-1-`）、≤1800s 过滤（89→72）、ceremony + verifier 镜像
allowlist=前两个 observed handle、init 冻结 config 与 smoke profile 逐字比对
（含 2×1×1 矩阵与 concurrentTrials=1）、doctor、run（进程包装 2.5h，run 自身 2h 信封
先触发）、逐 trial receipt chain 校验、trajectory 非空且非 replay 标记、
receiptUsageMatchesSettlement、oneTokenFilePerTrial、证据消毒复制 + 凭据/token
redaction 扫描。smoke 的单次 development trial 不进 repair-3 的 proposer/archive，
不构成任何提升声明（ADR-059 明确 scope.smokeFor='tree-v2-k80-formal-repair-3'）。

**启动门记录（2026-09-09）**：预注册提交 `571e1e6`（5 files / +991 −1，凭据扫描 0 匹配）；
`pnpm build`（tsc -b）通过；vitest 全绿 790 passed / 29 skipped（71 files，~6.6min，含
smoke profile/envelope 新测试）；真实 Loader E2E 单独复跑通过（loader-spike subprocess +
candidate-sdk harness，17 tests）。环境门：credential 0600、pinned tarball/CLI/native DSH
lock/harbor 就绪、fwd 容器 Up、17897 egress 代理在听、evidence/tree-v2/smoke-live-1 无冲突。
**已启动**（2026-09-09，PID 459427，detached + 持久 TMPDIR，日志
`/root/vibe/dsh/scratch/tree-v2-smoke-live-1.log`）。

**smoke 结果**：attempt 1（PID 459427，2026-09-09）：doctor `search-calibration` ✗ →
fail closed，$0，无 evidence 写入；scratch 保留于
`/root/vibe/dsh/scratch/dsh-tree-v2-smoke-live-1-DaONEB`。attempt 2（PID 472999）：
doctor 绿（2×1 修订通过校准）→ `run` 在 `ensureBaseline`/`mockReplay` 崩：
`service "candidateWorkflows" has been registered at
<dsh-evolve-le:candidate-workflow-stub>`——ADR-054 的外层 stub 与 native-solve-agent
的 per-Fiber 新鲜 registry 在 Cordis 禁止祖先服务重 provide 语义下结构互斥；**$0**，
无 evidence 写入；76h run 的每个 live trial 都会在同一行崩——smoke 抓到了全量套件
（从不真正执行 native-turn-probe）漏掉的断路。已修复：ADR-060（runner 复用外层 registry、
stub 保留完整 workflow 对象）。attempt 3（PID 499321，ADR-060 后）：**全绿** ——
K_REACHED、trials=3（2 矩阵 + 1 冷启动）、expansions=1（真实 proposer）、2950s、
123 requests / 2 156 366 tokens、record failures=[]、allPassed=true；结算 usd
516 633 µUSD（$0.52，solver receipts $0.31 + proposer）；矩阵 rewards [0, 1]
（adaptive-rejection-sampler 失败、break-filter-js-from-html 成功）、冷启动 reward 0；
evidence 落盘 `evidence/tree-v2/smoke-live-1/`（smoke-live-run.json sha256
`29051f344c0b61f01ebdf34cba14b68116d059c1007c89224013fd5d97dc88f4`）。smoke 端到端
验证了完整 live 路径：真实 Harbor job → capsule boot → 17897 egress 代理 → TCB
gateway → deepseek-v4-flash live 路由 → 任务自带 verifier → receipt chain settle，
以及真实 proposer 提案 + 子代构建 + q0 冷启动。ADR-060 修复在生产路径验证通过。

## 2026-09-09 ADR-060：外层 workflow stub × per-Fiber registry 冲突修复（smoke 抓获）

ADR-054（82dbbe8）给 native capsule 加了外层 `candidate-workflow-stub`（候选插件在
Loader 激活时可发布 workflow 声明），native-solve-agent 仍按 82dbbe8 前的设计在每个
agent Fiber 上新鲜 provide `candidateWorkflows`——Cordis 的 Fiber state 复制根作用域且
禁止对祖先已有服务重复 provide，两者互斥。任何单测/Loader 测试都没有同时 boot 过 stub
与 solve agent（builder 测试只断言 probe 文件被打包、从不执行），套件因此一直绿；付费
smoke attempt 2 在 mockReplay 抓到（$0）。

**修复**：native-solve-agent 检测到继承的 registry 时直接复用（register/snapshot 走
stub；继承服务不可用则显式 fail closed）；stub 保留完整 workflow 对象（name +
description + run），固定 solve-policy 钩子仍可执行；declaration-only 记录在 TCB
过滤器跳过。TCB 仍只执行 `candidate-workflow:solve-policy`；候选注册/反注册语义不变
（effect-scoped unregister 使 stub 数组回到基线，mockReplay 的 unload 检查保持诚实）。
无 stub 的作用域（单测 fixture、82dbbe8 前 capsule）保留新鲜 provide 路径。
native-solve-agent 单测 12/12（新增 2 个：复用路径经外层 registry 执行 solve-policy
checkpoint 且不重复 provide；declaration-only 记录不装 listener）。

## 2026-09-09 K=80 正式 run 启动记录（repair-3，用户授权 直接启动）

用户指令「直接启动 k=80 run repair 3，然后每 30 分钟汇报进度」——接受已知容器测试
超时说明（ADR-060 后全量套件 761s 有 2 个容器测试宿主机争用超时，隔离重跑 5/5 绿）。
启动门核对：预注册已提交（571e1e6/659d67b/54f9b7b/815f447）、付费 smoke 全绿、
credential 0600（36B）、egress 代理 172.17.0.1:17897 LISTEN、fwd 容器 Up、工作树
干净、无残留 scratch/evidence（全新 run）。

启动：`DSH_TREE_V2_LIVE_CONFIRM=confirm TMPDIR=/root/vibe/dsh/scratch/tmp setsid
nohup node --import tsx/esm scripts/record-tree-v2-k80-formal-live.ts`（PID 10597，
启动日志 `/root/vibe/dsh/scratch/k80-formal-launch.log`）。RUN_ID
`tree-v2-k80-formal-repair-3`、MASTER_SEED `…-master-seed-1`、profile
terminal-bench-formal（K=80/q0=3/shortlist=5/width=3、baseline 49×2×8=98 trials、
tournament 294、sealed 23×5×2=230、wallClockMinutes 2760）。脚本依次通过
live-confirm → tarball 提取 → verifier 镜像构建 → init → doctor → `dsh-evolve run`。
进度每 30 分钟汇报；终止后按 ADR-046..049 记录终局（含 sealed 一次性裁决）。

## 2026-09-09 ADR-056：LLM Agent Debugger 归因证据与可审计调用

已为后继 run 实现可注入的 TypeScript Agent Debugger：Harbor collect 将 ACP
事件与 CTRF verifier 结果压缩、脱敏为内容寻址 diagnostic trace bundle；受冻结
route 的 LLM attributor 只能输出带 bundle event/test 索引锚点的严格 JSON，结果经
验证后写为 `failure-attribution+json` 并由 `failure-index/v1` 引用。proposer 看到的是
label-filtered DEV_OBSERVED bundle、failure index 与归因结果，且提示词要求把摘要视为
非指令性证据并回查锚点。

该归因不会改变 reward、retry、任务选择、Thompson/Archive 或 sealed 流；
`never-initialized` 仍是账本中的失败、但不导出为 candidate-actionable evidence。repair-2
和其他已冻结 run 未被改写。此前对 repair-2 原始记录做过一次独立的 live debugger
示例（仅用于检查输出；不改变 repair-2）；后续代码修改没有发起新的付费调用。

现已将生产调用接入 controller action saga：新 run 必须冻结 `agentDebugger` 的 route、8,192
输出 token、180s timeout、输入上限，以及独立的 `attributionCalls` / `attributionTokens`。
intent/预算 reservation、launch marker、成功/失败 receipt 和 budget settle 均追加落盘；超时、网络
失败和崩溃恢复按未知费用吃掉完整预留且不会重放。若服务端返回空 `content` 但带 usage（reasoning-only
耗尽 token 的已知形态），现在会记为已知计费失败而非免费失败。Harbor `event_type` 也已纳入
diagnostic bundle 的事件分类，超大单 bundle 不再突破 debugger 的输入上限。

验证：controller 成功/超时/launch 后崩溃恢复 3 条契约均通过；Agent Debugger 有效锚点、伪造锚点、
空 reasoning 回复计费 3 条通过；driver 端到端断言 receipt → attribution artifact → failure index →
proposer export，且不会走旧 direct-store 旁路；TypeScript check 与 `git diff --check` 通过。
这只证明闭环与失败归因格式正确，尚未运行 repair3，不能声称子代多样性或成功率已提升。

## 2026-09-08 正式 K=80 `NO_ADMISSIBLE_CHILD` 复盘与 raw-child 修复

正式 run `scratch/dsh-tree-v2-k80-formal/runs/tree-v2-k80-formal/` 的权威
`drive-report.json` 已记录 `STOPPED:NO_ADMISSIBLE_CHILD`：search trial=98（即 49×2
baseline）、admitted non-baseline=18、expansionAttempts=13、连续 expansion failure=3/3；未进入
tournament、candidate lock 或 sealed reveal，故仍为 **`NO_SEALED_RESULTS`**。

复盘 `search-state.json`、proposal sandbox 原始子树和 transcript 后确认：17 个逐子代拒绝中 16 个是
`import/unresolved`。根因不是 benchmark trial，而是 proposer 工具的树语义不一致：`proposal_finish`
把 `parentSourceFiles + raw child files` 的合并视图交给 stage-6 测试，随后 controller 却只扫描 raw
child tree。模型把子代当 patch 写入时，合并测试会绿，而继承的 `src/mechanisms/*`、测试或 `tsconfig.json`
未落入 raw tree，最终在 admission 被拒；第 13 次扩张的两个子代正是该路径，触发协议冻结的 3 次连续
失败上限。

修复（TCB，契约测试先行）：

- `writeChildFile` 对每个 child 的首次写入先从受信任的 `input/parent-files.json` 物化完整父源树；这不消耗
  proposer 的 model-write/file cap 或 access-log 配额，模型仅覆盖修改/新增文件。
- `finalizeProposal` 在任何 candidate-test（含 recorded route）之前检查 raw child 是否含全部父文件；缺失时返回
  可修复的 tool error，且不启动合并测试。提示词同步为“完整父树已由 TCB 初始化”。
- 回归测试覆盖首次写入的完整物化，以及删除 `tsconfig.json` 时在测试运行前的拒绝；定向 41/41 通过，
  `tsc --noEmit`、Prettier、diff check 通过；全量 `pnpm test`、lint、format、build 均成功。

**续跑判定：不可在该 formal run 原地继续。** 它已按冻结的 `maxConsecutiveExpansionFailures=3` 达到
`NO_ADMISSIBLE_CHILD`，specs/03 要求不得再调用 proposer；本修复也改变了 proposer TCB/worker runtime，不能
改写旧 run 的冻结 manifest、journal 或证据树。specs/06 要求新 runtime 使用新 run directory，旧 run 保留。
新正式 run 允许跨 run 内容寻址去重 immutable objects，但 specs/04 §4.4 只允许复用**同一 manifest**的 baseline
结果，且 trial identity 包含 run 与 protocol hash；因此旧的 98 个 baseline verdict 不可作为新正式 run 的
baseline evidence。可复用的是镜像、CAS objects 和经重新验证的候选/构建缓存，不能复用旧 trial 记分。

**record 脚本证据门 FAILED（诚实记录，三类根因已逐一定位）**：正式 run 的 k80-formal-run.json
`failures` 非空、allPassed=false、scratch 按失败策略保留，evidence 已落盘
`evidence/tree-v2/k80-formal/`：

1. `trialCountWithinThePreRegisteredEnvelope`：trials=98 discovery=98 admittedNonBaseline=18
   → ordinary = 98 − 98 − 18×3 = **−54 < 0**。机制：98 baseline 完成后 UCB-Air 扩张门
   `98^0.8 ≈ 39 ≥ admitted(19)` 持续判 expand，13 次扩张全部发生在首个 evaluation wave 之前
   （16/17 `import/unresolved` + 1 `secret/aws-key` 设计内拒绝），3 次连续失败触发冻结上限——
   18 个 admitted 节点**零冷启动 trial**，违反「每个 admitted 节点带 q0 cold-start trials」的
   预注册记账不变式；检查按 ADR-042/049 信封 fail closed（非检查 bug，不放松）。
2. 13 个 baseline trial 的 `trajectoryNonEmpty` + `receiptChainVerifies` 失败：全部
   `NonZeroAgentExitCodeError` 死于 **agent setup**（ACP 容器内 apt-get 安装 python3/pip），
   9/13 含 egress 代理 **502**（`http://security.ubuntu.com`、`http://archive.ubuntu.com` →
   `502 Bad Gateway [IP: 172.17.0.1 17897]`），4/13 无 502 字样但同一条 setup 命令 exit 100。
   分布 10:46、11:03、16:21-16:50、17:14-17:16 CST 多个窗口（a1/a2 混合：qemu-alpine-ssh a1+a2、
   qemu-startup a1×2、guard-03 a2、guard-09 a1 等）。agent 未启动 → 无 trajectory、无 receipts；
   按 rule 7 记失败、不重试（infra 归因但非预注册可重试类）。时间线注：17:14 窗口 = a2 首波
   （12 个 setup 失败里的多数）。
3. `noGuardTaskNameInAnyArtifact`=60 + `noSealedTaskNameInAnyArtifact`=23：证据制品携带
   guard/sealed 真名——`image-prefetch.json`（按任务命名镜像：9 guard + 22 sealed）、run 文档
   自身 tasks 列表（9 guard）、guard trial 自身的 `trial-result.json` 与 object 副本（`task_name`
   含真名；guardHandles 无 `terminal-bench/` 前缀使 `includes()` 子串命中）。concealment
   （ADR-046 消毒）未覆盖这些制品副本。**sealed 名只出现在证据树**（`evidence/*` gitignore、
   不入 git；driver 全程只见 opaque id，从未进入 proposer/selector/archive；正式揭盲机制未触发，
   仍为 NO_SEALED_RESULTS）——本条目是 rule 5 相关的一次披露与 record 脚本拷贝集缺陷，不是搜索
   过程泄漏。

**正式 run 总账**：~$60/$500、35320s（09:12→19:00:37）、98 trials（85 有 receipts + 13 setup
失败）、0 tournament / 0 sealed、RUNNER 正常退出（record FAILED）。raw-child 修复（ADR-050）已
落工作树并全量验证（41/41 定向 + 全量 pnpm test/lint/format/build 绿）。

**repair-1 正式 run（ADR-051 预注册，用户补授权继续）**：`tree-v2-k80-formal-repair-1` 于
2026-09-08 **19:35:50 CST** 由 30 分钟监督 cron 的 auto-resume 启动——当时 record 脚本已被改为
repair-1 常量（并发 12、batchSize 12、新 RUN_ID/MASTER_SEED），**该启动没有先验用户授权**
（cron 是按已停止的 formal run 挂的 resume 指令；脚本里的「user-authorized」注释失实，已改正）。
用户于 ~19:55 CST 审查运行状态后**授权继续**，并以 ADR-051 作为事后预注册（信封、预算、K=80
协议全部不变，仅波宽 8→12 + schema/CLI 上限同步放宽）。监督教训：auto-resume 指令必须校验 run
身份（RUN_ID/MASTER_SEED）再重启，且不得重启协议输入与挂载时不同的 run。

## 2026-09-08 K=80 formal repair-1：12-way 新 run 预注册与启动授权

用户授权在修复后重跑，并指定 **12 并发**。旧 CLI/schema 的上限是 8，不能静默降级；现已把受控范围改为
1..12，并为新的正式 repair run 单独冻结：`RUN_ID=tree-v2-k80-formal-repair-1`、
`MASTER_SEED=tree-v2-k80-formal-repair-1-master-seed-1`、`concurrentTrials=12`、
`benchmarkBaseline={taskCount:49,attemptsPerTask:2,batchSize:12}`。其余 K=80 search/tournament/sealed
预算、任务集和协议不变；新的 scratch/run/evidence 根避免覆盖 stopped run。`batchSize=12` 与 wave width 对齐，
所以 49×2 baseline 也会实际使用最多 12 个并发 job。Docker verifier image cache、immutable CAS object 和可重验
candidate/build artifact 可以跨 run 去重；旧 trial verdict 不进入新 run。

启动前验证：repair-12 配置契约、既有 live-profile/CLI 契约共 83 passed（23 环境依赖 skipped），`pnpm build`
与 Prettier/diff check 通过。脚本启动时先校验 credential、native DSH lock、pinned dataset、已有 image receipts
与 Harbor doctor；这些检查失败均在 paid trial 之前停止。

**启动事实（2026-09-08）**：镜像准备命中宿主 Docker cache 后完成；init 与 doctor 通过，detached
`dsh-evolve run` 已启动。新 manifest 已冻结为
`sha256:abc8c6cf7050f86b2939f4d58fce4d7708f19e6744ce7b1604cf4bbdd2934f32`；启动后首次只读 status 为
`PREFLIGHT`、controller seq=1、0 action/0 trial，尚未发生任何付费评测。后续状态以该 run root 的
manifest/journal/report 为权威。

## 2026-09-08 ADR-052：K=80 三类终止根因的代码级修复（未启动新的付费 run）

原 formal/repair-1 manifest 不在原地修改。ADR-052 的实现已把下一次启动 identity 改为
`tree-v2-k80-formal-repair-2`（新 seed/scratch/evidence 根）；**本次只改代码、规范与契约测试，未
调用 paid `dsh-evolve run`、resume 或 sealed-evaluate**。

1. search scheduler：已 admitted 但尚欠 `q0` 的节点先完成 cold-start；连续 proposal failure cap
   只关闭新的 expansion，不能跳过这些既有 q0 obligation。于是达到 cap 后先清偿 q0，随后才
   `NO_ADMISSIBLE_CHILD`，不再产生 admitted=18 / cold-start=0 的负信封形状。
2. apt/egress：`NonZeroAgentExitCodeError` 仍是 FAIL（不能整体升格 retry）；host forwarder 对幂等
   GET/HEAD/OPTIONS 的 500/502/503/504 与连接失败采用 1+8 bounded retry，POST 不重试；配置代理的
   formal launcher 在首次付费 action/P0 resume 前对同一 docker0 listener 跑 12 路 HEAD preflight。
3. evidence：所有 public artifact 都走同一 bare + `terminal-bench/` qualified guard/sealed 名字消毒；
   `image-prefetch.json` 改为 hash/size/image-count attestation，artifact 文件名、正文、最终 run 文档和
   STATUS 都纳入 residual-name scan。raw run root 仍为受控权威证据。

已验证：新增 q0 调度回归、evidence sanitizer、forwarder loopback retry/POST/probe/CONNECT 契约通过；
`pnpm build`、`tsc --noEmit`、本次修改文件的 Prettier check 和 diff check 通过。全仓 `pnpm lint`
与全仓 `pnpm format:check` 仍分别因 HEAD 已有的未使用 import/parameter 与 35 个既有格式文件失败，
与本次修复无关，未顺手改动。

## 2026-09-09 ADR-053：post-commit harbor 重写事故 —— committed 重收集守卫（修复中正式 run 的 TCB 变更，显式记录）

2026-09-08 深夜宿主机重启打断了 repair-2 attempt 1 wave 4 的 mid-collect（8 个 action 已有
receipt、未提交，specs/06 §13 row-6 崩溃窗口）。恢复时我先对所有含 interim result.json 的
jobDir 重启 harbor，未先对照 journal 的 action.committed 集合——其中 3 个
（adaptive-rejection-sampler、filter-js-from-html、extract-moves-from-video）属于**已 COMMITTED**
trial，harbor 重跑（少量未入 controller 账本的 API 支出）并重写了 provider 字节；幂等 resume
重走时 collectAndCommit 经 row-6 路径重取字节、与已存 envelope 摘要不符 → ControllerError
（fail closed，行为正确；事故责任在运维性重跑，不在 store）。

修复：collectAndCommit 对 COMMITTED 短路（与 runEvaluation 对称）——已提交 observation 是最终
事实，其 provider jobDir 是 store 哈希链之外的 harbor 原始输出，事后重写不得击垮健康 run；
row-6 receipt-without-commit 窗口保留。3 个原始 trajectory envelope 已从 object store 摘要校验后
恢复；重跑产物弃用。永久运维规则：任何 harbor 重启前先查 journal 的 action.committed 集合，
已提交 trial 的 jobDir 绝不重启 harbor，仅未提交且 result.json 缺 finished_at 的才是候选。

验证：契约测试 `never re-collects a committed action whose provider bytes changed`（重开后
provider 字节改写、wave 重跑：observation 不变、journal 事件数不变、无重复提交）；controller
套件 26/26；tsc -b 绿；重启后的 record 进程即运行含守卫的构建。

**进展（2026-09-09 00:18 CST）**：attempt 1 已 49/49 提交（20 success / 29 failure，
guard-10/tune-mjcf 为第 20 个 success）；attempt 2 已开始：batch 1 共 12 trial 于 00:04:23 CST
（journal occurredAt 为 UTC：16:04:23Z）预占、12 路 harbor 并行启动（容器 StartedAt 16:04:31Z
吻合），fix-git-a2 于 00:07:56 CST 完成、00:18 又有两路 job 完成进入收集；预算台账 usd 累计
≈ $72.37（µUSD 求和，含预占与结算条目）。

## 2026-09-09 repair-2 search 只读诊断与 successor 修复（ADR-054；未改 repair-2）

对 `tree-v2-k80-formal-repair-2` 的冻结 manifest、journal、search-state 和可见 Harbor
terminal facts 的只读检查显示：baseline 为 49×2=98、其中 43 success；冻结 failure pool 有 14 个
zero-success observed handles。前三次 proposal 产生 9 个 child，均通过 trusted build/admission；
因此「低 trial 成功」不是 proposer 不能生成可准入 bundle 的问题。首批已完成 child cold-start 为
9/84 pass，但它们全部来自这 14 个 baseline 0-success handle；将其直接和全矩阵 baseline 的 43/98
相比较不成立（同一 pool 上 baseline 是 0/28，按定义）。

同时确认三个会降低后续探索质量的 controller 路径，已按 ADR-054 以契约测试先行修复到**后继
controller build**：

- wave 内维护 virtual pending q0 reservation，12 并发下 `q0=3` 不会把同一 child 排成 12 个
  cold-start；回归用例固定为 baseline=8、child q0=3 时总 trial=11，而旧实现为 12；
- Harbor 明确标记 `agentParticipation=never-initialized` 的失败仍在 trial ledger/failure pool 中
  计 FAIL，但不会作为 candidate-mechanism evidence 导出给 proposer；
- parent Thompson 只统计 frozen failure-pool 的 `dev-observed` observations，root 在 baseline 已
  解 handles 上的分数不再与仅在 pool 上 cold-start 的 child 混合比较。

`strategySurfaces` 的 tools/skills 过度声明是 proposal 叙述/审计质量问题，不是这批低成功率的
执行根因：真实 Loader 已验证 target-mode mounted delta，实际可执行变更为 system-prompt。没有
凭空新增一个无法区分「继承」与「实际修改」的 rejection gate。验证：driver 39/39、tree-v2
finalize/proposer 41/41、`tsc --noEmit` 与 diff check 通过。

**运行边界：** repair-2 的 manifest、journal、object store 与 live process 未被写入、重启或
重跑；ADR-054 的三项语义只能在一个新的、预注册的 successor run identity 上生效，尚未授权/启动
这样的 paid run。

## 2026-09-09 proposer 机制多样性 successor 改造（ADR-055；未启动）

为避免 tree-v2 proposer 在“严格 surface 保持 + 先 admission 后昂贵评测”的反馈下系统性收敛到
static prompt directive，新的 migration root 增加 solve-only
`candidate-workflow:solve-policy`。native solve runtime 在每个 admitted DSH pre-step 调用该
workflow，只接受 ≤2,048 字符的 checkpoint 并附加到本步上下文；它没有 ACP tool、verifier、
controller、budget 或 route 权限。根实现默认无 checkpoint，child 可在不增加 plugin topology 的
前提下演化有测试的 checkpoint/replan cadence。

proposer export 同时新增内容寻址 `failure-index/v1`：只投影 candidate-actionable failure 的
opaque identity、terminal category/participation/exception/request count、引用 digest 与 cluster
support，raw trajectory 仍可读。prompt 要求先读 index；若 parent 宣告 solve-policy workflow，
可信 finalizer 强制 multi-child batch 至少一个 child 声明并演化该 workflow，避免整批 prompt-only。
native spine capsule 另挂载 TCB-only outer workflow registry，避免新 candidate injection 在真实 Loader 启动时
缺服务；每个 native agent Fiber 仍创建独立执行 registry。native solve workflow 契约 10/10、baseline
candidate 5/5、driver/proposer 65/65、tree-v2 finalizer 23/23、实际 successor migration root 的 trusted Builder
十个 admission gate、TypeScript build 均已通过；没有启动或重启 paid run。

## 2026-09-07 ADR-045 K=80 正式信封修正（alpha=0.8、30h 墙钟、400-trial 信封、49×2 矩阵预注册）

ADR-042 校准预检持续拒绝 k80 profile（252-trial 信封）：冻结默认 alpha=0.6 下第 80 个
child 需要 `N ≥ ceil(80^(5/3)) = 1486`（minimumTrials=1501），任何可行墙钟都不可负担。
attempt 3 实测 live 节奏 1447s/trial-slot；并发 8 下 16h 只能容纳约 318 slot，而正式
K=80 强制 trial 量（矩阵 98 + 冷启动 240 + tournament + sealed）需 25-45h。用户确认
四项决策后按 ADR 显式修订（docs/decisions.md ADR-045；specs/00 §6.3、specs/03 §2、
specs/04 §4.2 同步带修订注记）：

- **alpha 预注册 0.8**（`ucbAirAlphaPerMille: 800`，profile 新字段）：finalGate=
  ceil(80^1.25)=240、minimumTrials=255 ≤ 400；搜索节奏由 q0=3 冷启动驱动，评估深度由
  延后的 tournament 覆盖。specs/03 §2 禁止临时改 alpha——预注册 ADR 修订是合规路径，
  校准拒绝条款本身不变（0.6 形状仍 fail closed：1501 > 400）。
- **墙钟 16h → 30h**（`wallClockMinutes: 1800`）显式修订 specs/00 §6.3（推翻 ADR-031
  对 16h 的保持）；$500 目标不变。
- **信封**：maxSolverTrials/taskTrials 252→400、solverTokens 504M→800M（保持
  taskTrials × 2M 不变式）、proposalCalls 20→60（~50 次扩张 × attempt 3 实测
  ~1.67 admitted/扩张）、proposerTokens 20M→60M、concurrentTrials 4→8（走专用
  `--concurrent-trials` CLI flag，非 --set 键；CLI 1..8 上限内）。
  kTarget/q0/shortlistSize/proposalWidth = 80/3/5/3 不变，maxDiscoveryTrials=12
  休眠（同 k10）。
- **矩阵**：live profile 携带过渡 observed-only 39×2×8；本 ADR 预注册正式 49×2
  （39 observed + 10 guard = 冻结 ≤1800s 资格策略下全部合格 development 任务），
  显式修订 specs/04 §4.2 原「60 tasks」并披露。
- **k3/k10 冻结值不变**：四个新 profile 字段均为可选，缺省 = 冻结默认值，k3/k10
  的 init args 保持字节级一致（契约测试固定）。

校准算术（契约测试固定）：alpha=0.8 → 240/255 ≤ 400 ✓；矩阵界 39×2+80×3=318 ≤ 400 ✓；
最佳供给 78+80×39=3198 ≥ 255 ✓；ceremony 检查 39 ≤ observed split 39（恰在界上）✓。
成本披露（attempt 3 实测 ~$0.14/trial）：搜索 400×$0.14≈$56 + proposer≈$15 → ~$71；
延后的 tournament（~300 trial ≈ $42）与 sealed（后续 ADR 预注册预算）合计仍远低于
$500 ✓。预注册：maxSolverTrials === taskTrials 时搜索耗尽信封报 `TRIAL_CAP`（driver
检查顺序在预算失败之前）。

**延期清单（任一未落地前禁止付费 K=80 启动，fail-closed 由「无 launch 路径」保证）**：
dev-guard 波次 + concealment（SAFETY_ABORTED）；tournament/champion + sealed
k_sealed 预注册；schema `benchmarkBaseline.taskCount` 48→49；`record-tree-v2-k80-live.ts`
（对称 k10，校验四个新字段）。实现：契约测试先行（calibration 0.8 金值 + 0.6 拒绝保留、
preflight 72-handle 接受、profile 字段与 args carrier 固定），红→绿→文档→全量套件。

## 2026-09-07 ADR-045 修订：K=80 过渡彩排（39×2）预注册与启动授权

用户要求「先启动 k=80」。按 ADR-045 修订（docs/decisions.md，2026-09-07）：k80 record
脚本落地（对称 k10，校验 alpha=0.8 / proposalCalls=60 / proposerTokens=60M /
concurrentTrials=8 / 39×2×8 矩阵全部 verbatim 冻结入 config，ADR-043 拷贝集接入），
**授权 observed-only 39×2 过渡彩排**——evidence 文档 `formal:false`，结果只作 development
evidence、不可晋升（rule 6）；延期清单不变，正式 49×2 run 仍被阻断。

**预注册**：

- RUN_ID=`tree-v2-k80-live`、MASTER_SEED=`tree-v2-k80-live-master-seed-1`（全新，未复用）；
  evidence 落盘 `evidence/tree-v2/k80-live/`；
- envelope = `TREE_V2_LIVE_PROFILES.k80`（400/400/800M、alpha=0.8、proposalCalls=60、
  proposerTokens=60M、concurrentTrials=8、wallClock 1800min=30h、矩阵 39×2×8）；
- 预期终止态（全部已注册）：`K_REACHED`、`TRIAL_CAP`、`NO_ADMISSIBLE_CHILD`、
  `NO_ADMISSIBLE_TASK`、`NO_REAL_FAILURE_SIGNAL`、`BUDGET_EXHAUSTED`；
- 成本：现实 ≈ $71（attempt 3 实测 ~$0.14/trial × 400 + proposer ≈ $15），worst ≈ $353
  （每 trial 打满 2M token ≈ $0.84），均 < $500 ✓；
- 校准（预检放行依据）：finalGate=240、minimumTrials=255 ≤ 400、矩阵界 318 ≤ 400、
  最佳供给 3198 ≥ 255、ceremony 39 ≤ observed 39；
- 启动环境同 k10（官方端点 deepseek-v4-flash、TREE_V2_TRIAL_CONTAINER_PROXY
  socat 转发 17897、TMPDIR 持久、setsid nohup + disown）。

**本彩排观察点**（对应风险分析）：a) 新颖性墙——60 次 proposal call 内能否 admit 80 个
不重复机制（attempt 2 在 10 个子代处撞墙）；b) 终点线——TRIAL_CAP 是否像 attempt 3
一样在最后冷启动 pending 时触发（slack 82）；c) 供给——39×2 矩阵下 pool 大小（pool < 4
即结构性饿死）；d) 成本——实测 $/trial 是否漂离 $0.14（长 agent trial 占比）；e) 墙钟——
30h 在并发 8 下的实际消耗曲线。

## 2026-09-07 彩排终止：用户转向直接实现正式 K=80 流程

彩排启动后用户重新评估——彩排与正式共享同一信封与流程，彩排成功也不等于正式成功
（rule 6），正式 run 反正要重跑搜索——判定 ~$71 保险不值 30h 重复，决定终止彩排、
直接实现正式流程并以正式 K=80 run 运行。

**终止时状态**（SIGTERM 优雅拆除，全进程树 + 容器清理干净）：已进入 live 搜索阶段，
8 个 harbor job 记录在案，3 个 trial 在飞行中被拆；search-state
`expansionAttempts=0`，无任何 trial verdict 入账；在飞行 token 消耗极小（未及
$1 量级，无结果可归因）。run root `dsh-tree-v2-k80-live-Eyxq2j` 保留在
`/root/vibe/dsh/scratch/`（ADR-029 模式留证）。彩排 evidence 维持 `formal:false`，
不可晋升。

**方向变更**：延期清单（dev-guard 波次 + concealment、tournament/champion、sealed
k_sealed 预注册、schema 48→49、正式 record script + 49×2 预注册）逐个落地，然后
直接预注册并启动正式 49×2 K=80 run。正式协议（49×2 矩阵、guard 通道、tournament、
sealed 揭盲、+5pp 门）不动。

## 2026-09-07 正式 K=80 流程：ADR-046..049 落定（计划已批准，实现完成）

延期清单以四个 ADR 全部落定（docs/decisions.md append-only，2026-09-07）：

- **ADR-046** dev-guard 波次 + concealment + 信息流监控：baseline 矩阵 39 observed
  段 + 10 guard opaque 段（split `dev-guard`）；failure pool 保持 observed-only；
  bounds 三处同步 observed+guard；`SAFETY_ABORTED` 首次获得发射者；HarborProvider
  attempt>1 放宽（49×2 第二 attempt 的关键阻塞，原实现直接 throw）。
- **ADR-047** tournament/champion：K_REACHED 后（仅 `terminal-bench-formal`）执行；
  资格 ≥12；q10(Beta) 短名单 5（专用 `'tournament'` stream + hash tie-break）；
  覆盖 6 节点 × 49 题 × 1 = 294 trials（guard 结果由此进入 selector）；90% LCB
  cluster bootstrap；champion 三重 hash → `candidate.locked`（一次性）→
  CANDIDATE_LOCKED；`NO_DEVELOPMENT_IMPROVEMENT` 新增 reducer 终止 phase。
- **ADR-048** sealed 计划预注册：**sealed=23 显式披露**（pinned-89 名义 29 vs
  ≤1800s 资格群体 23，rule 9 不静默缩小）、k_sealed=5、23×5×2=230 trials、
  交错随机序、95% CI ≥100k 固定种子；sealed 评估 = 新 CLI 子命令
  `sealed-evaluate`（driver sealedAccess 恒 false）；**分阶段墙钟（用户决策）**：
  搜索 1800 + tournament 960（run config 2760）+ sealed 720（sealed-plan.json）
  ≈ 50-55h 现实 / 65h 上限；specs/00 §6.3 二次显式修订。
- **ADR-049** schema 48→49 + `terminal-bench-formal` profile + formal record
  脚本 `record-tree-v2-k80-formal-live.ts` + 49×2 预注册 + 启动授权。

**预注册（正式 run）**：RUN_ID `tree-v2-k80-formal`、MASTER_SEED
`tree-v2-k80-formal-master-seed-1`、profile terminal-bench-formal、并发 8、
K=80/q0=3/shortlist=5、alpha 0.8、400 trials、baseline 49×2×8=98、tournament
294（max 360）、sealed 230；usd 500M µUSD、taskTrials 760、solverTokens 1 520M、
wallClockMinutes 2760。诚实总数 ≈ 924-1026 trials、≈ $144-160 < $500、
≈ 50-55h。终止态含 CHAMPION_LOCKED / NO_DEVELOPMENT_IMPROVEMENT /
SAFETY_ABORTED + sealed 四态。实现门：契约测试先行 → 全量 pnpm test 绿 →
预注册提交 → 启动（DSH_TREE_V2_LIVE_CONFIRM）。

**实现进度（2026-09-07 晚）**：ADR-046 已实现（契约测试先行：guard 波次 +
concealment + info-flow monitor + SAFETY_ABORTED + harbor attempt>1 放行）。
**ADR-047 已实现，全量单测绿**：`dsh-evolve-le` 包 54 文件 / 632 用例全绿
（52 passed + 2 skipped，含 driver 36/36、tournament+bootstrap 25/25、
reducer+controller 39/39）、tsc --noEmit 干净、prettier 干净。生产语义：
K_REACHED 后（仅 terminal-bench-formal）进入 tournament；资格 ≥12（baseline
恒资格）、q10('tournament' stream) 短名单 5、降级路径（1..4 全进 / 0 合格
top-up 到下限 / 预算不足 → NO_DEVELOPMENT_IMPROVEMENT 零 trial）；覆盖波
`tournament-<nodeIdx>-<batch>-<wave>`（action `tourn-<short>-<nodeIdx>-<task>-aN`，
attempt 延续 pre-tournament 计数——reducer 观察身份是 (candidate,task,split,
attempt)，tournament 试次复用矩阵 attempt 号会硬崩）；guard 覆盖走 opaque
dev-guard + canary；scoring = task-paired delta + 90% cluster-bootstrap LCB
（'bootstrap' stream counter 恒 0，crash 重放逐字节一致，每行 receipt 全入
journal）；champion = 最高 LCB（epsilonPerf 0.01 内 cost→duration→id）；
baseline 胜或 delta ≤ 0 → NO_DEVELOPMENT_IMPROVEMENT（不接触 sealed）；
champion 三重 hash（source||capsule||manifest）→ `candidate.locked`（one-shot）
→ CANDIDATE_LOCKED。crash drill：pool resume 只校验 handle 集（tournament
行不改冻结字节）、tournament 规划只依赖 pre-tournament 观察（resume 重推导
同计划同 action id）、lock 重放恰好一次、relock re-drive 零新增 launch。
**ADR-048 已实现，Phase 3 套件全绿（2026-09-07 深夜）**：sealed 计划生成
23×5×2=230（`'sealed-plan'` stream，order 置换 counter 1、每 cell 独立 seed
counter ≥231，canonical JSON 可字节级 hash）；裁决四门
（completeness 100%（missing+timeout 都扣）、criticalFindings 0、
delta ≥ 0.05、CI lower > 0；CI 跨 0 → PROMISING_NOT_CONFIRMED 停在
SEALED_EVALUATED）；runner 只经 provider（从不走 controller saga），
resume 逐 cell 校验、wall/usd/token 三预算每波前置、launched 必收集、行
0600；完整性顺序 = replay 先 → Controller.open(controllerDir) →
phase 检查第一（非 CANDIDATE_LOCKED 即 fail closed，不触碰 plan/store）→
lock doc 校验（protocol/runId/tripleHash/championId?/sealedPlanHash）→
verifySealedPlanDraws → PROTOCOL_INVALID（不 reveal、不 launch）；reveal
由 `state.locks.sealedRevealed === null` 守护（第二次发射直接 throw，非
幂等）；CLI `sealed-evaluate`（usage 错误码 2、未 lock 的 run root 码 1 且
不产生任何副作用）。测试：sealed 15/15 + sealed-evaluate 12/12 +
bootstrap/split 17/17 + cli 18 passed/1 skipped（两个新 CLI pin 绿，
catalog `/tmp/dsh-native-materialize-current`）；pnpm build (tsc -b) 绿、
prettier 全净。假 provider Loader E2E 由 sealed-evaluate 契约套件覆盖
（真实 CHAMPION_LOCKED run root 重放合成 sealed 计划）；真实 Harbor 的
sealed 冒烟留给 Phase 5 启动前验证。
**下一步：Phase 5 启动**（预注册提交 → 启动前全量验证 + doctor → 启动门清单 →
DSH_TREE_V2_LIVE_CONFIRM=confirm 的 detached 正式 run）。

**Phase 5 预注册提交：`bf219e4`**（2026-09-08 凌晨，208 files，+43130/−1514）：
启动 commit 即本状态节所在 commit（HEAD），其内容包含 ADR-046..049 全部生产
实现 + 契约测试 + formal record 脚本 + 预注册数字（见上）；`scratch/` 加入
.gitignore（sealed store 0600 落 scratch，证据树外）；全树 credential 扫描零命中。
**启动前验证（Phase 5 门清单，全部满足）**：pnpm build 绿；全量 pnpm test 绿
（68/70 文件、781/788、786s）；strict tsc（formal 脚本）绿；prettier/oxlint 净；
credential 0600 在场（内容从不进任何 artifact）；native DSH lock 在场；
retry egress forwarder 在 172.17.0.1:17897 监听（ADR-028 修正案，替代 socat）；
docker/harbor 由 formal 脚本内 doctor 阶段实检（`dockerCheck` +
`harborVersionCheck` + 镜像 prefetch，非绿即 fail closed 零付费）。
**harbor 真实 1-job 冒烟的显式解释（不静默跳过，rule 9）**：与 k3/k10/k80 彩排
启动相同——付费 Harbor 链路由 run 内第一波矩阵 job（98-trial 矩阵的 wave 1，
8 并发）承担；ADR-028 分类与 fail-closed 保证 harbor 故障全部可归因可重试，
record 脚本保留 scratch；单独付费冒烟不在本次预注册内，不新增未注册 trial。
**启动方式**：`DSH_TREE_V2_LIVE_CONFIRM=confirm` +
`TREE_V2_TRIAL_CONTAINER_PROXY=http://172.17.0.1:17897` + 持久 TMPDIR +
setsid nohup + disown（k10 同款）；launch 前最终核对：预注册已提交、套件全绿、
credential 0600、sealed store 路径未初始化（脚本首跑生成）。
**首次启动尝试（2026-09-08 凌晨）诚实记录**：detached 启动后脚本在
sealed-plan 预推导处失败（`canonical source rejected: build output directory
lib`）——baseline id 直接从工作树捕获，但 `pnpm build` 后的 `lib/` 是
canonical capture 的 FORBIDDEN_TOP_DIR；**死于任何付费 trial 之前**（init
未发生、零模型调用、零 harbor job；scratch 中 sealed store 由确定性
ceremony 生成，重跑字节一致）。修复：baseline id 改为与 builder 同一身份
路径（`stageDeclaredSource` 声明条目 staging → canonical capture →
candidateIdFromDigest），并用彩排 run root 的已准入 baseline id
`c_wjkdctjplj4qemzjzpr6ifcyni` 端到端验证一致。修复提交后以同一预注册数字
重启（RUN_ID/MASTER_SEED/profile/信封全部不变，规则 7/9 无任何放宽）。
**第二次启动尝试（2026-09-08 00:57，诚实记录）**：脚本通过 steps 0–4（付费门、
提取、split 39/10/23、sealed store 0600、sealed plan 预推导）并完成 49 dev
verifier 镜像（receipt 01:09）；23 sealed 镜像中最后一个完成于 **01:43:45**
（docker image CreatedAt），随后脚本在「sealed 准备返回 → init 首行日志」的
极窄窗口内**无声死亡**（stderr 已重定向，日志无任何错误文本 → 不可捕获的
外部 kill，SIGKILL 类）。**死于 init 之前：零付费 trial、零模型调用、零
harbor job**。死因证据链不可完全还原：该次 boot 的 kernel log 已随
2026-09-08 09:00 的 WSL2 重启丢失，OOM-killer 与外部 kill 无法区分（镜像
构建期是本次 run 唯一的高内存窗口，最大 balloon 7776MB）。同日事实：机器
26h 内 3 次重启（09-07 07:37、09-07 18:34、09-08 09:00），fwd forwarder
容器带 restart 策略随 dockerd 自愈（09:00 后 egress 复检 401=可达）。
**第三次启动尝试（2026-09-08 09:12，同一命令同一预注册数字）**：72 个
verifier 镜像全部已缓存，高内存构建窗口不再出现；detached 重启（setsid
nohup + disown，k10 同款），进程存活确认（node 14834）。**持久化监督为
未决提议**：`docs/runbook/dsh-k80-formal.service`（systemd Restart=on-failure

- boot 自启，~50h 付费 run 针对重启频发的对策）已写好但**未安装**——需要
  用户明确授权 systemd 持久化机制后才会 enable；在授权前 run 只受 detached
  进程保护，再次重启会再次中断（脚本 resume 幂等，可人工重启续跑）。

**Phase 4 已实现，门通过（2026-09-08 凌晨）**：schema taskCount 48→49；
`--profile` CLI flag + `terminal-bench-formal`；k80 profile 改为正式形态
（baseline {49,2,8}、tournament {12,1,360,100000}、runProfile formal）；
envelope 检查器 per-phase 化（搜索 ≤400 / tournament ≤360 / 总 ≤760）；
DriveReport 语义修正（ADR-049）：`trials`/`discoveryTrials` 只计 search-phase
（tournament 行单独报 `tournamentTrials`，driver 测试 pin 45→17）；formal
record 脚本 `scripts/record-tree-v2-k80-formal-live.ts` 完整落地（paid 门 +
credential 0600 + 固定 scratch + 89→72 资格 + split 39/10/23 + sealed store
0600 证据树外 + sealed plan 预注册在 init 之前（baseline id 预推导）+
49 dev / 23 sealed 独立 verifier 镜像根 + init/doctor/run/resume（
`--sealed-plan-file`）+ per-phase 信封 + 迁移/收据链/结算 + CHAMPION_LOCKED
事实与 sealed-plan 绑定 + 信息流监控 + guard 试次证据消毒（真名→opaque id）+
sealed-evaluate（仅 lock 后，PROTOCOL_INVALID 诚实形态，reveal 恰一次，
聚合-only 披露）+ redaction 扫描（credential/逐 trial token/canary/guard
名/sealed 名零命中）+ k80-formal-run.json/STATUS.json + 全绿才清理 scratch；
可 resume（固定 scratch、drive-report.json 判定 run/resume、sealed 从 0600
行续跑）。验证：pnpm build（tsc -b）绿；**全量 pnpm test 绿（68/70 文件、
781/788 用例、786s）**；formal 脚本严格 tsc --noEmit 绿（8 处退化动态导入
类型修复：导入结果显式 `as typeof import(...)` + 具名 interface 替代
`typeof lockDoc`/值型索引）；prettier 净、oxlint 净。启动环境已就绪：
retry forwarder 在 172.17.0.1:17897 监听（ADR-028 修正案替代 socat）、
credential 0600、native DSH lock 在场、socat 已退役。

## 2026-09-07 tree-v2 K=10 live attempt 2 结果（ADR-042 冻结机制生产验证，K=10 未达）

attempt 2（run root `dsh-tree-v2-k10-live-PRl3Pd`，recorder 按 ADR-029 模式录完即删；两次
中止 root 保留）结束：**STOPPED:NO_ADMISSIBLE_CHILD，trials=40（24 matrix + 8 冷启动 +
8 ordinary）expansions=8，16440s，RUNNER 正常退出**。record failures=[]（evidence 05:53
落盘 `evidence/tree-v2/k10-live/`）；$6.93（5 406 106 µUSD model receipts + 预算内杂项）、
1274 requests、solver 37.7M / proposer 7.7M tokens。

**冻结机制在生产中按契约工作（本次上线的核心验证）**：24×1 矩阵全量执行（discoveryTrials=24，
`baseline-<attempt>-<batch>-<wave>` 波形完整）、零成功 pool 冻结 **11 题**
（`chess-best-move, db-wal-recovery, dna-assembly, feal-linear-cryptanalysis,
gcode-to-text, large-scale-text-editing, make-mips-interpreter, mcmc-sampling-stan,
merge-diff-arc-agi-task, overfull-hbox, password-recovery`）；供给算术
`24 + 10×11 = 134 ≥ minimumTrials 49` —— **attempt 1 的供给死锁没有重演**。baseline 失败率
46%（11/24），高于预注册 40% 估计但仍在供给充裕区间。calibration 预检在 doctor 阶段放行
K=10（minimumTrials=49 ≤ 60）。

**K=10 未达（已注册终止态，不缩小协议）**：8 次扩张 admitted 8 个子代（depth 2），随后
**连续 3 次扩张失败**触发冻结上限 → NO_ADMISSIBLE_CHILD。`rebuildRejections=[]`、
`abandonedIntents=[]` → 最后 3 次失败模式为空 proposal 或全 duplicate（非 build 拒绝）。
8/10 admitted，差 2 个。扩张失败不是供给问题（pool 11 题充足），是 proposer 产出质量/去重
问题。

**从 trial 层重建的事实（attempt 1 的 14 个 trial 文件与 attempt 2 同目录共存，按 started_at
≥ 17:22 UTC 切分）**：matrix 24 题全为唯一任务（无重试，8 波 4 批 4+2 形状），13/24 solved
→ pool 11 题（与 drive-report 完全一致）；search 阶段 16 trial（4 波）仅 **3/16 solved**——
8 个 admitted 子代的冷启动与 ordinary 评估大面积失败，子代机制假设基本没在 pool 题上成立。
proposer 8 次调用共耗 7.7M tokens（≈962K/次）→ 每次都是完整 proposal 输出（v2 envelope），
结合 rebuildRejections=[]、abandonedIntents=[]，最后 3 次扩张最可能是全部 duplicate /
无新机制被拒，而非空 proposal 或 build 失败。5 次成功扩张 admitted 8 个（proposalWidth=3 →
最多 24 个 proposal），说明 proposal 阶段拒绝贯穿全程，最后 3 轮 100% 被拒触发上限。

**诚实披露**：a) 首次启动（00:26）doctor 因本实现的 preflight 检查对 72-handle 人口用
89-slot 默认 split 抛异常而中止，零付费 trial，修复+回归后重启（见预注册条目）；b) runner
log 尾部缺 record 摘要行（终段被外部中断，evidence 与 failures=[] 已完整落盘）；c) 每扩张
proposal receipts 不在 evidence 拷贝集内（k3 recorder 起就是此模式，scratch 已删）——最后
3 次扩张被拒子代的具体 diff/hypothesis 不可复盘；**已于 ADR-043 修复**（见下节），attempt 3
起 proposal saga 完整保留，attempt 2 的被拒 receipts 仍不可恢复。

## 2026-09-07 ADR-043 proposal-saga receipts 进入 recorder 拷贝集（rule 7 证据完整性修复）

attempt 2 复盘暴露：record 脚本的 evidence 拷贝集只有 per-trial artifacts +
run-manifest + drive-report + migration + verifier-image-receipt + image-prefetch，
**proposal saga 的 receipts 一条都没有**——validation summary（含逐子代 rejected 原因，
是区分 duplicate / no-new-mechanism / build reject 的唯一凭据）、proposal bundle、
transcript、gateway/remote receipts 都在 scratch run root 的 `objects/sha256/` 与
`sandboxes/prop-*/work/` 里，而 ADR-029 成功即删 scratch。k3 recorder 起就是此模式
（attempt 2 的 receipts 不可恢复）。

**ADR-043 修复**（契约测试先行，`scripts/tests/evidence-copy-set.test.ts` 3/3 绿）：
共享 helper `scripts/lib/evidence-copy-set.ts`，k3/k10 两个 record 脚本都接入，在 scratch
删除前补拷：a) `objects/sha256/` 全部文件平铺为 `object-<sha256>`（顶层落盘，rule 8
redaction scan 原样覆盖；实测 k3 root 60 个 object、共 1.4 MB，含 proposal validation
summary / transcript / receipts / normalized trial / admission receipt）；b)
`search-state.json` + `failure-pool.json`；c) 每扩张 `worker-result.json` →
`<actionId>-worker-result.json`（boot/DAC 事实，store 不存的唯一沙箱事实）。TCB 无改动
（object store 本就含这些 receipts）。安全验证：对幸存 k3 root 的 objects/ + sandbox
work 目录用 credential 文件做 `grep -lFf` 精确匹配 = 0 命中（`sk-` 字样命中均为
"sk-specific" 等普通文本）。attempt 3 起 proposal saga 完整进入 evidence。

## 2026-09-07 ADR-044 prior-rejection 反馈进入 proposer 输入（扩张墙修复，TCB 变更）

attempt 2 复盘 + 幸存 k3 root（attempt 12）实证：连续全拒扩张不是 duplicate，而是**畸形子代**
（`package/missing`、`modeComponents` 投影违规）——proposer 每次扩张都是 fresh roll，从未见过
validator 对自己输出的拒绝原因（ADR-038 只把父代失败测试喂回会话，proposal 拒绝原因没有
任何反馈通道）。修复（先 ADR 后实现，docs/decisions.md ADR-044；契约测试先行）：

1. **持久拒绝记录**：`searchState.proposalRejections`（可选字段，load/fresh 归一化 `[]`，
   与 rebuildRejections 同模式），每扩张一条 `{actionId, rejected:[{childName,reason}],
batchErrors}`，reason 截断 300 字符、保留最近 16 条、按 actionId 幂等合并，写入与扩张
   计数器同一次 saveSearchState（crash 不会留半条追加）。
2. **暂存输入**：driver 把历史随每次 proposal request 传入；supervisor 在 input/ 暂存
   `prior-rejections.json`（协议 `dsh-evolve-le/prior-rejections/v1`，deterministic from
   search-state，controller-owned 输入，与 archive-catalog.json 同级；dev-observed 的
   proposer 自身输出裁决，无 sealed 数据，无 label 变更）。worker closure
   （WORKER_RUNTIME_FILES）增补 `proposer/prompt-text.js`——prompt 文本迁出 bin 文件到
   `src/proposer/prompt-text.ts`（bin 文件 import 即执行 main()，测试无法 import 它）。
3. **prompt 绑定**：native instruction（live 路由）与 remote wire-protocol section 都把
   prior-rejections.json 列为可读根，并指示把每条原因当作硬约束——重复被拒形状会再被拒。
   recorded v1 policy 不动（deterministic，不读新输入）。

验证：`tests/feedback.test.ts` 8/8（record/doc builders、幂等合并、cap、截断、两路由 prompt
文本）；driver NO_ADMISSIBLE_CHILD 冻结测试扩展（search-state 落 2 条记录、第 2 次扩张
request 携带第 1 条原因）；sandbox staging 测试（prior-rejections.json 落入 sealed input
view）；**closure 缺文件正是被真实 uid+netns one-shot E2E 抓住并修复的**（standalone 跑旧
lib 不暴露）；全量套件 62/62 文件通过（665 passed / 23 skipped）、`tsc -b` 干净、prettier
干净。K=10 attempt 3 是首个消费者（见下节预注册）。

## 2026-09-07 tree-v2 K=10 live attempt 3 预注册（ADR-043/044 上线后的重试）

attempt 2 以 NO_ADMISSIBLE_CHILD 停在 8/10 admitted（8 次扩张、连续 3 次全拒、$6.93、
16440s）。两个已知问题已修复并全量验证（ADR-043 receipts 拷贝集、ADR-044 prior-rejection
反馈）。attempt 3 以**同一 RUN_ID / MASTER_SEED / 同一 k10 envelope** 启动（attempt 2
同目录共存，按 trial started_at 切分，同前）：

- profile `TREE_V2_LIVE_PROFILES.k10`：kTarget=10、coldStartTrials=1、shortlistSize=2、
  maxSolverTrials=60、taskTrials=60、solverTokens=120M、benchmarkBaseline={24×1×6}
  （batchSize 6 → 4 波）、proposalWidth=3、wallClockMinutes=960；proposer 默认预算
  proposalCalls=20、proposerTokens=20M（与 attempt 2 相同）；
- RUN_ID=`tree-v2-k10-live`、MASTER_SEED=`tree-v2-k10-live-master-seed-1`、evidence 落盘
  `evidence/tree-v2/k10-live/`；
- 预期终止态（全部已注册）：`K_REACHED`、`NO_ADMISSIBLE_CHILD`（扩张质量仍未改善时诚实
  停止）、`NO_REAL_FAILURE_SIGNAL`、`NO_ADMISSIBLE_TASK`、`TRIAL_CAP`、
  `BUDGET_EXHAUSTED`；
- 成本界同 attempt 2（现实 ≈ $12–18，worst ≈ $23.60，远低于 $500 上限）。

**本 attempt 观察点**：a) proposal saga receipts 完整进入 evidence（ADR-043）——若再停
NO_ADMISSIBLE_CHILD，被拒子代的 validator 原因可直接复盘；b) 第 N+1 次扩张 request 携带
第 N 次的拒绝原因（ADR-044）——若连续全拒仍发生，可区分「模型无视反馈」与「反馈未达」。

## 2026-09-07 tree-v2 K=10 live attempt 3 结果（ADR-043/044 首次生产验证，K=10 admitted 达成）

attempt 3（scratch `dsh-tree-v2-k10-live-mbg4Qv`，成功即删；证据落盘
`evidence/tree-v2/k10-live/`，record failures=[]、allPassed=true）：**STOPPED:TRIAL_CAP，
trials=60（24 matrix + 36 search）expansions=6，21698s，$8.41，1731 requests，58.7M
tokens**。consecutiveExpansionFailures=0、rebuildRejections=[]、abandonedIntents=[]。

**K=10 admitted 达成**：6 次扩张 admitted 10 个非 baseline 子代（prop-1:3、prop-4:3、
prop-5:2、prop-6:2；11 张 admission receipts 含 migration baseline）。**终止态是
TRIAL_CAP 而非 K_REACHED**：K_REACHED 要求 admitted≥10 且无待办冷启动，而 prop-6 的
第 9、10 个子代在 60-trial 上限触顶时才 admitted，冷启动未能完成——差的是 trial 预算，
不是扩张质量（attempt 2 的连续 3 次全拒死法没有重演）。matrix 7/24 solved → pool 17
（attempt 2 为 11）；search 阶段 13/36 solved（36%，attempt 2 为 3/16=19%）。

**ADR-044 反馈链路在真实模型上工作（预注册观察点 b 直接命中）**：prop-2 失败——
`agent exited without proposal_finish (tool calls=78)`（batchErrors 完整落盘）；prop-3
收到该反馈后正常提交，但 3 个子代死于新形状 `import/unresolved at src/strategy.ts:24`
（逐子代原因完整落盘）；prop-3 的拒绝原因喂给 prop-4 → **prop-4 3/3 全过**。search-state
的 proposalRejections 记录 2 条（prop-2 失败、prop-3 全拒），之后 3 次扩张零拒绝——
feedback 不是「反馈未达」，模型确在按拒绝原因修正形状。

**ADR-043 receipts 完整性**：evidence 531 个 artifact，含 185 个 object-*（全部
validation summary / 提案 bundle / transcript / receipts / admission receipt /
normalized trial）、search-state.json、failure-pool.json、prop-1…6 六个
worker-result.json——本 attempt 的全部扩张裁决可直接复盘，无需再从 trial 层重建。

**诚实披露**：a) mteb-retrieve 一个 trial 跑满 90 分钟 agent 上限被 harbor 杀掉（预注册
envelope 内；ADR-040 gate 2 豁免，failures=[]，未丢弃）；b) 启动 wrapper 未回显
RUNNER_EXIT 行（本 attempt 用内联 bash -c 启动，省略了 attempt 2 wrapper 脚本的
`echo "RUNNER_EXIT=$?"`）——但脚本最后一条语句 stop= 摘要已打印、失败路径会打印 FAILED
并 exit 1、STATUS.json allPassed:true、scratch 已按 ADR-029 删除、evidence 完整，判定为
正常退出而非中断。

**下一步**：K=10 差的是 60-trial 信封（UCB-Air 扩张门 `N^0.6 ≥ T` 需要 N≈39 才首次允许
扩张，24 matrix + 冷启动把余量吃光，扩张只来得及跑 6 次）。K=80 的旧 252-trial 信封被
ADR-042 校准预检拒绝（0.6 下需 1486 trials）；**ADR-045 已按预注册修订正式 K=80 信封**
（alpha=0.8、30h 墙钟、400-trial、49×2 矩阵预注册，见顶部 ADR-045 节）——但付费 K=80
启动仍被延期清单阻断（dev-guard 波次 / tournament / schema 48→49 / k80 record 脚本，
任一未落地前无 launch 路径）。是否提高 k10 的 maxSolverTrials / coldStartTrials
属于协议变更，需先 ADR。

## 2026-09-06 tree-v2 K=10 live attempt 2 预注册（ADR-042 benchmark baseline 冻结机制上线）

attempt 1 的供给缺口已量化（matrix 前的 supply 26 < minimumTrials 49）。ADR-042 冻结机制
已实现并通过契约测试（calibration 11 例、driver freeze 5 例、preflight/run-config 63 例、
profile/envelope 29 例、CLI carrier 1 例）。attempt 2 以同一 RUN_ID / MASTER_SEED 启动；
ADR-042 使 proposal runtime 内容寻址变化 → 全新 run root，attempt 1 root 保留（rule 7）。

**首次启动中止（2026-09-07 00:52，零付费 trial，run root `dsh-tree-v2-k10-live-o0jI3j`
保留）**：doctor 在 search-calibration 检查处报 `✗ preflight-internal: split: population of
72 unique handles cannot fill 89 slots`。根因是本实现的检查用默认 89-slot split 对 72-handle
live population（89→72 ≤1800s 排除后的真实任务集）跑 ceremony 而抛错——不是环境问题，是
预检检查自身崩溃。修复：检查按 `splitCountsForPopulation(handles.length)` 缩放 split
（与 run 自身 ceremony 一致；72 → observed 39/guard 10/sealed 23），回归测试钉住
"72-handle population 返回 finding 而非 throw" 与 "observed 上界随 population 缩放
（40 > 39 拒绝）"。preflight 15/15 绿后已重启。

**冻结机制（本次上线内容）**：

1. **specs/03 §7 修正**：UCB-Air 的 `N` = 已完成 development trials 总数（baseline、cold
   start、ordinary 的全部观测；literal ordinary-only 读法会让首个扩张门 `N ≥ 1` 死启动）。
2. **search.benchmarkBaseline**（schema 新增，taskCount 1..48 / attemptsPerTask 1..6 /
   batchSize 1..24，三者同现；CLI `--set` 三个 flat carrier 组合，部分出现 = config error
   code 2）。
3. **calibration 预检**（preflight 新增 search-calibration 检查）：`minimumTrials =
ceil(K^(1/alpha)) + q0×shortlistSize`（FP 防抖 ceil）。K=10 → finalGate=47、
   minimumTrials=49 ≤ maxSolverTrials=60 ✓；bestCaseSupply = 24 + 10×24 = 264 ≥ 49 ✓。
   k80 profile 被预检拒绝（252 < 1486 / minimumTrials 1501）——specs/03 §2 fail closed；
   K=80 的 60-task 矩阵 profile 修订是独立决策，不在本 attempt 范围。
4. **driver 冻结语义**：baseline 波形确定性排程（`baseline-<attempt>-<batch>-<wave>`）、
   pool = 全矩阵零成功任务、pool 空 → `NO_REAL_FAILURE_SIGNAL`（null，合法终止非失败）、
   infra-dead 抛 fail-closed（ADR-028）、freeze 后 phase-guarded CALIBRATED。
   crash-mid-matrix resume 按波形成员恢复；actionId `eval-...-a<attempt>`（attempt 后缀，
   reserve 幂等不吞后续 attempt）。
5. **envelope**：k10 profile 要求 `shape.discoveryTrials === 24`（matrix 精确替代 §4.1
   discovery；24 接受 / 12、18 拒绝）。

**attempt 2 预注册参数**：profile `TREE_V2_LIVE_PROFILES.k10`（kTarget=10、coldStartTrials=1、
shortlistSize=2、maxSolverTrials=60、taskTrials=60、solverTokens=120M、
benchmarkBaseline={24×1×6}，batchSize 6 → 4 波）。RUN_ID=`tree-v2-k10-live`、
MASTER_SEED=`tree-v2-k10-live-master-seed-1`、evidence 落盘 `evidence/tree-v2/k10-live/`。
baseline 任务集合 = 观测 split 前 24 个任务（ceremony deterministic），verifier 镜像预拉
覆盖 24 题。

**供给算术（预注册，不随结果修改）**：E[pool] ≈ 9.6（~40% 观测 baseline 失败率）；
`minimumTrials 49 ≤ 24 + 10×P → P ≥ 3` 即可供给全部 K 个冷启动；UCB-Air 扩张门
`N^0.6 ≥ T` 在 N ≥ 55 时允许 T=11（baseline + 10 子代）→ 60-trial 预算刚好可达 K_REACHED，
余量紧（55/60）。**预期终止态（全部已注册）**：`K_REACHED`（最可能）、`NO_REAL_FAILURE_SIGNAL`
（pool 空）、`NO_ADMISSIBLE_TASK`（供给不足）、`NO_ADMISSIBLE_CHILD`。
成本界：24 baseline ≈ $3.90（$0.16/trial），全预算 60 trials ≈ $9.70；现实 ≈ $12–18（脚本
预注册界，含 proposer；worst ≈ $23.60，远低于 $500 上限）。

## 2026-09-06 tree-v2 K=3 live attempt 11 结果 + attempt 12 预注册（ADR-038 proposal_finish 边界测试反馈）

attempt 11（scratch `dsh-tree-v2-k3-live-SHBwcZ`，保留）结束：**STOPPED:NO_ADMISSIBLE_CHILD，
trials=6 expansions=3，4607s，RUNNER_EXIT=1**。

**ADR-037 修复验证通过**：prop-1 一次调用 proposal_finish 成功提交（零 tool error、
零 failure transcript），6 个子代全部通过 diffBoundary 的 modeComponents 投影契约——边界
检查按设计把「契约违规」挡在会话内，本轮没有出现 attempt-10 的缺失文件拒绝。trial 层稳定：
6 trials attempts=1，4/6 solved（failurePool 冻结 `adaptive-rejection-sampler`、
`db-wal-recovery`，均为能力缺口，与 attempt 10 同池）。

**6 个子代全部死于下一层新根因（typeLintUnit 统一失败，ADR-038 证据）**：`candidate tests
failed: tests/candidate.spec.ts (5 tests | 5 failed)`。字节级复现：每个子代把新机制挂成
src/index.ts 的**第二个顶层插件**（`ctx.plugin(strategyPlugin, config)` 后又
`ctx.plugin(newMechanismPlugin, config)`）；父代 baseline spec 钉死挂载面——恰好 1 个
strategy 插件、每 mode 恰好 1 个 section/tool/skill、恰好 3 个 effects——于是 5/5 baseline
测试失败（子代自带的 mechanism 测试 3/3 通过，模型以为全绿）。结构性成因：proposal sandbox
没有 exec 工具，模型盲写 TS + vitest spec；typeLintUnit 只在提交后由 controller 独立运行，
会话内零反馈（rule 7 不可归因失败类）。该模式与前几轮一致：每修好一层契约，下一层未声明
契约就整体死亡。

**ADR-038 修复（先 ADR 后实现，docs/decisions.md；契约测试钉住；attempt 12 未启动）：**

1. **proposal_finish 边界测试反馈（TCB）**：gateway 新增 `candidate-tests` 请求类型。worker
   在 finalize 时对每个子代发送 `{childName, files: 父+子合并视图}`；gateway 先逐字节验证
   每个父文件与暂存父视图一致（允许变更集 = 子代 runtime.modeComponents 路径并集 +
   candidate.json），再用 controller 侧 runner 把合并视图暂存到一次性目录、**symlink 父
   capsule 的 node_modules**（子代依赖闭包按契约等于父代），跑与 builder stage 6 完全相同的
   oxlint + vitest（sandboxed 子进程），剥 ANSI、截断 2000 字符。失败作为 proposal_finish
   的 tool error 回给模型 → 同一会话内可修复后重试。测试运行独立计数 test-N、不占模型
   receipt 序号、预算 12 次/会话；recorded 路由无 runner 自动跳过（controller 的
   typeLintUnit 仍是每路由的权威门）。
2. **prompt 明确化**：新增机制必须经由现有 strategy 组件路由（在 src/strategy.ts 或其已
   依赖的模块内 import 新模块），**绝不新增顶层插件**——父代 baseline spec 断言的是恰好
   一个插件的挂载面；并预告 proposal_finish 会跑父 baseline + 子代新增测试、失败会作为
   tool error 回传（有界检查，不要死循环）。
3. **契约测试**：gateway 5+2 个用例（父字节篡改拒绝、缺父文件拒绝、无父视图 fail-closed、
   不安全路径/名字、预算墙、receipt 序号隔离；无依赖根时默认 runner fail-closed、真实
   suite 走 socket 全链路绿）、proposer 5 个用例（合并视图失败回传、绿过、runner 缺省跳过、
   传输错误、预算 12 次）。
4. **真实 attempt-11 视图冒烟**：`runCandidateTestSuite` 直接跑 attempt-11 实际子代树 →
   复现 5 条 baseline 失败（边界检查精确预测 controller 门）；去掉第二个 ctx.plugin 的
   表面保持变体 → oxlint clean + 测试全过。

attempt 12 以同一 RUN_ID / MASTER_SEED / 任务集 / trial 预算启动（由我之后择时运行；
ADR-038 改动使 proposal runtime 内容寻址变化 → 全新 run root，attempt 11 root 保留）。
预期：若子代再犯挂载面违规，proposal_finish 在会话内给出可修复的 tool error 而非整轮
无反馈死亡；ADR-037 的 modeComponents 边界继续钉住。

## 2026-09-06 tree-v2 K=3 live attempt 12 结果 + attempt 13 预注册（ADR-039 边界镜像准入 + 内容敏感指纹）

attempt 12（scratch `dsh-tree-v2-k3-live-xjXLQM`，保留）结束：**STOPPED:NO_ADMISSIBLE_CHILD，
trials=6 expansions=3，~45 分钟，$1.73，RUNNER_EXIT=1**。

**ADR-038 端到端验证通过**：prop-1 第一次 proposal_finish 把真实 vitest 输出作为 tool
error 回传（其自写 mechanism 断言错误），模型会话内修复 spec 后重交全绿；每个 proposal 的
父 baseline 5/5 exact-surface 测试全过。边界反馈机制按设计工作。但三个**新的** controller
门各杀一个 expansion，会话内全部不可见：

1. **prop-1（2/2 子代）**：`candidate manifest rejected the child:
/runtime/modeComponents/propose: must NOT have fewer than 1 items`——空 propose 数组；
   ADR-037 投影检查对空数组空洞通过，完整 manifest schema 只在 controller 侧跑。
2. **prop-2（2/2 子代）**：`candidate scan rejected the child: package/missing; patch/missing`
   ——子代树没有 package.json / cordis.patch.yml；边界测试跑过是因为合并视图的父侧补上了
   字节，builder 扫描的是子代自己的树。
3. **prop-3（2/2 子代）**：builder mockReplay `target mode solve Loader fingerprint did not
change`——子代完全按 ADR-038 prompt 走（把 directive 折进现有 solve section 文本，无新
   注册），自测全过，但 `treeV2RuntimeFingerprint` 只哈希 section **名字**和 registry
   **名字**——内容演化永远无法满足 target-mode 契约。结构性冲突：父 baseline spec 钉死
   挂载名字，名字不变指纹就不变，两扇门在 name-only 指纹下联合不可满足。

**ADR-039 修复（docs/decisions.md；契约测试钉住；attempt 13 未启动）：**

1. **固定文件边界检查（prop-2）**：`finalizeTreeV2Bundle` 要求每个子代树自带 package.json
   和 cordis.patch.yml，且与父视图逐字节一致（"keep fixed" 文件，父字节在 ADR-037 手中）。
   缺失/改动 fail，错误信息点名文件 + 修复动作。
2. **schema 边界检查（prop-1）**：gateway 侧 candidate-tests runner 用与 `validate.ts`
   完全相同的 `validateManifest('candidate')` 校验子代 candidate.json（v2 自动分派到
   tree-v2 candidate-intent schema），schema 错误逐字回传。
3. **内容敏感指纹（prop-3，契约层）**：probe 报告新增**可加**字段 `sectionSurfaces`
   （`{name, order, text}[]`，candidate section 的挂载文本），`treeV2RuntimeFingerprint`
   哈希这些对象 + registry 名字；name-only 老报告降级到旧列表。**实现期修订**：section
   文本普遍嵌入 `config.candidateId`（SDK 文档模式），父/子挂载 id 不同 → 原始文本哈希会
   把字节相同的 preserved-mode 判死（builder 套件首跑即复现）——指纹增加 `{candidateId}`
   参数，哈希前把调用者自己的 id 替换为固定哨兵（身份是固定内容，不是可演化机制）。
4. **边界挂载面对比（prop-3，反馈）**：candidate-tests runner 在 sandboxed 子进程里用
   SDK testkit 挂载子代合并视图**和**父视图（父 baseline spec 的同一 harness 模式），按
   子代 modeContract 逐 mode 对比挂载记录（section name/order/text + tool/skill 名）：
   target mode 必须不同、preserved mode 必须相同；失败点名 mode + 缺失的 delta。
5. **prompt 修订**：当前父代只有 src/index.ts + src/strategy.ts 两个生产文件且
   src/index.ts 按契约必须修改 → byte-preserved mode 结构性不可能，子代必须双 mode
   target 且两个挂载面都可观察地不同（把 per-mode directive 折进 solve **和** propose
   的 section 文本）；固定文件必须写进每个子代树；折 directive 时保留父 spec 断言的文本
   片段（结构不变、target-mode 文本变）；预告边界会跑 schema + 固定文件 + 挂载面对比 +
   全套测试，失败作为 tool error 回传。

**契约测试**：finalize 固定文件缺失/改动 +2；runner 套件 5（schema 逐字拒绝、unparseable、
target 面未变、preserved 面变了、合规子代全链路绿）；gateway +2（注入 runner 收到
parentFiles 钉住管线、真实 runner 下 prop-1 形态 schema 拒绝）；契约指纹 2（内容敏感 +
身份掩码）；builder 真 Loader probe 钉住 `sectionSurfaces` 形状。定向套件全绿
（candidate-test-runner 5/5、remote-gateway 16/16、finalize-bundle 21/21、tree-v2 11/11、
proposer 18/18、sandbox 10/10、builder 15/15、tree-v2-live-profile 5/5）。全量 vitest
套件隔离通过：62 个文件 59 绿 + 3 跳，623 个用例 601 绿 + 22 跳（~7.1 分钟，EXIT:0）。

**真实 attempt-12 视图冒烟（两个方向）**：prop-3 子代（db-wal-recovery）原样 → 新边界
拒绝 `tree-v2 target mode propose mounted surface did not change`（正是会话内会收到的
反馈）；同一子代把 directive 折进 propose section 文本 → 全边界绿
（`oxlint clean; candidate tests passed`）。

## 2026-09-06 tree-v2 K=3 live attempt 13 结果 + attempt 14 预注册（ADR-040 收据锚定用量 + 协议形态 envelope）

attempt 13（scratch `dsh-tree-v2-k3-live-sMVV0K`，保留）结束：**`K_REACHED` /
`STABLE_ITERATION_VERIFIED` — trials=14 discovery=6 expansions=2，6945s（~116 分钟），
$2.67，RUNNER_EXIT=1**。

**算法目标首次达成，ADR-039 端到端验证通过**：2 次扩张各准入 2 个子代（共 4 个
admitted non-baseline，均由真实 failure-pool 信号驱动），lineage depth 2，stable-demo
停止条件按 specs/03 §11 触发。attempt-12 的三类拒绝（空 modeComponents schema、子代树
缺固定文件、name-only 指纹）全部变成会话内 tool error——每个 proposal 都提交了
schema-valid manifest + 固定文件 + 内容敏感 target-mode 指纹通过。failurePool 冻结
`adaptive-rejection-sampler`（5 trials 后 1.0）与 `db-wal-recovery`（5 trials 全 0.0）。

**但整体 FAILED——三个证据门，全部在用量/形态记账层**：

1. `trialCountWithinThePreRegisteredEnvelope`：检查把 envelope 编码为
   `trials === discovery + expansions×coldStart`——协议真实形态是
   `discovery(6) + admitted(4)×q0(1) + ordinary UCB-Air 评估(4)`，该公式在 attempt 12
   上也误报过（6 ≠ 6+3×1）。上限全在信封内（14 ≤ 15/15，6 ≤ 12）。
2. `agentUsageReportedToHarbor`：db-wal-recovery 一个 trial 在 45 分钟时
   AgentTimeoutError（预注册 `[agent].timeout_sec` 900 × 常量 3.0 倍率）——上游 Harbor 的
   超时路径丢弃 capsule 报告（agent_result 全 null），而 gateway 实际记录了 25 requests /
   262,250 tokens。`participationOf` 把「异常 + 无 initialize 记录」判为
   never-initialized——链证明 agent 真实运行过。
3. `receiptUsageMatchesSettlement`：receipts 16,831,542 vs settled 16,569,292——差额
   正是该超时 trial 的 262,250。collect 端的 participation 优先零用量分支把一个真实
   消费过的 trial 记成 0（账本拒绝零 settle，"从不静默免费"被打破）。
4. 另发现：`stopReasonIsARegisteredTerminalState` 列表漏了 specs/03 §7 注册的
   `NO_ADMISSIBLE_CHILD`（attempt 12 的合法终止被误记为一个门失败）。

**ADR-040 修复（docs/decisions.md；契约测试钉住；attempt 14 未启动）：**

1. **收据优先零分支（harbor-provider collect）**：verified chain `requests > 0` 一律给
   出完整 figures，participation 启发式只把**缺失/损坏的链**在 never-booted 分类下降级为
   honest zero；其余坏链保持 fail-closed throw。
2. **envelope 公式镜像协议**：`trials = discovery + admittedNonBaseline×q0 + ordinary`
   （ordinary ≥ 0）、`discovery === discoveryBatchSize`、`trials ≤ taskTrials/≤
maxSolverTrials`、`discovery ≤ maxDiscoveryTrials`、`admitted ≤ kTarget +
shortlistSize − 1`（wave-snapshot 过冲上界）、`proposalCalls === expansionAttempts`。
   纯函数在 scripts/lib/tree-v2-live-profile.ts，契约测试钉住 attempt-12 与 attempt-13
   真实形态。
3. **用量门拆分**：`receiptChainCoversEveryLiveTrial`（每个 live trial 的链必须覆盖
   requests>0，除非 never-booted + 链为空/缺失）+ `harborUsageReportedWhenCapsuleCompleted`
   （capsule 完成报告时 Harbor 必须携带正用量；被 kill 的 trial 按构造豁免，kill 留在
   exception_info 可见）。不回填 Harbor 的 result.json（避免网关自证 + 证据不可变）。
4. **终止态列表**补 `NO_ADMISSIBLE_CHILD`。

**契约测试**：provider killed-trial fixture（AgentTimeoutError + null metadata + 非空
收据 → 完整 figures，而非启发式零）；never-booted honest zero 现在要求链**失败**（缺失
文件）；envelope 接受 attempt-12/13 形态、拒绝 cap/过冲/discovery/proposal 违规；门分类
（链覆盖优先于 never-initialized 启发式、capsule 完成但无用量 → 失败、
`NO_ADMISSIBLE_CHILD` 注册）。定向套件全绿：adapter 69/69（含新增 3 例）、
tree-v2-live-profile 全绿。全量 vitest 套件隔离通过：62 个文件 59 绿 + 3 跳，
639 个用例 617 绿 + 22 跳（~7.3 分钟，EXIT:0）。

## 2026-09-06 tree-v2 K=3 live attempt 14 结果（第一个全绿 live run）

attempt 14（scratch `dsh-tree-v2-k3-live-hpN7T4`，保留）结束：**`K_REACHED` /
`STOPPED:K_REACHED` — trials=14 discovery=6 expansions=1，6940s（~116 分钟），
$2.04（550 requests、13,879,429 tokens），RUNNER_EXIT=0，record 文档
`failures: []`**。预注册预期（"`K_REACHED` 一轮上全部证据门通过"）精确达成。

**三个 ADR-040 门按设计工作**：envelope 公式接受协议真实形态（6 discovery +
3 admitted×1 cold start + 5 ordinary）、settlement 与收据总和逐 token 相等
（13,879,429 = receipts）、每 trial 归因由 TCB 链覆盖。本次 1 次扩张准入全部 3 个
proposalWidth 子代（`admittedNonBaseline=3`，kTarget 精确达成；过冲上界 3+2−1=4 内），
无超时 kill trial。rewards 7×1.0 / 7×0.0（6 任务：discovery 6 题 + 3 子代评估），
failurePool 冻结按协议产生。evidence artifacts（14×3 trial 副本 + manifest +
drive-report + migration 收据）落盘 `evidence/tree-v2/k3-live/`。

**与 attempt 13 的形态差（诚实披露，不缩小协议）**：attempt 14 的 lineage depth=1
（单扩张直接达标）——specs/03 §11 的 stable-demo 停止态 `STABLE_ITERATION_VERIFIED`
要求 ≥2 层 lineage，本轮以注册的 `K_REACHED` 终止。两层 lineage +
`STABLE_ITERATION_VERIFIED` 形态已在 attempt 13 演示（其失败仅因记账门，现已修复）；
两份 run root 合起来覆盖完整协议，但**尚无单份全绿 run 同时具备 depth-2 形态**。
是否再跑一轮以拿到 depth-2 全绿记录是下一步的择时决策（每次 ~$2-3）。

**残余**：上游 Harbor 对被 kill trial 的 result.json 仍为 null（归因由 TCB 链承担，
raw 记录保持可见）；ADR-040 改动未提交（repositoryHead 仍为 7fa9f28，run manifest
已内容寻址冻结工作树）。

## 2026-09-06 tree-v2 K=10 live attempt 1 结果（record 全绿，K=10 结构性未达，§4.2 供给缺口确认）

attempt 1（第二次启动，scratch `dsh-tree-v2-k10-live-70Gosa` 已清理）结束：
**`NO_ADMISSIBLE_TASK` / `STOPPED:NO_ADMISSIBLE_TASK` — trials=14 discovery=6
expansions=4 admittedNonBaseline=4，5831s（~97 分钟），$2.27（574 requests、
15,688,824 tokens），RUNNER_EXIT=0，record 文档 `failures: []`**。evidence
artifacts 落盘 `evidence/tree-v2/k10-live/`。

**ADR-041 三个改动全部按设计工作（首次真实触发）**：`NO_ADMISSIBLE_TASK` 正确注册
记分（未重演 attempt-12 误判）；envelope 接受 14 = 6 discovery + 4×1 cold start +
4 ordinary；settlement 与 receipts 逐 token 相等；proposal-calls=4=expansions。
discovery 首批 6 题含 2 个真实 failure（adaptive-rejection-sampler、chess-best-move）
→ pool 冻结为 2 题。

**彩排的核心发现（量化，K=10 未达成）**：UCB-Air 扩张门为
`N^0.6 ≥ T`（T = baseline + admitted 子代）。K=10 需要 T=11 → `N ≥ 11^(5/3) ≈ 54.4`；
而 N 的供给上限 = discovery 6 + 每个子代最多试遍 pool 一次（pool=2 → 每子代 2 题）
= 6 + 10×2 = **26 < 54.4 —— 结构性不可达**。实际运行精确停在该模型的边界：
4 个子代耗尽 8 个 pool 题后 N=14（14^0.6=4.87 < T=5）→ 无法扩张也无法评估 →
`NO_ADMISSIBLE_TASK`。即使 pool=4 也不够（6+40=46 < 54.4）；**pool ≥ 5 才可行**。
specs/04 §4.1 的 stable-demo discovery（首批出现 failure 即冻结）供给不了 K=10，
这正是 specs/04 §4.2 的预设："启动 K=10/K=80 benchmark profile 前另行冻结对应
baseline"——该机制**尚未实现**。

**结论与下一步**：K=10/K=80 的付费路径被 §4.2 benchmark baseline 供给机制阻塞，
不是 pilot 重跑能解决的（rule 9：不得静默缩小协议，例如把 pool 补成 12 题失败集、
或调低扩张门）。60-trial/16h 信封算术本身未能被本轮验证（只用了 14 trials/97min）。
下一步是工程：设计并实现 specs/04 §4.2 的 benchmark baseline 冻结（ADR-042，含
K=10/K=80 的 pool 供给 ≥5/≥19 的可行性条件、以及 specs/03 §2 的 B_eval-calibration
预检——启动前拒绝结构性不可达的 run），契约测试先行；完成前不再启动付费 K=10/K=80。

## 2026-09-06 tree-v2 K=10 live attempt 1 预注册（K=80 前的规模彩排，ADR-041）

按用户批准的路线（K=3 全绿 → K=10 真实 solver 彩排 → K=80），启动第一个 K=10
真实 solver live run。**目的**：在 1/4 规模上验证 60-trial 信封、wave 并行度、16h
时间信封与 $500 预算内的时间/成本算术，为 K=80 预注册 ADR 提供实测数据。本 run
**不是** K=80 搜索本身，也不接触 sealed（split ceremony 不变：observed 48 /
guard 12 / sealed 29 保持不透明）。

**首次启动 fail-closed（同一日）**：`init` 拒绝生成的 config——
`/search/maxDiscoveryTrials: must be <= 12`（`schemas/run.config.schema.json`
maximum 12，引用 specs/04 §4.1 硬上限）——profile 从 v1 时代 Gate 8 pilot 继承的
48 在 tree-v2 schema 下不合法。RUNNER_EXIT=1、零花费、零 trial 启动，fail-closed
按设计工作。修正：**profile 改为 spec 上限 `maxDiscoveryTrials=12`（两个 funded
批次）**，schema 不动；K=10 彩排因此只演练已实现的 12-cap discovery + 60-trial
搜索信封，specs/04 §4.2 的 K=10/K=80 正式 baseline 另行冻结仍留待 K=80 预注册。
ADR-041 已记录该修正；契约测试重跑 26/26。

**预注册内容（全部先于启动冻结）**：

- profile：`TREE_V2_LIVE_PROFILES.k10`（kTarget=10、coldStartTrials=1、shortlistSize=2、
  maxSolverTrials=60、maxDiscoveryTrials=12、discoveryBatchSize=6、proposalWidth=3、
  taskTrials=60、wallClockMinutes=960、solverTokens=120M）。RUN_ID=`tree-v2-k10-live`、
  MASTER_SEED=`tree-v2-k10-live-master-seed-1`、evidence 落盘 `evidence/tree-v2/k10-live/`。
- **ADR-041（docs/decisions.md；契约测试先行）**：
  (1) envelope 的 discovery 条件改为 funded batch multiple（>0、≤maxDiscoveryTrials、
  %batchSize==0）——driver 只在含真实 failure 的批次边界冻结 pool，全 success 的第一批
  合法资助第二批（k3 同理：6/12 合法，5/7/13 拒绝）；(2) `NO_ADMISSIBLE_TASK`（所有
  admitted 节点都试遍 pool 题——60-trial 信封在小 pool 上可真实到达）加入
  `REGISTERED_TERMINAL_STOP_REASONS`，避免重演 attempt-12 `NO_ADMISSIBLE_CHILD`
  误判；(3) 启动时预构建**两个** discovery 批次（12 题的离线 verifier image）；
  第三批被 specs/04 §4.1 硬上限禁止，12 题全过即 `NO_REAL_FAILURE_SIGNAL`（已注册）。
- 预期终止态（全部已注册）：`K_REACHED`（最可能，K=10 + 每个 admitted 节点 q0=1
  cold start 完成后停止）、`NO_ADMISSIBLE_TASK`（pool 穷尽）、`TRIAL_CAP`、
  `BUDGET_EXHAUSTED`、`WALL_CLOCK_EXHAUSTED`、`NO_ADMISSIBLE_CHILD`、
  `NO_REAL_FAILURE_SIGNAL`。
- 预算估算（信封内）：solver 最坏 60×$0.30=$18.00，proposer 最坏 20M tokens≈$5.60，
  合计最坏 ≈$23.60；现实 ≈$9–15（attempt 14 均值 ≈$0.146/trial）。远低于 $500 上限。
- 时间估算：attempt 14 为 14 trials/6940s（并发 4）；60 trials 预计数小时量级，
  960 分钟信封内。
- **诚实披露**：本 run 不覆盖 k80 专属路径（coldStartTrials=3、shortlistSize=5、
  specs/03 §11 formal tournament、60-task coverage plan、guard 12 selector、
  cluster-bootstrap LCB）——这些仍留待 K=80 预注册 ADR；K=3 depth-2 全绿记录缺口
  仍然存在（attempt 13 形态红 / attempt 14 全绿但 depth-1），不因本 run 关闭。

## 2026-09-06 tree-v2 K=3 live attempt 10 结果 + attempt 11 预注册（ADR-037 modeComponents 边界契约）

attempt 10（scratch `dsh-tree-v2-k3-live-iuNcLB`，保留）结束：**STOPPED:NO_ADMISSIBLE_CHILD，
trials=6 expansions=3，3229s，RUNNER_EXIT=1**。

**ADR-036 修复验证通过**：3 个 proposal 全部一次调用 proposal_finish 成功提交（无 failure
transcript；worker-result ok:true、`"turns": 1`、proposal.json 完整）——深冻结提交墙已消除。
trial 层继续稳定：6 trials attempts=1（forwarder 持续零 infra 重试）；build-pmars、
break-filter-js-from-html、code-from-image solved；adaptive-rejection-sampler、
cancel-async-tasks、db-wal-recovery reward=0（failure pool 冻结 3 handles，均为能力缺口）。

**9 个子代全部死于下一层新根因（diffBoundary，ADR-037 证据）**：`tree-v2 contract rejected:
parent target solve references missing file src/<子代新增模块>.ts`——模型把子代新增的模块
（src/adaptive-rejection-sampler.ts、src/cancel-async-tasks.ts、src/db-wal-recovery.ts
及变体）列进了 candidate.json 的 `runtime.modeComponents`。契约语义是 modeComponents 只列
**父树已存在**、由子代改动字节的生产模块；新增模块由 added-file diff + tests.mechanism 确立。
该语义在 schema（无 description）与 prompt（无此规则）中都不可见；transcript 证明模型确实
读过 parent-files.json（父树完整文件清单在会话内），不是信息缺失而是语义缺口——父代的
intent 列自己的文件，子代照抄形状是天然后果。且该拒绝发生在整个 proposal 返回 ok 之后：
零 loop 内反馈，模型无法在会话内修复（rule 7 不可归因失败类）。

**ADR-037 修复（先 ADR 后实现，契约测试钉住后启动）：**

1. **提交边界契约检查（TCB）**：`finalizeTreeV2Bundle` 在 proposal_finish 边界对每个子代
   强制投影契约——modeComponents 每个路径必须匹配生产模式、存在于父视图（parent-files.json
   同名文件）、存在于子代树；target mode 必须有所列路径的生产字节变化、preserved mode 必须
   无变化；每个子代必须修改 src/index.ts。失败抛 `TreeV2FinalizationError` 并给出精确
   child/mode/path + 修复指引，作为 tool result 回给模型 → 同一会话内可改 intent 后重试
   proposal_finish。wiring（proposer/tools.ts）读 TCB 暂存的 parent-files.json + 父文件
   构建父视图；暂存缺失 → fail closed（绝不静默跳过）。controller 独立复验不变，仍是权威。
2. **schema 描述**：modeComponents/componentPaths 增加父成员规则说明。
3. **prompt 明确化**：点名 parent-files.json 为唯一合法路径来源 + 「新增模块绝不列入
   modeComponents」+ 子代必须改 src/index.ts 并新增非根生产模块与 mechanism test。
4. **契约测试**：7 个新边界用例（attempt-10 复现的父缺失路径、子代未写路径、非生产模式
   路径、target 无字节变化、preserved 字节变化、未改组件根、无父视图 fail-closed）+
   tools 层 fail-closed 用例；现有 ADR-034 fixture 补父视图。目标测试 34+85 全绿。

attempt 11 以同一 RUN_ID / MASTER_SEED / 任务集 / trial 预算启动；ADR-037 改动使 proposal
runtime 内容寻址变化 → 全新 run root；attempt 10 root 保留（rule 7）。预期：边界检查把
下一未知契约规则变成会话内可修复的 tool error，而非整轮无反馈死亡。

## 2026-09-06 tree-v2 K=3 live attempt 9 结果 + attempt 10 预注册（ADR-036 冻结参数修复）

attempt 9（scratch `dsh-tree-v2-k3-live-eUb2m5`，保留）结束：**STOPPED:NO_ADMISSIBLE_CHILD，
trials=6 expansions=3，4571s，RUNNER_EXIT=1**。

trial 事实（真实数据，rule 7 不丢弃）：**6 trials 全部 attempts=1（零 infra 重试）**——
retrying forwarder 在真实生产中验证：attempt 5-8 每轮 2-3 个 apt 死亡，本轮为零；
build-pmars、break-filter-js-from-html、cancel-async-tasks、code-from-image、
adaptive-rejection-sampler 全部 reward=1.0；**唯一真实能力缺口 db-wal-recovery
reward=0**，failure pool 冻结为 `["db-wal-recovery"]`（frozenFromObservations=6）。
forwarder 属主机侧环境设施（同地址 172.17.0.1:17897），job plan / 冻结配置 / run
manifest 零改动。

3 个 proposal 全部死于同一新根因（failure transcript 逐条钉住，ADR-036 证据）：

- **DSH session 深冻结 tool-call 参数**：上游 session 对每条追加消息 deep-freeze，模型
  经 proposal_finish 提交的 bundle 到达工具层时已冻结；ADR-034 的 TCB finalizer
  （`finalizeTreeV2Bundle`）原地重建 receipt → `TypeError: Cannot assign to read only
property 'analysisReceipt' of object '#<Object>'`。模型把错误反馈当 bug 反复重试
  proposal_finish——prop-1 31 次（另命中 64/64 request 上限）、prop-2 10 次、prop-3
  24 次——子代树全部写完（prop-3 97 tool calls、children 完整 staged）却死在提交边界，
  最终纯文本放弃 → runner 只见「agent exited without proposal_finish」。
- 契约测试无法先验捕获：测试传可变对象，生产传冻结对象。

**ADR-036 修复（先 ADR 后实现，契约测试钉住后启动）：** `proposal_finish` 工具边界在
TCB finalization 之前 `structuredClone(proposal)`——finalizer 在私有副本上重建 receipt，
审计轨迹保留原始冻结事件；契约测试用 deepFreeze 的 raw bundle + 变异型 fake finalizer
钉住「副本被写、冻结原件未被写」。full suite 567/566 全绿 + FULL_SUITE_EXIT=0
（567 = 566 + 新增 ADR-036 契约测试）。

attempt 10 以同一 RUN_ID / MASTER_SEED / 任务集 / trial 预算启动；ADR-036 改动使
proposal runtime 内容寻址变化 → 全新 run root；attempt 9 root 保留（rule 7）。预期
attempt 10 的 proposal_finish 首次成功提交，下一可见层为提交后的 controller 独立
复验（ADR-034 的 receipt 逐层绑定复验）。

## 2026-09-06 tree-v2 K=3 live attempt 8 结果 + attempt 9 预注册（ADR-035 提案预算墙修复）

attempt 8（scratch `dsh-tree-v2-k3-live-IrLZvY`，保留）结束：**STOPPED:NO_ADMISSIBLE_CHILD，trials=6 expansions=3，4839s，RUNNER_EXIT=1**。

trial 事实（真实数据，rule 7 不丢弃）：2 solved——adaptive-rejection-sampler reward=1.0
（1.88M tokens）、cancel-async-tasks reward=1.0（1.14M tokens）；db-wal-recovery reward=0；
3 个 apt 死亡（capability FAIL）——build-pmars、break-filter-js-from-html、
code-from-image（drop-in 在位仍死，生产证伪与回滚见下节）。

3 个 proposal 全部死于「agent exited without proposal_finish」（107/91/111 tool calls），
receipt 逐条相关给出两类机制（ADR-035 证据）：

- **prop-1（38 个已投递请求）/ prop-3（52 个）：网关 post-hoc 预算检查丢弃下一请求的
  已付费响应**——`budget stop: 4164820 tokens / 606457 µUSD would exceed the cap`（prop-1）、
  `4107189 tokens`（prop-3），对 4M token 上限。children 已全部 staged，被丢弃的多半是
  最终写入或 proposal_finish 提交本身；错误静默终止上游 DSH loop（`kick()` 吞掉 turn
  错误后 idle）→ runner 只见「未提交」。
- **prop-2（45 个请求，3.69M 累计 token——未超上限）：最后响应已投递但无 tool call**
  （纯文本收尾 → DSH loop 按 `completed` 退出）——模型以散文收场，没调用 proposal_finish。
- 共同根因：tree-v2 协议要求模型经 `proposal_write_child` 内联内容逐文件写完整子代树，
  DSH session 每请求重发全部工具历史 → 完整 2-3 子代提案落在 3.7-4.2M 累计 token，恰在
  4M 上限上；loop 内没有任何提交压力（prompt 声称有 bounded budget，但无物强制）。

**ADR-035 修复（先 ADR 后实现，契约测试钉住后启动）：**

1. `REMOTE_PROPOSER_BUDGET.maxTotalTokens` 4M → **6M**（3×6M=18M ≤ 冻结的 run-level
   `proposerTokens` 20M；成本上限 $4 不变，实测 ~$0.57/提案）；post-hoc 检查保持 hard——
   一旦再触发仍丢弃已付费响应而非超限，是应急刹车而非常规终止路径。
2. **工具调用预算（TCB 自有工具层）**：soft 72 次起每个 list/read/write 结果追加收尾
   提示（N/96 已用，只写必要剩余并提交）；hard 96 次起三个 authoring 工具拒绝执行
   （错误信息要求立即 proposal_finish）；`proposal_finish` 任何次数豁免。attempt 8 实测
   91-111 次 → 提示落在写作中段、拒绝线在观测带上方；最坏 session（~110 请求 × ~250K
   context）仍低于 6M 上限。
3. **prompt 明确化**：纯文本收尾 = run 失败，只有 `proposal_finish` 工具调用能成功
   （prop-2 修复）；并点名工具调用预算。
4. **失败 transcript**：`runNativeProposal` 抛错前把完整 session 事件序 + audits + 错误
   写入 `work/failure-transcript.jsonl` 并在错误信息中给出路径（attempt 8 只能靠 receipt
   相关性反推模型最后行为；rule 7 要求失败可归因）。

**重试 forwarder 已部署**（ADR-028 证伪增补，用户批准现场替换）：`fwd` 容器现为 retrying
HTTP forwarder（同地址 `172.17.0.1:17897`、network=host、restart=unless-stopped；502/连接
失败最多重试 3 次带退避 + 每次全新上游连接；CONNECT 透传不重试），curl 实测 plain HTTP
200 通过、CONNECT 隧道直达 api.deepseek.com。job plan / 冻结配置 / route hash / run
manifest 全部零改动（主机侧环境设施，不入 manifest）。

attempt 9 以同一 RUN_ID / MASTER_SEED / 任务集 / trial 预算启动；ADR-035 改动使 capsule
与 proposal runtime 内容寻址变化 → 全新 run root；attempt 8 root 保留（rule 7）。

## 2026-09-06 tree-v2 K=3 live attempt 8 预注册（ADR-034 TCB 终结 + ADR-028 增补 apt 重试）

attempt 7 的三类失败各自有根因与修复，全部先 ADR 后实现、契约测试钉住后再启动：

**(a) 2 个 trial 自 attempt 5 以来持续死亡（apt 偶发 502）——根因与修复。** 根因不是
forwarder 存活问题（attempt 6 曾全程无 502，attempt 7 又死 2 个），而是 apt 本身对单次
fetch 失败零重试：trial 容器经 172.17.0.1:17897（socat）→ 127.0.0.1:7897（Windows 侧代理）
访问 deb.debian.org，代理偶发 502（约 1/3 trial 命中一次）→ `E: Failed to fetch ...
502 Bad Gateway [IP: 172.17.0.1 17897]` → apt 退出 100 → agent 从未 boot（无 trajectory /
无 receipts / usage null）→ harbor 记 NonZeroAgentExitCodeError → capability FAIL（无
trial 级重试，rule 7 不丢弃）。attempt 7 死者：break-filter-js-from-html、
cancel-async-tasks（与 attempt 5 的 code-from-image、db-wal-recovery 不同任务，证明是
按 trial 随机命中而非任务特定）。ADR-028 增补修复：CLI 内容寻址物化
`Acquire::Retries "3";` drop-in（字节校验后以只读 bind mount 注入
`/etc/apt/apt.conf.d/99-dsh-evolve-le-retries.conf`），真实 verifier-runtime 镜像内
smoke 实测 `apt-config dump` 报出 `Acquire::Retries "3";`。该 drop-in 只进 harbor job
plan、不进 run manifest（`freeze()` fail-closed 会拒绝已冻结 run root 的新键，破坏
resume；与 CA bundle 同一条路径）。

**(b) prop-1/3 receiptDigest 拒绝——模型伪造摘要。** wire 协议要求模型自己计算
canonical-JSON sha256，真实模型伪造摘要样式字符串（复制父摘要、拼接 evidence 摘要、
随机 hex），controller 验签必然拒绝。ADR-034：摘要全部改由 TCB 在 proposal_finish
工具边界派生——`finalizeTreeV2Bundle` 用模型语义字段重建 analysis receipt /
candidate-intent parent evidence / proposal receipt，逐层绑定后 controller 独立复验；
结构不可能即 fail closed（与 controller 拒绝同结果，绝不静默修补）。

**(c) prop-2 analysis schema 严格性 + 编造 donor。** 模型的 `$schema` 习惯与缺字段撞上
`additionalProperties:false`；archive catalog 从未 staging 进 sandbox input，模型编造
`@dsh-evolve-le/candidate-tree-v2-baseline`。ADR-034 同批修复：catalog 作为 trusted
input 写入 proposal sandbox（treeV2Parent 存在而 catalog 缺失 → fail closed）；donor
只允许出现在 catalog 中的 candidate id；named evidence 摘要必须精确引用
export/manifest.json 内的对象（补齐 hollow-evidence 洞：模型引用的
normalizedTrialDigest/trajectoryDigest 必须是 analysis evidenceDigests 已引用的真实
导出对象）；prompt 明确禁止模型自算 receiptDigest、要求先读 manifest 与 catalog。

attempt 8 以同一 RUN_ID / MASTER_SEED / 任务集 / trial 预算启动；ADR-034 改动使 capsule
与 proposal runtime 内容寻址变化 → 全新 run root；attempt 7 root 保留（rule 7）。

**2026-09-06 attempt 8 期间更正：apt `Acquire::Retries` drop-in 被生产现场证伪。**
attempt 8（scratch `dsh-tree-v2-k3-live-IrLZvY`，进行中）首波 4 个 discovery trial 中 2 个
死于同一 502 类——`break-filter-js-from-html`（libjs-sphinxdoc 单次 502）与 `build-pmars`
（两个不同 URL 各 502）——而 drop-in mount 已证实挂载在位（sibling env 容器 docker inspect
见 exact read-only mount；harbor plan YAML 记录在案）。容器实验（同 verifier-runtime 镜像
apt 2.6.1）确认机制：`Acquire::Retries` 只重派 transient 连接级失败，HTTP 状态码失败不算；
带 mount 与不带 mount 的尝试次数完全相同（无 body 的 502 = 1 次；带 body 的 502 = 7 次
apt 2.6.1 内置 transient allowlist 重试，与 drop-in 无关）。drop-in 对全部已观测失败模式
都是 no-op → 予以回滚（CLI 物化 / plan mount / 契约 pin 一并移除），不得留下假装重试的
配置。**替代修复（attempt 9 预注册，ADR-028 增补见 docs/decisions.md）**：`fwd` socat
中继替换为同地址（`172.17.0.1:17897`）的 HTTP 重试 forwarder——对 502/连接失败以退避 +
全新上游连接重试最多 3 次，容器内 apt/curl/pip 不再看到 502；job plan、冻结配置、route
hash、run manifest 全部零改动；实现入库为 `scripts/lib/trial-egress-forwarder.py`（loopback
契约测试钉住策略），属主机侧环境设施（与所替换的 socat 同类，不入 run manifest）。
capability-FAIL 分类、1800s setup 上限、trial 级 1× infra 重试均不变。**已于 attempt 9
启动前现场部署**（见上节）。

## 2026-09-05 tree-v2 K=3 live attempt 7 结果（首个真实模型端到端 proposal run，官方端点健康）

attempt 7（scratch `dsh-tree-v2-k3-live-XNO5PX`，保留）：官方端点全程健康（0 次 ADR-033
重试），3 个 expansion 全部走完真实模型 proposal 但死于候选拒绝（prop-1/3
receiptDigest 验签失败、prop-2 analysis schema `additionalProperties:false` + 编造
donor），STOPPED:NO_ADMISSIBLE_CHILD（trials=6 expansions=3，2807s，RUNNER_EXIT=1）。
attempt-7 trial 事实（真实数据，计入开发反馈，rule 7 不丢弃）：
adaptive-rejection-sampler reward=0；break-filter-js-from-html 与 cancel-async-tasks
死于 apt 502（agent 从未 boot，capability FAIL）；db-wal-recovery reward=0；
code-from-image reward=0；build-pmars reward=1。

## 2026-09-05 tree-v2 K=3 live attempt 7 预注册（官方端点 + ADR-033 重试上线）

attempt 6 的根因修复已实现并全绿（ADR-033 网关层重试：upstream 核心 / 双网关 /
receipts / config / schema + 契约测试；remote receipt 2→3、solve receipt 3→4、attempts
轨迹、route hash 冻结 retry）。上游端点按 ADR-033 增补条款切换：one-api 退役（多日
`Database error` 500），attempt 7 使用官方 `https://api.deepseek.com/v1` + 同一
`deepseek-v4-flash`，凭据为更新的 0600 文件（rule 8：不进任何 receipt/log/prompt）；
route lock 其余不变（`maxOutputTokens: 131_072`），启动前已对官方端点实测通过（最小
请求与 `max_tokens: 131072` 均 200 且上报 usage）。RUN_ID / MASTER_SEED / 任务集 / trial
预算不变，新 baseUrl 内容寻址进入全新 run root 的 route hash 与 manifest。attempts
4–6 的 run root 全部保留（rule 7）。

## 2026-09-05 tree-v2 K=3 live attempt 6 失败（one-api 全量 500，外部故障）

attempt 6（scratch `dsh-tree-v2-k3-live-2dsMQ8`，保留）验证 attempt-5 两处修复在生产
成立：3 次 proposal sandbox boot 全部 quiescent 且 drift={}（PipeWrap 修复有效）；6 个
discovery trial 全程无 apt 502（forwarder `--restart unless-stopped` 保持），其中
db-wal-recovery reward=1。但扩张 3/3 死于上游：每个 proposal 首次模型调用即
`upstream 500`（req-1），agent 0 次 tool call 退出，NO_ADMISSIBLE_CHILD（trials=6
expansions=3，1297s）；code-from-image solve trial 同类死亡（req-1 500，0 tokens）。
现场探测确认 one-api 此刻对任何请求（含最小化请求）返回 `Database error` 500——外部
服务故障，非请求形状（同窗口 sibling trial 经同一网关成功调用 26–49 次）。

项目缺陷：模型调用路径没有任何重试——一次瞬时上游 5xx 就杀死整个付费 proposal/solve
trial。ADR-033 预注册修复（详见 docs/decisions.md）：重试类别固定（5xx + network
failure；4xx/超时/空内容/畸形 tool call 一律 FAIL 不重试）、policy 冻结进 route hash
与 manifest、每请求仍一条 receipt 且新增 attempts 轨迹、预算上界（proposer 最坏
≈40min < 60min sandbox；solve gateway 650s < ACP client 660s）。契约测试钉住分类与
预算收缩行为。

attempt-6 trial 事实（真实数据，计入开发反馈，rule 7 不丢弃）：
adaptive-rejection-sampler reward=0；break-filter-js-from-html reward=0；
code-from-image reward=0（req-1 500 零用量）；build-pmars reward=1；
db-wal-recovery reward=1；cancel-async-tasks reward=1。

## 2026-09-04 tree-v2 K=3 live attempt 5 失败（PipeWrap 静默误报 + apt 偶发 502）

attempt 5（scratch `dsh-tree-v2-k3-live-ChaXVB`，保留）暴露两处问题：
(a) proposer-worker 的 PipeWrap lazy-stdio 在子进程 stdio 尚未就绪时把空句柄列表误判为
"已 quiescent"，proposal 过早终结——3 个扩张全部 NativeProposalError（0 tool calls），
NO_ADMISSIBLE_CHILD（trials=6 expansions=3，1988s）。修复：snapshot 前先
`initializeProtocolStreams()`，并新增回归测试。
(b) 容器内 apt 经 upstream-proxy 偶发 502 致 2 个 trial 的 ACP setup 死亡（agent 从未
boot：code-from-image、db-wal-recovery 无 trajectory / 无 receipts / usage null），
harbor 错误分类匹配不到 apt 文本故记为 NonZeroAgentExitCodeError——按 normalize 契约
该类必须是 capability FAIL，harbor 只读：rule 7 两个失败 trial 留在分母不重试
（ADR-028 增补 3）。修复：forwarder 重建为 `--restart unless-stopped` 并在 attempt 6
前做端到端复验（attempt 6 全程无 502，修复成立）。

## 2026-09-04 tree-v2 K=3 live attempt 4 用户中止（网络未恢复）

attempt 4（scratch `dsh-tree-v2-k3-live-bv5f3o`，保留）在 WSL 网络切换后按 ADR-028
补救路径以不变 profile 重启，`dsh-evolve run` 阶段用户主动中止（Terminated，
RUNNER_EXIT=143，已启动 3 个 trial job，无结论性 trial 事实）。attempt 5 在用户
调整网络（局域网连接 + DNS 覆写）后重启。

## 2026-09-04 tree-v2 K=3 live attempt 3 中止（WSL 重启）与网络根因定位

attempt 3（scratch `dsh-tree-v2-k3-live-oa98ch`，已清理）在 discovery 批次窗口内遭遇
持续性 deb.debian.org 吞吐塌陷（容器内实测 ~18.8 KB/s，正常应为 MB/s 级）：6 个任务中
3 个（break-filter-js-from-html、build-pmars、cancel-async-tasks——均为 debian 基底
镜像）的 ACP setup 在 1800s 上限首次超时，预注册的 1 次 infra retry 正在进行时用户
重启 WSL 切换网络，run 进程随之终止。已完成的付费 trial（rule 7 不丢弃）：
adaptive-rejection-sampler reward=0（47 receipts）、db-wal-recovery reward=0
（49 receipts）；settled 预算 usd 82,418 µUSD / task-trials 4 / solver-tokens 516,537。
3 个 setup-timeout trial 若完成 retry 将走 ADR-028 infra-dead fail-closed，与 attempt 2
同类。重启后实测宿主与容器内 apt 吞吐恢复正常（宿主 1.49 MB/s；ubuntu:24.04 容器内
完整 ACP apt 阶段 84s，含 32.5 MB 索引 10s），确认根因为 WSL 网络栈瞬时恶化而非
协议或镜像问题。attempt 4 以不变的预注册 profile 重启（ADR-028 补救路径）。

## 2026-09-04 tree-v2 K=3 live attempt 2 失败（ADR-028 infra-dead fail-closed）

修正后 profile 的第二次真实模型 run（scratch `dsh-tree-v2-k3-live-swFrCZ`，保留待查）
完成了全部 6 个 discovery trial 的付费执行，随后按 ADR-028 预注册路径 fail closed：
`code-from-image` 的 ACP setup 在 1800s 上限两次超时（首次 + 预注册的 1 次 infra
retry 均超时），normalize 记 `infra_retryable` → outcome `missing`，driver 在
`discoverFailures()` 抛出 infra-dead discovery 错误并终止 run——"agent 从未运行不是
能力事实"，pool 不得冻结未知 baseline。协议按设计工作，非 TCB 缺陷。

attempt-1 预算修正经端到端验证：6 个 discovery 动作各预留 2,000,000 solver-tokens，
全部 settle 成功（budget ledger 47 条：18 reserve / 17 settle / 12 release；
solver-tokens 实耗 1,693,037，receipt 链核验一致；usd 实耗 249,765 µUSD，其中 1 条
unpriced settle 来自 code-from-image 的零用量 missing trial）。

attempt-2 trial 事实（真实数据，计入开发反馈，rule 7 不丢弃）：adaptive-rejection-sampler
reward=0（197,502+21,042 tokens，$0.0335）；break-filter-js-from-html reward=1
（714,260+38,745 tokens，$0.1108）；build-pmars reward=0（$0.0376）；
cancel-async-tasks reward=0（$0.0377）；db-wal-recovery reward=0（$0.0301）；
code-from-image 零用量 missing（AgentSetupTimeoutError ×2）。同窗口其余 5 个 trial 的
ACP setup 为 40s–5m41s，唯独 code-from-image（ubuntu:24.04 基底，ADR-028 已识别的高
setup 成本任务类）两次打满 1800s——WSL2 共享主机网络/IO 瞬时恶化，超出 5× 余量。
ADR-028 对该类的预注册补救即"restart the pilot"；split ceremony 确定性（固定 RUN_ID +
MASTER_SEED），attempt 3 重跑同一 6 任务批次，offline verifier image allowlist 不变。
`NO_SEALED_RESULTS` 不变。

## 2026-09-04 tree-v2 K=3 live attempt 1 失败与预算修正

K=3 tree-v2 首次真实模型 run（`record-tree-v2-k3-live.ts`，scratch
`dsh-tree-v2-k3-live-dgJ36H`）在 4 个 discovery trial 全部完成后于 solver-tokens
settle 阶段 fail closed：`BudgetError: settle 419863 exceeds action reserved
400000 (solver-tokens/eval-wjkdctjp-adaptive-rejection-sampler)`。根因是 k3 profile
把 `solverTokens=6M` 而 `taskTrials=15`，controller 每次评估动作只预留
`floor(6M/15)=400k` tokens，但 solve gateway 冻结的单 trial 上限是 2M；该 trial
合法消耗 419,863 tokens 超出预留，ledger 按不变式拒绝。这是 profile 预注册缺陷，
不是 TCB 缺陷——ledger 正确地 fail closed，4 个已付费 trial 的 Harbor job、receipts
与 budget ledger 保留在 scratch 中，未丢弃（rule 7）。

修正：三个 live profile 的 `solverTokens` 一律改为 `taskTrials × 2M`（k3=30M、
k10=120M、k80=504M），使单 trial 预留恒等于 gateway 上限，solver-token 维度不可能
先于 task-trials 触发；`packages/dsh-evolve-le/tests/tree-v2-live-profile.test.ts`
新增契约测试钉住该不变式（`perTrial >= DEFAULT_SOLVE_TRIAL_BUDGET.maxTotalTokens`）。
worst-case 成本上界不变（gateway 单 trial $0.30 上限 × 15 trial）。

attempt-1 trial 事实（真实数据，计入开发反馈）：adaptive-rejection-sampler
reward=0（48 ok + 1 budget-stop receipt，419,863 tokens，$0.0619）；
break-filter-js-from-html reward=0（16 receipts，$0.0729）；cancel-async-tasks
reward=1（49 receipts，$0.1897）；build-pmars reward=1 且带 1 个 AgentTimeoutError
exception（43 receipts，54m58s）。`NO_SEALED_RESULTS` 不变。

## 2026-09-04 tree-v2 contract implementation

完成 `dsh-self-evolving-candidate-tree-v2` 的可信协议实现：新增八类 strict
Ajv schema、canonical receipt digest、multi-file tree validator、四项具名
`requiredParentEvidence`、静态/Loader 双层 `modeContract` 校验，以及明确不继承旧结果的
migration receipt。candidate SDK 现在可 effect-owned 注册 system-prompt、tools、skills、
agent-events、session-events 和 workflow；probe/builder 会检查注册及 unload 后清理。
六个 surface 按 solve/propose 分别声明和探测；capability catalog 必须等于两个 mode 声明的
精确并集，不能多报、漏报或重复。

proposal wire 现为显式 v1/v2 双协议：v2 child 必须携带 analysis/proposal receipts，不能用裸
`evidenceRefs` 回退；controller 重新捕获 tree 后校验 candidate-intent、parent、mode 与 named
evidence 交叉引用。trusted builder 在成功准入后写出 mechanism-outcome、capability-catalog、
materialization 和 admission receipts；迭代 capsule record 保留下一代验证所需的父代 Loader
fingerprints 与 mechanism/admission digest。规范化 trial 以 canonical JSON 的 `DEV_OBSERVED`
对象和 raw trajectory 一起进入 label-filtered export，crash/snapshot replay 不改变 export identity。
proposal 版本由 trusted parent record 决定：legacy lineage 保持 v1 replay；v2 parent 的 durable
request/sandbox 默认并强制 v2，携带 parent candidate/mechanism digest。recorded proposer 已能从
具名 normalized-trial/trajectory export 物化多文件 v2 child 与 analysis/proposal/candidate-intent
receipts；remote/native 路径收到同一 v2 约束提示，不能由 proposer 自行降级。
controller 将通过验证的前三张 receipt 分别发布为 content-addressed objects；iteration 将 builder
生成的后四张 receipt 也写入 object store，并在 capsule record 保留可 scrub 的 refs。migration
receipt 提供相同的 object-store persistence API，旧结果仍不能被迁入新 identity。

验证：tree-v2 receipt chain、proposal v1/v2、migration、candidate SDK、manifest 与 iteration
crash/replay 定向测试通过；新增真实 builder E2E 以 v1 父代 Loader fingerprints 验证 v2
子代 target/preserved modes 并检查四张 builder receipts。`pnpm build`、typecheck、改动范围的
lint/format 通过；排除既有 live-solve container 文件后的全量回归为 518 passed、22 skipped
（55 files）。完整 suite 中该文件的两项用例仍因当前 capsule 未挂载 native composition 且未设置
`DSH_COMPATIBILITY_LIVE=1` 失败，不属于 tree-v2 路径。现有 v1 candidate/proposer/manifest
兼容测试保持通过。尚无新的 Terminal-Bench、sealed、
promotion 或性能 artifact；`NO_SEALED_RESULTS` 不变。

## 2026-09-03 proposal worker identity capability gate

proposal sandbox 不再把 `/usr/bin/setpriv` 的存在当成可降权的证明。supervisor 现在实际执行
`setpriv --reuid=65534 --regid=65534 --clear-groups true` 探测；不可执行时，CLI 的 fake 与
Terminal-Bench provider 路径都在 builder、sandbox、journal 或外部 effect 之前以
`proposal-worker-identity` finding 退出。`runProposalSandbox()` 本身也执行同一门，因而调用方不能
绕过 preflight 获得 netns-only root worker。

针对某些受限挂载拒绝递归 `chown` 的情况，已为**已确认可降权**的 worker tree 增加最小的 mode
handoff，并把 `chown`/`mode` 选择记录到 `supervisor.json`。这不改变 UID/network 隔离、DAC canary
和 capsule post-run digest 的要求；无法实际降权时该分支不会启动 worker。当前宿主的 seccomp
拒绝 `setresuid`，所以真实 proposal/full CLI 闭环在这里被明确 fail closed，而不是作为 root
运行或误报成功。

验证：`pnpm build` 通过；proposal sandbox/preflight 定向回归 17/17 通过；CLI 的 init/status、
root-worker preflight、doctor 和配置定向回归通过。具备实际 UID drop 的宿主仍执行真实 sandbox
proposal/replay/audit 闭环；当前宿主对此类测试标记 skip。没有新增 benchmark、pilot、sealed 或性能结论；
`NO_SEALED_RESULTS` 不变。

## 2026-09-02 candidate strategy-surface contract expansion

## 2026-09-02 native DSH composition seam (migration slice)

新增 `packages/dsh-evolve-le/src/dsh/native-composition.ts` 与 `native-runner.ts`，把原生
DSH 的调用边界固定为 `ctx.agents.create({ sessionId, meta, agentOptions, setup, signal })`：
候选策略在 `setup(agentCtx)` 中挂载，turn 由 upstream agent-loop 驱动，assistant/tool 证据从
DSH session events 提取，owner `dispose()` 在返回前必达。`mountNativeDshComposition()` 通过
延迟导入 upstream `dsh-agent-spine-demo` 与 `dsh-agent-default-model` 进行真实组合；缺失构建
产物时返回显式 capability miss（设置 `DSH_NATIVE_REQUIRED=1` 则 fail closed），不会静默把
legacy directive loop 标记为 native。`NATIVE_DSH_PACKAGE_PINS` 和 capsule runtime manifest
现在声明 `dsh-agent`、`dsh-agent-loop`、`dsh-session`、`dsh-tools`、`dsh-skill` 等固定
`0.1.0-rc.5` 依赖。candidate baseline 在真实 DSH 上下文支持时暴露
`candidateStrategySetup`，确保 tool/skill effect 进入 agent Fiber 而非 controller 全局。

验证：`pnpm build` 通过；native composition/runner、candidate baseline、candidate SDK 定向
测试共 21 项通过；`pnpm lint` 无 error（仅保留既有 warning）；`prettier` 已格式化本轮文件。
这段迁移的 packed-capsule admission 已在下文完成；旧 `proposer/agent-loop.ts` 与 ACP
replay/live 实现仍只作为兼容/回放路径保留。deterministic solve admission 已覆盖 ACP facade 的
三项工具 dispatch，但完整 ACP stdio transport 与 cancellation 仍须有独立 Loader 级 E2E。`NO_SEALED_RESULTS`
不变。

## 2026-09-02 native DSH packed-capsule AgentLoop admission

trusted builder 现在把 native DSH admission 设为有完整 upstream closure 时的强制门：capsule 内的
`native-turn-probe.js` 通过真实 Cordis Loader 装载候选和 DSH spine，以确定性的无网络、无凭据
LLM adapter 驱动 `ctx.agents.create()`。该 adapter 必须先看到 agent Fiber 中的
`candidate_strategy_snapshot`，请求一次该候选工具，随后才返回固定的最终文本；因此这不是私有
directive loop 或只验证服务存在的 stub。探针将 native session 的 `tool/call` / `tool/result` 数量、
所有 Cordis inventory 和进程 handles 写入 `native-turn-solve.json`，并要求 Loader 卸载后回到
pre-boot 基线。

在 closure `sha256:49fc9cd46e2468f382a28eb47bd817d0384615a11c35399f8cf13c300b8ce533`
（56 packages、2525 files）下，对 baseline 的一次新建 admission 得到 `admitted`：native turn
产生 27 个 session events，恰有一对候选 tool call/result，耗时 36ms，且 quiescent。对应 capsule
tar `sha256:de388d8ee7947f59c642862abcbc3bfe8d86411e66624ab6693336f45f109dbe`、archive
`sha256:8897c3794d65b32275c529f889f93c85e694e4d3bf78e017cde4e6d413b9bf3c` 和 build receipt
均在本次 isolated work root 中生成；builder 将同样的 probe 结果绑定到每次 native admission 的
work-root artifact。

该证据证明 baseline 的 Loader → upstream AgentLoop → candidate agent-scope tool → session evidence
→ unload 链路真实成立。它不执行 `solve_exec`/`solve_read`/`solve_write`，没有 live gateway、
cancellation、Terminal-Bench trial、性能或 sealed 结果；这些仍是下一个 P0 验收门。
`NO_SEALED_RESULTS` 不变。

## 2026-09-03 native DSH packed-capsule proposal admission

trusted builder 对带完整 native closure 的 candidate admission 现在还强制执行
`native-proposal-probe.js`。探针从 capsule 内以真实 Cordis Loader 启动 propose overlay，并由确定性的
无网络、无凭据 LLM adapter 驱动 `ctx.agents.create()`。adapter 依次调用 agent-scoped
`proposal_list_files`、`proposal_write_child`、`proposal_finish`；后端只接受预定义 child 的单一
`src/index.ts` 写入，因此该步骤验证的是 upstream AgentLoop 的 session/tool dispatch、受限 proposal
backend 及 unload，而非自由模型生成或候选源码变更的可信性替代。

在与 solve admission 相同的 closure
`sha256:49fc9cd46e2468f382a28eb47bd817d0384615a11c35399f8cf13c300b8ce533`
下，baseline 的一次新建 admission 得到 `admitted`：proposal turn 产生 42 个 session events，恰有
3 对 native `tool/call` / `tool/result`，完成 1 次受限 backend write，耗时 59ms，Loader unload 后
Cordis inventory 与 process handles 均恢复基线。报告写入该 admission work root 的
`native-proposal.json`，builder 将 event、tool 和 write 数量作为 fail-closed receipt 条件。

该证据只证明 packed capsule 中的 Loader -> upstream AgentLoop -> proposal tools -> bounded backend
write -> session evidence -> unload 链路成立。它不验证真实 proposal policy、child materialization/
post-finish admission、remote gateway、完整 ACP stdio transport 或 cancellation，也没有 Terminal-Bench
或 sealed 性能结论。`NO_SEALED_RESULTS` 不变。

## 2026-09-03 native DSH packed-capsule solve-tool admission

trusted builder 对带完整 native closure 的 candidate admission 还会执行 `native-solve-probe.js`。该探针
从 capsule 内以真实 Cordis Loader 启动 baseline，构造 `createNativeSolveAgent()`，以确定性的无网络、
无凭据 LLM adapter 驱动 upstream `AgentLoop`。其 `AgentSideConnection` 是进程内 ACP facade：按顺序记录
`solve_exec`、`solve_read`、`solve_write` 对 terminal/read/write 方法的调用，并收集 assistant chunk；它不是
ACP stdio transport，也没有伪造模型或工具执行成功。

在 closure `sha256:49fc9cd46e2468f382a28eb47bd817d0384615a11c35399f8cf13c300b8ce533` 下，baseline 的
一次新建 admission 得到 `admitted`：native solve turn 产生 47 个 session events，恰有 3 对 native
`tool/call` / `tool/result`，完成 4 次 LLM completion，并各执行一次受控 terminal `printf native-solve`、
`/workspace/input.txt` 读取和 `/workspace/output.txt` 写入，随后收到固定 final assistant chunk。solve 耗时
35ms；Loader 卸载后 Cordis inventory 与 process handles 均恢复基线。报告写入 admission work root 的
`native-solve.json`，builder 将 completion、event、tool 与 ACP effect 数量作为 fail-closed receipt 条件。

该证据证明 Loader -> native solve agent -> agent-scoped DSH `solve_*` tools -> ACP facade -> session evidence
-> unload 链路真实成立。它不覆盖完整 ACP stdio request/cancel transport、取消时机、live model gateway、
Terminal-Bench trial 或 sealed 性能，不能据此宣称 live runtime 已完成验收。`NO_SEALED_RESULTS` 不变。

## 2026-09-02 native DSH proposal/solve runtime wiring (migration slice)

本轮把实际运行路径继续向参照项目收敛。proposal sandbox worker 在 native composition 可用时通过
`ctx.agents.create()` 启动候选 proposal agent，使用 candidate-owned `proposal_*` tools、原生
session/tool 事件和结构化 Unix proxy 消息；proposal request/response 的 prompt、response、tool-call
审计哈希会写入既有 transcript/receipt。Terminal-Bench ACP 在同一条件下通过
`createNativeSolveAgent()` 进入原生 DSH agent loop，并将 `solve_exec`、`solve_read`、`solve_write`
绑定到 agent Fiber；ACP 终端生命周期由原生工具层管理，solve gateway 现在接收完整 DSH message history
和 tool schema，并回传结构化 tool calls 及 prompt/response 哈希。
`solve_exec` 对 agent `AbortSignal` 做 fail-closed 取消：只允许一次 kill、等待退出、释放句柄；读写工具
在已取消时不会触碰 ACP。

native ACP 的启动边界已 fail closed：CLI 将冻结的 live Terminal-Bench solve route 的
provider/model/max-tokens 逐 job 写入 capsule 环境，故所有 live route 都要求完整 native DSH
composition 与 live solve gateway；任一缺失均在 ACP 启动前失败，绝不降级到项目私有 directive
loop。仅未声明 live native route 的离线 replay/旧 profile 仍保留兼容实现，且不会被误报为 native。

验证：`pnpm build` 通过；native composition、proposal、LLM adapter、solve gateway、live solve 定向回归
共 6 个测试文件、60 项通过；全量回归 48 个测试文件、495 项通过；`pnpm lint` 无 error（仅既有 warning）。
`pnpm provenance:check --silent` 的 upstream snapshot、package pins、reference/content、lock/schema 检查通过，
但本环境中其子进程读取 `pnpm --version` 时返回空 stdout，故 toolchain/versions 项无法确认（交互式
`pnpm --version` 为 11.9.0）；`git diff --check` 通过。完整 native package/依赖闭包现已由 builder
预构建并以内容哈希锁定；baseline packed capsule 的 Loader → `ctx.agents.create()` → candidate
tool dispatch → session events → unload admission probe 已通过。仍未执行的是 native proposal 的真实
policy/materialization/post-finish admission E2E、完整 ACP stdio transport/cancellation、live benchmark 和
sealed 评测；上述取消语义目前仅有 native tool 单元契约，不替代这些 Loader 级证据。
此时任何缺少完整 native route 的 live job 会按上述契约 fail closed。
`NO_SEALED_RESULTS` 不变。

为消除 candidate 只能演化 system prompt 的既有实现约束，candidate SDK 现在支持候选-owned
DSH-shaped `tools` 与 `skills` 注册（命名、数量、内容和 effect ownership 均 fail closed）。golden
baseline 同时声明并注册一个 candidate tool 和一个 candidate skill；candidate manifest 新增
`runtime.newSkillNames` 与 optional `proposal.strategySurfaces`。真实 Loader probe 在 boot/unload
前后记录三类 inventory，trusted builder 校验声明与实际注册一致，并将遗留 tool/skill 视为 unload
invariant 失败。recorded proposer 对此 baseline 的前两名 child 实际变更候选 tool 的策略描述或 skill 的指导内容，
同时保留稳定 capability 名称并同步 manifest，避免“策略面仅存在于 hypothesis”的不一致。

验证：`pnpm build` 与 candidate SDK/baseline/proposer/builder/manifest/Loader 的定向回归全绿（38 tests）；
CLI 真实闭环 15 tests、solve-gateway 容器 3 tests 也已通过。
完整比较和后续迁移边界见 `docs/dsh-self-evolving-comparison.md`。

**剩余迁移限制：** legacy loader inventory 的 tool/skill 查询仍使用 TCB probe stub；native admission
turn 已在 upstream DSH registry/dispatcher 中实际完成候选工具调用。legacy directive/replay loop
仍作为离线兼容回退保留。完整 live gateway 现要求 native DSH composition 与
冻结 provider/model；旧 directive live loop 仅能由历史/测试 profile 显式设置
`DSH_COMPATIBILITY_LIVE=1` 启动，Harbor/CLI 不会注入。native proposal/solve 线路已经接入
`ctx.agents.create()` 和 native tool/skill/session composition；solve composition、candidate tool dispatch、
agent-scoped `solve_exec`/`solve_read`/`solve_write` 的 deterministic ACP facade dispatch，以及 proposal 的
bounded list/write/finish tool loop 已在完整 packed capsule 中通过真实 Loader 和上游依赖闭包验收；完整
ACP stdio transport/cancellation 与真实 proposal policy/materialization 仍未验收。因此不能声称 baseline 已完成全原生 DSH agent runtime
迁移，也不构成 benchmark 性能结论；`NO_SEALED_RESULTS` 不变。

## 2026-09-02 active Terminal-Bench eligibility subset

K=10、K=80、sealed 和最终评测现在由同一个冻结策略驱动：仅允许
`[agent].timeout_sec <= 1800` 的题目。固定 89-task tarball 中实际纳入 **72** 题，排除 **17** 题；
72 题按确定性的最大余数法生成 `39 observed / 10 guard / 23 sealed` split。CLI init 将完整来源集、
排除句柄、阈值和 split counts 写入 `dataset-handles.json`，inventory、Harbor provider、image prefetch
和审计重放均使用同一策略。超过 1800 秒的题目不会进入任何运行题库；因此后续结果是
“Terminal-Bench 2.1 eligibility subset”结果，不宣称官方 89-task leaderboard 结果。

本策略已通过 `pnpm build`、inventory/split/provider/CLI 相关检查。新的真实 solver K=10 已启动，
run id 为 `gate8-live-pilot-t1800-c8-v3`；其 frozen `dataset-handles.json` 记录 89→72、
17 个排除句柄和 `39/10/23` split，Harbor plans 固定 `n_concurrent_trials: 8`，
`image-prefetch.json` 记录符合资格题目的本地镜像缓存，solver gateway 已产生
`deepseek/zen-compatible` route 的真实 receipts。最后可核对快照（2026-09-02 08:37）显示
14 个控制器 trial 已结算（5 success / 9 failure），7 个 admitted（含 baseline，6 个非 baseline），
另有 search-2 wave 的 7 个 Harbor 结果已结束、1 个仍在运行。随后宿主 WSL 于 09:01 重启，
run 进程和 scratch run root 消失；由于最终 evidence 未写入，不能将该 run 宣称为完成，亦不能
把未 collect 的 Harbor 结果并入控制器正式计数。结果仍只能解释为 eligibility subset，不得外推为
官方 89-task leaderboard。

## 2026-09-02 live-solver task-aware deadline and 131k output cap

真实 solver 的 capsule 不再使用统一的 1,740,000ms 内部 wall-clock。可信
Terminal-Bench adapter 在每个付费 launch 前读取该题 `[agent].timeout_sec`，应用 Harbor 已冻结的
`agent_timeout_multiplier=3`，并把得到的毫秒数写入该 job 的非秘密环境变量
`DSH_SOLVE_AGENT_TIMEOUT_MS`。capsule 缺少、损坏或不合法的该值时 fail closed；否则内部 deadline
为 `3 * agent.timeout_sec - 300s`，将最后五分钟固定留给 ACP reply、Harbor 结果写入和 teardown。
模型请求和 terminal command 均以该 deadline 的剩余时间为上限，因而长题不再被短题的固定时钟截断，
短题也不会获得不属于其任务的无限运行时间。`[verifier].timeout_sec` 不驱动 solver deadline，因其是
后续 verifier 阶段的独立限制。

真实 zen-compatible route 的 `maxOutputTokens` 默认值已改为 **131,072**，并作为 route plan/config
hash 的一部分冻结；K=10 live-pilot 脚本会显式断言该值。builder/capsule identity 已升至
`dsh-evolve-le-builder-0.0.4`，旧 live run 不可 resume 到此策略。固定 TB 2.1 tarball 的 89 个 task
已逐题解析成功，存在 600、750、900、1200、1800、2400、3600、7200、12000 秒九档 agent 时限。
这是工程配置与离线验证，不是新的付费 K=10/K=80 结果；`NO_SEALED_RESULTS` 不变。

## 2026-09-01 K=10 live-pilot attempt 3 stopped — verifier bootstrap boundary repaired

用户请求已停止 run root `gate8-live-pilot`：controller、Harbor runners 和 task containers
均已收到终止信号并退出。该 run 的 4 个已完成 trial 保留为诊断证据，不得 resume 或改写为
绿色结果。

失败分析确认：`image-prefetch.json` 只冻结了 89 个 Harbor task image 的本地 image ID；它
不包含 task 容器启动后由 `tests/test.sh` 执行的 `curl https://astral.sh/.../uv`、`uvx` 或
`pip install`。因此三项 verifier 在测试入口前就因 GitHub egress 失败，另一个 trial 的
`pyknotid` 未安装。此次修复新增 `verifier-image` 准备层（ADR-031）：对首个 discovery wave
的运行副本构建派生 image，预装 Python 3.13、精确 verifier requirements 和 verifier 所需的
literal system packages，改写副本 verifier 仅调用本地 `python -m pytest`，并用
`verifier-image-receipt.json` 绑定 base/derived image ID、依赖、固定 verifier fixture 和脚本
哈希。固定的 verifier-side git fixture 也在准备阶段冻结，trial 只从派生 image 复制；live
solver 在缺少该 receipt 时于付费 launch 前 fail closed。

工程验证：离线 verifier/image-cache targeted tests 7/7、`tsc -b`、oxlint、Prettier 和
`git diff --check` 均通过；真实 `build-pmars` 派生 image
`sha256:d7f28f1aac0ac57bb9470a215bbcfd644466f0e8d7f230411cd917a574b8586a` 已在
`docker run --network none` 下加载本地 pytest/CTRF plugin。首个 discovery wave 的六个
verifier 运行副本静态扫描未残留 `uvx`、PyPI/apt bootstrap 或 verifier-side `git clone`。

这只是修复验证基础设施边界；尚无修复后的付费 K=10/K=80 结果，也不改变
`NO_SEALED_RESULTS`。

## 2026-09-01 live-solver concurrency and image-cache boundary

为 K=10/K=80 的真实 solver 流程补上 wave-synchronous 调度：每个 wave 先按
reservation 顺序持久化全部 action，再并发 launch/等待 Harbor job，最后按 reservation
顺序 collect/commit；crash resume 对同一 wave 也并发补齐。真实 solver 的默认配置冻结
`harbor.concurrentTrials=4`，CLI 与 K=10 rehearsal 显式传入并校验该值。

真实 solver 在首个 Harbor launch 前扫描冻结 task set 的 `[environment].docker_image`，对
本机已有镜像只做 inspect，对缺失镜像只 pull 一次，并写入 run-scoped
`image-prefetch.json`（protocol、image ID、repo digest、动作）。resume 只校验 receipt 和
本机 image ID；镜像缺失或 tag 漂移 fail closed，不重复拉取或静默替换。真实 provider
还会把 receipt 的内容哈希冻结到 `run-manifest.json`，`audit` 会复算该绑定。该 receipt/并发
实现已有 unit、controller wave、driver、Loader service、CLI、TypeScript build 验证；尚未据此运行新的付费
K=10/K=80 或产生新的 benchmark 结果，`NO_SEALED_RESULTS` 不变。

**Gate 8 live-solver repair boundary:** 2026-09-01 的 K=10 live-pilot attempt 2 因模型单次
completion 模拟整段多轮 transcript、runner 解析/历史处理放大该行为而作废。首对象严格解析、成功
历史净化与失败原回复截断回灌已通过 unit + 真实 Loader/TLS 回归；`BUILDER_VERSION` 已升至
`dsh-evolve-le-builder-0.0.3`。这只是工程修复，尚无修复后付费 smoke/K=10 evidence；旧 run 不得
resume，下一次验证必须使用 fresh lineage。`NO_SEALED_RESULTS` 不变。

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
  benchmark profile：`specs/07` §10 的 pilot（K=10）profile 已于 2026-08-31 重新记录
  （首记录因 infra 伪装作废，见当日节）；search（K=80）/sealed/official 三个 profile
  未运行。前代项目的通过记录不是本仓库的完成证据（见 2026-08-28 节）。

## 2026-09-01 Gate 8 live-pilot attempt 2 voided — chatty completion parser/history repair

- **故障事实边界**：隔离失败产物的 operator analysis（未进入 accepted `evidence/gate8/`）报告 8 条
  已完成 trajectory 全部在 1,740,000ms wall-clock backstop 结束，零 final directive、任务交付物缺失；
  代表 trial `bn-fit-modify__ZVG8Gw2` 的文本含 204 个 JSON-looking directive、157 个伪
  `[exec exitCode=0]`，但 ACP events 只有 6 次真实 `create_terminal`。多条 receipt 的 completion
  恰为 32,768 tokens，符合当时模型在一次 completion 内生成“指令 → 幻觉 tool result → 后续指令 →
  伪 role prompt”的整场模拟。
- **根因**：旧 parser 用首 `{` 到末 `}` 的整段做 `JSON.parse`，多对象回复必然失败；失败分支又只
  回灌错误句、不回灌原回复，stateless gateway 的下一轮看不到上一轮输出，形成重复的大 completion
  循环。成功解析若继续保留整段 raw reply，也会把幻觉 suffix 再次带入下一轮。
- **工程修复**：只验证第一个 string/escape-aware 平衡对象，首对象无效即 recoverable fail，不扫描后续
  对象；raw completion 仍完整进入 trajectory，但成功历史只加入规范化的已接受 directive + 真实 ACP
  tool result；失败历史加入最多 2,000 字符原回复和截断标记。builder/runner identity 升至 `0.0.3`。
- **验证**：新增契约先在旧实现上得到 3 个预期失败，再在修复后转绿；live-solve 定向文件 20/20 通过，
  其中现场形状经真实 Cordis Loader 子进程 + 本地 HTTPS solve gateway 验证；production capsule 双构建
  契约确认 `solve-protocol.js`/`solve-client.js`/`live-solve-agent.js` 均存在且进入 `SHA256SUMS`。
- **未完成/不得声称**：未运行修复后的真实模型 smoke、K=10 或 sealed；attempt 2 不可 resume，不得作为
  baseline、能力或成本结论。下一次付费验证必须新 run root、新 capsule hash，并保留完整 failure/success
  lineage。详见 ADR-030 的 2026-09-01 amendment。

## 2026-08-31 Gate 8 pilot recorded — voided first recording, five-defect repair chain, 50/50 real-agent trials

- **旧记录作废（VOID）**：2026-08-30 首次记录的 pilot（13 trials、"10/10 baseline FAIL"）
  是无效测量：capsule 入口 `exec node` 依赖 PATH 里的 node，而 TB task 镜像不带 node，
  **全部 baseline trial 实为 `exec: node: not found` 的 infra 死亡，从未有 agent 运行**，
  "10/10 FAIL" 把基础设施死亡伪装成了能力结果。当时的 recorder 没有 participation
  分类，伪装未被拦截。作废依据：ADR-025 与 git 历史中的旧 evidence（本次 PASS 已替换）。
- **修复链（attempts 5→9，每步先 ADR 后实现，旧 run root 一律保留为缺陷证据）**：
  - ADR-025：capsule 自包含（pinned node runtime 随包分发，TB 镜像无 node）；
    normalizer 引入 agent-participation 事实（`agent_result.metadata.acp.initialize`
    非空 ⇔ agent 真实说过协议）与 infra 分类（never-initialized + 预登记 pre-launch
    异常 → INFRA_RETRYABLE，按 rule 7 留在分母计 reward 0；agent 进程死亡 fail
    gate）；trial cap 24→48。
  - ADR-026：trusted builder 拒绝子代 = 逐 child 结果而非 run crash（specs/03 §7）；
    crash-mid-rebuild 的 intent 结算与计数修复；**K 语义纠正**——specs/03 §2 的 K 恒指
    admitted 子代数，首个 pilot 错把 K=10 解释成 10 个开发样本；cap 48→60（实测曲线
    6 freeze + ≤12 q0 + ~2.8 pool/child ≈ 49）。
  - ADR-027：harbor 双时钟域使 `agent_execution` 出现负增量 → 归一为 null（attempt 6
    的 run root 被一条持久化非法 observation 砖死，不可重放）；`validatePayload` 前置
    到 journal append 之前，malformed payload fail closed 而 run root 保持可重放。
  - ADR-028：harbor 层预登记 infra retry（1 次、include-list 与 normalizer 的
    INFRA_RETRYABLE_EXCEPTIONS 同源）+ `agent_setup_timeout_multiplier` 5（1800s；
    实测 ubuntu:24.04 真基座 ACP bootstrap 隔离 ~383s、现场两次 >850s，360s/900s
    两档均被 `AgentSetupTimeoutError` 击穿）+ driver 对 infra-dead discovery 立即
    fail closed（attempt 7 曾把一个从未运行 agent 的 handle 冻进 pool，被
    `baselineFreezeTrialsAllRanAgents` 拦下）；recorder 修复相对路径 bug（此前把
    participation 全部误读为 unknown=42，掩盖真实 ran=33/never=9）且证据目录改为
    仅 PASS 写入（verify-only 重跑不再能覆盖已提交证据）。
- **本次记录（attempt 9，run root `dsh-gate8-pilot-DCJKdk`，configHash `d5a7982a…`）**：
  `runId=gate8-pilot`，§4.1 首批 6 个 observed handle（seed commitment 预注册）全部
  真实运行并 FAIL → failure pool 6 题在首个 batch 边界冻结（任何 proposal 之前）；
  live `deepseek-v4-flash`（routeHash `892fad67…` 与 smoke 一致）**4 次扩张全部
  receipt ok**（28 receipts、267k prompt + 190k completion tokens、90 712 µUSD 权威
  结算恰好一次）；**12 个 admitted 子代**（第 4 次扩张使 K=10 达成，补齐全部 q0 后
  `STOPPED:K_REACHED` 停机，depthMax 4、深度分布 1–4 层），0 rebuild 拒绝、
  0 abandoned intent；**50 trials 全部 participation ran=50 / never-initialized=0 /
  unknown=0**（此前五次尝试的 infra 伪装类彻底消失）；50 个 trial 目录 = 50 行
  ledger = 50 个归属 capsule 归档，二次 resume 字节不变，audit 全绿，**37 条机器
  断言全 true**；sealed/guard（29/12 handle）对 proposer/selector 不可见，凭据未
  出现在任何 run/job artifact。
- **预算外推原始数据（specs/04 §12，外推是设计输入不是已验证结论）**：整条 pilot
  13 386s（~3.7 h；50 trials ≈ 268s/trial 含 Harbor 容器与 bootstrap 开销）；
  proposer 90 712 µUSD / 4 次扩张（~22.7k µUSD/扩张、3 子代/扩张）→ K=80 外推
  ~27 次扩张 ≈ **$0.6 金钱侧**、~302 trials ≈ **22.5 h 顺序时间侧**：$500/16h 验收
  在金钱侧宽裕、时间侧需要 trial 并行化，这是 search profile 的已知设计输入。
- **产物**：`evidence/gate8/pilot/{pilot-run.json,STATUS.json,EVIDENCE.md,run/,jobs/}`
  （PASS、failedChecks 空、evidenceSha256 `0549bfb5…`）；`scripts/record-gate8-pilot.ts`
  （`pnpm evidence:gate8-pilot`）。attempts 5–8 的 run root 保留在 scratch 作缺陷
  证据（`84ayxu`=TRIAL_CAP 预算校准、`ilqc34`=poisoned journal、`Gyz9DL`=attempt 7
  infra 冻结、`tHdvWP`=attempt 8 setup 击穿）。证据是**文档化子集**（ADR-029）：13 个
  capsule tarball 因体积未入库（digest 已 pin 在 `capsules/*.json`，可由归档源码 +
  pinned runtime 重建比对）；audit 的 `capsule-archives` 检查在 live run root 上
  13/13 通过（PASS 当时），对子集直接重跑会报 archive missing，属子集语义非篡改。
- **边界**：pilot 只证明 K=10 admitted 的 tuning 稳定性、infra 分类下 50/50 的
  真实 agent 参与率、以及预算量级；**solve 侧（baseline 与全部 12 个子代）用的都是
  Gate 6 stable-demo 的 recorded-replay 胶囊**——LLM 表面对未录制 prompt 回一条
  罐头消息（`[dsh-evolve-le replay] no recorded response for prompt sha256:…`）后
  end_turn、零工具调用、零产物，live `deepseek-v4-flash` 只出现在 **propose 侧**
  （4 次扩张）。因此 50 个 solve trial 的 reward 全为 0 是零能力 replay 的机械结果，
  failure pool 6 题全 FAIL 同理（verifier 真实运行：adaptive-rejection-sampler
  9/9 测试失败因 `/app/ars.R` 不存在等）；这不是 infra 伪装（participation ran=50），
  也不构成该模型/harness 在 Terminal-Bench 上的任何性能陈述——第一个测量真实
  solve 能力的是未运行的 search（K=80）/sealed profile；不含 sealed 揭盲；
  `NO_SEALED_RESULTS` 维持。

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
  Zen/high/1M/131k 可选路由）；加载即 JSON-Schema + 语义校验（discovery ≤ solver ≤
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
