# Ontology DSL 使用指南（v1）

> 权威语言定义见 [ontology/spec/v1.md](../ontology/spec/v1.md)。本文件是操作手册。

## 常用命令

```bash
pnpm ontology:validate          # 语法+语义校验（0=通过, 1=有 error, 2=运行错误）
pnpm ontology:compile           # 编译 Canonical IR 并写 ontology/.generated/
pnpm ontology:check-generated   # CI 用：生成物漂移检查（漂移 exit 1）
pnpm ontology:inspect           # IR 摘要与指纹
pnpm ontology:diff -- <old> <new>   # 兼容性分级（参数可为 schema 目录或 manifest.json）
```

## 变更演练示例（diff 分级）

在分支上修改 `ontology/schema/v1/`，然后 `pnpm ontology:diff -- ontology/.generated/ontology.manifest.json ontology/schema/v1`：

| 变更例子 | 结果 |
|---|---|
| 给 `Contract` 加可选属性 `internalNote: {type: text}` | `[additive] property-added` → patch |
| 给 `paymentStatus` 加枚举值 `refunded` | `[compatible] valueSet-expanded` → patch |
| `cardinality: one_to_many → many_to_many` | `[compatible] cardinality-loosened` → patch |
| `amount: {type: integer} → {type: decimal}` | `[data-migration-required] property-type-widened` → minor（需回填） |
| 删除属性、`title` 改 `type: integer` | `[breaking] property-removed / property-type-changed` → major |
| `paymentStatus` 删掉 `waived` | `[breaking] valueSet-shrunk` → major |
| `cardinality: many_to_many → one_to_many` | `[breaking] cardinality-tightened` → major |
| 给 `recordPayment` 加必填输入 `invoiceNo` | `[breaking] property-added-required`（inputs 袋）→ major |
| 改 `confirmFact` 的 preconditions | `[breaking] action-preconditions-changed` → major |
| 删除 rule/policy/projection | `[breaking] rules-removed` 等 → major |

breaking 必须升 ontology major version；CLI 在存在 breaking 时退出码 1。

## 编写规则

- Rule 只允许 spec §8 的受限操作符；`{op: eval, ...}` 之类会被 DSL1013 拒绝。
- rule `when` 的 path 叶子字段必须存在于 scope 类型的 `properties` 或 `derived`；派生字段（如 `unsettledAmount`、`availableQuantity`）要在 objectType 的 `derived` 袋中声明。
- Action precondition 的 path 以 `input.` 或 `target.` 开头；`target.` 字段同样要求已在类型中声明。
- Action 只声明 `handler` key；handler 实现注册在 Runtime（`packages/ontology-runtime`），DSL 中写任何可执行代码都会被拒绝。
- 待客户确认的口径保留 `status: TBD`/`draft`，会产生 DSL2010 warning 但不阻塞编译；确认后移除标记或收紧为 valueSet。

## 生成物

`ontology/.generated/` 由编译器独占写入，禁止手改；提交到仓库供 Runtime 消费与 CI 漂移检查。

- `ontology.manifest.json` — Runtime 清单（Canonical IR + fingerprint）
- `ontology.schema.json` — 实例校验 JSON Schema（Data Pack/Connector 导入用）
- `ontology.types.ts` — TS contracts（UI/Worker/Runtime 共用）
- `ontology.openapi.json` — API 片段
- `ontology.index-plan.json` — PostgreSQL 索引计划（migration 生成依据）
- `ontology.fingerprint` — 内容指纹（幂等与缓存键）
