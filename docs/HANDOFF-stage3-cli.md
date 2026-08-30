# 交接文档 — 阶段 3 CLI 清理(2026-08-30)

> 本文件为后续会话交接用。总进度见 `docs/local-only-migration-progress.md`。

## 当前状态

- **阶段 3 CLI 清理已完成并提交**:commit `56befb8` `refactor(cli): drop ama-runner
  mode and device login`(12 文件,+60/-1417,pre-commit biome/typecheck/vitest 2519 全过)。
- 至此**阶段 3(删 AMA)全部完成**:服务端 + shared + CLI。

### 提交 `56befb8` 内容

| 文件 | 改动 |
|---|---|
| `packages/cli/src/amaRunner.ts` | **已删除**(AMA runner 下载/校验,152 行) |
| `packages/cli/src/commands/start.ts` | 删除 `--mode ama` 分支:amaRunnerArgs/ensureRunnerLogin/startAmaRunner/startPreparedAmaRunner/applyAmaRunnerOnboarding/registerMachine/RunnerMode/runnerMode;删除 runner 凭据 store 类型与 migrateLegacyRunnerLogin/runnerLoginStatus;DaemonState 删 runtime/runnerPath/runnerVersion;删除 `--mode` 选项(start/restart) |
| `packages/cli/src/commands/auth.ts` | maintainer session 请求不再发送 ama_session_id/ama_trigger_run_id;workerGithubAuthHome 改用 AK_WORKSPACE_HOME/AK_WORKSPACE_DIR |
| `packages/cli/src/controlPlaneEnv.ts` | 删除 AMA_TOKEN/AMA_RUNNER_CONFIG/AMA_RUNNER_CREDENTIALS/AMA_OIDC_CLIENT_SECRET |
| `packages/cli/src/daemon/maintainerScheduler.ts` | `scheduler_type` 类型收窄为 `"local"` |
| `packages/cli/src/paths.ts` | 删除 `AMA_WORKSPACE` 回退 |
| `packages/cli/tests/ama-runner.test.ts` 等 3 个 | **已删除**(AMA runner 测试) |
| `packages/cli/tests/start-command.test.ts` | **重写**:删 AMA 测试/辅助(vi.mock amaRunner、mockMachineRunnerFetch、writeCredentialStore、credentialsFilePath/legacyLoginFilePath、registerStart/RestartCommand 的 mode 覆盖);`it.each` 并发锁只留 `["local","local"]`;local 测试删 `runtime: "local-daemon"` 断言;restart 启动日志断言改为小写 `machine runner started`(local 版日志为 `Local machine runner started`) |
| `packages/cli/tests/auth-command.test.ts` | `AMA_WORKSPACE_HOME`/`AMA_WORKSPACE` → `AK_WORKSPACE_HOME`/`AK_WORKSPACE_DIR`(beforeEach/afterEach + 2 个 git 测试) |
| `packages/cli/tests/processManager.test.ts` | controlPlaneKeys 删 AMA_*(与 controlPlaneEnv.ts 同步) |

### 坑

- `replace_in_file` 偶发"报告成功但未生效",编辑后需 read_file 复核。
- local daemon 成功日志是 `● Local machine runner started`(小写 machine),旧 AMA
  断言 `Machine runner started`(大写)不匹配。
- biome pre-commit 只检查不自动修,格式问题需先 `npx biome format --write`。

## 已完成提交(阶段 3 服务端 + shared + CLI,全部过 pre-commit)

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

1. ~~**修复 CLI 测试并提交**~~ ✅ 已完成(commit `56befb8`,见上)。
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
