import type pg from "pg";
import type { ActorContext } from "./context";
import { RUNTIME_ERRORS, RuntimeError } from "./errors";
import type { RuntimeManifest } from "./manifest";
import { writeAudit, writeOutbox } from "./repository";

/**
 * 事实治理：proposed → verified / rejected；verified → superseded。
 * 所有状态迁移与审计/outbox 同事务；verified 必须满足证据策略（DB 约束兜底）。
 */

export interface FactRecord {
  id: string;
  subjectType: string;
  subjectId: string;
  predicate: string;
  objectValue: unknown;
  status: "proposed" | "verified" | "rejected" | "superseded";
  evidenceAnchorId: string | null;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  supersededAt: string | null;
  assertedBy: string;
}

export async function proposeFact(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
  releaseId: string,
  input: {
    subjectType: string;
    subjectId: string;
    predicate: string;
    objectValue: unknown;
    confidence?: number;
    evidenceAnchorId?: string;
    validFrom?: string;
    validTo?: string;
  },
): Promise<FactRecord> {
  if (!manifest.objectTypes[input.subjectType]) {
    throw new RuntimeError(RUNTIME_ERRORS.UNKNOWN_TYPE, `subjectType "${input.subjectType}" 不在 manifest 中`);
  }
  const { rows } = await client.query(
    `INSERT INTO fact_assertions
       (tenant_id, workspace_id, ontology_release, subject_type, subject_id, predicate, object_value, status, confidence, evidence_anchor_id, valid_from, valid_to, asserted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9,$10,$11,$12)
     RETURNING id, recorded_at`,
    [
      ctx.tenantId, ctx.workspaceId, releaseId, input.subjectType, input.subjectId, input.predicate,
      JSON.stringify(input.objectValue), input.confidence ?? null, input.evidenceAnchorId ?? null,
      input.validFrom ?? null, input.validTo ?? null, ctx.actorId,
    ],
  );
  await writeAudit(client, ctx, "fact.propose", "FactAssertion", rows[0].id, { predicate: input.predicate, subjectId: input.subjectId });
  await writeOutbox(client, ctx, "fact.proposed", { id: rows[0].id, predicate: input.predicate });
  return {
    id: rows[0].id, subjectType: input.subjectType, subjectId: input.subjectId, predicate: input.predicate,
    objectValue: input.objectValue, status: "proposed", evidenceAnchorId: input.evidenceAnchorId ?? null,
    validFrom: input.validFrom ?? null, validTo: input.validTo ?? null, recordedAt: rows[0].recorded_at,
    supersededAt: null, assertedBy: ctx.actorId,
  };
}

async function loadFactForUpdate(client: pg.PoolClient, ctx: ActorContext, factId: string): Promise<{ status: string; evidence_anchor_id: string | null }> {
  const { rows } = await client.query(
    `SELECT status, evidence_anchor_id FROM fact_assertions
     WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE`,
    [ctx.tenantId, ctx.workspaceId, factId],
  );
  if (rows.length === 0) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `FactAssertion ${factId} 不存在`);
  return rows[0];
}

async function evidenceAnchorExists(client: pg.PoolClient, ctx: ActorContext, anchorId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM evidence_anchors WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.workspaceId, anchorId],
  );
  return rows.length > 0;
}

export async function verifyFact(
  client: pg.PoolClient,
  ctx: ActorContext,
  factId: string,
  reviewComment?: string,
): Promise<void> {
  const fact = await loadFactForUpdate(client, ctx, factId);
  if (fact.status !== "proposed") {
    throw new RuntimeError(RUNTIME_ERRORS.PRECONDITION_FAILED, `fact.status=${fact.status}，只有 proposed 可确认`);
  }
  // 证据策略：锚点存在或显式人工声明
  const hasAnchor = fact.evidence_anchor_id ? await evidenceAnchorExists(client, ctx, fact.evidence_anchor_id) : false;
  if (!hasAnchor && !reviewComment) {
    throw new RuntimeError(RUNTIME_ERRORS.EVIDENCE_REQUIRED, "verified 需要有效证据锚点或 review_comment 人工声明");
  }
  await client.query(
    `UPDATE fact_assertions SET status='verified', version=version+1, review_comment=$4, reviewed_by=$5, reviewed_at=now()
     WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.workspaceId, factId, reviewComment ?? null, ctx.actorId],
  );
  await writeAudit(client, ctx, "fact.verify", "FactAssertion", factId, { reviewComment });
  await writeOutbox(client, ctx, "fact.verified", { id: factId });
}

export async function rejectFact(
  client: pg.PoolClient,
  ctx: ActorContext,
  factId: string,
  rejectionReason: string,
): Promise<void> {
  const fact = await loadFactForUpdate(client, ctx, factId);
  if (fact.status !== "proposed") {
    throw new RuntimeError(RUNTIME_ERRORS.PRECONDITION_FAILED, `fact.status=${fact.status}，只有 proposed 可驳回`);
  }
  await client.query(
    `UPDATE fact_assertions SET status='rejected', version=version+1, review_comment=$4, reviewed_by=$5, reviewed_at=now()
     WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.workspaceId, factId, rejectionReason, ctx.actorId],
  );
  await writeAudit(client, ctx, "fact.reject", "FactAssertion", factId, { rejectionReason });
  await writeOutbox(client, ctx, "fact.rejected", { id: factId });
}

/** 替代：旧 verified → superseded（superseded_at 落系统时间），新事实直接 verified。 */
export async function supersedeFact(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
  releaseId: string,
  oldFactId: string,
  replacement: { predicate: string; objectValue: unknown; evidenceAnchorId: string },
  reason: string,
): Promise<string> {
  const old = await loadFactForUpdate(client, ctx, oldFactId);
  if (old.status !== "verified") {
    throw new RuntimeError(RUNTIME_ERRORS.PRECONDITION_FAILED, `old fact status=${old.status}，只有 verified 可被替代`);
  }
  if (!(await evidenceAnchorExists(client, ctx, replacement.evidenceAnchorId))) {
    throw new RuntimeError(RUNTIME_ERRORS.EVIDENCE_REQUIRED, "替代事实需要有效证据锚点");
  }
  await client.query(
    `UPDATE fact_assertions SET status='superseded', version=version+1, superseded_at=now(), review_comment=$4, reviewed_by=$5, reviewed_at=now()
     WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.workspaceId, oldFactId, reason, ctx.actorId],
  );
  const { rows } = await client.query(
    `SELECT subject_type, subject_id FROM fact_assertions WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
    [ctx.tenantId, ctx.workspaceId, oldFactId],
  );
  const { rows: created } = await client.query(
    `INSERT INTO fact_assertions
       (tenant_id, workspace_id, ontology_release, subject_type, subject_id, predicate, object_value, status, evidence_anchor_id, asserted_by, supersedes_fact_id, review_comment, reviewed_by, reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'verified',$8,$9,$10,$11,$12,now())
     RETURNING id`,
    [
      ctx.tenantId, ctx.workspaceId, releaseId, rows[0].subject_type, rows[0].subject_id,
      replacement.predicate, JSON.stringify(replacement.objectValue), replacement.evidenceAnchorId,
      ctx.actorId, oldFactId, reason, ctx.actorId,
    ],
  );
  void manifest;
  await writeAudit(client, ctx, "fact.supersede", "FactAssertion", oldFactId, { replacementId: created[0].id, reason });
  await writeOutbox(client, ctx, "fact.superseded", { oldId: oldFactId, newId: created[0].id });
  return created[0].id;
}

export async function listFacts(
  client: pg.PoolClient,
  ctx: ActorContext,
  opts: { status?: string; subjectId?: string } = {},
): Promise<FactRecord[]> {
  const conditions = ["tenant_id=$1", "workspace_id=$2"];
  const params: unknown[] = [ctx.tenantId, ctx.workspaceId];
  if (opts.status) { params.push(opts.status); conditions.push(`status=$${params.length}`); }
  if (opts.subjectId) { params.push(opts.subjectId); conditions.push(`subject_id=$${params.length}`); }
  const { rows } = await client.query(
    `SELECT id, subject_type, subject_id, predicate, object_value, status, evidence_anchor_id,
            valid_from, valid_to, recorded_at, superseded_at, asserted_by
     FROM fact_assertions WHERE ${conditions.join(" AND ")} ORDER BY recorded_at ASC`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, predicate: r.predicate,
    objectValue: r.object_value, status: r.status, evidenceAnchorId: r.evidence_anchor_id,
    validFrom: r.valid_from, validTo: r.valid_to, recordedAt: r.recorded_at,
    supersededAt: r.superseded_at, assertedBy: r.asserted_by,
  }));
}
