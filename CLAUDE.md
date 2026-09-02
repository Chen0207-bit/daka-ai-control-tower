# Claude Code 项目指引：DAKA Ontology Platform

## 唯一有效 workspace

- 工作目录：`D:\Project\agents\daka-ontology-platform`
- Git branch：`feat/ontology-platform-v1`
- 原工作区 `D:\Project\agents\daka-ai-control-tower` 只作为基线，不要修改。

有效任务包：`D:\Project\agents\daka-research\claude-daka-platform-v2\`

从 `05_CLAUDE_PROMPT.md` 开始并按顺序完整阅读。旧目录 `claude-daka-demo` 的 Goal/Boundaries/Plan 已被用户否决，只有其中的 `02_PRESET_INTERVIEW_ANSWERS.md` 可作为业务假设输入。

## 目标

以最短可验证时间完成生产化第 1/2/3 期，而不是按固定工期等待：

1. 稳定 Ontology DSL、Canonical IR、Compiler、CLI、Codegen 和兼容性检查。
2. PostgreSQL 事实层、双时态、Evidence、Action、Rule、Projection、YAML Data Pack。
3. Policy/RLS、Connector、错误重放、数据质量、可观测性、控制塔接入和 Cloudflare Preview。

三期是依赖 Gate；前置契约稳定后，应并行推进相互独立的 Runtime、Data Pack、UI、测试和文档工作。

## 架构硬边界

- PostgreSQL 是唯一规范事实库。
- YAML 是 Schema/Data Pack/Connector 的 authoring format；Runtime 只消费编译后的 Canonical IR/manifest。
- Cloudflare Worker 承载 Ontology Runtime API，并通过 Hyperdrive 连接 PostgreSQL。
- Runtime 核心放在可独立测试的 package，Worker 只负责环境适配和路由装配。
- D1、React state 和 YAML 文件不得承担生产规范事实。
- Action 使用注册 handler；Rule 使用受限 AST；禁止任意代码或 `eval`。
- LLM/Semantica 只能创建 proposed facts/建议，不能执行高风险状态变化。

## GitHub 与 Cloudflare 权限

- 允许在当前 feature branch 小步 commit、push 到 GitHub，并通过网页创建/更新 PR。
- 不得 merge `main`、force-push、改写历史或修改原工作区。
- 允许使用 Wrangler/Cloudflare GUI 创建新命名、分支隔离的 Worker version preview、preview alias、Hyperdrive 和必要的 Preview 资源。
- 不得覆盖原 DAKA Worker/Pages、域名、D1、R2、Secret 或生产 PostgreSQL。
- Preview URL 上传前必须完成 PB 脱敏、Secret 扫描和演示数据标签检查；优先使用 Cloudflare Access。

## 工作规则

- 开始先检查当前 branch、HEAD、git status；保护所有用户改动。
- 使用新 worktree 独立安装依赖，不复制旧 worktree 的失效 pnpm junction。
- 允许增加 DSL/PostgreSQL/Runtime/测试所需的成熟依赖，不随意升级现有前端框架。
- 保留 `/api/chat`、`/api/import`、`/api/data` 兼容性。
- 所有写操作按 tenant/workspace 隔离，需幂等、乐观锁、权限校验并进入 audit/outbox。
- 缺客户数据时使用可替换、可校验、可幂等导入的 YAML Data Pack，不把未知值写成页面常量。
- 公共界面所有合成经营数字明确标“演示推演”；未官宣影视合作只显示“影视 IP·代号 PB”。
- 不在仓库复制内部策略报告、尽调来源、客户敏感信息或 Secret。
- 删除、重建或不可逆迁移任何已有数据前必须停下确认。

## 完成证据

以任务包 `04_ACCEPTANCE.md` 和 `07_TRACEABILITY.md` 为准。只有命令输出、数据库查询、API 响应、测试报告和浏览器流程可以证明完成；文件存在、页面能打开或接口占位不算完成。

