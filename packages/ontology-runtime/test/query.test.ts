import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  QUERY_STAGES,
  composeAnswer,
  labelFor,
  localRoute,
  loadGraph,
  runQuery,
  makeContext,
  type QueryTrace,
} from "../src/index";

/**
 * 查询管线测试：
 * - 纯函数（无 DB）：localRoute 意图/时间/实体解析、composeAnswer 不编造数字、labelFor。
 * - 真库（有 DATABASE_URL_RUNTIME 时）：runQuery 产出 8 阶段、触及对象/关系非空、SQL 为 SELECT。
 */

const TENANT = "d0000000-0000-4000-8000-000000000001";
const WS = "d0000000-0000-4000-8000-000000000002";
const ctx = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "test", roles: ["dataSteward"] });

describe("localRoute（意图/时间/实体 → 白名单工具）", () => {
  it("过去N年 + 应付 → payments，解析时间范围", () => {
    const r = localRoute("过去三年我应付了哪些账单？");
    expect(r.intent).toBe("payments");
    expect(r.params.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.params.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.evidence.intent).toContain("应付");
    expect(r.evidence.time.length).toBeGreaterThan(0);
  });

  it("逾期 → payments + status=overdue", () => {
    const r = localRoute("今年有哪些逾期的款？");
    expect(r.intent).toBe("payments");
    expect(r.params.status).toBe("overdue");
    expect(r.params.from).toMatch(/^2026-01-01$/);
  });

  it("权利 → rights + 合同编号实体", () => {
    const r = localRoute("DEMO-2026-001 这份合同给了我们哪些权利？");
    expect(r.intent).toBe("rights");
    expect(r.params.contract).toBe("DEMO-2026-001");
    expect(r.evidence.entity).toContain("DEMO-2026-001");
  });

  it("甲乙方 → contracts", () => {
    const r = localRoute("我们跟哪些版权方签了合同？");
    expect(r.intent).toBe("contracts");
  });

  it("账单尾号 + 来龙去脉 → chain", () => {
    const r = localRoute("账单 0102 的来龙去脉");
    expect(r.intent).toBe("chain");
    expect(r.params.schedule).toBe("0102");
  });
});

describe("composeAnswer（模板答案，不编造数字）", () => {
  it("payments：合计与明细数字来自 rows", () => {
    const rows = [
      { id: "aaa", data: { amount: "500000", currency: "CNY", dueAt: "2026-03-01T00:00:00Z", status: "paid" }, settled: "500000" },
      { id: "bbb", data: { amount: "300000", currency: "CNY", dueAt: "2026-06-01T00:00:00Z", status: "planned" }, settled: "0" },
    ];
    const a = composeAnswer("payments", {}, rows);
    expect(a).toContain("2 笔");
    expect(a).toContain("800,000");
    expect(a).toContain("500,000");
    expect(a).toContain("账单 aaa");
  });

  it("contracts：主体角色映射", () => {
    const rows = [{ id: "c1", data: { contractNumber: "X-1", title: "T", status: "active" }, parties: [{ name: "甲方公司", role: "licensor" }], schedules: 1, rights: 2 }];
    const a = composeAnswer("contracts", {}, rows);
    expect(a).toContain("甲方（授权方）：甲方公司");
  });
});

describe("labelFor", () => {
  it("合同显示编号+标题；账单显示金额；IP 显示规范名", () => {
    expect(labelFor("Contract", { contractNumber: "DEMO-1", title: "合同T" })).toContain("DEMO-1");
    expect(labelFor("PaymentSchedule", { amount: "500000", currency: "CNY", dueAt: "2026-03-01T00:00:00Z" })).toContain("账单");
    expect(labelFor("FootballClub", { canonicalName: "AC 米兰" })).toBe("AC 米兰");
  });
});

// 真库测试：无 DATABASE_URL_RUNTIME 时跳过（不冒充完成）
const DB_URL = process.env.DATABASE_URL_RUNTIME ?? process.env.DATABASE_URL_TEST;
const hasDb = Boolean(DB_URL);
describe.skipIf(!hasDb)("runQuery（真实 PostgreSQL + RLS）", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: DB_URL }); });
  afterAll(async () => { await pool.end(); });

  async function ask(question: string): Promise<QueryTrace> {
    return runQuery(pool, ctx, question);
  }

  it("产出完整 8 阶段，query.execute 为 SELECT，触及对象/关系非空", async () => {
    const t = await ask("过去三年我应付了哪些账单？");
    expect(t.spans.map((s) => s.stage)).toEqual([...QUERY_STAGES]);
    expect(t.intent).toBe("payments");
    const exec = t.spans.find((s) => s.stage === "query.execute")!;
    expect(exec.status).toBe("ok");
    expect(t.sql.trim().toLowerCase()).toMatch(/^select/);
    expect(t.touchedObjects.length).toBeGreaterThan(0);
    expect(t.answer.length).toBeGreaterThan(0);
    expect(t.dataSourceNote).toContain("演示推演");
  });

  it("rights 查询触及合同与权利对象", async () => {
    const t = await ask("DEMO-2026-001 给了哪些权利？");
    expect(t.intent).toBe("rights");
    expect(t.touchedObjects.some((o) => o.type === "RightsGrant")).toBe(true);
  });

  it("loadGraph 返回全图（对象 + 关系）", async () => {
    const g = await loadGraph(pool, ctx);
    expect(g.objects.length).toBeGreaterThan(0);
    expect(g.links.length).toBeGreaterThan(0);
    expect(g.objects[0]).toHaveProperty("label");
    expect(g.links[0]).toHaveProperty("linkType");
  });
});
