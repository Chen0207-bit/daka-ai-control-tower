# 5 分钟中文演示脚本 + 验收清单

面向评审/客户的现场演示。所有演示数字均为“演示推演”（demo pack），可整体替换；未官宣影视合作只称“影视 IP·代号 PB”。

## 前置（30 秒）

```bash
pnpm install && pnpm ontology:compile && pnpm seed:demo:dry
```

`seed:demo:dry` 输出 `plan: {...}` 和 `[dry-run] 不写库` —— 先证明 dry-run 不落库。

## 演示动线（每条约 1 分钟）

### 1. 市场建议：AI 只能建议，无权改印量
- 打开 `ontology/explainability/action-graphs.yaml` → `marketRecommendation`：规则生成 `ReleaseRecommendation`（status=suggested，decisionBy=ai）。
- 唯一状态出口是人工 action `reviewReleaseRecommendation`（executiveViewer/ipOperations）。
- 口播：“systemAgent 可调的 action 里没有任何印量/价格 effect，由 contract test 保证。”

### 2. 签名额度：守恒 + 超额阻断
- `signatureQuota` 子图：余额 = Σreceived − Σallocated − Σconsumed，movement 只追加。
- 指 `allocateSignatures` 的 precondition `availableQuantity ≥ quantity`：超额在服务端 deny，不是前端校验。

### 3. 合同链：evidence → candidate → verified → rights/risk
- `contractChain` 子图：上传合同（sha256）→ AI 抽取 proposed 事实（必挂 evidenceAnchorId）→ dataSteward/legalReviewer confirm → verified 物化为 RightsGrant → 规则生成 RiskFinding → 法务凭证据关闭。
- 口播：“AI 只能产出 proposed；confirm/reject/supersede 全是人工角色，进审计链。”

### 4. 付款链：action → policy → rule → projection
- `paymentChain` 子图：`recordPayment`（financeOperator，金额>0、币种一致）→ 规则 `paymentOverdue` 出风险 → 投影 `paymentCalendar` / `bossActionInbox` 汇总。
- 口播：“每个写操作带 correlationId 进 audit/outbox，traceId 贯穿。”

### 收尾（30 秒）

```bash
pnpm test   # contract test 13 项全绿；无库时集成测试自动 skip
```

## 验收清单（勾选即证据）

| # | 验收点 | 证据命令 / 位置 | 期望 |
| --- | --- | --- | --- |
| 1 | dry-run 不落库 | `pnpm seed:demo:dry` | 输出 `[dry-run] 不写库`，退出 0；无库时非 dry-run 退出 2 |
| 2 | AI 不可直接修改印量 | `pnpm --filter @daka/ontology-runtime test` → contract test | systemAgent action 无印量/价格 effect；评审 action 仅人工角色 |
| 3 | 超额分配服务端阻断 | contract test `超额分配 precondition` | manifest 含 `gte target.availableQuantity input.quantity` |
| 4 | 规则不做状态变化 | contract test `规则只产出风险/阻断/候选建议` | rule.result 无 set/update/delete |
| 5 | deny/failed 留痕、traceId 贯穿 | contract test `traceId 贯穿`；有库时 `pnpm test:integration` | audit/outbox 均带 correlationId |
| 6 | 可解释性图与编译产物一致 | contract test `交叉一致` 5 项 | action/rule/projection/humanRoles 全部对得上 |
| 7 | 调试可用 | `docs/debugging.md` + `.vscode/launch.json` | workerd inspector 仅 localhost:9229，断点落 .ts 源 |
| 8 | 演示数据标签 | `ontology/data-packs/demo/` | 合成数字标“演示推演”，影视合作仅“代号 PB” |

注：#5 的库内零写入验证（deny/failed 行数不变）需真实 PostgreSQL，由 `test/integration.test.ts` 覆盖；本分支不伪造该证据，缺库时显示 skip。
