"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MOCK_OBLIGATIONS,
  buildMockTrace,
  executeWithTrace,
} from "./trace-adapter";
import {
  TRACE_STAGE_IDS,
  TRACE_STAGE_LABELS,
  type PaymentObligationView,
  type TraceDoc,
  type TraceStage,
} from "./trace-types";

type ResultTab = "yaml" | "ir" | "explain" | "diff" | "projection" | "audit";

const TABS: { id: ResultTab; label: string }[] = [
  { id: "yaml", label: "YAML Source" },
  { id: "ir", label: "Canonical IR" },
  { id: "explain", label: "Policy / Rule Explain" },
  { id: "diff", label: "Fact / SQL Diff" },
  { id: "projection", label: "Projection Diff" },
  { id: "audit", label: "Audit / Outbox" },
];

const STATUS_CLASS: Record<TraceStage["status"], string> = {
  pending: "st-pending",
  running: "st-running",
  done: "st-done",
  failed: "st-failed",
  skipped: "st-skipped",
};

/**
 * 付款闭环工作台（纵向切片）：左业务对象 + 登记付款，中 11 阶段时间线，
 * 右结果面板（YAML/IR/Explain/Diff/Projection/Audit）。
 * Trace 目前来自 mock adapter（API 未上线时），界面明确标注 DEMO/MOCK。
 */
export function PaymentWorkbench() {
  const [obligations] = useState<PaymentObligationView[]>(MOCK_OBLIGATIONS);
  const [selectedObligation, setSelectedObligation] = useState(MOCK_OBLIGATIONS[0].id);
  const [trace, setTrace] = useState<TraceDoc | null>(null);
  const [traceSource, setTraceSource] = useState<"api" | "mock" | null>(null);
  const [busy, setBusy] = useState<"dryRun" | "commit" | null>(null);
  const [error, setError] = useState("");
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);
  const [replayActive, setReplayActive] = useState(false);
  const [tab, setTab] = useState<ResultTab>("diff");
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const obligation = obligations.find((o) => o.id === selectedObligation) ?? obligations[0];

  const stopReplay = useCallback(() => {
    setReplayActive(false);
    if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null; }
  }, []);

  useEffect(() => () => stopReplay(), [stopReplay]);

  // 回放：把 11 个阶段逐个点亮（只驱动 UI 演示，不重放请求）
  useEffect(() => {
    if (!replayActive || !trace) return;
    replayTimer.current = setInterval(() => {
      setSelectedStageIndex((prev) => {
        const next = prev + 1;
        if (next >= TRACE_STAGE_IDS.length) { stopReplay(); return prev; }
        return next;
      });
    }, 700);
    return () => { if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null; } };
  }, [replayActive, trace, stopReplay]);

  const runAction = async (dryRun: boolean) => {
    setBusy(dryRun ? "dryRun" : "commit");
    setError("");
    stopReplay();
    try {
      const apiTrace = await executeWithTrace("", { "x-actor-id": "demo-finance", "x-actor-roles": "financeOperator" }, "recordPayment", {
        targetId: obligation.id,
        input: { amount: obligation.amount.replace(/[^\d]/g, ""), currency: "CNY", paidAt: new Date().toISOString() },
        idempotencyKey: `demo-pay-${obligation.id}-${dryRun ? "dry" : "commit"}`,
        dryRun,
      });
      if (apiTrace) {
        setTrace(apiTrace);
        setTraceSource("api");
      } else {
        // Runtime trace API 尚未上线 —— mock 兜底，不伪装真实落库
        setTrace(buildMockTrace({ targetId: obligation.id, amount: obligation.amount.replace(/[^\d]/g, ""), mode: dryRun ? "dryRun" : "commit", seed: dryRun ? 1 : 2 }));
        setTraceSource("mock");
      }
      setSelectedStageIndex(0);
      setTab("diff");
    } catch (e) {
      setError(e instanceof Error ? e.message : "执行失败");
    } finally {
      setBusy(null);
    }
  };

  const stages: TraceStage[] = useMemo(() => trace?.stages ?? [], [trace]);
  const selectedStage = stages[Math.min(selectedStageIndex, Math.max(0, stages.length - 1))];
  const progressedStages = useMemo(() => new Set(stages.slice(0, selectedStageIndex + 1).map((s) => s.id)), [stages, selectedStageIndex]);

  return (
    <section className="wb-root" data-testid="payment-workbench">
      <header className="wb-head">
        <div>
          <p className="eyebrow">PAYMENT CLOSURE WORKBENCH</p>
          <h1>付款闭环 · 本体透视 × Runtime 调试</h1>
          <p className="sub">
            左侧登记付款，中间查看 11 阶段执行 trace，右侧核对 YAML / IR / Policy / Diff / Audit。
            {traceSource === "mock" && <b className="mock-flag">当前 trace 为 MOCK 演示数据，未真实落库</b>}
            {traceSource === "api" && <b className="api-flag">trace 来自 Runtime API</b>}
          </p>
        </div>
        <span className="demo-flag-pill">DEMO · 演示推演</span>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <div className="wb-layout">
        <aside className="wb-left panel">
          <div className="panel-head"><div><span>BUSINESS OBJECTS</span><h2>付款义务（演示数据包）</h2></div></div>
          {obligations.map((o) => (
            <button key={o.id} className={`wb-obl ${o.id === selectedObligation ? "selected" : ""}`} onClick={() => { setSelectedObligation(o.id); stopReplay(); }}>
              <b>{o.label}</b>
              <small>{o.amount} · 到期 {o.dueAt}</small>
              <em className="state-pill">{o.status}</em>
            </button>
          ))}
          <div className="wb-subgraph">
            <p className="eyebrow">本 action 子图（默认不全图展开）</p>
            <ul>
              {(trace?.subgraph.nodes ?? [
                { id: `obl:${obligation.id}`, type: "PaymentObligation", label: obligation.label },
              ]).map((n) => (
                <li key={n.id}><span className="tag">{n.type}</span>{n.label}</li>
              ))}
            </ul>
            {trace && (
              <ul className="wb-edges">
                {trace.subgraph.edges.map((e) => <li key={`${e.from}-${e.to}`}>{shortId(e.from)} —{e.relation}→ {shortId(e.to)}</li>)}
              </ul>
            )}
          </div>
          <div className="wb-run">
            <button className="wb-btn dry" disabled={busy !== null} onClick={() => void runAction(true)}>
              {busy === "dryRun" ? "演练中…" : "Dry-run 登记付款"}
            </button>
            <button className="wb-btn commit" disabled={busy !== null || !trace || trace.mode === "dryRun"} title={!trace || trace.mode === "dryRun" ? "先完成一次 dry-run 确认差异后再提交" : "提交到规范事实库（mock 模式仅演示）"} onClick={() => void runAction(false)}>
              {busy === "commit" ? "提交中…" : "Commit 登记付款"}
            </button>
            <p className="wb-note">dry-run 只计算差异不写入；commit 才进入 PostgreSQL 规范事实库。当前 {traceSource === "mock" ? "MOCK 演示" : traceSource === "api" ? "真实 Runtime" : "未执行"}。</p>
          </div>
        </aside>

        <section className="wb-mid panel">
          <div className="panel-head">
            <div><span>RUNTIME TRACE · 11 STAGES</span><h2>{trace ? `${trace.actionId} · ${trace.mode === "dryRun" ? "DRY-RUN" : "COMMIT"}` : "尚未执行"}</h2></div>
            {trace && (
              <div className="wb-replay">
                <button onClick={() => { if (replayActive) { stopReplay(); } else { setSelectedStageIndex(0); setReplayActive(true); } }}>
                  {replayActive ? "⏸ 暂停回放" : "▶ 回放"}
                </button>
                <small>已进行到第 {selectedStageIndex + 1} / {TRACE_STAGE_IDS.length} 步</small>
              </div>
            )}
          </div>
          {!trace && <p className="empty">在左侧选择付款义务并执行 Dry-run，查看 11 阶段 trace。</p>}
          <ol className="wb-timeline">
            {stages.map((stage, i) => {
              const revealed = i <= selectedStageIndex;
              return (
                <li key={stage.id} className={`${STATUS_CLASS[revealed ? stage.status : "pending"]} ${i === selectedStageIndex ? "current" : ""} ${progressedStages.has(stage.id) ? "reached" : ""}`}>
                  <button onClick={() => { stopReplay(); setSelectedStageIndex(i); }}>
                    <i className="wb-dot" aria-hidden />
                    <span className="wb-stage-label">{TRACE_STAGE_LABELS[stage.id]}</span>
                    <span className="wb-stage-status">{revealed ? statusText(stage.status) : "未执行"}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          {selectedStage && (
            <div className="wb-stage-explain">
              <p><b>为什么需要这一步？</b>{selectedStage.why}</p>
              <p><b>这一步如何产生结果？</b>{selectedStage.how}</p>
            </div>
          )}
        </section>

        <section className="wb-right panel">
          <div className="panel-head"><div><span>RESULTS &amp; EXPLAIN</span><h2>结果面板</h2></div></div>
          <div className="wb-tabs" role="tablist">
            {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
          </div>
          <div className="wb-tab-body">
            {!trace && <p className="empty">执行 dry-run 后这里展示 YAML 源、IR、policy 解释、差异与审计。每个结果都附「为什么 / 如何产生」。</p>}
            {trace && tab === "yaml" && <CodeBlock title="Data Pack / Action 输入（YAML）" why="为什么：YAML 是 authoring 格式，Runtime 只消费编译产物。" how="如何产生：来自演示数据包与本次 action 输入。" code={trace.yamlSource ?? "—"} />}
            {trace && tab === "ir" && <CodeBlock title="Canonical IR（编译产物）" why="为什么：Runtime 不读 YAML，只信编译后的 IR 与指纹。" how="如何产生：DSL 编译器输出，execute 前做兼容性校验。" code={trace.canonicalIR ?? "—"} />}
            {trace && tab === "explain" && (
              <div className="wb-text-result">
                <ExplainRow title="Policy Explain" why="为什么：付款超过 ¥50 万需要解释授权依据。" how="如何产生：编译 policy 模型在 authorize 阶段输出的命中规则。" text={trace.policyExplain ?? "—"} />
                <ExplainRow title="Rule Explain" why="为什么：结清状态是 Rule 推导而非手填。" how="如何产生：受限 AST Rule 在 rules 阶段求值命中。" text={trace.ruleExplain ?? "—"} />
              </div>
            )}
            {trace && tab === "diff" && (
              <>
                <div className="wb-factdiff">
                  <b>Fact Diff</b>
                  {(trace.factDiff ?? []).map((d, i) => (
                    <p key={i}><span className={`tag ${d.op}`}>{d.op}</span>{d.subject} · {d.predicate} = {d.value}</p>
                  ))}
                </div>
                <CodeBlock title="SQL Diff" why="为什么：DBA 需要核对本次动作改了哪些行。" how="如何产生：执行事务内收集的行级 before/after。" code={trace.sqlDiff ?? "—"} />
              </>
            )}
            {trace && tab === "projection" && <CodeBlock title="Projection Diff" why="为什么：页面读投影，需要知道投影会怎么变。" how="如何产生：projectionRefresh 阶段重算的差异（dry-run 不落盘）。" code={trace.projectionDiff ?? "—"} />}
            {trace && tab === "audit" && (
              <div className="wb-audit">
                <b>Audit</b>
                {(trace.audit ?? []).map((a, i) => <p key={i}><span className="tag">{a.action}</span>{a.actor} → {a.entity} · {a.at}</p>)}
                <b>Outbox</b>
                {(trace.outbox ?? []).map((o) => <p key={o.eventId}><span className="tag">{o.type}</span>{o.eventId} · {o.status}</p>)}
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

function statusText(status: TraceStage["status"]): string {
  return status === "done" ? "✓ 完成" : status === "failed" ? "✕ 失败" : status === "running" ? "… 执行中" : status === "skipped" ? "跳过" : "待执行";
}

function ExplainRow({ title, why, how, text }: { title: string; why: string; how: string; text: string }) {
  return <div className="wb-explain-row"><b>{title}</b><p>{text}</p><small>{why}</small><small>{how}</small></div>;
}

function CodeBlock({ title, why, how, code }: { title: string; why: string; how: string; code: string }) {
  return (
    <div className="wb-code">
      <div className="wb-code-head"><b>{title}</b><small title={why}>{why}</small></div>
      <pre><code>{code}</code></pre>
      <small className="wb-how">{how}</small>
    </div>
  );
}
