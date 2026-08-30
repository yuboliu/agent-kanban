# 纯本地化迁移 — 阶段 0 基线

> 来源:`plans/local-only-cloudflare-ama-removal.md` 阶段 0(冻结基线与迁移预检)。
> 本文档记录迁移起点,保证实施从已知 revision 和已知数据清单开始,旧数据库有明确恢复路径。

## 基线信息

- 记录日期:2026-08-30
- Git revision:`420fc61`(feat(auth): first-run username bootstrap registration and login)
- 工作区:干净,无未提交改动
- 测试基线:`npx vitest run` → 2548 passed / 1 skipped(122 files passed / 1 skipped)
- 认证阶段(计划阶段 5)已交付:username bootstrap 注册、用户名密码登录、legacy email 兼容登录、GitHub 仅绑定。

## 旧数据库路径与备份

- 本地 D1(SQLite)文件:
  `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/9d259a40372361988d9f0d3cd5dacd404f25338818ed025b6f78b4afe7c28164.sqlite`
  (3.7 MB,含业务表与 Better Auth 表)
- 迁移命令:`pnpm --filter @agent-kanban/web db:migrate`(wrangler d1 migrations apply --local)
- 恢复路径:旧库只读导入到新 SQLite baseline;不原地修改源库;迁移前创建权限 0600 的完整备份并记录 SHA-256。

## 数据清单(2026-08-30)

| 表 | 行数 | 说明 |
|---|---|---|
| user | 490 | Better Auth 用户(含 username/usernameConfirmed) |
| account | 490 | credential 等账号 |
| session | 454 | 会话 |
| apikey | 2 | Machine API Key |
| boards | 355 | 看板 |
| repositories | 30 | 仓库 |
| machines | 2 | 本地机器 |
| agents | 387 | Agent 身份 |
| agent_sessions | 28 | 本地 agent 会话(保留) |
| tasks | 28 | 任务 |
| task_actions | 34 | 任务动作日志 |
| messages | 125 | 任务消息 |
| gpg_keys | 350 | GPG/Ed25519 密钥 |
| owner_settings | 6 | 租户设置 |
| relay_endpoints | 2 | 自定义 relay 出口 |
| ama_agent_sessions | 0 | AMA 专属表(空) |
| ama_owner_integrations | 0 | AMA 集成(空) |
| board_maintainers | 0 | maintainer(空) |
| skills / subagents / github_installations | 0 | 空 |

**AMA 影响评估**:AMA 业务表(ama_agent_sessions、ama_owner_integrations)均为空,无 active/terminal AMA-bound tasks、无 AMA maintainers、无 cloud machines、无 AMA OAuth accounts。阶段 3(删除 AMA)无存量数据风险。

## 新数据目录约定(阶段 0 默认)

- 数据目录:`${XDG_DATA_HOME:-~/.local/share}/agent-kanban`
- 数据库文件:`agent-kanban.sqlite`
- 可覆盖:`AK_DATA_DIR`、`AK_DATABASE_PATH`
- 服务锁:位于数据目录内,防止不同 checkout 同时写同一数据库
- 安全:数据库、备份、服务锁和本地 Secret 文件权限 0600,目录 0700

## 关键风险与约束

- 迁移期间磁盘保留两个数据库(旧 D1 + 新 SQLite);换取可验证、可重复、可回退的导入。
- `agent_sessions` 是本地 session 表,必须保留;`ama_agent_sessions` 只导出,不得重命名覆盖。
- 迁移失败时删除未完成的新库,不得改写/删除源库与备份。
