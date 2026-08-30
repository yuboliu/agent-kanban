# 交接文档 — 阶段 3 CLI 清理(2026-08-30)

> 本文件为后续会话交接用。总进度见 `docs/local-only-migration-progress.md`。

## 当前状态

- **已提交(9 个)**:阶段 3 服务端 + shared 全部完成(见下)。
- **未提交(9 个文件,全部为 CLI 清理)**:`git status` 显示 `packages/cli/src` 与
  `packages/cli/tests` 的 AMA 清理。**这些改动已验证 `tsc` 通过,但 CLI 测试
  `start-command.test.ts` 仍有 28 个失败(AMA 测试未重写),因此尚未 commit
  (pre-commit 钩子会跑完整测试)**。

### 未提交的改动清单

| 文件 | 改动 |
|---|---|
| `packages/cli/src/amaRunner.ts` | **已删除**(AMA runner 下载/校验,152 行) |
| `packages/cli/src/commands/start.ts` | 删除 `--mode ama` 分支:amaRunnerArgs/ensureRunnerLogin/startAmaRunner/startPreparedAmaRunner/applyAmaRunnerOnboarding/registerMachine/RunnerMode/runnerMode;删除 runner 凭据 store 类型与 migrateLegacyRunnerLogin/runnerLoginStatus;DaemonState 删 runtime/runnerPath/runnerVersion;删除 `--mode` 选项(start/restart) |
| `packages/cli/src/commands/auth.ts` | maintainer session 请求不再发送 ama_session_id/ama_trigger_run_id;workerGithubAuthHome 改用 AK_WORKSPACE_HOME/AK_WORKSPACE_DIR |
| `packages/cli/src/controlPlaneEnv.ts` | 删除 AMA_TOKEN/AMA_RUNNER_CONFIG/AMA_RUNNER_CREDENTIALS/AMA_OIDC_CLIENT_SECRET |
| `packages/cli/src/daemon/maintainerScheduler.ts` | `scheduler_type` 类型收窄为 `"local"` |
| `packages/cli/src/paths.ts` | 删除 `AMA_WORKSPACE` 回退 |
| `packages/cli/tests/ama-runner.test.ts` 等 3 个 | **已删除**(AMA runner 测试) |

### CLI 测试当前状态(未完成,必须修复才能提交)

- `packages/cli/tests/start-command.test.ts`(1736 行):**28 个失败**。需删除 AMA 相关
  测试与辅助:
  - 删头部 `vi.mock("../src/amaRunner.js", ...)`、`mockMachineRunnerFetch()`、
    `writeCredentialStore()`、`credentialsFilePath`/`legacyLoginFilePath` 常量、
    `registerStartCommand`/`registerRestartCommand` 的 `mode` 覆盖辅助。
  - 删测试:"finishes AMA onboarding…"、"rechecks a live PID…"、"preserves AMA
    onboarding…"、"sanitizes inherited control-plane secrets…"、"starts the Machine
    runner, pointing it at the AMA origin…"、"does not pass onboarding runner id…"、
    "skips device login…"、"migrates a legacy saved login…"、"re-runs device login…"(×3)、
    "refreshes a saved runner login…"、"clears a stale refreshable runner login…"、
    "throws when machine registration…"(×3)、"fails start when device login exits
    non-zero"、"restarts the Machine runner with the original AK credentials flow"。
  - `it.each([["local","local"],["ama","ama"],["ama","local"]])` 改为只 `["local","local"]`。
  - 保留所有 local daemon 测试(IPC ready、并发锁、stale marker、SIGTERM/SIGKILL、
    restart 本地设置保留、status/stop/logs)。
  - 注意:local daemon 测试断言 `daemon-state.json` 含 `runtime: "local-daemon"`,
    该字段已从 `DaemonState` 删除,需同步删断言。
- `packages/cli/tests/auth-command.test.ts`:5 处 `AMA_WORKSPACE_HOME`/`AMA_WORKSPACE`
  改为 `AK_WORKSPACE_HOME`/`AK_WORKSPACE_DIR`。

## 已完成提交(阶段 3 服务端 + shared,全部过 pre-commit:biome/typecheck/vitest 2545+)

- `a79262d` 3.1 任务分配只本地,删 AMA dispatch(净删 836 行)
- `58dd78b` 3.2 modelCatalog 只聚合本地;删 maintainerTriggerConcurrency.ts
- `586727c` 3.3 移除 AMA 任务消息
- `9dcd4d7` 3.4/3.5 routes 全本地化;删 amaRuntime.ts(1496 行)/amaOwnerIntegrationRepo.ts/
  taskDispatch.ts/amaRuntime.test.ts(净删 3675 行);betterAuth 删 AMA OIDC;githubWebhook
  删 AMA maintainer 事件
- `ff8cd6c` 3.6 shared types 去 ama runtime/cloud hosting/ama_agent_id;repo 层清理
- `32df9db` AppServices/Env 去 AMA_* 配置
- `4f9021f` 进度文档

## 后续任务(按优先级)

1. **修复 CLI 测试并提交**:
   - 重写 `start-command.test.ts`(删 AMA 测试)、改 `auth-command.test.ts`。
   - `pnpm --filter agent-kanban exec tsc --noEmit` + `npx vitest run packages/cli/tests/start-command.test.ts packages/cli/tests/auth-command.test.ts`。
   - 提交未提交的 9 个文件(建议 message:`refactor(cli): drop ama-runner mode and device login`)。
2. **前端 AMA UI**(`apps/web/src`):
   - 搜索 `ama`/`AMA`/`cloud machine`/`session` 相关页面/组件/API 客户端。
   - 已知:MaintainerDetailPage.tsx 的 AMA session 元数据展示(AK_ANNOTATION_KEY_* 可保留
     或清理,取决于 session 来源);SessionsTab/OIDC 按钮/cloud machine UI。
3. **schema/迁移清理**(`apps/web/migrations`):
   - `agents.ama_agent_id`、`machines.ama_environment_id`、`board_maintainers.ama_schedule_id`/
     `ama_http_trigger_id`/`ama_memory_store_id`/`ama_board_vault_id` 等、`ama_agent_sessions.ama_session_id`/
     `secret_ref`。新建迁移删除列(注意 board_maintainers.ama_schedule_id 现为
     `local:<id>` 占位,需先转换再删)。
4. **repo 残留**(`boardMaintainerRepo`/`machineRepo`/`taskRepo`/`runtimeBindingRepo`):
   - 删 AMA 列读取/写入与分支(如 `ama_environment_id`、`ama_http_trigger_serialized`)。
5. **wrangler 配置**:删 AMA env 绑定与 `wrangler.jsonc` 中 AMA vars。
6. **阶段 4**:Local Maintainer 完整替代(本地 schedule/trigger 已部分存在:
   `maintainerScheduler.ts`、`POST .../maintainers/:id/local-runs`、`ak local_start`)。

## 关键命令

```bash
# CLI typecheck
pnpm --filter agent-kanban exec tsc --noEmit
# 单测(CLI)
npx vitest run packages/cli/tests/start-command.test.ts packages/cli/tests/auth-command.test.ts
# 全量回归(pre-commit 自动跑)
git commit -m "..."
# 服务端 typecheck
npx tsc -p apps/web/tsconfig.json --noEmit
```
