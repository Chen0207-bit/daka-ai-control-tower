# 架构说明（feat/ontology-platform-v1）

```text
React/vinext 控制塔 (app/)
  └─ 本体平台视图 app/ontology-panel.tsx ── @daka/ontology-client
        │ 同源 HTTP（/v1/*）
        ▼
Cloudflare Worker (worker/)
  ├─ 兼容路由 /api/chat /api/import /api/data（D1/R2，原演示能力保留）
  └─ Ontology Runtime API worker/ontology/api.ts
        │ pg（本地 DATABASE_URL 直连 / 远程 Hyperdrive binding）
        ▼
@daka/ontology-runtime（纯 Node 包，可独立测试）
  ├─ repository / facts / action engine / rules evaluator+runner
  ├─ policy engine + RLS（migrations 内）双层权限
  ├─ projections（请求时纯推导） / ingest datapack / derived resolvers
        ▼
PostgreSQL 唯一规范事实库（便携 binaries 或 docker compose）

@daka/ontology-dsl：YAML → 校验 → Canonical IR → 6 生成物（ontology/.generated/）
YAML Data Pack（ontology/data-packs/demo）：可替换、可校验、幂等导入的数据来源
```

## 关键边界

- Runtime 只消费编译产物（manifest 构建期内联进 Worker）；生产请求不解释原始 YAML。
- Action 只调用注册 handler；Rule 为受限 AST（闭集操作符，无 eval）。
- LLM/Semantica 只能写 proposed 候选事实（CandidateFactProvider 契约 + handler 硬编码）。
- RLS 为数据库底线：runtime 角色必须带 `app.tenant_id/app.workspace_id`，否则无行可见。
- 演示数据全合成：PB 只显示“影视 IP·代号 PB”，金额/日期/指标均标“演示推演”。

## 目录

| 路径 | 内容 |
|---|---|
| `ontology/spec/v1.md` | DSL v1 权威规范 |
| `ontology/schema/v1/` | 本体 authoring YAML（10 个 section 文件） |
| `ontology/.generated/` | 编译产物（禁手改，check-generated 守漂移） |
| `ontology/data-packs/demo/` | 演示数据包（fingerprint 幂等） |
| `packages/ontology-dsl` | parser/validator/compiler/diff/CLI |
| `packages/ontology-runtime` | 运行时核心（DB 无关接口 + pg 实现） |
| `packages/ontology-client` | UI typed client |
| `worker/ontology/` | Worker 装配层（路由 + Hyperdrive） |
| `migrations/postgres/` | SQL 迁移（只追加） |
| `scripts/e2e-api.mjs` | 四闭环 E2E（23 断言） |

详细验收矩阵见任务包 `04_ACCEPTANCE.md`；逐条实现与证据见 `07_TRACEABILITY.md`。
