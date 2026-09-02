"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createOntologyClient,
  type BossInboxItem,
  type FactView,
  type OntologyClient,
  type PaymentCalendar,
  type RecommendationView,
  type SignatureOverview,
} from "@daka/ontology-client";

/**
 * 本体平台视图：四条业务闭环全部走 Ontology Runtime API（PostgreSQL 规范事实），
 * 页面不含核心业务常量。所有数字来自演示数据包，标注“演示推演”。
 */

const steward = createOntologyClient({ actorId: "demo-steward", roles: ["dataSteward"] });
const finance = createOntologyClient({ actorId: "demo-finance", roles: ["financeOperator"] });
const ipOps = createOntologyClient({ actorId: "demo-ipops", roles: ["ipOperations"] });

function fmtAmount(amount: number | string, currency = "CNY"): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return `¥${(n / 10000).toFixed(1).replace(/\.0$/, "")}万 ${currency === "CNY" ? "" : currency}`.trim();
}

export function OntologyPanel() {
  const [ready, setReady] = useState<{ status: string; fingerprint?: string } | null>(null);
  const [payments, setPayments] = useState<PaymentCalendar | null>(null);
  const [signature, setSignature] = useState<SignatureOverview | null>(null);
  const [inbox, setInbox] = useState<BossInboxItem[]>([]);
  const [facts, setFacts] = useState<FactView[]>([]);
  const [recs, setRecs] = useState<RecommendationView[]>([]);
  const [audit, setAudit] = useState<Array<{ occurred_at: string; actor_id: string; action: string; entity_type: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async (client: OntologyClient = steward) => {
    try {
      const [pay, sig, box, factList, market, auditTail] = await Promise.all([
        client.paymentCalendar(),
        client.signatureOverview(),
        client.bossActionInbox(),
        client.listFacts("proposed"),
        client.marketRecommendation(),
        client.audit(12),
      ]);
      setPayments(pay);
      setSignature(sig);
      setInbox(box.items);
      setFacts(factList.items);
      setRecs(market.recommendations);
      setAudit(auditTail.items);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    steward.health().then((h) => { if (!cancelled) setReady(h); }).catch(() => { if (!cancelled) setReady({ status: "not_ready" }); });
    const t = setTimeout(() => void refresh(), 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="ontology-panel">
      <div className="page-head">
        <div>
          <p className="eyebrow">ONTOLOGY RUNTIME</p>
          <h1>本体平台 · 实时事实层</h1>
          <p className="sub">
            数据来自 PostgreSQL 规范事实库（Ontology Runtime API · 指纹 {ready?.fingerprint?.slice(0, 12) ?? "…"}）。
            全部业务数字为合成数据包内容，标注<mark>演示推演</mark>。
          </p>
        </div>
        <button className="ghost" onClick={() => void refresh()}>刷新</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="onto-grid">
        <div className="onto-card">
          <h3>老板行动项 <small>bossActionInbox</small></h3>
          {inbox.length === 0 && <p className="empty">暂无待办</p>}
          {inbox.map((item) => (
            <div className="onto-row" key={`${item.kind}-${item.id}`}>
              <span className={`tag ${item.kind}`}>{item.kind === "risk" ? "风险" : item.kind === "payment_overdue" ? "逾期付款" : "发行建议"}</span>
              <span>{item.title ?? `${item.type ?? ""} ${item.amount ? fmtAmount(item.amount) : ""}`}</span>
              <em>演示推演</em>
            </div>
          ))}
        </div>

        <div className="onto-card">
          <h3>付款日历 <small>paymentCalendar</small></h3>
          {payments?.items.map((p) => (
            <div className="onto-row" key={p.id}>
              <span className={`tag ${p.status}`}>{p.status}</span>
              <span>{fmtAmount(p.amount, p.currency)} · 应付 {new Date(p.dueAt).toLocaleDateString("zh-CN")}</span>
              <span>未结清 {fmtAmount(p.unsettledAmount, p.currency)}</span>
              {p.status !== "paid" && (
                <button
                  className="mini"
                  disabled={busy === p.id}
                  onClick={() =>
                    void run(p.id, () =>
                      finance.executeAction("recordPayment", {
                        targetId: p.id,
                        input: { amount: String(p.unsettledAmount), currency: p.currency, paidAt: new Date().toISOString() },
                        idempotencyKey: `demo-pay-${p.id}-${p.unsettledAmount}`,
                      }),
                    )
                  }
                >
                  登记结清
                </button>
              )}
            </div>
          ))}
          <p className="totals">未结清合计 {fmtAmount(payments?.totals.unsettledAmount ?? 0)} · 逾期 {fmtAmount(payments?.totals.overdueAmount ?? 0)}（演示推演）</p>
        </div>

        <div className="onto-card">
          <h3>签名资源 <small>signatureOverview</small></h3>
          {signature?.lots.map((lot) => (
            <div className="onto-row" key={lot.id}>
              <span className="tag">{lot.lotNumber}</span>
              <span>可用 {lot.buckets.available} · 已分配 {lot.buckets.allocated} · 已消耗 {lot.buckets.consumed}</span>
              <button
                className="mini"
                disabled={busy === lot.id || lot.buckets.available < 10}
                onClick={() =>
                  void run(lot.id, () =>
                    ipOps.executeAction("allocateSignatures", {
                      targetId: lot.id,
                      input: { releaseProjectId: "d0000000-0000-4000-8000-000000000301", quantity: 10, reason: "演示分配" },
                      idempotencyKey: `demo-alloc-${lot.id}-${Date.now()}`,
                    }),
                  )
                }
              >
                分配 10 张
              </button>
            </div>
          ))}
          <p className="totals">合计可用 {signature?.totals.available ?? 0} · Movement 守恒，超额由服务端 422 阻断（演示推演）</p>
        </div>

        <div className="onto-card">
          <h3>候选事实复核 <small>fact review（AI 只产 proposed）</small></h3>
          {facts.length === 0 && <p className="empty">复核队列已清空</p>}
          {facts.map((f) => (
            <div className="onto-row" key={f.id}>
              <span className="tag proposed">{f.status}</span>
              <span>{f.predicate}</span>
              <button className="mini" disabled={busy === f.id} onClick={() => void run(f.id, () => steward.verifyFact(f.id, "演示确认"))}>确认</button>
              <button className="mini danger" disabled={busy === f.id} onClick={() => void run(f.id, () => steward.rejectFact(f.id, "演示驳回"))}>驳回</button>
            </div>
          ))}
        </div>

        <div className="onto-card">
          <h3>二级市场建议 <small>marketRecommendation（人工评审，不自动改印量）</small></h3>
          {recs.map((r) => (
            <div className="onto-row" key={r.id}>
              <span className={`tag ${r.status}`}>{r.status}</span>
              <span>{r.recommendationType}：{r.rationale.slice(0, 40)}…</span>
              {(r.status === "suggested" || r.status === "in_review") && (
                <>
                  <button className="mini" disabled={busy === r.id} onClick={() => void run(r.id, () => ipOps.executeAction("reviewReleaseRecommendation", { targetId: r.id, input: { decision: "approved", reviewComment: "演示批准" }, idempotencyKey: `demo-review-${r.id}-${Date.now()}` }))}>批准</button>
                  <button className="mini danger" disabled={busy === r.id} onClick={() => void run(r.id, () => ipOps.executeAction("reviewReleaseRecommendation", { targetId: r.id, input: { decision: "rejected", reviewComment: "演示驳回" }, idempotencyKey: `demo-reject-${r.id}-${Date.now()}` }))}>否决</button>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="onto-card">
          <h3>审计流水 <small>audit（只追加）</small></h3>
          {audit.map((a, i) => (
            <div className="onto-row" key={i}>
              <span className="tag">{a.action}</span>
              <span>{a.actor_id} → {a.entity_type}</span>
              <em>{new Date(a.occurred_at).toLocaleTimeString("zh-CN")}</em>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
