#!/usr/bin/env node
/**
 * E2E：四条业务闭环走真实 Worker API（需 dev server + 数据库已 seed）。
 * 用法: node scripts/e2e-api.mjs [baseUrl]   默认 http://localhost:3000
 * 退出码 0 = 全过；1 = 有失败。
 */

const BASE = process.argv[2] ?? "http://localhost:3000";
const TENANT = "d0000000-0000-4000-8000-000000000001";
const WS = "d0000000-0000-4000-8000-000000000002";

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

// 每次运行用时间戳后缀，保证 E2E 可重复执行（不产生主键冲突）
const RUN = String(Date.now()).slice(-12).padStart(12, "0");
const id = (suffix) => `e2e00000-0000-4000-8000-${String(Number(RUN) + parseInt(suffix.slice(-4), 16) % 0xffffffff).slice(-12).padStart(12, "0")}`;

async function call(path, { method = "GET", roles = ["executiveViewer"], actor = "e2e", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-tenant-id": TENANT,
      "x-workspace-id": WS,
      "x-actor-id": actor,
      "x-actor-roles": roles.join(","),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

console.log(`E2E against ${BASE}`);

// 0. 健康
{
  const live = await call("/health/live");
  const ready = await call("/health/ready");
  ok("health live", live.status === 200);
  ok("health ready + 指纹", ready.status === 200 && Boolean(ready.data?.fingerprint));
}

// 1. 合同/权益闭环：对象 → 候选事实 → 人工确认
{
  const c = await call("/v1/objects", {
    method: "POST", roles: ["legalOperator"], actor: "e2e-legal",
    body: { type: "Contract", id: id("0000000000d1"), data: { title: "E2E 合同（演示推演）", status: "draft", documentId: "d0000000-0000-4000-8000-0000000000e1" } },
  });
  ok("创建 Contract", c.status === 201, JSON.stringify(c.data));
  const f = await call("/v1/facts", {
    method: "POST", roles: ["systemAgent"], actor: "e2e-extractor",
    body: { subjectType: "Contract", subjectId: id("0000000000d1"), predicate: "e2e.predicate", objectValue: { v: 1 }, evidenceAnchorId: "d0000000-0000-4000-8000-0000000000e2" },
  });
  ok("提交 proposed fact", f.status === 201 && f.data?.status === "proposed", JSON.stringify(f.data));
  const factId = f.data?.id;
  const denyPropose = await call("/v1/facts", {
    method: "POST", roles: ["executiveViewer"], actor: "e2e-exec",
    body: { subjectType: "Contract", subjectId: id("0000000000d1"), predicate: "e2e.deny", objectValue: { v: 0 }, evidenceAnchorId: "d0000000-0000-4000-8000-0000000000e2" },
  });
  ok("越权提议事实被拒 403", denyPropose.status === 403, JSON.stringify(denyPropose.data));
  const sysVerify = await call(`/v1/facts/${factId}/verify`, { method: "POST", roles: ["systemAgent"], actor: "e2e-extractor", body: {} });
  ok("systemAgent 确认事实被拒 403", sysVerify.status === 403, JSON.stringify(sysVerify.data));
  const execVerify = await call(`/v1/facts/${factId}/verify`, { method: "POST", roles: ["executiveViewer"], actor: "e2e-exec", body: {} });
  ok("executiveViewer 确认事实被拒 403", execVerify.status === 403, JSON.stringify(execVerify.data));
  const v = await call(`/v1/facts/${factId}/verify`, { method: "POST", roles: ["legalReviewer"], actor: "e2e-legalreview", body: {} });
  ok("人工确认 fact → verified", v.status === 200 && v.data?.status === "verified", JSON.stringify(v.data));
  const list = await call("/v1/facts?status=verified", { roles: ["dataSteward"] });
  ok("verified 可查", list.data?.items?.some((x) => x.id === factId));
}

// 2. 付款闭环：计划 → 登记 → 状态重算 → 投影
{
  const s = await call("/v1/objects", {
    method: "POST", roles: ["financeOperator"], actor: "e2e-fin",
    body: { type: "PaymentSchedule", id: id("000000000101"), data: { amount: "800", currency: "CNY", dueAt: "2031-01-01T00:00:00Z", status: "planned" } },
  });
  ok("创建 PaymentSchedule", s.status === 201, JSON.stringify(s.data));
  const denied = await call("/v1/actions/recordPayment/execute", {
    method: "POST", roles: ["executiveViewer"],
    body: { targetId: id("000000000101"), input: { amount: "800", currency: "CNY", paidAt: "2026-09-03T00:00:00Z" }, idempotencyKey: "e2e-deny-1-" + RUN },
  });
  ok("越权付款被拒 403", denied.status === 403);
  const pay = await call("/v1/actions/recordPayment/execute", {
    method: "POST", roles: ["financeOperator"], actor: "e2e-fin",
    body: { targetId: id("000000000101"), input: { amount: "800", currency: "CNY", paidAt: "2026-09-03T00:00:00Z" }, idempotencyKey: "e2e-pay-1-" + RUN },
  });
  ok("财务付款成功", pay.status === 200 && pay.data?.result?.scheduleStatus === "paid", JSON.stringify(pay.data));
  const replay = await call("/v1/actions/recordPayment/execute", {
    method: "POST", roles: ["financeOperator"], actor: "e2e-fin",
    body: { targetId: id("000000000101"), input: { amount: "800", currency: "CNY", paidAt: "2026-09-03T00:00:00Z" }, idempotencyKey: "e2e-pay-1-" + RUN },
  });
  ok("幂等重放同 runId 不产生重复 effect", replay.data?.status === "replayed" && replay.data?.runId === pay.data?.runId);
  const cal = await call("/v1/projections/paymentCalendar", { roles: ["financeOperator"] });
  const item = cal.data?.items?.find((x) => x.id === id("000000000101"));
  ok("投影反映已付", item?.status === "paid" && item?.unsettledAmount === 0, JSON.stringify(item));
}

// 2.5 关系路由授权：越权创建 403；合法创建 201（关系委托 linkType.from 端点 write）
{
  const denyLink = await call("/v1/links", {
    method: "POST", roles: ["executiveViewer"], actor: "e2e-exec",
    body: { linkType: "contractParties", from: id("0000000000d1"), to: "d0000000-0000-4000-8000-0000000000e2" },
  });
  ok("越权创建关系被拒 403", denyLink.status === 403, JSON.stringify(denyLink.data));
  const okLink = await call("/v1/links", {
    method: "POST", roles: ["legalOperator"], actor: "e2e-legal",
    body: { linkType: "contractHasPaymentSchedule", from: id("0000000000d1"), to: id("000000000101") },
  });
  ok("合法创建关系 201", okLink.status === 201, JSON.stringify(okLink.data));
}

// 3. 签名闭环：收货 → 分配 → 超额 422 → 桶余额
{
  const e = await call("/v1/objects", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { type: "SignatureEntitlement", id: id("000000000201"), data: { grantedQuantity: 20, unit: "张" } },
  });
  ok("创建 SignatureEntitlement", e.status === 201, JSON.stringify(e.data));
  const recv = await call("/v1/actions/receiveSignatureLot/execute", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { targetId: id("000000000201"), input: { lotNumber: "LOT-E2E-1", quantity: 20, receivedAt: "2026-09-03T00:00:00Z", evidenceAnchorId: "d0000000-0000-4000-8000-0000000000e2" }, idempotencyKey: "e2e-recv-1-" + RUN },
  });
  ok("批次收货", recv.status === 200, JSON.stringify(recv.data));
  const lotId = recv.data?.result?.lotId;
  const alloc = await call("/v1/actions/allocateSignatures/execute", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { targetId: lotId, input: { releaseProjectId: "d0000000-0000-4000-8000-000000000301", quantity: 15 }, idempotencyKey: "e2e-alloc-1-" + RUN },
  });
  ok("分配 15/20 成功", alloc.status === 200, JSON.stringify(alloc.data));
  const over = await call("/v1/actions/allocateSignatures/execute", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { targetId: lotId, input: { releaseProjectId: "d0000000-0000-4000-8000-000000000301", quantity: 6 }, idempotencyKey: "e2e-alloc-over-" + RUN },
  });
  ok("超额分配 5+1 被 422 阻断", over.status === 422, JSON.stringify(over.data));
  const sig = await call("/v1/projections/signatureOverview", { roles: ["ipOperations"] });
  const lot = sig.data?.lots?.find((l) => l.id === lotId);
  ok("桶余额守恒 available=5", lot?.buckets?.available === 5, JSON.stringify(lot?.buckets));
}

// 4. 市场闭环：观察 → 建议 → 人工评审（不自动改印量）
{
  const o = await call("/v1/objects", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { type: "MarketObservation", id: id("000000000401"), data: { source: "kaitao_demo", observedAt: "2026-09-03T00:00:00Z", windowDays: 7, currency: "CNY", premiumRate: "0.7", volume: 200 } },
  });
  ok("创建 MarketObservation", o.status === 201, JSON.stringify(o.data));
  const r = await call("/v1/objects", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { type: "ReleaseRecommendation", id: id("000000000410"), data: { recommendationType: "reprint", status: "suggested", rationale: "E2E 演示推演", createdBy: "rule-runner", createdAt: "2026-09-03T00:00:00Z" } },
  });
  ok("创建 ReleaseRecommendation(suggested)", r.status === 201, JSON.stringify(r.data));
  const review = await call("/v1/actions/reviewReleaseRecommendation/execute", {
    method: "POST", roles: ["ipOperations"], actor: "e2e-ip",
    body: { targetId: id("000000000410"), input: { decision: "approved", reviewComment: "E2E 批准" }, idempotencyKey: "e2e-review-1-" + RUN },
  });
  ok("人工评审批准", review.status === 200 && review.data?.result?.status === "approved", JSON.stringify(review.data));
  const market = await call("/v1/projections/marketRecommendation", { roles: ["ipOperations"] });
  ok("投影反映评审结果", market.data?.recommendations?.some((x) => x.id === id("000000000410") && x.status === "approved"));
}

// 5. 审计与指标
{
  const audit = await call("/v1/audit?limit=20", { roles: ["dataSteward"] });
  ok("审计含 E2E 动作", audit.data?.items?.some((a) => a.actor_id?.startsWith("e2e-")));
  const metrics = await call("/v1/metrics", { roles: ["dataSteward"] });
  ok("指标端点可用", metrics.status === 200 && metrics.data?.action_runs !== undefined);
  const dq = await call("/v1/dq/report", { roles: ["dataSteward"] });
  ok("数据质量报告", dq.status === 200 && dq.data?.healthy !== undefined);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
