/**
 * Workbench 契约测试：
 *  1) 前端阶段列表与 Runtime TRACE_STAGES 完全一致（stage 命名差异在这里被捕获）；
 *  2) execute 请求发送 mode: plan|execute（绝不发送 dryRun）；traceId 只读内嵌 trace.traceId；
 *  3) 失败响应（403/422）携带内嵌 trace 时如实返回，无 trace 时抛错（禁止静默 MOCK）；
 *  4) mapRuntimeTrace：spans → UI 阶段的确定性映射，未知 stage 兼容展示不丢失；
 *  5) MOCK：committed 恒为 false，产出物不含“已写入 PostgreSQL”表述。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACE_STAGES } from "@daka/ontology-runtime";
import { RUNTIME_TRACE_STAGES, type ExecutionTrace, type TraceSpan } from "@daka/ontology-client";
import {
  MOCK_OBLIGATIONS,
  WorkbenchApiError,
  buildMockTrace,
  executeWithTrace,
  mapRuntimeTrace,
} from "./trace-adapter";
import { WORKBENCH_STAGES } from "./trace-types";
import { PaymentWorkbench } from "./payment-workbench";

const HEADERS = { actorId: "demo-finance", roles: ["financeOperator"] };

function span(stage: string, status: TraceSpan["status"] = "ok", extra: Partial<TraceSpan> = {}): TraceSpan {
  return { stage, status, startedAt: "2026-09-03T00:00:00Z", durationMs: 1, attributes: {}, ...extra };
}

function cannedTrace(over: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    schemaVersion: 1,
    traceId: "11111111-1111-4111-8111-111111111111",
    correlationId: "corr-1",
    runId: "run-1",
    actionId: "recordPayment",
    targetType: "PaymentSchedule",
    targetId: "d0000000-0000-4000-8000-000000000102",
    tenantId: "t",
    workspaceId: "w",
    actorId: "demo-finance",
    mode: "execute",
    status: "completed",
    committed: true,
    error: null,
    durationMs: 12,
    createdAt: "2026-09-03T00:00:00Z",
    spans: [
      span("action.received"),
      span("ontology.resolved"),
      span("policy", "ok", { attributes: { policyId: "p-1" } }),
      span("validation"),
      span("facts.loaded", "ok", { attributes: { version: 3 } }),
      span("preconditions"),
      span("transaction"),
      span("writeset.planned", "ok", { attributes: { writes: [{ op: "insert", table: "object_records", count: 1 }] } }),
      span("rules", "skipped", { attributes: { reason: "独立执行" } }),
      span("projection", "skipped"),
      span("audit.outbox", "ok", { attributes: { auditEvents: 1, outboxEvents: 1 } }),
    ],
    ...over,
  };
}

describe("stage 契约：前端阶段 ⇔ Runtime TRACE_STAGES", () => {
  it("client 镜像的 stage 列表与 runtime 完全一致（顺序敏感）", () => {
    expect([...RUNTIME_TRACE_STAGES]).toEqual([...TRACE_STAGES]);
  });

  it("WORKBENCH_STAGES 的 id 顺序与 runtime 一致，且都有 why/how/label", () => {
    expect(WORKBENCH_STAGES.map((s) => s.id)).toEqual([...TRACE_STAGES]);
    for (const s of WORKBENCH_STAGES) {
      expect(s.label).toMatch(/^\d+ · /);
      expect(s.why.length).toBeGreaterThan(0);
      expect(s.how.length).toBeGreaterThan(0);
    }
  });
});

describe("mapRuntimeTrace", () => {
  it("成功链：11 阶段按规范序映射，状态/属性保留", () => {
    const doc = mapRuntimeTrace(cannedTrace());
    expect(doc.stages).toHaveLength(TRACE_STAGES.length);
    expect(doc.stages.map((s) => s.id)).toEqual([...TRACE_STAGES]);
    expect(doc.stages.find((s) => s.id === "policy")?.status).toBe("done");
    expect(doc.stages.find((s) => s.id === "rules")?.status).toBe("skipped");
    expect(doc.stages.find((s) => s.id === "writeset.planned")?.attributes?.writes).toHaveLength(1);
    expect(doc.mode).toBe("execute");
    expect(doc.committed).toBe(true);
  });

  it("权限拒绝链：policy 之后未到达的阶段为 pending（绝不伪成功）", () => {
    const denied = cannedTrace({
      status: "denied",
      committed: false,
      runId: null,
      error: { code: "ONTO-403-POLICY-DENY", message: "deny" },
      spans: [span("action.received"), span("ontology.resolved"), span("policy", "failed", { error: { code: "ONTO-403-POLICY-DENY", message: "deny" } })],
    });
    const doc = mapRuntimeTrace(denied);
    expect(doc.status).toBe("denied");
    expect(doc.committed).toBe(false);
    expect(doc.stages.find((s) => s.id === "policy")?.status).toBe("failed");
    expect(doc.stages.find((s) => s.id === "validation")?.status).toBe("pending");
    expect(doc.stages.find((s) => s.id === "audit.outbox")?.status).toBe("pending");
  });

  it("未知 stage 进入 extraStages 兼容展示，不丢失", () => {
    const doc = mapRuntimeTrace(cannedTrace({ spans: [...cannedTrace().spans, span("future.newStage")] }));
    expect(doc.extraStages).toHaveLength(1);
    expect(doc.extraStages[0].id).toBe("future.newStage");
    expect(doc.extraStages[0].known).toBe(false);
    expect(doc.stages).toHaveLength(TRACE_STAGES.length);
  });
});

describe("executeWithTrace 契约（stub fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    });
    return calls;
  }

  it("请求体使用 mode: plan，绝不发送 dryRun", async () => {
    const calls = stubFetch(() => Response.json({ runId: null, status: "planned", result: { planned: true }, trace: cannedTrace({ mode: "plan", status: "planned", committed: false, runId: null }) }));
    const out = await executeWithTrace("", HEADERS, "recordPayment", { targetId: "t1", input: { amount: "1" }, idempotencyKey: "k1", mode: "plan" });
    expect(out.httpStatus).toBe(200);
    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(sent.mode).toBe("plan");
    expect("dryRun" in sent).toBe(false);
    expect(calls[0].url).toBe("/v1/actions/recordPayment/execute");
  });

  it("traceId 只从内嵌 trace.traceId 读取（顶层 traceId/runId 不是定位符）", async () => {
    stubFetch(() => Response.json({ traceId: "WRONG-TOP-LEVEL", runId: "WRONG-RUN", status: "completed", result: {}, trace: cannedTrace() }));
    const out = await executeWithTrace("", HEADERS, "recordPayment", { targetId: "t1", input: {}, idempotencyKey: "k2", mode: "execute" });
    expect(out.trace.traceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(out.apiError).toBeNull();
  });

  it("403 拒绝响应携带内嵌 trace：如实返回 apiError + trace，不抛错、不降级 MOCK", async () => {
    const deniedTrace = cannedTrace({ status: "denied", committed: false, runId: null, error: { code: "ONTO-403-POLICY-DENY", message: "deny" } });
    stubFetch(() => Response.json({ error: { code: "ONTO-403-POLICY-DENY", message: "deny" }, trace: deniedTrace }, { status: 403 }));
    const out = await executeWithTrace("", HEADERS, "recordPayment", { targetId: "t1", input: {}, idempotencyKey: "k3", mode: "execute" });
    expect(out.httpStatus).toBe(403);
    expect(out.apiError?.code).toBe("ONTO-403-POLICY-DENY");
    expect(out.trace.status).toBe("denied");
    expect(out.trace.committed).toBe(false);
  });

  it("失败响应缺少内嵌 trace → 抛 WorkbenchApiError（契约违规，禁止静默 MOCK）", async () => {
    stubFetch(() => Response.json({ error: { code: "ONTO-500-INTERNAL", message: "boom" } }, { status: 500 }));
    await expect(executeWithTrace("", HEADERS, "recordPayment", { targetId: "t1", input: {}, idempotencyKey: "k4", mode: "execute" }))
      .rejects.toBeInstanceOf(WorkbenchApiError);
  });

  it("网络异常 → 抛 WorkbenchApiError，不伪造任何 trace", async () => {
    stubFetch(() => { throw new Error("connection refused"); });
    await expect(executeWithTrace("", HEADERS, "recordPayment", { targetId: "t1", input: {}, idempotencyKey: "k5", mode: "execute" }))
      .rejects.toThrow(/无法连接/);
  });
});

describe("MOCK（仅显式选择）", () => {
  it("committed 恒为 false，且不包含“已写入 PostgreSQL”表述", () => {
    for (const mode of ["plan", "execute"] as const) {
      const trace = buildMockTrace({ mode });
      expect(trace.committed).toBe(false);
      expect(trace.status).toBe(mode === "plan" ? "planned" : "completed");
      expect(JSON.stringify(trace)).not.toContain("已写入 PostgreSQL");
      expect(JSON.stringify(trace)).toContain("MOCK");
    }
  });

  it("plan 模式下事务及以后阶段为 skipped（与真实 Runtime 行为一致）", () => {
    const plan = buildMockTrace({ mode: "plan" });
    expect(plan.stages.find((s) => s.id === "transaction")?.status).toBe("skipped");
    expect(plan.stages.find((s) => s.id === "policy")?.status).toBe("done");
  });

  it("MOCK 义务列表带金额与到期日，且显式标注 MOCK", () => {
    expect(MOCK_OBLIGATIONS.length).toBeGreaterThan(0);
    for (const o of MOCK_OBLIGATIONS) {
      expect(o.label).toContain("MOCK");
      expect(o.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("PaymentWorkbench 渲染", () => {
  const html = renderToStaticMarkup(createElement(PaymentWorkbench));

  it("默认真实 Runtime 模式，MOCK 只能显式进入", () => {
    expect(html).toContain('data-mode="real"');
    expect(html).toContain("真实 Runtime（PostgreSQL）");
    expect(html).toContain("演示推演模式（MOCK）");
    // 默认不出现 MOCK 常驻横幅
    expect(html).not.toContain("mock-banner");
  });

  it("真实模式按钮文案诚实：plan 零写入 / execute 真实写入", () => {
    expect(html).toContain("Plan 演练（零写入）");
    expect(html).toContain("Execute 登记付款（真实写入）");
  });

  it("未 Plan 前 Execute 被禁用", () => {
    expect(html).toContain("disabled");
  });

  it("提供 traceId 重新打开入口（刷新可复现）", () => {
    expect(html).toContain("按 traceId 重新打开");
  });

  it("渲染全部 6 个结果面板 tab", () => {
    for (const label of ["YAML Source", "Canonical IR", "Policy / Rule Explain", "Fact / SQL Diff", "Projection Diff", "Audit / Outbox"]) {
      expect(html).toContain(label);
    }
  });
});
