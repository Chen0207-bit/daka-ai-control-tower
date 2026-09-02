import type pg from "pg";
import type { ActorContext } from "../context";
import { RUNTIME_ERRORS, RuntimeError } from "../errors";
import type { ObjectRecord } from "../repository";
import { createLink, createObject, updateObject } from "../repository";
import { rejectFact, supersedeFact, verifyFact } from "../facts";
import type { ActionHandler } from "./engine";

/**
 * 注册 handler（spec §7：handler key → 代码实现；DSL 只声明契约）。
 */

/** FactAssertion 存储在 fact_assertions 表，而非 object_records；提供 target loader。 */
export async function factTargetLoader(
  client: pg.PoolClient,
  ctx: ActorContext,
  id: string,
): Promise<ObjectRecord | null> {
  const { rows } = await client.query(
    `SELECT version, status, evidence_anchor_id, subject_type, subject_id, predicate, object_value, recorded_at, superseded_at
     FROM fact_assertions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.workspaceId, id],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id,
    objectType: "FactAssertion",
    version: r.version,
    data: {
      status: r.status,
      evidenceAnchorId: r.evidence_anchor_id,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      predicate: r.predicate,
      objectValue: r.object_value,
    },
    recordedAt: r.recorded_at,
    supersededAt: r.superseded_at,
  };
}

/** AI/抽取侧车契约：只能产出 proposed 候选事实（边界见 01_BOUNDARIES）。 */
export interface CandidateFactProvider {
  extract(input: {
    contractId: string;
    extractorVersion: string;
    documentUri?: string;
  }): Promise<
    Array<{
      predicate: string;
      objectValue: unknown;
      confidence?: number;
      locator: Record<string, unknown>;
      excerptHash?: string;
    }>
  >;
}

export function buildHandlers(provider?: CandidateFactProvider): Record<string, ActionHandler> {
  return {
    "contract.upload": async ({ client, ctx, manifest, target, input }) => {
      const doc = await client.query(
        `INSERT INTO documents (tenant_id, workspace_id, uri, sha256, media_type, version, captured_at, recorded_by)
         VALUES ($1,$2,$3,$4,'application/pdf','1',now(),$5) RETURNING id`,
        [ctx.tenantId, ctx.workspaceId, String(input.documentUri), String(input.sha256), ctx.actorId],
      );
      const updated = await updateObject(client, ctx, manifest, "Contract", target.id, {
        documentId: doc.rows[0].id,
        title: String(input.title),
        status: "draft",
      }, target.version);
      return { documentId: doc.rows[0].id, contractVersion: updated.version };
    },

    "extraction.contractCandidates": async ({ client, ctx, manifest, releaseId, input }) => {
      if (!provider) {
        throw new RuntimeError(RUNTIME_ERRORS.UNKNOWN_HANDLER, "未配置 CandidateFactProvider");
      }
      const contract = await client.query(
        `SELECT data FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND superseded_at IS NULL`,
        [ctx.tenantId, ctx.workspaceId, String(input.contractId)],
      );
      if (contract.rows.length === 0) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, "contract 不存在");
      const candidates = await provider.extract({
        contractId: String(input.contractId),
        extractorVersion: String(input.extractorVersion),
      });
      let created = 0;
      for (const c of candidates) {
        const doc = await client.query(
          `SELECT document_id FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
          [ctx.tenantId, ctx.workspaceId, String(input.contractId)],
        );
        void doc;
        const docId = (contract.rows[0].data as Record<string, unknown>).documentId as string;
        const anchor = await client.query(
          `INSERT INTO evidence_anchors (tenant_id, workspace_id, document_id, locator_type, locator, excerpt_hash)
           VALUES ($1,$2,$3,'yaml_candidate',$4,$5) RETURNING id`,
          [ctx.tenantId, ctx.workspaceId, docId, JSON.stringify(c.locator), c.excerptHash ?? null],
        );
        await client.query(
          `INSERT INTO fact_assertions
             (tenant_id, workspace_id, ontology_release, subject_type, subject_id, predicate, object_value, status, confidence, evidence_anchor_id, asserted_by)
           VALUES ($1,$2,$3,'Contract',$4,$5,$6,'proposed',$7,$8,$9)`,
          [
            ctx.tenantId, ctx.workspaceId, releaseId, String(input.contractId), c.predicate,
            JSON.stringify(c.objectValue), c.confidence ?? null, anchor.rows[0].id,
            `extractor:${input.extractorVersion}`,
          ],
        );
        created++;
      }
      void manifest;
      return { proposedCount: created };
    },

    "fact.confirm": async ({ client, ctx, target, input }) => {
      await verifyFact(client, ctx, target.id, input.reviewComment as string | undefined);
      return { factId: target.id, status: "verified" };
    },

    "fact.reject": async ({ client, ctx, target, input }) => {
      await rejectFact(client, ctx, target.id, String(input.rejectionReason));
      return { factId: target.id, status: "rejected" };
    },

    "fact.supersede": async ({ client, ctx, manifest, releaseId, target, input }) => {
      const repl = input.replacementFact as { predicate: string; objectValue: unknown; evidenceAnchorId: string };
      const newId = await supersedeFact(client, ctx, manifest, releaseId, target.id, repl, String(input.reason));
      return { oldFactId: target.id, newFactId: newId };
    },

    "payment.record": async ({ client, ctx, manifest, releaseId, target, input }) => {
      const payment = await createObject(client, ctx, manifest, releaseId, "Payment", {
        amount: input.amount as string,
        currency: input.currency as string,
        paidAt: input.paidAt as string,
        ...(input.transactionReference ? { transactionReference: input.transactionReference as string } : {}),
      });
      await createLink(client, ctx, manifest, releaseId, "paymentSettlesSchedule", payment.id, target.id);
      // 重算计划状态（演示口径：全额结清 → paid）
      const sums = await client.query(
        `SELECT COALESCE(SUM((p.data->>'amount')::numeric),0) AS settled
         FROM link_records l JOIN object_records p ON p.id=l.from_id AND p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.superseded_at IS NULL
         WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.link_type='paymentSettlesSchedule' AND l.to_id=$3 AND l.superseded_at IS NULL`,
        [ctx.tenantId, ctx.workspaceId, target.id],
      );
      const settled = Number(sums.rows[0].settled);
      const amount = Number((target.data as Record<string, unknown>).amount);
      const dueAt = Date.parse(String((target.data as Record<string, unknown>).dueAt));
      const status = settled >= amount ? "paid" : dueAt < Date.now() ? "overdue" : "due";
      await updateObject(client, ctx, manifest, "PaymentSchedule", target.id, { status }, target.version);
      return { paymentId: payment.id, settled, scheduleStatus: status };
    },

    "signature.receiveLot": async ({ client, ctx, manifest, releaseId, target, input }) => {
      const lot = await createObject(client, ctx, manifest, releaseId, "SignatureLot", {
        lotNumber: input.lotNumber as string,
        receivedQuantity: input.quantity as number,
        receivedAt: input.receivedAt as string,
        qualityStatus: "pending_inspection",
      });
      await createLink(client, ctx, manifest, releaseId, "signatureLotFulfillsEntitlement", lot.id, target.id);
      const movement = await createObject(client, ctx, manifest, releaseId, "SignatureMovement", {
        movementType: "received",
        quantity: input.quantity as number,
        occurredAt: input.receivedAt as string,
        actorId: ctx.actorId,
      });
      await createLink(client, ctx, manifest, releaseId, "signatureMovementAffectsLot", movement.id, lot.id);
      return { lotId: lot.id, movementId: movement.id };
    },

    "signature.allocate": async ({ client, ctx, manifest, releaseId, target, input }) => {
      const movement = await createObject(client, ctx, manifest, releaseId, "SignatureMovement", {
        movementType: "allocated",
        quantity: input.quantity as number,
        occurredAt: new Date().toISOString(),
        reason: (input.reason as string) ?? undefined,
        actorId: ctx.actorId,
      });
      await createLink(client, ctx, manifest, releaseId, "signatureMovementAffectsLot", movement.id, target.id);
      await createLink(client, ctx, manifest, releaseId, "signatureMovementForProject", movement.id, String(input.releaseProjectId));
      return { movementId: movement.id };
    },

    "risk.resolve": async ({ client, ctx, manifest, target, input }) => {
      const updated = await updateObject(client, ctx, manifest, "RiskFinding", target.id, {
        status: "resolved",
      }, target.version);
      return { riskId: target.id, status: "resolved", version: updated.version, resolution: input.resolution };
    },

    "market.reviewRecommendation": async ({ client, ctx, manifest, target, input }) => {
      // 人工评审只改建议状态；绝不自动改印量/价格（边界）
      const updated = await updateObject(client, ctx, manifest, "ReleaseRecommendation", target.id, {
        status: input.decision as string,
        reviewComment: (input.reviewComment as string) ?? undefined,
        reviewedAt: new Date().toISOString(),
      }, target.version);
      return { recommendationId: target.id, status: input.decision, version: updated.version };
    },
  };
}
