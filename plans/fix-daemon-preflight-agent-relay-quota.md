# Fix: daemon 预检应按 agent 关联的 relay 检查额度

## Bug

Daemon 调度前的可用性预检 `dispatcher.ts` → `getProvider('claude').checkAvailability()`
内部走 `readCustomEndpoint()`,读的是**全局 `~/.claude/settings.json`(或 daemon 进程 env)**,
而不是 agent 绑定的 relay(`agents.relay_id` → `relay_endpoints`)。

当 settings.json 的 relay ≠ agent 的 relay 时,门控基于错误的额度来源放行/拦截。
例:settings.json 切到 DeepSeek(有余额)→ 预检 "ready" → 放行;但 agent 实际跑在
Kimi(relay_id),若 Kimi 5h 窗口已满 → 立刻 429。失败敞开(fail-open)。

实际执行路径 `getAgentRuntimeConfig` 已按 `agent.relay_id` 返回 relay env —— 预检与执行
两条路径用的 relay 来源不一致。

## 方案:server 端按 agent 的 relay 探测可用性

把 `RuntimeAvailability` / `availabilityFromUsage` / `availabilityFromUsageError` 从 CLI
迁移到 shared(两端复用),新增机器鉴权端点 `GET /api/agents/:id/relay-availability`,
daemon 对带 relay 的 agent 用它取代全局 `checkAvailability`。

### 改动文件

1. **`packages/shared/src/availability.ts`(新增)** + `index.ts` 导出
   - `RuntimeAvailability`、`availabilityFromUsage`、`availabilityFromUsageError`
2. **`packages/cli/src/providers/types.ts`**
   - 删除本地定义,改为从 `@agent-kanban/shared` re-export(保持现有 import 兼容)
3. **`apps/web/server/routes.ts`**
   - 新增 `GET /api/agents/:id/relay-availability`(machine auth):
     - 无 relay → `{ availability: null }`
     - 有 relay → `probeRelayQuota({ kind, baseUrl: base_url, token })` → `availabilityFromUsage`
     - 失败 → `availabilityFromUsageError(err, relay.name)`
4. **`packages/cli/src/client/base.ts`**
   - 新增 `getAgentRelayAvailability(agentId)`
5. **`packages/cli/src/agent/systemPrompt.ts`**
   - `AgentInfo` 增加 `relay_id?: string | null`
6. **`packages/cli/src/daemon/dispatcher.ts`**
   - agent 缓存记录 `relayId`
   - 门控:有 relay → 调 server 端点(失败置 `unhealthy` = 失败关闭);无 relay → 维持
     `provider.checkAvailability()`(OAuth/全局 config,对无 relay agent 正确)

### 测试 / 回归

- `packages/cli/tests/dispatcher-preflight.test.ts`:新增 relay agent 用例
  (limited → skip; ready → dispatch; 非 relay → 仍走 provider checkAvailability;
  端点失败 → fail-closed skip)
- `pnpm build && pnpm typecheck && npx vitest run`
- 触及 `packages/cli/src/daemon/` → `bash scripts/install-cli.sh` + `./scripts/daemon-smoke-test.sh`

### 交付

- 直接 commit(不建 PR)。live daemon 需 `ak restart` 后新逻辑才生效。
