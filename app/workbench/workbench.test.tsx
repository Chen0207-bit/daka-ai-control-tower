/** UI workbench 测试：trace adapter 契约 + 组件静态渲染冒烟（node 环境，无 DOM 依赖）。 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MOCK_OBLIGATIONS, buildMockTrace } from "./trace-adapter";
import { TRACE_STAGE_IDS, TRACE_STAGE_LABELS } from "./trace-types";
import { PaymentWorkbench } from "./payment-workbench";

describe("buildMockTrace", () => {
  it("生成 11 阶段且每阶段都有 why/how 解释", () => {
    const trace = buildMockTrace();
    expect(trace.stages).toHaveLength(TRACE_STAGE_IDS.length);
    expect(trace.stages.map((s) => s.id)).toEqual([...TRACE_STAGE_IDS]);
    for (const stage of trace.stages) {
      expect(stage.why.length).toBeGreaterThan(0);
      expect(stage.how.length).toBeGreaterThan(0);
      expect(TRACE_STAGE_LABELS[stage.id]).toMatch(/^\d+ · /);
    }
  });

  it("dry-run 与 commit 在 SQL diff / outbox 上可区分", () => {
    const dry = buildMockTrace({ mode: "dryRun" });
    const committed = buildMockTrace({ mode: "commit" });
    expect(dry.mode).toBe("dryRun");
    expect(dry.sqlDiff).toContain("DRY RUN");
    expect(committed.sqlDiff).toContain("COMMITTED");
    expect(dry.outbox?.[0].status).toContain("dry-run");
    expect(committed.outbox?.[0].status).toBe("dispatched");
  });

  it("确定性：同 seed 同参数产生相同 traceId", () => {
    expect(buildMockTrace({ seed: 7 }).traceId).toBe(buildMockTrace({ seed: 7 }).traceId);
  });

  it("子图只包含当前 action 相关节点（不全图展开）", () => {
    const trace = buildMockTrace({ targetId: "pay-obl-X" });
    expect(trace.subgraph.nodes.length).toBeLessThanOrEqual(6);
    const nodeIds = new Set(trace.subgraph.nodes.map((n) => n.id));
    for (const edge of trace.subgraph.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
    }
  });
});

describe("MOCK_OBLIGATIONS", () => {
  it("演示付款义务带金额与到期日", () => {
    expect(MOCK_OBLIGATIONS.length).toBeGreaterThan(0);
    for (const o of MOCK_OBLIGATIONS) {
      expect(o.amount).toMatch(/¥/);
      expect(o.dueAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("PaymentWorkbench 渲染", () => {
  const html = renderToStaticMarkup(createElement(PaymentWorkbench));

  it("初始态渲染三栏布局与 dry-run / commit 按钮", () => {
    expect(html).toContain("payment-workbench");
    expect(html).toContain("Dry-run 登记付款");
    expect(html).toContain("Commit 登记付款");
  });

  it("明确标注 DEMO 演示属性", () => {
    expect(html).toContain("DEMO");
    expect(html).toContain("演示推演");
  });

  it("未执行时 commit 被禁用（须先 dry-run）", () => {
    expect(html).toMatch(/Commit 登记付款[\s\S]{0,200}/);
    // 无 trace 时 trace?.mode !== "dryRun" → disabled
    expect(html).toContain("disabled");
  });

  it("渲染全部 6 个结果面板 tab", () => {
    for (const label of ["YAML Source", "Canonical IR", "Policy / Rule Explain", "Fact / SQL Diff", "Projection Diff", "Audit / Outbox"]) {
      expect(html).toContain(label);
    }
  });
});
