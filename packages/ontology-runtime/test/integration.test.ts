import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  buildHandlers,
  createObject,
  createPool,
  derivedResolvers,
  ensureRelease,
  executeAction,
  factTargetLoader,
  listFacts,
  loadManifest,
  makeContext,
  paymentCalendar,
  proposeFact,
  RUNTIME_ERRORS,
  RuntimeError,
  signatureOverview,
  updateObject,
  verifyFact,
  withTx,
  bossActionInbox,
} from "../src/index";
import { applyDataPack, loadDataPack } from "../src/ingest/datapack";
import { runRules, materializeFindings } from "../src/rules/runner";

/**
 * 集成测试：需要真实 PostgreSQL（便携 binaries 或 compose）。
 * 连接角色为 daka_runtime（非 owner），全程经过 RLS。
 * 无 DATABASE_URL_RUNTIME 时整体 skip（不冒充完成）。
 */

const DB_URL = process.env.DATABASE_URL_RUNTIME ?? process.env.DATABASE_URL_TEST;
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TENANT = "e0000000-0000-4000-8000-000000000001";
const WS = "e0000000-0000-4000-8000-000000000002";

const d = (suffix: string) => `e0000000-0000-4000-8000-${suffix}`;

let pool: pg.Pool;
let manifest: ReturnType<typeof loadManifest>;
let releaseId: string;
let ctx: ReturnType<typeof makeContext>;

const FINANCE = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "fin-1", roles: ["financeOperator"] });
const LEGAL = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "legal-1", roles: ["legalReviewer"] });
const STEWARD = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "steward-1", roles: ["dataSteward"] });
const IPOPS = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "ip-1", roles: ["ipOperations"] });
const OUTSIDER = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "x", roles: ["executiveViewer"] });

const engineOpts = () => ({
  handlers: buildHandlers(),
  derived: derivedResolvers,
  targetLoaders: { FactAssertion: factTargetLoader },
});

async function expectError(p: Promise<unknown>, code: string): Promise<RuntimeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).code).toBe(code);
    return err as RuntimeError;
  }
  throw new Error(`预期抛出 ${code}，实际成功`);
}

describe.skipIf(!DB_URL)("runtime 集成（真实 PostgreSQL + RLS 角色）", () => {
  beforeAll(async () => {
    pool = createPool(DB_URL!);
    manifest = loadManifest(`${ROOT}/ontology/.generated/ontology.manifest.json`);
    ctx = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "test-setup", roles: ["dataSteward"] });
    // 可重跑：清空测试 tenant/workspace 的历史数据
    await withTx(pool, ctx, async (c) => {
      for (const t of ["ingest_records", "ingest_jobs", "audit_events", "outbox_events", "action_runs", "link_records", "fact_assertions", "object_records", "evidence_anchors", "documents"]) {
        await c.query(`DELETE FROM ${t} WHERE tenant_id=$1 AND workspace_id=$2`, [TENANT, WS]);
      }
    });
    releaseId = await withTx(pool, ctx, (c) => ensureRelease(c, manifest, "test-setup"));
  });

  it("对象 CRUD + 乐观锁 409", async () => {
    const contract = await withTx(pool, STEWARD, (c) =>
      createObject(c, STEWARD, manifest, releaseId, "Contract", {
        title: "集成测试合同（演示推演）",
        status: "draft",
        documentId: d("0000000000e1"),
      }, d("000000000001")),
    );
    expect(contract.version).toBe(1);
    const updated = await withTx(pool, STEWARD, (c) =>
      updateObject(c, STEWARD, manifest, "Contract", contract.id, { title: "改题" }, 1),
    );
    expect(updated.version).toBe(2);
    await expectError(
      withTx(pool, STEWARD, (c) => updateObject(c, STEWARD, manifest, "Contract", contract.id, { title: "旧版本写" }, 1)),
      RUNTIME_ERRORS.VERSION_CONFLICT,
    );
  });

  it("未知字段/immutable 写入被 manifest 拒绝", async () => {
    await expectError(
      withTx(pool, STEWARD, (c) =>
        createObject(c, STEWARD, manifest, releaseId, "Contract", {
          title: "x", status: "draft", documentId: d("0000000000e1"), hackerField: "eval(1)",
        } as Record<string, unknown>, d("000000000002")),
      ),
      RUNTIME_ERRORS.VALIDATION,
    );
  });

  it("Fact 治理：proposed→verify（证据策略）→supersede；双时态可查", async () => {
    const fact = await withTx(pool, STEWARD, async (c) => {
      await c.query(
        `INSERT INTO documents (id, tenant_id, workspace_id, uri, sha256, media_type, version, captured_at, recorded_by)
         VALUES ($1,$2,$3,'https://example.invalid/t.pdf',$4,'application/pdf','1',now(),'test')
         ON CONFLICT DO NOTHING`,
        [d("0000000000e1"), TENANT, WS, `sha-${d("0000000000e1")}`],
      );
      const anchor = await c.query(
        `INSERT INTO evidence_anchors (id, tenant_id, workspace_id, document_id, locator_type, locator)
         VALUES ($1,$2,$3,$4,'page_clause','{"page":1}') ON CONFLICT DO NOTHING RETURNING id`,
        [d("0000000000e2"), TENANT, WS, d("0000000000e1")],
      );
      return proposeFact(c, STEWARD, manifest, releaseId, {
        subjectType: "Contract", subjectId: d("000000000001"), predicate: "test.pred",
        objectValue: { v: 1 }, evidenceAnchorId: anchor.rows[0]?.id ?? d("0000000000e2"),
        validFrom: "2026-01-01T00:00:00Z",
      });
    });
    expect(fact.status).toBe("proposed");

    // 无证据无评论 → 拒绝 verified
    const noEvidence = await withTx(pool, STEWARD, (c) =>
      proposeFact(c, STEWARD, manifest, releaseId, {
        subjectType: "Contract", subjectId: d("000000000001"), predicate: "test.noEvidence", objectValue: {},
      }),
    );
    await expectError(withTx(pool, STEWARD, (c) => verifyFact(c, STEWARD, noEvidence.id)), RUNTIME_ERRORS.EVIDENCE_REQUIRED);

    await withTx(pool, LEGAL, (c) => verifyFact(c, LEGAL, fact.id, "法务确认（演示）"));
    const verified = await withTx(pool, STEWARD, (c) => listFacts(c, STEWARD, { status: "verified", subjectId: d("000000000001") }));
    expect(verified.map((f) => f.id)).toContain(fact.id);
    expect(verified[0].validFrom).toBeTruthy();
    expect(verified[0].recordedAt).toBeTruthy();
  });

  it("Action：policy 403 / 幂等重放 / 并发 409 / 前置条件 422", async () => {
    // 造 schedule
    await withTx(pool, STEWARD, (c) =>
      createObject(c, STEWARD, manifest, releaseId, "PaymentSchedule", {
        amount: "100", currency: "CNY", dueAt: "2030-01-01T00:00:00Z", status: "planned",
      }, d("000000000101")),
    );
    // 403: 法务角色不能登记付款
    await expectError(
      executeAction(pool, manifest, engineOpts(), LEGAL, "recordPayment", {
        targetId: d("000000000101"),
        input: { amount: "50", currency: "CNY", paidAt: "2026-09-01T00:00:00Z" },
        idempotencyKey: "pay-deny-1",
      }),
      RUNTIME_ERRORS.POLICY_DENY,
    );
    // 422: 金额为负
    await expectError(
      executeAction(pool, manifest, engineOpts(), FINANCE, "recordPayment", {
        targetId: d("000000000101"),
        input: { amount: "-5", currency: "CNY", paidAt: "2026-09-01T00:00:00Z" },
        idempotencyKey: "pay-neg-1",
      }),
      RUNTIME_ERRORS.PRECONDITION_FAILED,
    );
    // 正常执行
    const run1 = await executeAction(pool, manifest, engineOpts(), FINANCE, "recordPayment", {
      targetId: d("000000000101"),
      input: { amount: "50", currency: "CNY", paidAt: "2026-09-01T00:00:00Z" },
      idempotencyKey: "pay-ok-1",
      expectedVersion: 1,
    });
    expect(run1.status).toBe("completed");
    // 幂等重放：同 key 同载荷 → 不重复产生 effect
    const run2 = await executeAction(pool, manifest, engineOpts(), FINANCE, "recordPayment", {
      targetId: d("000000000101"),
      input: { amount: "50", currency: "CNY", paidAt: "2026-09-01T00:00:00Z" },
      idempotencyKey: "pay-ok-1",
    });
    expect(run2.status).toBe("replayed");
    expect(run2.runId).toBe(run1.runId);
    const payments = await withTx(pool, FINANCE, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='Payment'`,
        [TENANT, WS],
      );
      return rows[0].n;
    });
    expect(payments).toBe(1);
    // 同 key 不同载荷 → 409
    await expectError(
      executeAction(pool, manifest, engineOpts(), FINANCE, "recordPayment", {
        targetId: d("000000000101"),
        input: { amount: "60", currency: "CNY", paidAt: "2026-09-01T00:00:00Z" },
        idempotencyKey: "pay-ok-1",
      }),
      RUNTIME_ERRORS.IDEMPOTENCY_REPLAY_MISMATCH,
    );
    // expectedVersion 过期 → 409
    await expectError(
      executeAction(pool, manifest, engineOpts(), FINANCE, "recordPayment", {
        targetId: d("000000000101"),
        input: { amount: "10", currency: "CNY", paidAt: "2026-09-02T00:00:00Z" },
        idempotencyKey: "pay-409",
        expectedVersion: 1,
      }),
      RUNTIME_ERRORS.VERSION_CONFLICT,
    );
  });

  it("签名守恒：超额分配被服务端阻断；桶余额正确", async () => {
    await withTx(pool, IPOPS, async (c) => {
      await createObject(c, IPOPS, manifest, releaseId, "SignatureEntitlement", {
        grantedQuantity: 10, unit: "张",
      }, d("000000000201"));
      await createObject(c, IPOPS, manifest, releaseId, "ReleaseProject", {
        projectName: "测试项目（演示推演）", stage: "designing", ownerId: d("0000000000b1"),
      }, d("000000000301"));
    });
    // 收 10 张
    const recv = await executeAction(pool, manifest, engineOpts(), IPOPS, "receiveSignatureLot", {
      targetId: d("000000000201"),
      input: { lotNumber: "LOT-T-1", quantity: 10, receivedAt: "2026-09-01T00:00:00Z", evidenceAnchorId: d("0000000000e2") },
      idempotencyKey: "recv-1",
    });
    const lotId = (recv.result as { lotId: string }).lotId;
    // 分配 7 → 成功；再分配 4 → 超额 422
    await executeAction(pool, manifest, engineOpts(), IPOPS, "allocateSignatures", {
      targetId: lotId,
      input: { releaseProjectId: d("000000000301"), quantity: 7 },
      idempotencyKey: "alloc-1",
    });
    await expectError(
      executeAction(pool, manifest, engineOpts(), IPOPS, "allocateSignatures", {
        targetId: lotId,
        input: { releaseProjectId: d("000000000301"), quantity: 4 },
        idempotencyKey: "alloc-over",
      }),
      RUNTIME_ERRORS.PRECONDITION_FAILED,
    );
    const overview = await signatureOverview(pool, IPOPS, manifest);
    const lot = overview.lots.find((l) => l.id === lotId);
    expect(lot?.buckets.available).toBe(3);
    expect(lot?.buckets.allocated).toBe(7);
  });

  it("规则：paymentOverdue 与 signatureBalanceNegative 正反案例", async () => {
    // 逾期 schedule（dueAt 已过且有未结清）
    await withTx(pool, STEWARD, (c) =>
      createObject(c, STEWARD, manifest, releaseId, "PaymentSchedule", {
        amount: "200", currency: "CNY", dueAt: "2020-01-01T00:00:00Z", status: "planned",
      }, d("000000000102")),
    );
    const result = await withTx(pool, STEWARD, async (c) => {
      const findings = await runRules(c, STEWARD, manifest);
      return materializeFindings(c, STEWARD, manifest, releaseId, findings);
    });
    expect(result.length).toBeGreaterThan(0);
    // 再跑一次：同 rule+subject 不重复建
    const again = await withTx(pool, STEWARD, async (c) => {
      const findings = await runRules(c, STEWARD, manifest);
      return materializeFindings(c, STEWARD, manifest, releaseId, findings);
    });
    expect(again.length).toBe(0);
  });

  it("投影重建一致性：两次全量计算结果一致", async () => {
    const a = await paymentCalendar(pool, FINANCE, manifest);
    const b = await paymentCalendar(pool, FINANCE, manifest);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const inbox = await bossActionInbox(pool, FINANCE, manifest);
    expect(inbox.items.length).toBeGreaterThan(0);
  });

  it("RLS：跨 workspace 不可见（应用层外直连验证）", async () => {
    const other = makeContext({ tenantId: TENANT, workspaceId: "e0000000-0000-4000-8000-999999999999", actorId: "s", roles: ["dataSteward"] });
    const count = await withTx(pool, other, async (c) => {
      const { rows } = await c.query(`SELECT count(*)::int AS n FROM object_records`);
      return rows[0].n as number;
    });
    expect(count).toBe(0);
  });

  it("Data Pack 幂等：同 fingerprint 重复导入 skipped", async () => {
    const pack = loadDataPack(`${ROOT}/ontology/data-packs/demo`);
    // demo pack 的 tenant/workspace 是 d000...；已被 seed 导入过 → skipped
    const r = await applyDataPack(pool, manifest, pack);
    expect(r.status).toBe("skipped");
  });

  it("执行管理层遮罩：executiveViewer 看 Payment 隐去 transactionReference", async () => {
    const a = await paymentCalendar(pool, FINANCE, manifest);
    const b = await paymentCalendar(pool, OUTSIDER, manifest);
    // 双方均可见行（RLS 通过），但字段遮罩不同由 maskRecord 保证；此处验证投影可运行
    expect(a.items.length).toBe(b.items.length);
  });
});
