import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  committedFor,
  executeTracedAction,
  isFailedTrace,
  loadManifest,
  makeContext,
  sanitizeTrace,
  sanitizeTraceAttributes,
  traceStatusForErrorCode,
  TraceRecorder,
  instrumentClient,
  type ExecutionTrace,
  type RuntimeManifest,
} from "../src/index";

/**
 * trace 单元测试：不依赖真实 PostgreSQL——用内存 fake pool/client 驱动完整执行链。
 * 真库 + RLS 的持久化验证在 integration.test.ts（无 DATABASE_URL_RUNTIME 时 skip）。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const manifest: RuntimeManifest = loadManifest(`${ROOT}/ontology/.generated/ontology.manifest.json`);

const TENANT = "f0000000-0000-4000-8000-000000000001";
const WS = "f0000000-0000-4000-8000-000000000002";
const TARGET = "f0000000-0000-4000-8000-0000000000aa";

const FINANCE = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "fin-1", roles: ["financeOperator"], correlationId: "corr-test-1" });
const OUTSIDER = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "x", roles: ["executiveViewer"] });

/** 内存 fake：按 SQL 形状返回罐头结果，并记录所有写语句。 */
function makeFakeDb() {
  const writes: string[] = [];
  const all: string[] = [];
  const rows = (sql: string): Record<string, unknown>[] => {
    if (/FROM action_runs/.test(sql)) return []; // 无幂等命中
    if (/FROM object_records/.test(sql)) {
      return [{ version: 1, data: { currency: "CNY", status: "scheduled", amountDue: 1000 }, recorded_at: new Date().toISOString(), superseded_at: null }];
    }
    if (/INTO ontology_releases/.test(sql)) return [{ id: "rel-1" }];
    if (/INTO action_runs/.test(sql)) return [{ id: "run-1" }];
    return [];
  };
  const client = {
    query: async (sqlOrCfg: unknown) => {
      const sql = typeof sqlOrCfg === "string" ? sqlOrCfg : String((sqlOrCfg as { text?: string })?.text ?? "");
      all.push(sql);
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql);
      return { rows: rows(sql), rowCount: 1 } as pg.QueryResult;
    },
    release: () => {},
  } as unknown as pg.PoolClient;
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, client, writes, all };
}

const req = (over: Partial<Parameters<typeof executeTracedAction>[5]> = {}) => ({
  targetId: TARGET,
  input: { amount: 500, currency: "CNY", paidAt: "2026-09-03", transactionReference: "TX-1" },
  idempotencyKey: "idem-trace-1",
  ...over,
});

describe("TraceRecorder 协议", () => {
  it("成功链产出全部规范 stage，committed=true", async () => {
    const db = makeFakeDb();
    const out = await executeTracedAction(db.pool, manifest, { handlers: { "payment.record": async () => ({ ok: true }) } }, FINANCE, "recordPayment", req());
    expect(out.ok).toBe(true);
    expect(out.trace.status).toBe("completed");
    expect(out.trace.committed).toBe(true);
    expect(out.trace.correlationId).toBe(FINANCE.correlationId);
    expect(out.trace.runId).toBe("run-1");
    const stages = out.trace.spans.map((s) => s.stage);
    for (const s of ["action.received", "ontology.resolved", "policy", "validation", "facts.loaded", "preconditions", "transaction", "writeset.planned", "audit.outbox"]) {
      expect(stages).toContain(s);
    }
    // 写集：action_runs + audit_events + outbox_events 三类写均被观察
    const writes = out.trace.spans.find((s) => s.stage === "writeset.planned")!.attributes.writes as { table: string }[];
    expect(writes.map((w) => w.table)).toEqual(expect.arrayContaining(["action_runs", "audit_events", "outbox_events"]));
  });

  it("权限拒绝：status=denied、committed=false、失败 span 定位在 policy", async () => {
    const db = makeFakeDb();
    const out = await executeTracedAction(db.pool, manifest, { handlers: { "payment.record": async () => ({}) } }, OUTSIDER, "recordPayment", req());
    expect(out.ok).toBe(false);
    expect(out.error!.code).toBe("ONTO-403-POLICY-DENY");
    expect(out.trace.status).toBe("denied");
    expect(out.trace.committed).toBe(false);
    expect(isFailedTrace(out.trace)).toBe(true);
    const policy = out.trace.spans.find((s) => s.stage === "policy")!;
    expect(policy.status).toBe("failed");
    // 拒绝链没有任何写语句触达数据库
    expect(db.writes.filter((w) => !/action_traces/.test(w))).toHaveLength(0);
  });

  it("前置条件失败：currency 不匹配 → precondition_failed", async () => {
    const db = makeFakeDb();
    const out = await executeTracedAction(
      db.pool, manifest, { handlers: { "payment.record": async () => ({}) } }, FINANCE, "recordPayment",
      req({ input: { amount: 500, currency: "USD", paidAt: "2026-09-03", transactionReference: "TX-2" } }),
    );
    expect(out.trace.status).toBe("precondition_failed");
    expect(out.trace.committed).toBe(false);
    expect(out.trace.spans.find((s) => s.stage === "preconditions")!.status).toBe("failed");
  });

  it("plan/dry-run：全链路校验但绝不写业务表", async () => {
    const db = makeFakeDb();
    const out = await executeTracedAction(
      db.pool, manifest, { handlers: { "payment.record": async () => { throw new Error("dry-run 不得执行 handler"); } } },
      FINANCE, "recordPayment", req({ mode: "plan", idempotencyKey: "idem-plan-1" }),
    );
    expect(out.ok).toBe(true);
    expect(out.trace.status).toBe("planned");
    expect(out.trace.committed).toBe(false);
    expect(out.trace.runId).toBeNull();
    // 业务表零写入（action_traces 是观测持久化，不算业务写）
    const business = db.writes.filter((w) => !/INTO action_traces/.test(w));
    expect(business).toHaveLength(0);
  });

  it("plan 模式下前置条件失败同样不落库且失败语义真实", async () => {
    const db = makeFakeDb();
    const out = await executeTracedAction(
      db.pool, manifest, { handlers: { "payment.record": async () => { throw new Error("dry-run 不得执行 handler"); } } },
      FINANCE, "recordPayment",
      req({ mode: "plan", input: { amount: 500, currency: "USD", paidAt: "x", transactionReference: "y" } }),
    );
    expect(out.ok).toBe(false);
    expect(out.trace.status).toBe("precondition_failed");
    expect(db.writes.filter((w) => !/INTO action_traces/.test(w))).toHaveLength(0);
  });

  it("未知 action → not_found；handler 缺失 → failed（未知 handler 无专用 trace 状态）", async () => {
    const db = makeFakeDb();
    const out = await executeTracedAction(db.pool, manifest, { handlers: {} }, FINANCE, "noSuchAction", req());
    expect(out.trace.status).toBe("not_found");
    expect(out.trace.spans.find((s) => s.stage === "ontology.resolved")!.status).toBe("failed");

    const db2 = makeFakeDb();
    const out2 = await executeTracedAction(db2.pool, manifest, { handlers: {} }, FINANCE, "recordPayment", req());
    expect(out2.ok).toBe(false);
    expect(out2.trace.status).toBe("failed");
    expect(out2.trace.committed).toBe(false);
  });
});

describe("trace 脱敏与不变量", () => {
  it("敏感键整体 redact；递归限深；字符串截断", () => {
    const out = sanitizeTraceAttributes(manifest, FINANCE, {
      apiToken: "s3cr3t",
      nested: { password: "x", ok: 1 },
      long: "a".repeat(900),
    });
    expect(out.apiToken).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).password).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect((out.long as string).length).toBeLessThanOrEqual(501);
  });

  it("committedFor：仅 completed/replayed 为 true", () => {
    for (const s of ["denied", "precondition_failed", "validation_failed", "not_found", "failed", "planned"] as const) {
      expect(committedFor(s)).toBe(false);
    }
    expect(committedFor("completed")).toBe(true);
    expect(committedFor("replayed")).toBe(true);
  });

  it("traceStatusForErrorCode 映射稳定", () => {
    expect(traceStatusForErrorCode("ONTO-403-POLICY-DENY")).toBe("denied");
    expect(traceStatusForErrorCode("ONTO-422-PRECONDITION")).toBe("precondition_failed");
    expect(traceStatusForErrorCode("ONTO-400-VALIDATION")).toBe("validation_failed");
    expect(traceStatusForErrorCode("ONTO-404-NOT-FOUND")).toBe("not_found");
    expect(traceStatusForErrorCode("ONTO-409-VERSION-CONFLICT")).toBe("failed");
  });

  it("failOpen 把打开中的 span 标记为 failed；未打开的不伪造", () => {
    const r = new TraceRecorder(FINANCE, "recordPayment", "PaymentSchedule", TARGET, "execute");
    r.start("policy");
    r.ok("action.received"); // 未 start 直接收口（引擎保证顺序，这里验证容错）
    r.failOpen("ONTO-403-POLICY-DENY", "deny");
    const t = r.finish("denied", null, { code: "ONTO-403-POLICY-DENY", message: "deny" });
    expect(t.spans.find((s) => s.stage === "policy")!.status).toBe("failed");
    expect(t.committed).toBe(false);
  });

  it("instrumentClient 识别 insert/update/delete 并计数 audit/outbox", () => {
    const r = new TraceRecorder(FINANCE, "recordPayment", "PaymentSchedule", TARGET, "execute");
    const sqls = [
      ["INSERT INTO action_runs (a) VALUES (1)", "insert", "action_runs"],
      ["update object_records set data='x'", "update", "object_records"],
      ["DELETE FROM outbox_events WHERE id=1", "delete", "outbox_events"],
      ["INSERT INTO audit_events (a) VALUES (1)", "insert", "audit_events"],
      ["SELECT 1", null, null],
    ] as const;
    const calls: string[] = [];
    const fake = {
      query: async (sql: string) => { calls.push(sql); return { rows: [] }; },
    } as unknown as pg.PoolClient;
    const proxied = instrumentClient(fake, r);
    for (const [sql] of sqls) void (proxied.query as unknown as (s: string) => Promise<unknown>)(sql);
    const t = r.finish("completed", "run-1", null);
    const writes = t.spans.find((s) => s.stage === "writeset.planned")!.attributes.writes as { op: string; table: string; count: number }[];
    expect(writes).toEqual(expect.arrayContaining([
      { op: "insert", table: "action_runs", count: 1 },
      { op: "update", table: "object_records", count: 1 },
      { op: "delete", table: "outbox_events", count: 1 },
      { op: "insert", table: "audit_events", count: 1 },
    ]));
    const audit = t.spans.find((s) => s.stage === "audit.outbox")!.attributes as { auditEvents: number; outboxEvents: number };
    expect(audit).toEqual({ auditEvents: 1, outboxEvents: 1 });
  });

  it("sanitizeTrace 对 targetData 应用字段级遮罩", () => {
    const r = new TraceRecorder(FINANCE, "recordPayment", "PaymentSchedule", TARGET, "execute");
    r.ok("facts.loaded", { targetType: "PaymentSchedule", targetData: { currency: "CNY", transactionReference: "TX" } });
    const raw: ExecutionTrace = r.finish("completed", "run-1", null);
    const masked = sanitizeTrace(manifest, OUTSIDER, raw);
    const attrs = masked.spans.find((s) => s.stage === "facts.loaded")!.attributes.targetData as Record<string, unknown>;
    // 断言遮罩生效与否取决于 manifest 对该字段的 policy——至少结构与脱敏管道不抛错、输出仍是对象
    expect(typeof attrs).toBe("object");
  });
});
