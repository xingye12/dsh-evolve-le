# 本机 Docker 候选生成

新运行可选择 `docker-local/v1` proposal backend。它在本机 WSL/Linux Docker 中启动真实
Cordis Loader/native AgentLoop，导出不可变候选源码并清理容器，然后交给既有可信规范化、
验证与准入流程。候选生成容器不编排 online tests、validator 或 benchmark。

## 启用

1. 使用可信构建得到 proposal executor 的 digest 与 image ID。现有构建入口是
   `scripts/build-sandbox-images.ts <base@sha256:digest> <new-output-directory> proposal`，
   只构建 proposal image 并输出 `images.json`，无需构建 validator；不要用浮动 tag 替代 digest。
2. 建一个无凭据的 profile 文件，image 字段取构建输出中的 proposal image：

```json
{
  "backend": "docker-local/v1",
  "hostRoot": "/tmp/dsh-generation",
  "image": {
    "reference": "dsh-evolve-le/proposal-executor@sha256:<actual-digest>",
    "id": "sha256:<actual-image-id>",
    "platform": "linux/amd64"
  }
}
```

3. 在原有 `dsh-evolve init` 参数上增加 `--proposal-docker-profile /absolute/profile.json`。
   同时选择已配置 endpoint、精确 model、价格和 credential file 的 live proposer route。
   `init` 将 profile 内容写入新 run config，并冻结该 proposer route 为 `maxAttempts=1`。
   Native DSH catalog/closure 继续使用原有初始化参数。
4. 正常执行 `run` / `resume`。CLI 创建 `localDockerProposalRunner`，现有 Controller 的
   `runProposal` 自动走 Docker 分支。配置哈希包含新 profile；为此创建新 run，不能修改既有
   run config 或把历史结果归到新执行策略。

`hostRoot` 应是同一个本机 Docker Engine 可见的 root-owned 私有目录，且路径不超过 40 字符，
以满足 action Unix socket 的长度限制。该后端已针对本机 WSL 内 Docker Engine 验证；
其 shell process census 使用与 daemon 相同的 Linux PID 视图。

## 边界与预算

`local-generation/v1` 不要求 AppArmor 或宿主 delegated cgroup v2。它保留固定镜像/入口、
非 root、只读根与输入、无网络/凭据/Docker socket、cap-drop、no-new-privileges、seccomp，
以及有界 tmpfs、Docker 内存/swap/CPU 速率/PID 限额、输出/文件上限和外部 wall timeout。
不测量累计 CPU 时间、memory peak 或宿主 cgroup events。

模型请求由容器外 owner 发出，凭据从私有 root-owned 普通文件读取，不传给容器或冻结配置。
每个请求只有一次 dispatch，费用和 token 上限来自 Controller 已持久化的 action reservation。
不确定 dispatch 不按零费用结算，也不自动重发。

生成提交是 `generation-submission/v1`，保留原始语义草稿与源码快照；不是 admission。
Controller 验证 execution/cleanup/source graph，再在私有副本上规范化 receipt，并复用原有
proposal validator 和后续 builder。source registration 不等于 build admission，原始快照不改。`generation-accounting/v1` 将模型账本汇总
绑定到同一 execution，供 Controller 预算结算。

## 读取与清理

每个 proposal 的 `controller/sandboxes/<action>/generation-config.json` 保存无凭据冻结配置。
CAS handoff 记录为 `generation-handoff.json`。手工检查或回收该 attempt：

```bash
node packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js read /absolute/generation-config.json
node packages/dsh-evolve-le/lib/bin/docker-proposal-generation.js sweep /absolute/generation-config.json
```

`sweep` 取得原 attempt 的同一把 kernel lock，核对已有执行和挂载身份，停止、导出、删除容器、
卸载 tmpfs 并释放 reservation。不创建 worker、不初始化 live transport、不重新计费；
锁被活 owner 占用时返回 75，不抢清理。它追加 cleanup receipt，不把原失败改成成功。

新 backend 在外部调用前记录 launch；恢复时只读回原结果，不重新启动一个不确定的 attempt。
完整 evidence/registry 丢失时需要人工处理，不使用全局 prune 或路径猜测。

## 验证

```bash
pnpm build
DSH_LOCAL_GENERATION=1 pnpm vitest run packages/dsh-evolve-le/tests/execution/local-generation.live.test.ts
```

上述为零费用 replay，覆盖真实 Loader、文件与 shell 修改、只读/网络/凭据负例、源码快照、
owner-kill/sweep、wall timeout，以及 Controller 外部验证/准入和重复消费。
付费测试独立开启，不能由该 replay 标志触发。

设计依据：[ADR-079](adr/0003-local-docker-generation.md)、
[执行计划](docker-proposal-sandbox-v0-plan.md)。本后端的工程验证不产生 benchmark 或 sealed 结论。
