"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadGraph, QueryWorkbenchError, runQuestion } from "./query-adapter";
import { QUERY_STAGE_DEFS, type GraphView, type QuerySpan, type QueryStage, type QueryTrace } from "./query-types";

// 演示 actor：查询工作台回答财务/经营口径（金额可见），以 financeOperator 角色走只读查询。
// 注意：/v1/query 当前走 RLS 租户隔离，但未做字段级遮罩（与 /v1/objects 的 maskRecord 对齐是后续项）。
const ACTOR = { actorId: "demo-finance", roles: ["financeOperator"] };

const EXAMPLES = [
  "过去三年我应付了哪些账单？",
  "DEMO-2026-001 给了哪些权利？",
  "我们跟哪些版权方签了合同？",
  "今年有哪些逾期的款？",
  "账单 0102 的来龙去脉",
];

const TYPE_COLOR: Record<string, string> = {
  Contract: "#d6336c",
  Party: "#7048e8",
  FootballClub: "#16805e",
  TVSeries: "#16805e",
  Talent: "#16805e",
  RightsGrant: "#0b7285",
  PaymentSchedule: "#e8590c",
  Payment: "#2f9e44",
  ReleaseProject: "#1971c2",
  SKU: "#a61e4d",
  SignatureEntitlement: "#9c36b5",
  SignatureLot: "#9c36b5",
  SignatureMovement: "#9c36b5",
  MarketObservation: "#e67700",
  ReleaseRecommendation: "#c92a2a",
};
const FALLBACK_COLOR = "#868e96";

function colorFor(type: string): string {
  return TYPE_COLOR[type] ?? FALLBACK_COLOR;
}

function shortLabel(label: string): string {
  return label.length > 16 ? `${label.slice(0, 16)}…` : label;
}

/** 简易力导向布局（节点 ~30、边 ~25，若干轮迭代即可稳定）。 */
function layoutGraph(nodes: GraphView["objects"], edges: GraphView["links"], w: number, h: number): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const N = nodes.length;
  const k = Math.sqrt((w * h) / Math.max(1, N)) * 0.55;
  nodes.forEach((n, i) => {
    const ang = (i / Math.max(1, N)) * Math.PI * 2;
    const r = Math.min(w, h) * 0.38;
    pos.set(n.id, { x: w / 2 + Math.cos(ang) * r, y: h / 2 + Math.sin(ang) * r });
  });
  for (let iter = 0; iter < 70; iter++) {
    for (let i = 0; i < N; i++) {
      const a = nodes[i]; const pa = pos.get(a.id)!;
      for (let j = i + 1; j < N; j++) {
        const pb = pos.get(nodes[j].id)!;
        let dx = pa.x - pb.x, dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = (k * k) / d2;
        pa.x += (dx / d) * f; pa.y += (dy / d) * f; pb.x -= (dx / d) * f; pb.y -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - k) * 0.02;
      a.x += (dx / d) * f; a.y += (dy / d) * f; b.x -= (dx / d) * f; b.y -= (dy / d) * f;
    }
    for (const p of pos.values()) {
      p.x += (w / 2 - p.x) * 0.01; p.y += (h / 2 - p.y) * 0.01;
      p.x = Math.max(24, Math.min(w - 24, p.x)); p.y = Math.max(24, Math.min(h - 24, p.y));
    }
  }
  return pos;
}

function SpanDot({ status }: { status: QuerySpan["status"] | "pending" }) {
  return <i className={`qw-dot qw-${status}`} aria-hidden />;
}

export function QueryWorkbench() {
  const [question, setQuestion] = useState("");
  const [graph, setGraph] = useState<GraphView | null>(null);
  const [graphError, setGraphError] = useState("");
  const [trace, setTrace] = useState<QueryTrace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedStage, setSelectedStage] = useState<QueryStage>("intent.parse");
  const [tab, setTab] = useState<"answer" | "evidence">("answer");

  useEffect(() => {
    loadGraph("", ACTOR)
      .then(setGraph)
      .catch((e) => setGraphError(e instanceof QueryWorkbenchError ? e.message : String(e)));
  }, []);

  const touchedIds = useMemo(() => new Set((trace?.touchedObjects ?? []).map((o) => o.id)), [trace]);
  const touchedLinkKeys = useMemo(() => new Set((trace?.touchedLinks ?? []).map((l) => `${l.from}|${l.to}`)), [trace]);
  const spanByStage = useMemo(() => new Map((trace?.spans ?? []).map((s) => [s.stage, s])), [trace]);
  const layout = useMemo(() => (graph ? layoutGraph(graph.objects, graph.links, 560, 440) : new Map<string, { x: number; y: number }>()), [graph]);

  const run = useCallback(async () => {
    if (!question.trim()) return;
    setBusy(true);
    setError("");
    try {
      const t = await runQuestion("", ACTOR, question.trim());
      setTrace(t);
      setSelectedStage(t.spans.find((s) => s.status === "failed")?.stage ?? "intent.parse");
    } catch (e) {
      setError(e instanceof QueryWorkbenchError ? e.message : `查询失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [question]);

  const selectedDef = QUERY_STAGE_DEFS.find((d) => d.id === selectedStage)!;
  const selectedSpan = spanByStage.get(selectedStage);
  const okCount = trace ? trace.spans.filter((s) => s.status === "ok").length : 0;

  return (
    <section className="qw-root" data-testid="query-workbench">
      <header className="qw-head">
        <div>
          <p className="eyebrow">ONTOLOGY QUERY · OBSERVABLE</p>
          <h1>自然语言查询 · 本体图 × 查询管线 trace</h1>
          <p className="sub">问一句中文，看它如何被解析成受约束的只读查询，触及了哪些对象，答案与证据来自哪里。</p>
        </div>
      </header>

      <div className="qw-askbar">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy) void run(); }}
          placeholder="例如：过去三年我应付了哪些账单？每笔关联哪份合同，甲方乙方都是谁？"
          maxLength={500}
        />
        <button className="qw-run" disabled={busy || !question.trim()} onClick={() => void run()}>
          {busy ? "查询中…" : "运行查询"}
        </button>
      </div>
      <div className="qw-examples">
        {EXAMPLES.map((ex) => (
          <button key={ex} onClick={() => setQuestion(ex)} disabled={busy}>{ex}</button>
        ))}
      </div>

      {error && <div className="qw-error">查询失败：{error}</div>}
      {graphError && <div className="qw-error">本体图加载失败：{graphError}</div>}

      <div className="qw-layout">
        <aside className="qw-left panel">
          <div className="panel-head"><div><span>ONTOLOGY GRAPH</span><h2>对象与关系（高亮本次触及）</h2></div><small className="qw-legend"><i className="lg-touch" />触及</small></div>
          {graph && graph.objects.length > 0 ? (
            <svg className="qw-graph" viewBox="0 0 560 440" role="img" aria-label="本体对象与关系图">
              {graph.links.map((e, i) => {
                const a = layout.get(e.from), b = layout.get(e.to);
                if (!a || !b) return null;
                const touched = touchedLinkKeys.has(`${e.from}|${e.to}`);
                return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={touched ? "qw-edge touched" : "qw-edge"} />;
              })}
              {graph.objects.map((n) => {
                const p = layout.get(n.id);
                if (!p) return null;
                const touched = touchedIds.has(n.id);
                return (
                  <g key={n.id} className={touched ? "qw-node touched" : "qw-node"} transform={`translate(${p.x},${p.y})`}>
                    <circle r={touched ? 9 : 6} fill={colorFor(n.type)} />
                    <text y={16} textAnchor="middle">{shortLabel(n.label)}</text>
                    <text y={28} className="qw-node-type" textAnchor="middle">{n.type}</text>
                  </g>
                );
              })}
            </svg>
          ) : (
            <p className="empty">{graphError ? "图不可用" : "加载图中…"}</p>
          )}
        </aside>

        <section className="qw-mid panel">
          <div className="panel-head">
            <div><span>QUERY PIPELINE · 8 STAGES</span><h2>{trace ? `${trace.intent} · ${trace.durationMs}ms` : "尚未查询"}</h2></div>
            {trace && <small className="qw-okcount">{okCount}/{trace.spans.length} 通过</small>}
          </div>
          {!trace && <p className="empty">输入问题并运行，这里展示查询管线的每一步真实计算。</p>}
          <ol className="qw-timeline">
            {QUERY_STAGE_DEFS.map((d) => {
              const span = spanByStage.get(d.id);
              return (
                <li key={d.id} className={selectedStage === d.id ? "current" : ""}>
                  <button onClick={() => setSelectedStage(d.id)}>
                    <SpanDot status={span?.status ?? "pending"} />
                    <span className="qw-stage-label">{d.label}</span>
                    <span className="qw-stage-status">{span ? statusText(span.status) : "未执行"}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="qw-stage-explain">
            <p><b>为什么需要这一步？</b>{selectedDef.why}</p>
            <p><b>这一步如何产生结果？</b>{selectedDef.how}</p>
            {selectedSpan?.status === "failed" && <p className="qw-stage-error"><b>失败</b>{selectedSpan.error?.code} · {selectedSpan.error?.message}</p>}
            {selectedSpan?.status === "skipped" && <p><b>跳过原因</b>{String(selectedSpan.attributes.reason ?? "—")}</p>}
            {selectedSpan && Object.keys(selectedSpan.attributes).length > 0 && (
              <pre className="qw-attrs">{JSON.stringify(selectedSpan.attributes, null, 2)}</pre>
            )}
          </div>
        </section>

        <section className="qw-right panel">
          <div className="panel-head"><div><span>ANSWER &amp; EVIDENCE</span><h2>结果与证据</h2></div></div>
          <div className="qw-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "answer"} className={tab === "answer" ? "active" : ""} onClick={() => setTab("answer")}>答案</button>
            <button role="tab" aria-selected={tab === "evidence"} className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}>证据 / 口径 / 路径</button>
          </div>
          {!trace && <p className="empty">运行查询后，这里展示自然语言答案与完整证据（SQL、参数、口径、触及对象）。</p>}
          {trace && tab === "answer" && <pre className="qw-answer">{trace.answer}</pre>}
          {trace && tab === "evidence" && (
            <div className="qw-evidence">
              <Row k="意图" v={trace.intent} />
              <Row k="参数" v={JSON.stringify(trace.params)} />
              <Row k="数据来源" v={trace.dataSourceNote} />
              <Row k="触及对象" v={`${trace.touchedObjects.length} 个：${trace.touchedObjects.map((o) => `${o.type}·${shortLabel(o.label)}`).join("；")}`} />
              <Row k="触及关系" v={`${trace.touchedLinks.length} 条：${trace.touchedLinks.map((l) => l.linkType).join("、")}`} />
              <Row k="答案生成" v={trace.answerGenerated ? "GLM 组合" : "确定性模板（未编造数字）"} />
              <div className="qw-sql">
                <b>实际执行的 SQL（只读）</b>
                <pre><code>{trace.sql}</code></pre>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <p className="qw-row"><span className="tag">{k}</span>{v}</p>;
}

function statusText(status: QuerySpan["status"]): string {
  return status === "ok" ? "✓" : status === "failed" ? "✕" : "·";
}
