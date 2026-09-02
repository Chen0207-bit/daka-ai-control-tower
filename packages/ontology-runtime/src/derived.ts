import type pg from "pg";
import type { ActorContext } from "./context";
import type { DerivedResolver } from "./actions/engine";

/**
 * 派生字段解析器（对应 schema derived 袋）。全部从不可变事件/关系推导。
 */

const asNumber = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

async function paymentSums(client: pg.PoolClient, ctx: ActorContext, scheduleId: string): Promise<{ settled: number; amount: number }> {
  const { rows } = await client.query(
    `SELECT o.data->>'amount' AS amount,
            COALESCE(SUM((p.data->>'amount')::numeric), 0) AS settled
     FROM object_records o
     LEFT JOIN link_records l ON l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
       AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL
     LEFT JOIN object_records p ON p.tenant_id=o.tenant_id AND p.workspace_id=o.workspace_id
       AND p.object_type='Payment' AND p.id=l.from_id AND p.superseded_at IS NULL
     WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.id=$3 AND o.object_type='PaymentSchedule' AND o.superseded_at IS NULL
     GROUP BY o.data`,
    [ctx.tenantId, ctx.workspaceId, scheduleId],
  );
  if (rows.length === 0) return { settled: 0, amount: 0 };
  return { settled: asNumber(rows[0].settled), amount: asNumber(rows[0].amount) };
}

/** 签名桶：available = received + returned + adjusted - allocated；allocated 桶 = allocated - consumed */
async function signatureBuckets(client: pg.PoolClient, ctx: ActorContext, lotId: string): Promise<{ available: number; allocated: number; consumed: number }> {
  const { rows } = await client.query(
    `SELECT m.data->>'movementType' AS mt, SUM((m.data->>'quantity')::int) AS qty
     FROM link_records l
     JOIN object_records m ON m.tenant_id=l.tenant_id AND m.workspace_id=l.workspace_id
       AND m.object_type='SignatureMovement' AND m.id=l.from_id AND m.superseded_at IS NULL
     WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.link_type='signatureMovementAffectsLot' AND l.to_id=$3 AND l.superseded_at IS NULL
     GROUP BY m.data->>'movementType'`,
    [ctx.tenantId, ctx.workspaceId, lotId],
  );
  const by: Record<string, number> = {};
  for (const r of rows) by[r.mt] = asNumber(r.qty);
  const allocated = by.allocated ?? 0;
  const consumed = by.consumed ?? 0;
  const available = (by.received ?? 0) + (by.returned ?? 0) + (by.adjusted ?? 0) - allocated;
  return { available, allocated: allocated - consumed, consumed };
}

async function rightsCoverage(client: pg.PoolClient, ctx: ActorContext, projectId: string): Promise<string[]> {
  const { rows } = await client.query(
    `SELECT r.id FROM link_records l
     JOIN object_records r ON r.tenant_id=l.tenant_id AND r.workspace_id=l.workspace_id
       AND r.object_type='RightsGrant' AND r.id=l.to_id AND r.superseded_at IS NULL
     WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.link_type='releaseProjectReliesOnRights' AND l.from_id=$3 AND l.superseded_at IS NULL
       AND (r.data->>'validFrom')::date <= CURRENT_DATE AND (r.data->>'validTo')::date >= CURRENT_DATE`,
    [ctx.tenantId, ctx.workspaceId, projectId],
  );
  return rows.map((r) => r.id);
}

export const derivedResolvers: Record<string, Record<string, DerivedResolver>> = {
  PaymentSchedule: {
    settledAmount: async (c, ctx, id) => (await paymentSums(c, ctx, id)).settled,
    unsettledAmount: async (c, ctx, id) => {
      const { settled, amount } = await paymentSums(c, ctx, id);
      return amount - settled;
    },
  },
  SignatureLot: {
    availableQuantity: async (c, ctx, id) => (await signatureBuckets(c, ctx, id)).available,
    allocatedQuantity: async (c, ctx, id) => (await signatureBuckets(c, ctx, id)).allocated,
    consumedQuantity: async (c, ctx, id) => (await signatureBuckets(c, ctx, id)).consumed,
  },
  ReleaseProject: {
    activeRightsCoverage: rightsCoverage,
  },
};
