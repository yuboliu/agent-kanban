# Local Maintainer：复刻 AMA 云端 Maintainer

## 1. 目标与源码结论

基于 AMA 上游提交 [`31402b4`](https://github.com/saltbo/any-managed-agents/commit/31402b45ee4be3032c566c379a6877f5ff204081) 实现本地等价能力：

- AMA Maintainer 的核心是“触发器 → 独立运行记录 → 可复用会话”，HTTP 事件按 `routing_key` 复用 issue/PR 会话，并通过串行队列和幂等键避免并发重复处理。[触发调度源码](https://github.com/saltbo/any-managed-agents/blob/31402b45ee4be3032c566c379a6877f5ff204081/server/usecases/dispatch-triggers.ts)
- Agent 配置只保存 prompt、runtime/model、skills、subagents 和工具权限；runner 在工作区通过平台 `skills` 安装能力物化 skill。[Agent 定义](https://github.com/saltbo/any-managed-agents/blob/31402b45ee4be3032c566c379a6877f5ff204081/server/domain/agent.ts) [Skill 安装](https://github.com/saltbo/any-managed-agents/blob/31402b45ee4be3032c566c379a6877f5ff204081/cmd/ama-runner/internal/workspace/agent.go)
- Memory store 作为可写文件卷挂载，运行结束后读取整个文件快照并同步回控制面。[Memory 工作区](https://github.com/saltbo/any-managed-agents/blob/31402b45ee4be3032c566c379a6877f5ff204081/cmd/ama-runner/internal/workspace/workspace.go)
- 当前 AK local maintainer 仅把心跳和评审转换为普通任务，缺少 GitHub 事件会话、持久记忆、独立运行历史和完整 skill references；新实现将替换这条临时路径。

目标状态：完全移除 Maintainer 对 AMA 的依赖，但不影响 AMA 作为普通任务运行时的现有能力。

## 2. 架构与关键决策

```text
GitHub App webhook ───────────────┐
                                 ├─> 事件规范化/去重 ─> Maintainer Run Queue
ak start GitHub Events API 兜底 ──┘                         │
定时心跳调度 ───────────────────────────────────────────────┤
                                                           ▼
                                              机器租约与串行领取
                                                           │
                                                           ▼
                    内置 Agent + 固定 skill 快照 + runtime/model
                                                           │
                              ┌─────────────────────────────┼──────────────────────┐
                              ▼                             ▼                      ▼
                    issue/PR 会话复用                心跳临时会话          持久 Memory
                    本机保存 resume token             运行后清理            D1 文件快照
```

- 每个租户自动创建一个不可删除、不可用于普通任务调度的 `Local Maintainer` 内置 Agent；所有看板共享身份，但 runtime/model、触发配置、会话和记忆按看板隔离。
- Maintainer 运行不再创建任务卡。只有 maintainer 判断为可执行并分配给普通 worker 的工作才进入看板。
- 每个 maintainer 同时只运行一个 session turn，保护共享 memory；相同 GitHub issue/PR 使用相同 routing key 和 provider resume token，不同 subject 排队执行。
- Provider resume token、工作区和临时凭据只保存在执行机器；D1 仅保存会话元数据和机器亲和性。原机器不可恢复时创建新会话，并用持久 memory 恢复上下文。
- 心跳每次使用新会话；GitHub subject 工作区在关闭事件后清理，长期无事件的工作区最多保留 30 天。
- Webhook 是实时主通道；没有公网 webhook 时，`ak start` 使用 GitHub Repository Events API、ETag 和 `X-Poll-Interval` 增量补齐。首次轮询只建立基线，不重放历史事件；官方说明该接口最多保留 30 天/300 条且可能延迟数小时，因此兜底是最终一致而非实时保证。[GitHub Events API](https://docs.github.com/en/rest/activity/events)

## 3. 实现变更

### 控制面和数据模型

- 为 `board_maintainers` 增加显式本地配置：`runtime`、可空 `model`、`github_events_enabled`、迁移/清理状态；`agent_id` 由服务端固定为租户内置 Agent。
- 新增：
  - `maintainer_runs`：heartbeat/GitHub 来源、幂等键、routing key、状态、租约、机器、session、错误和时间。
  - `maintainer_sessions`：subject routing key、状态、机器亲和性、最后运行时间；不保存 provider token。
  - `maintainer_memories`：相对路径、UTF-8 内容、hash、revision 和更新时间。
  - `maintainer_event_cursors`：仓库轮询 ETag、最新事件 ID、允许的下次轮询时间和错误。
- 队列使用 D1 条件更新领取，租约每 30 秒续期；运行前失败按指数退避重新排队，provider 已开始后的不确定失败不自动重放，避免重复公开回复，改为在详情页手动重试。
- Webhook 和轮询统一生成规范化事件指纹，以仓库、事件/action、subject、comment/review node id 去重；忽略 AK GitHub App 自己产生的评论和 review。
- issue/PR 关闭或 PR 转 draft 时关闭对应 session；reopen 时优先恢复，机器状态丢失则以新会话继续。

### 本地执行面

- 将普通 task dispatcher 中的 provider 启动、临时 Ed25519 session 身份、隔离 HOME、runtime 配置、skill snapshot 和限流逻辑提取成可复用执行管线；新增 `LocalMaintainerRuntime`，不调用 task claim/complete/reject 生命周期。
- Session 本地存储增加 `type: "maintainer"`，记录 maintainer/run/routing key；provider resume token 继续只写入本机 session 文件。
- 每次运行：
  1. 原子领取 run 并创建临时 Agent session 身份。
  2. 物化固定版本的 `ak-maintainer` skill 和当前 memory revision。
  3. 注入 `AK_BOARD_ID`、`AK_MAINTAINER_ID`、`AK_MAINTAINER_RUN_ID`、trigger/event 信息。
  4. 由 `ak auth git` 按次取得 GitHub App 短期 token，禁止使用宿主人类 `gh` 登录。
  5. 完成后以 revision 条件更新 memory、run 和 session；发生 revision 冲突时保留工作区并报告错误，不覆盖新数据。
- Memory 只允许安全相对路径和常规 UTF-8 文件，拒绝绝对路径、`..`、符号链接和 `.ama` 保留目录；限制为 500 个文件、单文件 1 MiB、单看板 10 MiB。
- 移除 Maintainer 自定义 Vault 变量界面与 API。首版只注入短期 AK session 凭据和 GitHub App token，不在 D1 或运行记录中保存长期秘密。

### Skill 本地化与每日更新

- 以 `skills/ak-maintainer/` 为唯一内置基线，完整打包 `SKILL.md`、`references/` 和示例文件到服务端及 CLI 发布物；修正当前只通过 API 传输单个 `SKILL.md`、丢失 references 的问题。
- `ak@ak-maintainer` 成为保留的只读内置引用；内置 Agent 强制使用它。若租户已有同名自定义 skill，迁移为唯一的 `ak-maintainer-custom[-n]`，并同步更新普通 Agent 引用，不静默覆盖。
- 新机器或离线机器先使用随版本发布的内置基线；后台每 24 小时通过平台 `npx skills add saltbo/agent-kanban --skill ak-maintainer` 拉取官方版本。
- 更新在 staging 中校验名称、完整文件树、路径、symlink 和大小，计算内容 hash 后原子发布；当前运行固定使用启动时的 hash，新版本只影响后续运行。
- 更新失败使用 last-known-good；没有缓存时回退内置基线。机器心跳和 Runtime/Maintainer 详情显示 source、hash、最后检查时间、最后成功更新时间及错误。

### API 与界面

- `POST /api/boards/:id/maintainers` 不再接收 `agent_id` 或 `scheduler_type`，改为接收：`runtime`、可空 `model`、`interval_seconds`、`heartbeat_enabled`、`github_events_enabled`、`status`。
- `PATCH` 使用同一配置；旧 `review_enabled` 暂作为 `github_events_enabled` 的兼容别名，二者冲突时返回 400；响应暂保留 `scheduler_type: "local"` 兼容字段。
- 现有 runs、sessions、memories URL 保持不变，但改为读取本地表；新增失败 run 的显式 retry 操作。
- 增加机器专用的 event ingestion、run claim、lease renew、complete/fail 接口；所有接口校验 API key 绑定的 machine/owner。
- Board Maintainer 创建界面取消 Agent 选择和 AMA 选项，增加 runtime/model。默认预选最近在线机器上第一个健康的本地 runtime，model 使用 provider 默认，保存前允许修改。
- Maintainer 详情展示本地 runs、session routing、memory、执行机器和 skill hash；移除 AMA、Vault、variables 文案和控件。
- 内置 Agent 在 Agent 列表中可查看但不可编辑、删除或接收普通任务。

## 4. AMA 移除与升级迁移

- 所有现存 local maintainer 自动改绑租户内置 Agent，保留触发配置；runtime/model 继承原 Agent。原 Agent 保留但不再承担 maintainer 绑定。
- 从旧 `maintainer_trigger_version: 1` 任务回填运行摘要，旧任务保留为历史数据；迁移后不再创建此类任务。
- 所有现存 AMA maintainer：
  - 数据库迁移首先禁用其 Better Auth API key，立即阻止云端 Agent 修改 AK。
  - 不导入 AMA memory、run 或 session 历史。
  - 继承原 Agent 的本地 runtime/model；若只有 `ama` runtime 或当前没有可用本地 runtime，则保持 paused 并提示选择 runtime。
  - 后台清理任务幂等删除 schedule/HTTP trigger、memory store、vault credentials 和 API key；AMA 暂不可达时记录 `cleanup_pending` 并持续重试，但不阻止已经配置好的本地执行。
- 保留旧 AMA 列仅作为远端资源清理账本，清理完成后不再参与业务逻辑；删除 Maintainer 的 AMA provisioning、trigger dispatch、variables 和状态查询代码。
- 普通任务的 AMA runtime、AMA owner integration 及其现有 API 不在本次移除范围内。

## 5. 测试与验收

- 单元/接口测试：
  - 内置 Agent 幂等播种、不可变、NoSchedule、跨看板共享身份。
  - maintainer 创建/更新、runtime readiness、旧字段兼容和租户隔离。
  - run 原子领取、租约恢复、单 maintainer 串行、幂等去重和失败重试边界。
  - Webhook/轮询归一化、bot 忽略、ETag/`X-Poll-Interval`、首次基线、跨通道去重。
  - 同 subject 会话复用、关闭/reopen、机器丢失后的新会话恢复。
  - memory revision、路径/容量限制、daemon 重启和机器切换。
  - skill 全目录打包、24 小时刷新、原子升级、运行快照固定、last-known-good 和内置回退。
  - local/AMA 旧数据迁移、API key 先失效、远端清理重试。
- Provider 集成测试使用 fake provider 验证：heartbeat 写入 memory；GitHub issue/PR/comment 进入独立 run；同一 subject 延续上下文；maintainer 只在发现可执行工作时创建并分配普通任务。
- Playwright 验证内置 Agent、无 Agent 选择的创建流程、runtime 默认值、pause/resume、runs/sessions/memory/skill 状态，以及普通看板不出现 maintainer 系统任务。
- 按 `ak-verify` 执行 Tests → 独立 Review → Regression；UI 变更由 E2E 角色补测试。最终运行：`pnpm build && pnpm typecheck && npx vitest run`。
- 因涉及 `packages/cli/src/daemon/`，先运行 `bash scripts/install-cli.sh`，再执行 `./scripts/daemon-smoke-test.sh`。
- 验收标准：
  - Maintainer 启用、心跳、GitHub 事件处理和记忆均不产生任何 AMA API 调用。
  - 离线首次启动可用内置 skill；联网后每 24 小时检查官方更新，失败不影响运行。
  - webhook 正常时实时入队；不可用时轮询最终补齐且不重复回复。
  - `ak start` 重启后 run、memory 和可恢复 session 连续；机器丢失只损失 provider 短期上下文，不损失持久记忆。
  - 新运行不污染看板，现有 local maintainer 配置和历史仍可查看。

## 6. 已确定的范围与默认值

- Local Maintainer 是租户级单一内置身份，每个看板保存独立配置和状态。
- GitHub 事件采用 webhook 优先、Repository Events API 轮询兜底。
- skill 使用官方上游每日镜像、内容寻址快照、last-known-good 和随产品发布的内置回退。
- runtime/model 按看板配置；新建时优先选择在线机器已就绪的本地 runtime。
- Maintainer 的 AMA 能力被完全替换；普通任务的 AMA runtime 不在本计划范围内。
- AMA memory 和 run/session 历史不迁移；现有 local task-based 历史保留并回填摘要。
- 首版不建设本地加密 Vault，也不支持 Maintainer 自定义秘密环境变量。
