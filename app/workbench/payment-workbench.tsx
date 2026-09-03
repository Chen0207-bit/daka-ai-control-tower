"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MOCK_OBLIGATIONS,
  WorkbenchApiError,
  buildMockTrace,
  executeWithTrace,
  fetchStoredTrace,
  loadOntologyMeta,
  loadPaymentObligations,
} from "./trace-adapter";
import {
  type PaymentObligationView,
  type TraceDoc,
  type UiStage,
} from "./trace-types";

type ResultTab = "yaml" | "ir" | "explain" | "diff" | "projection" | "audit";
type DataMode = "real" | "mock";

const TABS: { id: ResultTab; label: string }[] = [
  { id: "yaml", label: "YAML Source" },
  { id: "ir", label: "Canonical IR" },
  { id: "explain", label: "Policy / Rule Explain" },
  { id: "diff", label: "Fact / SQL Diff" },
  { id: "projection", label: "Projection Diff" },
  { id: "audit", label: "Audit / Outbox" },
];

const STATUS_CLASS: Record<UiStage["status"], string> = {
  pending: "st-pending",
  done: "st-done",
  failed: "st-failed",
  skipped: "st-skipped",
};

const TRACE_STATUS_LABEL: Record<TraceDoc["status"], string> = {
  completed: "已完成 · committed",
  replayed: "幂等重放 · committed",
  planned: "PLAN 演练 · 零写入",
  denied: "权限拒绝 · 零写入",
  precondition_failed: "前置条件失败 · 零写入",
  validation_failed: "输入校验失败 · 零写入",
  not_found: "对象不存在 · 零写入",
  failed: "执行失败 · 零写入",
};

const TRACE_STATUS_CLASS: Record<TraceDoc["status"], string> = {
  completed: "ts-ok",
  replayed: "ts-ok",
  planned: "ts-plan",
  denied: "ts-deny",
  precondition_failed: "ts-fail",
  validation_failed: "ts-fail",
  not_found: "ts-fail",
  failed: "ts-fail",
};

/** 演示 actor：真实模式以 financeOperator 角色走 Runtime API（演示部署用请求头声明身份）。 */
const REAL_ACTOR = { actorId: "demo-finance", roles: ["financeOperator"] };

function traceIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const t = new URLSearchParams(window.location.search).get("trace");
  return t && /^[0-9a-f-]{36}$/i.test(t) ? t : null;
}

/**
 * 付款闭环工作台（纵向切片）：左业务对象 + 登记付款，中 11 阶段 Runtime trace 时间线，
 * 右结果面板（YAML/IR/Explain/Diff/Projection/Audit）。
 * 默认真实 Runtime 模式（PostgreSQL 规范事实）；API 失败明确报错，绝不静默降级。
 * MOCK 演示推演只能由用户显式选择，常驻 DEMO/MOCK 标识且 committed 恒为 false。
 */
export function PaymentWorkbench() {
  const [dataMode, setDataMode] = useState<DataMode>("real");
  const [obligations, setObligations] = useState<PaymentObligationView[]>([]);
  const [selectedObligation, setSelectedObligation] = useState("");
  const [meta, setMeta] = useState<{ version: string; fingerprint: string } | null>(null);
  const [trace, setTrace] = useState<TraceDoc | null>(null);
  const [traceSource, setTraceSource] = useState<"api" | "mock" | null>(null);
  const [busy, setBusy] = useState<"plan" | "execute" | null>(null);
  /** 业务失败（denied/precondition_failed 等，带真实 trace） */
  const [apiError, setApiError] = useState<{ code: string; message: string } | null>(null);
  /** 无 trace 可用的真实失败（网络/契约违规）——明确报错，禁止静默 MOCK */
  const [fatalError, setFatalError] = useState("");
  const [listError, setListError] = useState("");
  const [selectedStageIndex, setSelectedStageIndex] = useState(0);
  const [replayActive, setReplayActive] = useState(false);
  const [reopenId, setReopenId] = useState("");
  const [tab, setTab] = useState<ResultTab>("diff");
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // MOCK 列表不走 state：直接派生，避免 effect 内同步 setState
  const shownObligations = dataMode === "mock" ? MOCK_OBLIGATIONS : obligations;
  const obligation = shownObligations.find((o) => o.id === selectedObligation) ?? shownObligations[0];

  const stopReplay = useCallback(() => {
    setReplayActive(false);
    if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null; }
  }, []);

  useEffect(() => () => stopReplay(), [stopReplay]);

  const allStages: UiStage[] = useMemo(() => (trace ? [...trace.stages, ...trace.extraStages] : []), [trace]);

  // 回放：把阶段逐个点亮（只驱动 UI 演示，不重放请求）
  useEffect(() => {
    if (!replayActive || !trace) return;
    replayTimer.current = setInterval(() => {
      setSelectedStageIndex((prev) => {
        const next = prev + 1;
        if (next >= allStages.length) { stopReplay(); return prev; }
        return next;
      });
    }, 700);
    return () => { if (replayTimer.current) { clearInterval(replayTimer.current); replayTimer.current = null; } };
  }, [replayActive, trace, allStages.length, stopReplay]);

  // 真实模式：加载本体元信息 + paymentCalendar 投影作为左栏业务对象。失败即显式报错。
  const loadReal = useCallback(async () => {
    try {
      const [m, items] = await Promise.all([loadOntologyMeta("", REAL_ACTOR), loadPaymentObligations("", REAL_ACTOR)]);
      setMeta(m);
      setObligations(items);
      setSelectedObligation((cur) => (items.some((o) => o.id === cur) ? cur : (items[0]?.id ?? "")));
    } catch (e) {
      setObligations([]);
      setListError(e instanceof WorkbenchApiError ? e.message : `真实 Runtime 不可用：${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    if (dataMode !== "real") return;
    // 微任务调度：setState 不落在 effect 同步体（react-hooks/set-state-in-effect）
    void Promise.resolve().then(loadReal);
    // 刷新后按 URL 中的 ?trace= 重新打开同一 Trace
    const fromUrl = traceIdFromUrl();
    if (fromUrl) {
      fetchStoredTrace("", REAL_ACTOR, fromUrl)
        .then((doc) => { setTrace(doc); setTraceSource("api"); setApiError(doc.error); setSelectedStageIndex(0); })
        .catch((e) => setFatalError(e instanceof Error ? e.message : String(e)));
    }
  }, [dataMode, loadReal]);

  const rememberTraceUrl = (traceId: string) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "workbench");
    url.searchParams.set("trace", traceId);
    window.history.replaceState(null, "", url.toString());
  };

  const runAction = async (mode: "plan" | "execute") => {
    if (!obligation) return;
    setBusy(mode);
    setApiError(null);
    setFatalError("");
    stopReplay();
    try {
      if (dataMode === "mock") {
        // MOCK：用户显式选择的演示推演；committed 恒为 false，不伪装落库
        setTrace(buildMockTrace({ targetId: obligation.id, amount: obligation.rawAmount, mode, seed: mode === "plan" ? 1 : 2 }));
        setTraceSource("mock");
      } else {
        const outcome = await executeWithTrace("", REAL_ACTOR, "recordPayment", {
          targetId: obligation.id,
          input: { amount: obligation.rawAmount, currency: obligation.currency, paidAt: new Date().toISOString() },
          idempotencyKey: `wb-${obligation.id.slice(-8)}-${mode}-${Date.now()}`,
          mode,
        });
        setTrace(outcome.trace);
        setTraceSource("api");
        setApiError(outcome.apiError);
        rememberTraceUrl(outcome.trace.traceId);
        if (outcome.trace.committed) await loadReal(); // 投影为请求时推导：提交后重取左栏
      }
      setSelectedStageIndex(0);
      setTab("diff");
    } catch (e) {
      // 真实模式失败：明确报错，保留既有 trace 不覆盖、绝不切换 MOCK
      setFatalError(e instanceof WorkbenchApiError ? e.message : `真实模式执行失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const openTrace = async (id: string) => {
    setFatalError("");
    setApiError(null);
    try {
      const doc = await fetchStoredTrace("", REAL_ACTOR, id.trim());
      setTrace(doc);
      setTraceSource("api");
      setApiError(doc.error);
      setSelectedStageIndex(0);
      rememberTraceUrl(doc.traceId);
    } catch (e) {
      setFatalError(e instanceof Error ? e.message : String(e));
    }
  };

  const selectedStage = allStages[Math.min(selectedStageIndex, Math.max(0, allStages.length - 1))];
  const executeReady = Boolean(trace && trace.mode === "plan" && obligation && trace.targetId === obligation.id && trace.status === "planned");
  const stageAttr = (id: string): Record<string, unknown> => allStages.find((s) => s.id === id)?.attributes ?? {};

  return (
    <section className="wb-root" data-testid="payment-workbench" data-mode={dataMode}>
      <header className="wb-head">
        <div>
          <p className="eyebrow">PAYMENT CLOSURE WORKBENCH</p>
          <h1>付款闭环 · 本体透视 × Runtime 调试</h1>
          <p className="sub">
            左侧登记付款，中间查看 Runtime 11 阶段 trace，右侧核对 YAML / IR / Policy / Diff / Audit。
            {traceSource === "mock" && <b className="mock-flag">当前 trace 为 MOCK 演示数据，未写入 PostgreSQL</b>}
            {traceSource === "api" && <b className="api-flag">trace 来自真实 Runtime API · PostgreSQL</b>}
          </p>
        </div>
        <div className="wb-mode">
          <button className={dataMode === "real" ? "active" : ""} onClick={() => { setDataMode("real"); setTrace(null); setTraceSource(null); setApiError(null); setFatalError(""); setListError(""); }}>
            真实 Runtime（PostgreSQL）
          </button>
          <button className={dataMode === "mock" ? "active mock" : "mock"} onClick={() => { setDataMode("mock"); setTrace(null); setTraceSource(null); setApiError(null); setFatalError(""); }}>
            演示推演模式（MOCK）
          </button>
        </div>
      </header>

      {dataMode === "mock" && (
        <div className="mock-banner">DEMO / MOCK · 演示推演模式：本页所有数据为本地合成，不连接 Runtime、不写入 PostgreSQL。</div>
      )}
      {listError && dataMode === "real" && (
        <div className="error-banner">
          真实模式加载失败：{listError}（未降级 MOCK；可显式切换到「演示推演模式」。）
          <button className="banner-retry" onClick={() => { setListError(""); void loadReal(); }}>重试</button>
        </div>
      )}
      {fatalError && <div className="error-banner">真实模式失败：{fatalError}</div>}
      {apiError && trace && (
        <div className="deny-banner">
          业务失败已如实记录：{apiError.code} · {apiError.message}（trace.status = {trace.status}，committed = false，业务写入为 0）
        </div>
      )}

      <div className="wb-layout">
        <aside className="wb-left panel">
          <div className="panel-head"><div><span>BUSINESS OBJECTS</span><h2>{dataMode === "real" ? "付款计划（paymentCalendar 投影）" : "付款义务（MOCK 演示列表）"}</h2></div></div>
          {shownObligations.length === 0 && !listError && <p className="empty">加载中…</p>}
          {shownObligations.map((o) => (
            <button key={o.id} className={`wb-obl ${o.id === selectedObligation ? "selected" : ""}`} onClick={() => { setSelectedObligation(o.id); stopReplay(); }}>
              <b>{o.label}</b>
              <small>{o.amount} · 到期 {o.dueAt}</small>
              {typeof o.unsettledAmount === "number" && <small>未结清 {o.unsettledAmount.toLocaleString("zh-CN")} {o.currency}</small>}
              <em className="state-pill">{o.status}</em>
            </button>
          ))}
          <div className="wb-subgraph">
            <p className="eyebrow">本 action 子图（默认不全图展开）</p>
            <ul>
              <li><span className="tag">Action</span>recordPayment（financeOperator）</li>
              <li><span className="tag">{trace?.targetType ?? "PaymentSchedule"}</span>{shortId(trace?.targetId ?? obligation?.id ?? "—")}</li>
              {trace?.runId && <li><span className="tag">Run</span>{shortId(trace.runId)}</li>}
            </ul>
          </div>
          <div className="wb-run">
            <button className="wb-btn dry" disabled={busy !== null || !obligation} onClick={() => void runAction("plan")}>
              {busy === "plan" ? "演练中…" : dataMode === "mock" ? "Plan 演练（MOCK）" : "Plan 演练（零写入）"}
            </button>
            <button
              className="wb-btn commit"
              disabled={busy !== null || !executeReady}
              title={executeReady ? (dataMode === "mock" ? "MOCK 提交：不写入 PostgreSQL" : "提交到 PostgreSQL 规范事实库") : "先对当前对象完成一次 Plan 演练"}
              onClick={() => void runAction("execute")}
            >
              {busy === "execute" ? "提交中…" : dataMode === "mock" ? "Commit（MOCK · 不写入 PostgreSQL）" : "Execute 登记付款（真实写入）"}
            </button>
            <p className="wb-note">
              plan 只校验不写入；execute 才进入 PostgreSQL 规范事实库。
              当前：{dataMode === "mock" ? "MOCK 演示（committed 恒为 false）" : traceSource === "api" ? "真实 Runtime" : "真实模式 · 未执行"}。
            </p>
          </div>
          <div className="wb-reopen">
            <p className="eyebrow">按 traceId 重新打开（刷新可复现）</p>
            <div className="wb-reopen-row">
              <input value={reopenId} onChange={(e) => setReopenId(e.target.value)} placeholder="traceId（UUID）" />
              <button disabled={dataMode === "mock" || !/^[0-9a-f-]{36}$/i.test(reopenId.trim())} onClick={() => void openTrace(reopenId)}>打开</button>
            </div>
          </div>
        </aside>

        <section className="wb-mid panel">
          <div className="panel-head">
            <div>
              <span>RUNTIME TRACE · 11 STAGES</span>
              <h2>{trace ? `${trace.actionId} · ${trace.mode === "plan" ? "PLAN" : "EXECUTE"}` : "尚未执行"}</h2>
            </div>
            {trace && (
              <div className="wb-replay">
                <button onClick={() => { if (replayActive) { stopReplay(); } else { setSelectedStageIndex(0); setReplayActive(true); } }}>
                  {replayActive ? "⏸ 暂停回放" : "▶ 回放"}
                </button>
                <small>已进行到第 {Math.min(selectedStageIndex + 1, allStages.length)} / {allStages.length} 步</small>
              </div>
            )}
          </div>
          {trace && (
            <div className={`wb-trace-meta ${TRACE_STATUS_CLASS[trace.status]}`}>
              <span className="ts-pill">{TRACE_STATUS_LABEL[trace.status]}</span>
              <span>traceId {shortId(trace.traceId)}</span>
              <span>corr {shortId(trace.correlationId)}</span>
              {trace.runId && <span>run {shortId(trace.runId)}</span>}
              <span>{trace.durationMs}ms</span>
              {traceSource === "mock" && <span className="mock-flag">MOCK · committed=false</span>}
            </div>
          )}
          {!trace && <p className="empty">在左侧选择付款计划并执行 Plan 演练，查看 Runtime 各阶段 trace。</p>}
          <ol className="wb-timeline">
            {allStages.map((stage, i) => {
              const revealed = i <= selectedStageIndex;
              return (
                <li key={stage.id} className={`${STATUS_CLASS[revealed ? stage.status : "pending"]} ${i === selectedStageIndex ? "current" : ""} ${stage.known ? "" : "unknown"}`}>
                  <button onClick={() => { stopReplay(); setSelectedStageIndex(i); }}>
                    <i className="wb-dot" aria-hidden />
                    <span className="wb-stage-label">{stage.label}</span>
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
              {typeof selectedStage.durationMs === "number" && <p><b>耗时</b>{selectedStage.durationMs} ms</p>}
              {selectedStage.error && <p className="stage-error"><b>失败原因</b>{selectedStage.error.code} · {selectedStage.error.message}</p>}
              {selectedStage.attributes && Object.keys(selectedStage.attributes).length > 0 && (
                <pre className="stage-attrs">{JSON.stringify(selectedStage.attributes, null, 2)}</pre>
              )}
            </div>
          )}
        </section>

        <section className="wb-right panel">
          <div className="panel-head"><div><span>RESULTS &amp; EXPLAIN</span><h2>结果面板</h2></div></div>
          <div className="wb-tabs" role="tablist">
            {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>)}
          </div>
          <div className="wb-tab-body">
            {!trace && <p className="empty">执行 Plan 后这里展示 YAML 引用、IR、policy 解释、写集与审计。每个结果都附「为什么 / 如何产生」。</p>}
            {trace && tab === "yaml" && (
              <CodeBlock
                title="Action 契约引用（YAML authoring → 编译产物）"
                why="为什么：YAML 是业务语义的可评审源码，Runtime 只消费编译后的 Canonical IR。"
                how="如何产生：ontology/daka.v0.1.yaml → validate/compile → manifest（含指纹）。"
                code={[
                  `# ontology/daka.v0.1.yaml`,
                  `action_types:`,
                  `  ${trace.actionId}:`,
                  `    target: ${trace.targetType}`,
                  `    actor_roles: [financeOperator]`,
                  `    preconditions: [amount > 0, currency == target.currency, status not in (paid, waived)]`,
                  ``,
                  `# 本次调用`,
                  `mode: ${trace.mode}   # plan = 零写入演练`,
                  `targetId: ${trace.targetId}`,
                  `actor: ${trace.actorId}`,
                ].join("\n")}
              />
            )}
            {trace && tab === "ir" && (
              <CodeBlock
                title="Canonical IR（编译产物）"
                why="为什么：Runtime 不读 YAML，只信编译后的 IR 与指纹。"
                how="如何产生：DSL 编译器输出；execute 前 assertSupported 校验 schema 版本。"
                code={JSON.stringify({
                  ontologyVersion: meta?.version ?? "(重新打开的 trace 未加载 meta)",
                  fingerprint: meta?.fingerprint ?? "—",
                  traceSchemaVersion: 1,
                  resolved: stageAttr("ontology.resolved"),
                }, null, 2)}
              />
            )}
            {trace && tab === "explain" && (
              <div className="wb-text-result">
                <ExplainRow title="Policy Explain" why="为什么：需要回答“为什么这个人可以/不可以执行”。" how="如何产生：policy 阶段编译 policy 模型的判定结果。" text={explainText("policy", stageAttr("policy"), trace)} />
                <ExplainRow title="Rule Explain" why="为什么：派生状态由规则推导而非手填。" how="如何产生：rules 阶段如实标注规则物化安排。" text={explainText("rules", stageAttr("rules"), trace)} />
              </div>
            )}
            {trace && tab === "diff" && (
              <>
                <div className="wb-factdiff">
                  <b>写集（writeset.planned · 事务内实际写操作）</b>
                  <WriteSet attrs={stageAttr("writeset.planned")} committed={trace.committed} source={traceSource} />
                  <p><span className="tag">facts.loaded</span>target version = {String(stageAttr("facts.loaded").version ?? "—")}{stageAttr("facts.loaded").replay ? " · 幂等重放" : ""}</p>
                  <p><span className="tag">transaction</span>{String(stageAttr("transaction").note ?? stageAttr("transaction").releaseId ?? (trace.committed ? "已提交" : "只读/未提交"))}</p>
                </div>
              </>
            )}
            {trace && tab === "projection" && (
              <CodeBlock
                title="Projection（paymentCalendar / bossActionInbox）"
                why="为什么：页面读投影，需要知道投影如何变化。"
                how="如何产生：投影为请求时纯推导；execute 提交后左栏已重新查询。"
                code={JSON.stringify({ projection: stageAttr("projection"), 当前选中计划: obligation ? { id: obligation.id, status: obligation.status, settled: obligation.settledAmount, unsettled: obligation.unsettledAmount } : null }, null, 2)}
              />
            )}
            {trace && tab === "audit" && (
              <div className="wb-audit">
                <b>Audit / Outbox（同事务提交；plan 与拒绝链为零业务写入）</b>
                <p><span className="tag">audit_events</span>{String(stageAttr("audit.outbox").auditEvents ?? 0)} 条</p>
                <p><span className="tag">outbox_events</span>{String(stageAttr("audit.outbox").outboxEvents ?? 0)} 条</p>
                <p><span className="tag">correlationId</span>{trace.correlationId}</p>
                <p><span className="tag">traceId</span>{trace.traceId}</p>
                <small>可用 GET /v1/audit 与 GET /v1/traces/{trace.traceId} 复核；刷新本页后通过左侧「按 traceId 重新打开」恢复本 trace。</small>
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

function WriteSet({ attrs, committed, source }: { attrs: Record<string, unknown>; committed: boolean; source: "api" | "mock" | null }) {
  const writes = Array.isArray(attrs.writes) ? (attrs.writes as Array<{ op: string; table: string; count: number }>) : [];
  if (writes.length === 0) {
    return <p>{committed ? "—" : "空写集（plan / 拒绝 / 失败链均为零业务写入）"}{source === "mock" ? " · MOCK 无真实写集" : ""}</p>;
  }
  return (
    <>
      {writes.map((w, i) => <p key={i}><span className={`tag ${w.op}`}>{w.op}</span>{w.table} × {w.count}</p>)}
    </>
  );
}

function explainText(stage: string, attrs: Record<string, unknown>, trace: TraceDoc): string {
  const stageInfo = trace.stages.find((s) => s.id === stage);
  if (!stageInfo || stageInfo.status === "pending") return "本阶段未到达（前序阶段失败或为 plan 链）。";
  if (stageInfo.status === "skipped") return `已跳过：${String(attrs.reason ?? "—")}`;
  if (stageInfo.status === "failed") return `失败：${stageInfo.error?.code ?? ""} ${stageInfo.error?.message ?? ""}`;
  if (stage === "policy") return `允许执行。命中 policy：${String(attrs.policyId ?? "（默认角色策略）")}；actor 角色与 action.actorRoles 匹配。`;
  if (stage === "rules") return String(attrs.reason ?? "规则物化由 /v1/rules/run 独立执行（受限 AST，非 eval）。");
  return JSON.stringify(attrs);
}

function shortId(id: string): string {
  return id.length > 24 ? `${id.slice(0, 24)}…` : id;
}

function statusText(status: UiStage["status"]): string {
  return status === "done" ? "✓ 完成" : status === "failed" ? "✕ 失败" : status === "skipped" ? "跳过" : "未到达";
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
