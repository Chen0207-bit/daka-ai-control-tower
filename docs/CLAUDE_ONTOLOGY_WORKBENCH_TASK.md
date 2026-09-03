# Claude 执行任务：DAKA 可观察本体工作台

## 角色与边界

你是本任务的实现 subagent。当前仓库是 `D:\Project\agents\daka-ontology-platform`。先完整阅读根目录 `CLAUDE.md`、`README.md`、现有架构文档、ontology YAML、runtime、worker API、数据库 schema 和前端实现，然后在现有代码上增量实现，不重写项目，不破坏已有四条业务闭环。

本次使用模型 `glmv3flash`。优先用最短时间完成可演示、可验证的纵向切片。不要只写计划或静态说明，必须产出可运行代码、测试和验证记录。不得删除或覆盖已有业务数据；不得发布生产环境；不得修改 DAKA 之外的项目。

## 目标

把当前“普通 CRUD 风格的业务 Demo”升级为一个可观察、可追溯、可单步回放的 Ontology Runtime Demo，证明以下架构真实参与了每次业务执行：

`YAML 业务语义 -> Canonical IR -> Runtime 权限/前置条件/规则 -> PostgreSQL 规范事实 -> Audit/Outbox -> 经营 Projection`

同一笔业务操作至少能在三个视角间联动：

1. 业务视图：保留当前正常操作体验。
2. 本体透视：显示当前动作涉及的类型、实例、关系、事实来源、规则和投影，不画无意义的全图毛线球。
3. Runtime 调试器：像程序调试一样显示执行阶段、输入输出、命中依据、停止原因和 before/after diff。

## 实施顺序

### 第一优先级：付款闭环完整纵向切片

以 `付款计划 -> 到期/逾期 -> 登记付款 -> 经营视图更新` 为首个完整实现。一次 `recordPayment` 操作应产生稳定的 `traceId/correlationId`，并能看到：

1. ACTION_RECEIVED：actor、action、target、input 摘要。
2. ONTOLOGY_RESOLVED：ontology release/fingerprint、YAML/IR 定义引用。
3. POLICY_EVALUATED：命中的 policy、ALLOW/DENY、可解释原因。
4. INPUT_VALIDATED：schema/错误。
5. FACTS_LOADED：对象 id、版本、必要事实摘要。
6. PRECONDITIONS_EVALUATED：表达式、变量绑定、布尔结果。
7. WRITESET_PLANNED：拟创建/更新的对象，尚未提交。
8. TRANSACTION_COMMITTED 或 TRANSACTION_SKIPPED：写入前后 diff。
9. RULES_EVALUATED：命中/未命中规则及解释。
10. PROJECTION_UPDATED：经营投影 before/after diff。
11. AUDIT_OUTBOX_RECORDED：关联 id。

必须同时演示三种结果：

- 成功：财务角色登记付款，规范事实和经营投影更新。
- 权限拒绝：无权限角色停在 policy，数据库写入为 0。
- 校验或前置条件失败：停在对应阶段，数据库写入为 0。

### 第二优先级：Ontology Workbench UI

在现有页面中增加明确入口和可演示工作台，建议采用联动布局：

- 左侧：业务动作和当前业务对象。
- 中部：可点击的 Runtime 执行流水线/时间线。
- 右侧或底部标签页：YAML Source、Canonical IR、Policy/Rule Explain、Fact/SQL Diff、Projection Diff、Audit/Outbox。
- 顶部或独立标签：只显示当前 action 涉及的 ontology 子图，并支持 before/after 高亮。

每个 Trace stage 应有 `pending/running/succeeded/denied/failed/skipped` 状态。支持单步查看和已完成 Trace 的暂停/继续回放。不要通过长时间暂停真实 PostgreSQL 事务实现界面断点。

增加 Plan/Dry Run 语义：可以先生成写入计划和规则评估结果，但不得提交。只有明确执行才真正落库。Debug/trace 接口需要管理员或开发权限，输出必须脱敏。

### 第三优先级：复用到另外三条闭环

在 Trace 协议和 UI 稳定后接入：

1. 合同证据：Evidence -> CandidateFact(proposed) -> 人工确认 -> Fact(verified) -> RightsGrant/RiskFinding，显示来源、确认者和推导链。
2. 签名额度：显示总额守恒；超额申请应在 precondition/rule 阶段停止，写入为 0。
3. 市场建议：MarketObservation -> ReleaseRecommendation(proposed) -> Human Review；必须可视化证明 AI 没有直接修改印量的合法 action/edge，未人工审批停在 WAITING_FOR_HUMAN。

## 推荐技术结构

尽量复用已有 action engine、policy、rule runner、audit、outbox 和 correlation id。在 runtime 中抽象统一的：

- `ExecutionTrace`
- `TraceSpan`
- `TraceStage`
- `OntologyReference`
- `PolicyDecision`
- `RuleEvaluation`
- `EntityChange`
- `ProjectionChange`

Trace 是运行时可观察数据，不要污染业务事实模型。可新增独立 trace/span 存储表或清晰隔离的存储层。数据不足时允许用 YAML fixture，但界面必须标明 `assumed/demo/imported/evidence/verified`，不得伪装成客户真实数据。

可按现有路由风格实现等价接口：

- ontology graph/meta 查询
- action plan/dry-run
- trace 查询
- entity lineage/provenance
- projection diff

不要为了迎合命名而破坏当前 API 风格。

## 真实源码断点

补充本地开发调试配置和文档，使开发者能通过 VS Code/Chrome DevTools 对本地 Cloudflare Worker 设置真实 TypeScript 断点。断点至少覆盖 action engine、policy evaluation、rule runner 和 worker action API。使用 source maps；不得把开发调试端口暴露到公网。

## UX 要求

- 用户第一眼能看出“这不是普通 CRUD”：每个业务结果旁必须有可展开的“为什么/如何产生”。
- 图谱不是装饰；点击节点能关联到 YAML、IR、事实、规则、动作和本次 Trace。
- 默认只呈现当前 action 子图，避免信息过载。
- 同一 traceId 必须贯穿业务结果、执行轨迹、审计和投影。
- 明确区分拟议事实、已验证事实、AI 建议和人工决定。
- 保持现有中文业务语境与移动端基本可用性。

## 验收标准

至少完成并验证付款闭环纵向切片：

- 一次成功操作生成完整 Trace，并可刷新后重新打开。
- 每个关键阶段能定位 ontology release/fingerprint 和定义引用。
- 能看到规范事实与经营投影 before/after。
- 无权限角色明确停在 Policy，写入数为 0。
- Dry Run 永不落库，Commit 才落库。
- 失败动作不会出现伪造的 committed/projection updated。
- 现有测试不回归；新增 runtime/API/UI 关键测试。
- `pnpm` 的 lint/typecheck/test/build 中仓库已有的适用命令通过；记录无法执行项和原因。
- 提供简短演示脚本和本地 VS Code 断点使用说明。

完成付款纵向切片后，如果剩余上下文与时间允许，再接另外三条。不要用四条半成品替代一条完整可验证链路。

## 工作方式与交付

持续直接实施，遇到普通实现选择自行决策。只有涉及删除/覆盖数据、需要真实密钥或不可逆外部操作才停止。完成后汇报：改动文件、运行方式、验收结果、尚未完成事项和下一步建议。不要部署公网，不要创建虚假的成功记录。
