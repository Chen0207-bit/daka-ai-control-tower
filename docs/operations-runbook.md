# 运维 Runbook

## 环境

- **便携 PostgreSQL 17.6**（无 Docker/WSL 时）：`D:\Project\agents\.tools\pgsql`，数据目录 `.tools\pgdata`，端口 55432。
  - 启动：`pgsql/bin/pg_ctl -D pgdata -o "-p 55432" -l pg.log start`
  - 停止：`pgsql/bin/pg_ctl -D pgdata stop -m fast`
  - 角色：`postgres`(超级) / `daka_app`(owner，迁移与 seed) / `daka_runtime`(应用，受 RLS)。
- 有 Docker 时备选：`docker compose up -d postgres`（同一端口与库名，迁移脚本通用）。
- Worker 本地 dev：`.dev.vars` 提供 `DATABASE_URL`（不入库；模板见 `.env.example`）。Preview/生产走 Hyperdrive binding。

## 从空库复现

```bash
# 1. 角色与库（超级用户，仅首次）
psql $DATABASE_URL_SUPER -f migrations/postgres/0000_bootstrap.sql
createdb -O daka_app daka_ontology   # 或 psql -c "CREATE DATABASE daka_ontology OWNER daka_app"
# 2. 编译本体 → 迁移 → 种子 → 启动
pnpm ontology:compile && pnpm ontology:check-generated
DATABASE_URL=postgresql://daka_app:***@127.0.0.1:55432/daka_ontology pnpm db:migrate
DATABASE_URL=... pnpm db:verify
DATABASE_URL=... pnpm seed:demo
pnpm dev   # 或 build && start
# 3. E2E
node scripts/e2e-api.mjs http://localhost:3000
```

实测（2026-09-03，全新库 daka_fresh）：migrate applied [0001,0002] → verify OK → seed applied → 规则 2 发现 → 投影数字正确。

## 备份与恢复

- 备份：`pg_dump -h 127.0.0.1 -p 55432 -U daka_app daka_ontology -Fc -f backup-$(date +%Y%m%d).dump`
- 恢复（新库演练，不覆盖现有库）：
  `createdb -O daka_app daka_restore && pg_restore -h ... -d daka_restore backup-XXX.dump`
- 非破坏路径已演练：备份→恢复到新库→`pnpm db:verify`（见空库复现同流程）。

## 迁移回滚/前滚

- 迁移只追加（NNNN_名称.sql），已应用版本记录在 `schema_migrations`。
- 回滚策略：无自动 down migration；需要回滚时新建前滚迁移（roll-forward）恢复语义，并在 PR 中说明。
- 破坏性变更（删列/改型）必须先在 DSL diff 中标 breaking 并升级 major version。

## 投影重建

- 投影为请求时纯推导（无独立物化表），重建 = 重新查询；一致性由集成测试断言（两次全量 JSON 相等）。
- `projection_checkpoints` 表预留给未来增量物化；当前 lag 恒为 0（见 /v1/metrics）。

## 错误重放

- 同步失败记录：`ingest_records(status='failed')`，经 `GET /v1/ingest/jobs/:id/errors` 查询。
- 重放：修正数据后重新提交同一 pack（内容指纹幂等，已 applied 记录自动 skipped，只补失败项）。
- Action 重试：客户端以同一 `idempotencyKey` 重发即安全重放（同载荷返回原结果，不同载荷 409）。

## 审计与指标

- `GET /v1/audit?limit=N`：只追加审计流水（actor/action/entity/detail/correlation_id）。
- `GET /v1/metrics`：action 执行、事实复核队列、ingest 失败、开放风险数。
- 结构化日志：Worker console 输出 JSON（event 字段），关联 `x-correlation-id`。

## 数据质量

- `GET /v1/dq/report`：幽灵关系、verified 无证据、时态冲突、ingest 失败。
