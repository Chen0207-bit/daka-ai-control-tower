import type pg from "pg";
import type { ActorContext } from "./context";
import type { RuntimeManifest } from "./manifest";
import { maskRecord } from "./policy";

/**
 * Projection Runtime：五个投影全部由规范事实纯推导（物化只读视图语义）。
 * 重建 = 重新执行同一查询；因此重建与增量天然一致（parity 由集成测试断言）。
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export async function paymentCalendar(pool: pg.Pool, ctx: ActorContext, manifest: RuntimeManifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    const { rows } = await client.query(
      `SELECT o.id, o.data,
              COALESCE(SUM((p.data->>'amount')::numeric), 0) AS settled
       FROM object_records o
       LEFT JOIN link_records l ON l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
         AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL
       LEFT JOIN object_records p ON p.tenant_id=o.tenant_id AND p.workspace_id=o.workspace_id
         AND p.object_type='Payment' AND p.id=l.from_id AND p.superseded_at IS NULL
       WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_type='PaymentSchedule' AND o.superseded_at IS NULL
       GROUP BY o.id, o.data ORDER BY o.data->>'dueAt'`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const items = rows.map((r) => {
      const data = maskRecord(manifest, ctx, "PaymentSchedule", r.data);
      const settled = num(r.settled);
      const amount = num(r.data.amount);
      return {
        id: r.id,
        ...data,
        settledAmount: settled,
        unsettledAmount: amount - settled,
        isOverdue: Date.parse(r.data.dueAt) < Date.now() && amount - settled > 0,
      };
    });
    await client.query("COMMIT");
    return {
      projection: "paymentCalendar",
      items,
      totals: {
        unsettledAmount: items.reduce((s, i) => s + i.unsettledAmount, 0),
        overdueAmount: items.filter((i) => i.isOverdue).reduce((s, i) => s + i.unsettledAmount, 0),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function contractRiskList(pool: pg.Pool, ctx: ActorContext, manifest: RuntimeManifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    const risks = await client.query(
      `SELECT id, data FROM object_records
       WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='RiskFinding' AND superseded_at IS NULL
       ORDER BY created_at DESC`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const grants = await client.query(
      `SELECT id, data FROM object_records
       WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='RightsGrant' AND superseded_at IS NULL`,
      [ctx.tenantId, ctx.workspaceId],
    );
    await client.query("COMMIT");
    return {
      projection: "contractRiskList",
      risks: risks.rows.map((r) => ({ id: r.id, ...maskRecord(manifest, ctx, "RiskFinding", r.data) })),
      rightsGrants: grants.rows.map((r) => ({ id: r.id, ...maskRecord(manifest, ctx, "RightsGrant", r.data) })),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function signatureOverview(pool: pg.Pool, ctx: ActorContext, manifest: RuntimeManifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    const lots = await client.query(
      `SELECT o.id, o.data FROM object_records o
       WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_type='SignatureLot' AND o.superseded_at IS NULL`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const movements = await client.query(
      `SELECT l.to_id AS lot_id, m.data->>'movementType' AS mt, SUM((m.data->>'quantity')::int) AS qty
       FROM link_records l
       JOIN object_records m ON m.tenant_id=l.tenant_id AND m.workspace_id=l.workspace_id
         AND m.object_type='SignatureMovement' AND m.id=l.from_id AND m.superseded_at IS NULL
       WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.link_type='signatureMovementAffectsLot' AND l.superseded_at IS NULL
       GROUP BY l.to_id, m.data->>'movementType'`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const entitlements = await client.query(
      `SELECT id, data FROM object_records
       WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='SignatureEntitlement' AND superseded_at IS NULL`,
      [ctx.tenantId, ctx.workspaceId],
    );
    await client.query("COMMIT");
    const byLot = new Map<string, Record<string, number>>();
    for (const m of movements.rows) {
      const entry = byLot.get(m.lot_id) ?? {};
      entry[m.mt] = num(m.qty);
      byLot.set(m.lot_id, entry);
    }
    const items = lots.rows.map((l) => {
      const b = byLot.get(l.id) ?? {};
      const allocated = num(b.allocated);
      const consumed = num(b.consumed);
      return {
        id: l.id,
        ...maskRecord(manifest, ctx, "SignatureLot", l.data),
        buckets: {
          received: num(b.received),
          available: num(b.received) + num(b.returned) + num(b.adjusted) - allocated,
          allocated: allocated - consumed,
          consumed,
          returned: num(b.returned),
        },
      };
    });
    return {
      projection: "signatureOverview",
      entitlements: entitlements.rows.map((e) => ({ id: e.id, ...maskRecord(manifest, ctx, "SignatureEntitlement", e.data) })),
      lots: items,
      totals: {
        available: items.reduce((s, i) => s + i.buckets.available, 0),
        allocated: items.reduce((s, i) => s + i.buckets.allocated, 0),
        consumed: items.reduce((s, i) => s + i.buckets.consumed, 0),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function bossActionInbox(pool: pg.Pool, ctx: ActorContext, manifest: RuntimeManifest) {
  const [risks, payments, recs] = await Promise.all([
    contractRiskList(pool, ctx, manifest),
    paymentCalendar(pool, ctx, manifest),
    marketRecommendation(pool, ctx, manifest),
  ]);
  const items: Array<Record<string, unknown>> = [];
  for (const r of risks.risks as Array<Record<string, unknown>>) {
    if (r.status === "open" && (r.severity === "high" || r.severity === "critical")) {
      items.push({ kind: "risk", severity: r.severity, id: r.id, title: r.explanation, demo: true });
    }
  }
  for (const p of payments.items as Array<Record<string, unknown> & { isOverdue: boolean; id: string; unsettledAmount: number; dueAt?: string }>) {
    if (p.isOverdue) items.push({ kind: "payment_overdue", id: p.id, amount: p.unsettledAmount, dueAt: p.dueAt, demo: true });
  }
  for (const r of recs.recommendations as Array<Record<string, unknown>>) {
    if (r.status === "suggested" || r.status === "in_review") {
      items.push({ kind: "release_recommendation", id: r.id, type: r.recommendationType, demo: true });
    }
  }
  return { projection: "bossActionInbox", items };
}

export async function marketRecommendation(pool: pg.Pool, ctx: ActorContext, manifest: RuntimeManifest) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    const observations = await client.query(
      `SELECT id, data FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='MarketObservation' AND superseded_at IS NULL ORDER BY created_at DESC`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const recommendations = await client.query(
      `SELECT id, data FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='ReleaseRecommendation' AND superseded_at IS NULL ORDER BY created_at DESC`,
      [ctx.tenantId, ctx.workspaceId],
    );
    await client.query("COMMIT");
    return {
      projection: "marketRecommendation",
      observations: observations.rows.map((r) => ({ id: r.id, ...maskRecord(manifest, ctx, "MarketObservation", r.data) })),
      recommendations: recommendations.rows.map((r) => ({ id: r.id, ...maskRecord(manifest, ctx, "ReleaseRecommendation", r.data) })),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const PROJECTIONS: Record<string, (pool: pg.Pool, ctx: ActorContext, manifest: RuntimeManifest) => Promise<unknown>> = {
  contractRiskList,
  paymentCalendar,
  signatureOverview,
  bossActionInbox,
  marketRecommendation,
};
