# 纯本地化迁移 — 进度跟踪

> 实施依据:`plans/local-only-cloudflare-ama-removal.md`。每个阶段独立测试验收并提交。
> 基线数据见 `docs/local-only-migration-baseline.md`。

## 阶段状态总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 冻结基线与迁移预检 | ✅ 已交付(commit `0caf692`) |
| 1 | 平台无关边界(AppDatabase 契约 + SQLite 适配) | ✅ 已交付(commit `4859309`) |
| 2 | 纯 Node 运行时 | ✅ 已交付(commit `25354e1` + `58b10a2` + `78e4475`) |
| 3 | 删除 AMA 双轨运行时 | ✅ 已交付(见下,commit 至 `d12689c`) |
| 4 | Local Maintainer 完整替代 | 🔶 服务端+UI 已交付(commit `5806179`+`503c24f`),CLI 执行面/事件/skill 待续 |
| 5 | 用户名认证与托管邮箱移除 | ✅ 已交付(commit `420fc61`) |
| 6 | 可选 GitHub App | ✅ 已交付(commit `b34d7b8`) |
| 7 | 导入旧 Wrangler/D1 数据 | ✅ 已交付(commit `753cb7f`) |
| 8 | 删除 Cloudflare/AMA 构建与文档遗留 | ✅ 已交付(commit `79d9153`) |

## 阶段 1 已完成部分

- ✅ `AppDatabase` 契约(`apps/web/server/database/appDatabase.ts`):镜像 D1 的
  `prepare/bind/all/first/run/raw/batch/exec` 形状,`meta.changes`/`last_row_id` 为必填。
- ✅ better-sqlite3 适配器(`apps/web/server/database/sqliteDatabase.ts`):
  WAL、`foreign_keys = ON`、5s busy timeout、`batch()` 原子事务(失败回滚)、
  `wal_checkpoint(TRUNCATE)` 关闭前 checkpoint;值归一化(undefined→NULL、boolean→0/1、Date→ISO)。
- ✅ 依赖:`better-sqlite3@13` + `@types/better-sqlite3`,pnpm-workspace.yaml 放行构建脚本。
- ✅ repo 类型解耦:`db.ts` 的 `D1` 别名指向 `AppDatabase`,约 290 处 `prepare` 调用点
  无需改动即切换契约(Cloudflare D1 运行时结构兼容)。
- ✅ 契约测试(`sqliteDatabase.test.ts`,8 用例):语句绑定/归一化、`meta.changes`、
  batch 原子回滚、条件 task claim 原子性、外键约束。

## 提交记录

- `420fc61` — 阶段 5 用户名认证改造
- `0caf692` — 阶段 0 基线 + 阶段 1 AppDatabase 契约/better-sqlite3 适配器/契约测试
- `4859309` — 阶段 1 完成(AppServices + createApi)
- `25354e1` — 阶段 2 核心(Node 运行时:server 入口/relay/长 SSE/metrics/scheduler)
- `a79262d` — 阶段 3.1 任务分配只检查本地,移除 AMA dispatch
- `58dd78b` — 阶段 3.2 modelCatalog 本地化,删 maintainerTriggerConcurrency
- `586727c` — 阶段 3.3 移除 AMA 任务消息
- `9dcd4d7` — 阶段 3.4/3.5 routes 全部本地化,删除 amaRuntime/amaOwnerIntegrationRepo/taskDispatch
- `ff8cd6c` — 阶段 3.6 shared types 移除 AMA 类型与 ama_agent_id
- `32df9db` — types.ts 移除 AMA env 配置
- `56befb8`/`faa19c2`/`b266f9c`/`d12689c` — 阶段 3 收尾(CLI/前端/schema/repo/wrangler)
- `58b10a2` — 阶段 2 收尾:Node 运行时入口(`node/cli.ts`)、本地 migrations(`migrate.ts` + `db:migrate`)、vite 去 cloudflare() 改 proxy、`service_runner.sh` 纯 Node
- `b34d7b8` — 阶段 6 可选 GitHub App:webhook/repositories 稳定 disabled
- `753cb7f` — 阶段 7 `pnpm local:migrate --from-wrangler` 导入旧 D1 数据(备份/列交集/AMA 清理/manifest)
- `79d9153` — 阶段 8 删除 Cloudflare/AMA 构建遗留(worker/wrangler/tunnelRelay/CF metrics/依赖/文档)
- `78e4475` — dev 启动修复(`pnpm run server` 避开 pnpm 内置 server 命令)

## 阶段 3 完成情况

### 已完成(服务端 + shared)
- **3.1**(`a79262d`):runtimeRouter ama 恒 false;taskDispatch 删 dispatch/claim/backoff/
  prompt/vault/session/teardown/sweeps;runtimeCoordinator dispatch/release 变空;
  githubWebhook/taskStale 不再 teardown;cron 只剩 stale sweeps。净删 836 行。
- **3.2**(`58dd78b`):modelCatalog 只聚合本地机器;删 maintainerTriggerConcurrency.ts。
- **3.3**(`586727c`):taskDispatch 删 sendTaskMessageToAma/sendTaskRejectToAma;routes
  reject/notes/messages 不再发 AMA session 消息。
- **3.4/3.5**(`9dcd4d7`):routes 删 /api/ama/provision、/api/machines/cloud、/api/sessions*、
  /api/tasks/:id/session(+/ws);agent create/update/delete 不再镜像 AMA;board maintainer
  纯 local(无 AMA schedule/HTTP trigger/vault/memory);maintainer variables/memories/runs
  端点删除;machine 状态纯本地;githubWebhook 删 AMA maintainer 事件;betterAuth 删
  hasAmaResources 与 AMA OIDC provider;删除 taskDispatch.ts/amaRuntime.ts/
  amaOwnerIntegrationRepo.ts/amaRuntime.test.ts;runtimeRouter 删 ama 辅助。净删 3675 行。
- **3.6**(`ff8cd6c`):AgentRuntime 去 'ama';MachineHosting 仅 local;删
  CLOUD_AGENT_RUNTIMES/isCloudAgentRuntime;Agent.ama_agent_id 删除;agentRepo 删
  setAgentAmaId 等;agentSessionRepo 删 AMA session 函数,listSessions 不再暴露
  ama_session_id/'ama' source。
- **`32df9db`**:AppServices/Env 移除 AMA_* 配置;auth agentRuntimeSource 仅 legacy。

### 已完成(CLI/前端/schema/repo,2026-08-30)
- **CLI**(`56befb8` `refactor(cli): drop ama-runner mode and device login`,12 文件
  +60/-1417):删 `packages/cli/src/amaRunner.ts`;`start.ts` 的 --mode ama 分支与
  RunnerMode;controlPlaneEnv.ts 的 AMA_* env;paths.ts 的 AMA_WORKSPACE;
  maintainerScheduler.ts 的 scheduler_type "ama";重写 start-command.test.ts、
  auth-command.test.ts、processManager.test.ts。
- **前端**(`faa19c2` `refactor(web): drop AMA cloud UI, session chat, and dead API
  clients`,14 文件 +33/-2281):删 api.sessions/chat/Cloud Sandbox/OIDC/
  MaintainerDetailPage 的 AMA session 元数据展示。
- **schema/迁移**(`b266f9c`,含 `0048_drop_ama_columns.sql`):先 DROP 索引再
  DROP COLUMN,删 agents.ama_agent_id、machines.ama_environment_id、
  board_maintainers.ama_*(含 last_ama_session_id)。
  **保留**:`ama_agent_sessions` 表及其 ama_session_id/secret_ref/secret_credential_id
  (agent 会话认证核心,agentSessionRepo/auth.ts/agentRepo/statsRepo 使用)。
- **repo 残留**(`b266f9c` + `d12689c`):boardMaintainerRepo/machineRepo 删 AMA
  列与死函数;`d12689c` `refactor(server): drop dead runtime-binding repo and AMA
  claim branches`(+2/-153)删 runtimeBindingRepo.ts(listPendingTaskRuntimeBindings/
  compareAndSetTaskRuntimeSource/persistInferredAmaTaskRuntimeSource 全无调用方)、
  runtimeRouter.selectRuntimeSource、taskRepo claimTask 的 "ama" sourceGuard 分支与
  listTasks 的 runtime_source 类型收窄为 "legacy"。
- **wrangler**(`b266f9c`):删 AMA_ORIGIN/AMA_OIDC_*/AMA_RUNNER_VERSION vars(生产+staging)。
- 全量回归 2450 tests 通过;`docs/HANDOFF-stage3-cli.md` 已同步。

## 后续会话起点

阶段 2/3/6/7/8 全部完成,纯本地运行时已是唯一部署方式
(`pnpm dev` = Node API 8787 + Vite 6265 proxy;`service_runner.sh` 单进程生产;
数据迁移 `pnpm local:migrate --from-wrangler`)。

### 阶段 4 当前进度(🔶 进行中)

**已交付(2026-08-30)**:
- `5806179` 服务端核心:
  - 迁移 `0049_local_maintainer_runtime.sql`:board_maintainers 加 `runtime`/`model`/
    `github_events_enabled`;新表 maintainer_runs/sessions/memories/event_cursors。
  - `maintainerAgent.ts`:租户级内置 Local Maintainer Agent(username
    `ak-local-maintainer-<suffix>`,builtin=1 + NoSchedule taint,不可编辑/删除)。
  - `maintainerRuntimeRepo.ts`:run 原子领取/串行/租约/完成/失败/幂等入队/supersede;
    session 按 routing_key 复用;memory 带 revision 条件写入。
  - 服务端 API:create/PATCH 支持 runtime/model/github_events_enabled(agent_id 兼容
    忽略,恒绑定内置 agent);GET runs/sessions/memories;机器专用
    `POST runs/claim`、`PATCH runs/:id/lease|complete|fail`。
- `503c24f` UI:BoardMaintainerDialog 去 agent 选择,改 runtime/model/GitHub 事件开关;
  MaintainerDetailPage 加 Runtime/GitHub events 指标与 Sessions tab,Activity 改读本地
  runs(trigger/routing_key/machine/status/error),移除 Variables 面板。

**剩余(CLI 执行面 + 事件 + skill,计划 3.3-3.4)**:
1. **CLI 执行管线**:把 `daemon/dispatcher.ts` 的 provider 启动/临时 Ed25519 session
   身份/隔离 HOME/runtime 配置/skill snapshot/限流提取为可复用执行管线,新增
   `LocalMaintainerRuntime`(不调 task claim/complete/reject):领取 run → 物化
   ak-maintainer skill + memory → 注入 AK_BOARD_ID/AK_MAINTAINER_ID/AK_MAINTAINER_RUN_ID
   → 启动 provider → 完成/失败 + memory revision 回写。Session 本地存储加
   `type: "maintainer"`。
2. **Scheduler 切换**:`LocalMaintainerScheduler` 从 local-runs 任务卡改为主管道:心跳/
   review 入队 maintainer_runs + 执行器消费(仍保留旧 local-runs 端点兼容)。
3. **GitHub 事件**:webhook 规范化/去重 + `maintainer_event_cursors` 轮询兜底
   (Repository Events API + ETag);issue/PR 会话复用与关闭。
4. **Skill 本地化**:完整打包 `skills/ak-maintainer/`(SKILL.md + references),每日更新
   + 快照固定 + last-known-good。

测试:服务端已覆盖(run 原子领取/串行/租约、sessions 复用、memory revision、UI)。
CLI 执行面测试待做(计划用 fake provider 验证心跳写 memory、GitHub 事件入独立 run)。
