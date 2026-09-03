/**
 * Trace adapter：优先调用真实 Runtime API（`GET /v1/traces/:traceId`、
 * `POST /v1/actions/:id/execute` 带 `dryRun`），失败时降级为确定性 mock。
 * mock 结果通过 `source: "mock"` 标记，UI 必须显示 DEMO/MOCK 徽标。
 */
import {
  TRACE_STAGE_IDS,
  TRACE_STAGE_LABELS,
  type PaymentObligationView,
  type TraceDoc,
  type TraceStage,
  type TraceStageId,
} from "./trace-types";

export interface TraceWithSource {
  trace: TraceDoc;
  source: "api" | "mock";
}

const STAGE_NARRATIVE: Record<TraceStageId, { why: string; how: string }> = {
  authorize: { why: "确认当前操作者有权登记该笔付款，防止越权改写账目。", how: "编译后的 policy 模型按 actor 角色（financeOperator）匹配 allow 规则，不执行任何用户代码。" },
  validateInput: { why: "金额、币种与付款日期缺失或非法会让台账失真。", how: "按 Canonical IR 中 action 的 input schema 逐字段校验（amount=decimal、paidAt=ISO 日期）。" },
  loadTarget: { why: "付款必须挂在正确的付款义务上，才能冲抵未结清余额。", how: "按 targetId 从 PostgreSQL 加载 PaymentObligation，校验对象类型存在。" },
  concurrencyCheck: { why: "两人同时登记同一笔付款会导致重复冲抵。", how: "对比 expectedVersion 与行版本号，不一致直接 409 拒绝。" },
  plan: { why: "先算清楚这次动作会改哪些表，dry-run 才有东西可看。", how: "由 action 注册的 handler 生成 movement/fact 写入计划，dry-run 模式下不开启写事务。" },
  rules: { why: "付款完成后要自动触发“结清状态更新 / 逾期解除”等派生判断。", how: "受限 AST Rule 逐条求值（非 eval），命中规则产出后续 fact 断言。" },
  policyExplain: { why: "老板/审计需要知道“为什么允许这么做”。", how: "输出命中的 policy 规则文本与角色依据，附在 trace 上供 UI 解释。" },
  factAssertions: { why: "付款是一次规范事实，必须带证据锚点进入事实层。", how: "以双时态记录写入 fact 表，附 evidence anchor 与 assertedBy。" },
  sqlDiff: { why: "让 DBA 能核对这次动作到底改了哪些行。", how: "事务内收集行级 before/after，渲染为 SQL 语义 diff。" },
  projectionRefresh: { why: "前端付款日历读的是投影，不刷新看不到新状态。", how: "重算 paymentCalendar 等投影物化行，dry-run 下仅计算差异不落盘。" },
  outboxCommit: { why: "跨系统通知与审计回执不能丢。", how: "业务写入与 outbox 事件在同一事务提交，保证至少一次投递。" },
};

export interface MockTraceOptions {
  actionId?: string;
  targetId?: string;
  amount?: string;
  mode?: "dryRun" | "commit";
  seed?: number;
}

/** 确定性 mock trace：不调用任何网络，不写任何数据。 */
export function buildMockTrace(opts: MockTraceOptions = {}): TraceDoc {
  const mode = opts.mode ?? "dryRun";
  const actionId = opts.actionId ?? "recordPayment";
  const targetId = opts.targetId ?? "pay-obl-NU-2026-H2";
  const amount = opts.amount ?? "610000";
  const stages: TraceStage[] = TRACE_STAGE_IDS.map((id) => ({
    id,
    status: "done" as const,
    ...STAGE_NARRATIVE[id],
    artifacts: { [id]: `${TRACE_STAGE_LABELS[id]} · ${mode === "dryRun" ? "演练，无写入" : "已提交"} · seed=${opts.seed ?? 0}` },
  }));
  return {
    traceId: `mock-trace-${mode}-${opts.seed ?? 0}`,
    actionId,
    targetId,
    mode,
    status: "succeeded",
    stages,
    subgraph: {
      nodes: [
        { id: "contract:NU-LIC", type: "Contract", label: "纽卡斯尔联授权合同 2026–2028" },
        { id: `obl:${targetId}`, type: "PaymentObligation", label: "年度授权费 · MG 下半年度分期（演示推演）" },
        { id: `pay:${targetId}-1`, type: "Payment", label: `登记付款 ¥${Number(amount).toLocaleString("zh-CN")}` },
        { id: "ledger:cash-q3", type: "LedgerEntry", label: "现金台账 · Q3" },
      ],
      edges: [
        { from: "contract:NU-LIC", to: `obl:${targetId}`, relation: "规定付款义务" },
        { from: `obl:${targetId}`, to: `pay:${targetId}-1`, relation: "被付款冲抵" },
        { from: `pay:${targetId}-1`, to: "ledger:cash-q3", relation: "进入台账" },
      ],
    },
    yamlSource: [
      `# 演示数据包片段（Demo Pack · 演示推演）`,
      `action: ${actionId}`,
      `target: PaymentObligation/${targetId}`,
      `input:`,
      `  amount: "${amount}"`,
      `  currency: CNY`,
      `  paidAt: "2026-09-08T10:30:00+08:00"`,
    ].join("\n"),
    canonicalIR: `{"action":"${actionId}","input":{"amount":"${amount}","currency":"CNY"},"policy":"financeOperator:allow recordPayment","rules":["settleWhenFullyPaid","clearOverdueFlag"]}`,
    policyExplain: "命中 allow 规则：角色 financeOperator 可对名下 PaymentObligation 执行 recordPayment；金额超过 ¥50 万需额外 bossApproval —— 本次 ¥61 万由已批准的决策事项 nufc-payment 背书（演示推演）。",
    ruleExplain: "Rule settleWhenFullyPaid：当 unsettledAmount = 0 时置 status=paid 并解除逾期标记。Rule clearOverdueFlag：结清后 24h 内清除老板收件箱的逾期提醒（均为演示推演数据触发）。",
    factDiff: [
      { op: "create", subject: `Payment/${targetId}-1`, predicate: "amount", value: amount },
      { op: "update", subject: `PaymentObligation/${targetId}`, predicate: "unsettledAmount", value: "0" },
    ],
    sqlDiff: [
      `-- ${mode === "dryRun" ? "DRY RUN（未执行）" : "COMMITTED"}`,
      `INSERT INTO payments (id, obligation_id, amount, currency, paid_at)`,
      `  VALUES ('${targetId}-1', '${targetId}', ${amount}, 'CNY', now());`,
      `UPDATE payment_obligations SET unsettled_amount = 0, status = 'paid'`,
      `  WHERE id = '${targetId}'; -- version 3 -> 4`,
    ].join("\n"),
    projectionDiff: "paymentCalendar：该义务从「待付款 ¥61.0万」→「已结清」；bossActionInbox 移除对应逾期提醒；totals.unsettledAmount -610000（演示推演）。",
    audit: [{ at: "2026-09-08 10:30:01", actor: "demo-finance", action: actionId, entity: `PaymentObligation/${targetId}` }],
    outbox: [{ eventId: "evt-demo-0001", type: "payment.recorded", status: mode === "commit" ? "dispatched" : "prepared(dry-run)" }],
  };
}

export const MOCK_OBLIGATIONS: PaymentObligationView[] = [
  { id: "pay-obl-NU-2026-H2", label: "纽卡斯尔联 · 年度授权费 MG 下半年度分期", amount: "¥610,000", dueAt: "2026-09-10", status: "待审批" },
  { id: "pay-obl-ACM-SIG-03", label: "AC 米兰 · 人物资源第三批签名包干", amount: "¥460,000", dueAt: "2026-10-15", status: "待付款" },
  { id: "pay-obl-SVC-AGENCY-Q3", label: "共享服务 · 海外代理协调费", amount: "¥86,000", dueAt: "2026-09-25", status: "待核对" },
];

/**
 * 尝试真实 API：POST /v1/actions/:actionId/execute（携带 dryRun），
 * 成功后 GET /v1/traces/:traceId。任一步失败返回 null，由调用方降级 mock。
 * 接口假设（Runtime 分支落地后核对）：
 *  - execute 请求体在现有 {targetId,input,idempotencyKey} 之上接受 dryRun?: boolean
 *  - 响应含 traceId（未含则用 runId）
 *  - GET /v1/traces/:id 返回与 TraceDoc 兼容的 JSON
 */
export async function executeWithTrace(
  baseUrl: string,
  headers: Record<string, string>,
  actionId: string,
  req: { targetId: string; input: Record<string, unknown>; idempotencyKey: string; dryRun: boolean },
): Promise<TraceDoc | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/actions/${actionId}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(req),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { traceId?: string; runId?: string };
    const traceId = body.traceId ?? body.runId;
    if (!traceId) return null;
    const traceRes = await fetch(`${baseUrl}/v1/traces/${encodeURIComponent(traceId)}`, { headers });
    if (!traceRes.ok) return null;
    const doc = (await traceRes.json()) as TraceDoc;
    if (req.dryRun) doc.mode = "dryRun";
    return doc;
  } catch {
    return null;
  }
}
