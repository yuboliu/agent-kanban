# 纯本地化迁移 — 进度跟踪

> 实施依据:`plans/local-only-cloudflare-ama-removal.md`。每个阶段独立测试验收并提交。
> 基线数据见 `docs/local-only-migration-baseline.md`。

## 阶段状态总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | 冻结基线与迁移预检 | ✅ 已交付(commit `0caf692`) |
| 1 | 平台无关边界(AppDatabase 契约 + SQLite 适配) | 🔶 部分完成 |
| 2 | 纯 Node 运行时 | ⏳ 未开始 |
| 3 | 删除 AMA 双轨运行时 | ⏳ 未开始 |
| 4 | Local Maintainer 完整替代 | ⏳ 未开始 |
| 5 | 用户名认证与托管邮箱移除 | ✅ 已交付(commit `420fc61`) |
| 6 | 可选 GitHub App | ⏳ 未开始 |
| 7 | 导入旧 Wrangler/D1 数据 | ⏳ 未开始 |
| 8 | 删除 Cloudflare/AMA 构建与文档遗留 | ⏳ 未开始 |

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

## 阶段 1 未完成(纳入阶段 2)

- ❌ Worker `Env` 拆成 `AppServices`(database/config/relay/metrics/background/GitHub clients)。
- ❌ Hono 导出改为 `createApi(services)`,移除业务代码对 Cloudflare binding、
  `ExecutionContext`、`waitUntil()` 的直接依赖。
  - 现状:`routes.ts` 为 `const api = new Hono<{ Bindings: Env }>()` + `export { api }`,
    worker 入口 `api.fetch(request, env)`;scheduled handler 直接使用 `env.DB` 与 `env`。
  - 依赖关系:这两项与阶段 2(Node server 入口、进程内 relay)强耦合,需一并系统实施。

## 提交记录

- `420fc61` — 阶段 5 用户名认证改造
- `0caf692` — 阶段 0 基线 + 阶段 1 AppDatabase 契约/better-sqlite3 适配器/契约测试

## 后续会话起点

从阶段 1 未完成项开始:先做 `AppServices` 类型抽象与 `createApi(services)` 重构,
再进入阶段 2 的 Node server 入口、进程内 relay hub、长连接 SSE 与 Node scheduler。
