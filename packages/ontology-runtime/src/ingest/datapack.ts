import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type pg from "pg";
import type { ActorContext } from "../context";
import { RUNTIME_ERRORS, RuntimeError } from "../errors";
import type { RuntimeManifest } from "../manifest";
import { createLink, createObject, ensureRelease } from "../repository";

/**
 * YAML Data Pack（00_GOAL §缺失数据策略 / 02_ARCHITECTURE §6）。
 * 流程: validate → plan/diff → dry-run → transactional apply → audit → projection refresh。
 * 幂等: 相同 pack fingerprint 重复导入不产生重复行。
 */

export interface DataPackObject {
  type: string;
  id: string;
  data: Record<string, unknown>;
  source?: string;
}

export interface DataPackLink {
  linkType: string;
  from: string;
  to: string;
}

export interface DataPackFact {
  subjectType: string;
  subjectId: string;
  predicate: string;
  objectValue: unknown;
  status?: "proposed";
  evidenceAnchorId?: string;
}

export interface DataPack {
  manifest: {
    id: string;
    version: string;
    ontologyConstraint: string;
    source: "confirmed_public" | "demo_assumption" | "external_signal" | "model_suggestion";
    tenantId: string;
    workspaceId: string;
    description?: string;
  };
  objects: DataPackObject[];
  links: DataPackLink[];
  facts: DataPackFact[];
  documents: Array<{ id: string; uri: string; sha256: string; mediaType: string; version: string; capturedAt: string }>;
  anchors: Array<{ id: string; documentId: string; locatorType: string; locator: Record<string, unknown>; excerptHash?: string }>;
  fingerprint: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ["confirmed_public", "demo_assumption", "external_signal", "model_suggestion"];

export function loadDataPack(dir: string): DataPack {
  const read = (name: string): unknown => {
    try {
      return parseYaml(readFileSync(join(dir, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  const manifestRaw = read("pack.yaml") as Record<string, unknown> | undefined;
  if (!manifestRaw?.pack) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `Data Pack 缺 pack.yaml 或 pack 段: ${dir}`);
  }
  const p = manifestRaw.pack as Record<string, unknown>;
  const required = ["id", "version", "ontologyConstraint", "source", "tenantId", "workspaceId"];
  for (const k of required) {
    if (p[k] === undefined) throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `pack.yaml 缺字段 pack.${k}`);
  }
  if (!SOURCES.includes(String(p.source))) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `pack.source 必须是 ${SOURCES.join("/")}`);
  }
  const objects = ((read("objects.yaml") as Record<string, unknown>)?.objects ?? []) as DataPackObject[];
  const links = ((read("links.yaml") as Record<string, unknown>)?.links ?? []) as DataPackLink[];
  const facts = ((read("facts.yaml") as Record<string, unknown>)?.facts ?? []) as DataPackFact[];
  const documents = ((read("documents.yaml") as Record<string, unknown>)?.documents ?? []) as DataPack["documents"];
  const anchors = ((read("documents.yaml") as Record<string, unknown>)?.anchors ?? []) as DataPack["anchors"];

  // 内容指纹（确定性）：除 fingerprint 外全量内容
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ manifest: p, objects, links, facts, documents, anchors }))
    .digest("hex");

  return {
    manifest: {
      id: String(p.id),
      version: String(p.version),
      ontologyConstraint: String(p.ontologyConstraint),
      source: p.source as DataPack["manifest"]["source"],
      tenantId: String(p.tenantId),
      workspaceId: String(p.workspaceId),
      description: typeof p.description === "string" ? p.description : undefined,
    },
    objects,
    links,
    facts,
    documents,
    anchors,
    fingerprint,
  };
}

/** 对照 manifest 校验 pack（dry-run 也走同一链）。返回错误列表（空 = 通过）。 */
export function validateDataPack(pack: DataPack, manifest: RuntimeManifest): string[] {
  const errors: string[] = [];
  if (!UUID_RE.test(pack.manifest.tenantId) || !UUID_RE.test(pack.manifest.workspaceId)) {
    errors.push("tenantId/workspaceId 必须是 UUID");
  }
  // ontology 约束：同名 + major 兼容（>= 简化处理：要求同 major）
  if (manifest.meta.name === undefined) errors.push("manifest 缺 name");
  const constraintMajor = pack.manifest.ontologyConstraint.replace(/[^\d.].*$/, "").split(".")[0];
  if (constraintMajor && manifest.meta.version.split(".")[0] !== constraintMajor.replace("^", "")) {
    errors.push(`ontologyConstraint ${pack.manifest.ontologyConstraint} 与 manifest ${manifest.meta.version} major 不匹配`);
  }
  const ids = new Set<string>();
  for (const o of pack.objects) {
    if (!manifest.objectTypes[o.type]) errors.push(`对象类型未知: ${o.type}`);
    if (!UUID_RE.test(o.id)) errors.push(`对象 ${o.type} id 非 UUID: ${o.id}`);
    if (ids.has(o.id)) errors.push(`对象 id 重复: ${o.id}`);
    ids.add(o.id);
  }
  for (const l of pack.links) {
    if (!manifest.linkTypes[l.linkType]) errors.push(`linkType 未知: ${l.linkType}`);
    if (!ids.has(l.from)) errors.push(`link from 未在 pack 中定义: ${l.from}`);
    if (!ids.has(l.to)) errors.push(`link to 未在 pack 中定义: ${l.to}`);
  }
  const anchorIds = new Set(pack.anchors.map((a) => a.id));
  const docIds = new Set(pack.documents.map((d) => d.id));
  for (const a of pack.anchors) {
    if (!docIds.has(a.documentId)) errors.push(`anchor 指向未知 document: ${a.documentId}`);
  }
  for (const f of pack.facts) {
    if (f.status !== undefined && f.status !== "proposed") {
      errors.push(`pack 内 fact 只能是 proposed（治理边界）: ${f.predicate}`);
    }
    if (f.evidenceAnchorId && !anchorIds.has(f.evidenceAnchorId)) {
      errors.push(`fact 引用未知 anchor: ${f.evidenceAnchorId}`);
    }
  }
  return errors;
}

export interface PackPlan {
  fingerprint: string;
  counts: { objects: number; links: number; facts: number; documents: number; anchors: number };
}

export function planDataPack(pack: DataPack): PackPlan {
  return {
    fingerprint: pack.fingerprint,
    counts: {
      objects: pack.objects.length,
      links: pack.links.length,
      facts: pack.facts.length,
      documents: pack.documents.length,
      anchors: pack.anchors.length,
    },
  };
}

/** 事务性导入；幂等：同 fingerprint 已 applied 直接返回 skipped。 */
export async function applyDataPack(
  pool: pg.Pool,
  manifest: RuntimeManifest,
  pack: DataPack,
  opts: { dryRun?: boolean; actorId?: string } = {},
): Promise<{ status: "applied" | "skipped" | "dry-run"; jobId?: string; plan: PackPlan }> {
  const errors = validateDataPack(pack, manifest);
  if (errors.length > 0) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `Data Pack 校验失败: ${errors.join("; ")}`, errors);
  }
  const plan = planDataPack(pack);
  if (opts.dryRun) return { status: "dry-run", plan };

  const ctx: ActorContext = {
    tenantId: pack.manifest.tenantId,
    workspaceId: pack.manifest.workspaceId,
    actorId: opts.actorId ?? "datapack-loader",
    roles: ["dataSteward"],
    correlationId: `pack-${pack.fingerprint.slice(0, 12)}`,
  };

  const { withTx } = await import("../db/client");
  return withTx(pool, ctx, async (client) => {
    // 幂等：fingerprint 已 applied
    const done = await client.query(
      `SELECT id FROM ingest_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND connector_id=$3 AND batch_id=$4 AND status='applied'`,
      [ctx.tenantId, ctx.workspaceId, pack.manifest.id, pack.fingerprint],
    );
    if (done.rows.length > 0) {
      return { status: "skipped", jobId: done.rows[0].id, plan } as const;
    }
    const job = await client.query(
      `INSERT INTO ingest_jobs (tenant_id, workspace_id, connector_id, pack_fingerprint, batch_id, status, stats, created_by)
       VALUES ($1,$2,$3,$4,$4,'pending',$5,$6)
       ON CONFLICT (tenant_id, workspace_id, connector_id, batch_id) DO UPDATE SET status='pending'
       RETURNING id`,
      [ctx.tenantId, ctx.workspaceId, pack.manifest.id, pack.fingerprint, JSON.stringify(plan.counts), ctx.actorId],
    );
    const jobId = job.rows[0].id;
    const releaseId = await ensureRelease(client, manifest, ctx.actorId);

    for (const d of pack.documents) {
      await client.query(
        `INSERT INTO documents (id, tenant_id, workspace_id, uri, sha256, media_type, version, captured_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, workspace_id, sha256, version) DO NOTHING`,
        [d.id, ctx.tenantId, ctx.workspaceId, d.uri, d.sha256, d.mediaType, d.version, d.capturedAt, ctx.actorId],
      );
      await recordIngest(client, ctx, jobId, `document:${d.id}`, "Document", "applied");
    }
    for (const a of pack.anchors) {
      await client.query(
        `INSERT INTO evidence_anchors (id, tenant_id, workspace_id, document_id, locator_type, locator, excerpt_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, workspace_id, id) DO NOTHING`,
        [a.id, ctx.tenantId, ctx.workspaceId, a.documentId, a.locatorType, JSON.stringify(a.locator), a.excerptHash ?? null],
      );
      await recordIngest(client, ctx, jobId, `anchor:${a.id}`, "EvidenceAnchor", "applied");
    }
    for (const o of pack.objects) {
      const exists = await client.query(
        `SELECT 1 FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND object_type=$3 AND id=$4`,
        [ctx.tenantId, ctx.workspaceId, o.type, o.id],
      );
      if (exists.rows.length > 0) {
        await recordIngest(client, ctx, jobId, `object:${o.id}`, o.type, "skipped");
        continue;
      }
      // 来源等级记录在 ingest_jobs/audit（connector_id=pack id），不混入业务对象字段
      await createObject(client, ctx, manifest, releaseId, o.type, o.data, o.id);
      await recordIngest(client, ctx, jobId, `object:${o.id}`, o.type, "applied");
    }
    for (const l of pack.links) {
      const exists = await client.query(
        `SELECT 1 FROM link_records WHERE tenant_id=$1 AND workspace_id=$2 AND link_type=$3 AND from_id=$4 AND to_id=$5 AND superseded_at IS NULL`,
        [ctx.tenantId, ctx.workspaceId, l.linkType, l.from, l.to],
      );
      if (exists.rows.length > 0) {
        await recordIngest(client, ctx, jobId, `link:${l.linkType}:${l.from}->${l.to}`, l.linkType, "skipped");
        continue;
      }
      await createLink(client, ctx, manifest, releaseId, l.linkType, l.from, l.to);
      await recordIngest(client, ctx, jobId, `link:${l.linkType}:${l.from}->${l.to}`, l.linkType, "applied");
    }
    for (const f of pack.facts) {
      await client.query(
        `INSERT INTO fact_assertions (tenant_id, workspace_id, ontology_release, subject_type, subject_id, predicate, object_value, status, evidence_anchor_id, asserted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9)`,
        [ctx.tenantId, ctx.workspaceId, releaseId, f.subjectType, f.subjectId, f.predicate, JSON.stringify(f.objectValue), f.evidenceAnchorId ?? null, `pack:${pack.manifest.id}`],
      );
      await recordIngest(client, ctx, jobId, `fact:${f.subjectId}:${f.predicate}`, "FactAssertion", "applied");
    }
    await client.query(
      `UPDATE ingest_jobs SET status='applied', completed_at=now() WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
      [ctx.tenantId, ctx.workspaceId, jobId],
    );
    await client.query(
      `INSERT INTO audit_events (tenant_id, workspace_id, actor_id, action, entity_type, entity_id, detail, correlation_id)
       VALUES ($1,$2,$3,'datapack.apply','DataPack',$4,$5,$6)`,
      [ctx.tenantId, ctx.workspaceId, ctx.actorId, pack.manifest.id, JSON.stringify(plan), ctx.correlationId],
    );
    return { status: "applied", jobId, plan } as const;
  });
}

async function recordIngest(
  client: pg.PoolClient,
  ctx: ActorContext,
  jobId: string,
  key: string,
  type: string,
  status: "applied" | "skipped" | "failed",
  error?: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO ingest_records (job_id, tenant_id, workspace_id, record_key, record_type, status, error, applied_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6='failed' THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id, workspace_id, job_id, record_key) DO NOTHING`,
    [jobId, ctx.tenantId, ctx.workspaceId, key, type, status, error ? JSON.stringify(error) : null],
  );
}

/** 列出 pack 目录（seed CLI 用） */
export function listPackFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml")).sort();
}
