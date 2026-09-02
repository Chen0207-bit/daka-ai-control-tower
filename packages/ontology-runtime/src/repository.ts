import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "./context";
import { RUNTIME_ERRORS, RuntimeError } from "./errors";
import type { RuntimeManifest } from "./manifest";
import { validateInstance } from "./validate-instance";

/** 登记（或复用）ontology release，返回其 id。同一事务内调用。同 name+version 再发布会更新指纹与 manifest。 */
export async function ensureRelease(client: pg.PoolClient, manifest: RuntimeManifest, actorId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ontology_releases (name, version, fingerprint, manifest, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name, version) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, manifest = EXCLUDED.manifest
     RETURNING id`,
    [manifest.meta.name, manifest.meta.version, manifest.fingerprint, JSON.stringify(manifest), actorId],
  );
  return rows[0].id;
}

export async function writeAudit(
  client: pg.PoolClient,
  ctx: ActorContext,
  action: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (tenant_id, workspace_id, actor_id, action, entity_type, entity_id, detail, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.tenantId, ctx.workspaceId, ctx.actorId, action, entityType, entityId, JSON.stringify(detail), ctx.correlationId],
  );
}

export async function writeOutbox(
  client: pg.PoolClient,
  ctx: ActorContext,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, workspace_id, event_type, payload, correlation_id) VALUES ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, ctx.workspaceId, eventType, JSON.stringify(payload), ctx.correlationId],
  );
}

export interface ObjectRecord {
  id: string;
  objectType: string;
  version: number;
  data: Record<string, unknown>;
  recordedAt: string;
  supersededAt: string | null;
}

export async function createObject(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
  releaseId: string,
  objectType: string,
  data: Record<string, unknown>,
  id?: string,
): Promise<ObjectRecord> {
  const clean = validateInstance(manifest, objectType, data);
  const objectId = id ?? (typeof data.id === "string" ? data.id : randomUUID());
  const { rows } = await client.query(
    `INSERT INTO object_records (id, tenant_id, workspace_id, ontology_release, object_type, data, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING version, recorded_at, superseded_at`,
    [objectId, ctx.tenantId, ctx.workspaceId, releaseId, objectType, JSON.stringify(clean), ctx.actorId],
  );
  await writeAudit(client, ctx, "object.create", objectType, objectId, { data: clean });
  await writeOutbox(client, ctx, "object.created", { objectType, id: objectId });
  return { id: objectId, objectType, version: rows[0].version, data: clean, recordedAt: rows[0].recorded_at, supersededAt: rows[0].superseded_at };
}

export async function getObject(
  client: pg.PoolClient,
  ctx: ActorContext,
  objectType: string,
  id: string,
): Promise<ObjectRecord | null> {
  const { rows } = await client.query(
    `SELECT version, data, recorded_at, superseded_at FROM object_records
     WHERE tenant_id=$1 AND workspace_id=$2 AND object_type=$3 AND id=$4 AND superseded_at IS NULL`,
    [ctx.tenantId, ctx.workspaceId, objectType, id],
  );
  if (rows.length === 0) return null;
  return { id, objectType, version: rows[0].version, data: rows[0].data, recordedAt: rows[0].recorded_at, supersededAt: rows[0].superseded_at };
}

/** 乐观锁更新；expectedVersion 不匹配抛 409。 */
export async function updateObject(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
  objectType: string,
  id: string,
  patch: Record<string, unknown>,
  expectedVersion?: number,
): Promise<ObjectRecord> {
  const current = await getObject(client, ctx, objectType, id);
  if (!current) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `${objectType} ${id} 不存在`);
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new RuntimeError(RUNTIME_ERRORS.VERSION_CONFLICT, `版本冲突: 期望 ${expectedVersion}，实际 ${current.version}`);
  }
  const t = manifest.objectTypes[objectType];
  if (!t) throw new RuntimeError(RUNTIME_ERRORS.UNKNOWN_TYPE, objectType);
  for (const key of Object.keys(patch)) {
    const prop = t.properties[key];
    if (prop?.immutable && key !== "id") {
      throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `${key} 是 immutable 字段`);
    }
  }
  const merged = { ...current.data, ...patch };
  const clean = validateInstance(manifest, objectType, merged);
  const { rows } = await client.query(
    `UPDATE object_records SET data=$5, version=version+1, updated_by=$6, updated_at=now()
     WHERE tenant_id=$1 AND workspace_id=$2 AND object_type=$3 AND id=$4 AND version=${expectedVersion ?? current.version} AND superseded_at IS NULL
     RETURNING version, recorded_at, superseded_at`,
    [ctx.tenantId, ctx.workspaceId, objectType, id, JSON.stringify(clean), ctx.actorId],
  );
  if (rows.length === 0) {
    throw new RuntimeError(RUNTIME_ERRORS.VERSION_CONFLICT, `并发冲突: ${objectType} ${id}`);
  }
  await writeAudit(client, ctx, "object.update", objectType, id, { patch, version: rows[0].version });
  await writeOutbox(client, ctx, "object.updated", { objectType, id, version: rows[0].version });
  return { id, objectType, version: rows[0].version, data: clean, recordedAt: rows[0].recorded_at, supersededAt: rows[0].superseded_at };
}

export async function listObjects(
  client: pg.PoolClient,
  ctx: ActorContext,
  objectType: string,
  opts: { limit?: number } = {},
): Promise<ObjectRecord[]> {
  const { rows } = await client.query(
    `SELECT id, version, data, recorded_at, superseded_at FROM object_records
     WHERE tenant_id=$1 AND workspace_id=$2 AND object_type=$3 AND superseded_at IS NULL
     ORDER BY created_at ASC LIMIT $4`,
    [ctx.tenantId, ctx.workspaceId, objectType, opts.limit ?? 500],
  );
  return rows.map((r) => ({ id: r.id, objectType, version: r.version, data: r.data, recordedAt: r.recorded_at, supersededAt: r.superseded_at }));
}

/** 创建关系：校验 linkType 端点与基数（同事务 SELECT ... FOR UPDATE 防并发）。 */
export async function createLink(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
  releaseId: string,
  linkType: string,
  fromId: string,
  toId: string,
): Promise<void> {
  const lt = manifest.linkTypes[linkType];
  if (!lt) throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `linkType "${linkType}" 不在 manifest 中`);
  const resolvesTo = (endpoint: string, actualType: string): boolean => {
    if (endpoint === actualType) return true;
    // 端点是 interface 时，实现类型均可
    return Object.entries(manifest.objectTypes).some(
      ([id, t]) => id === actualType && t.implements.includes(endpoint),
    );
  };
  const fromObj = await client.query(
    `SELECT object_type FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND superseded_at IS NULL FOR UPDATE`,
    [ctx.tenantId, ctx.workspaceId, fromId],
  );
  const toObj = await client.query(
    `SELECT object_type FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 AND superseded_at IS NULL FOR UPDATE`,
    [ctx.tenantId, ctx.workspaceId, toId],
  );
  if (fromObj.rows.length === 0 || toObj.rows.length === 0) {
    throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `link 端点对象不存在（禁止幽灵关系）`);
  }
  if (!resolvesTo(lt.from, fromObj.rows[0].object_type) || !resolvesTo(lt.to, toObj.rows[0].object_type)) {
    throw new RuntimeError(
      RUNTIME_ERRORS.VALIDATION,
      `link 端点类型不匹配: 期望 ${lt.from}→${lt.to}，实际 ${fromObj.rows[0].object_type}→${toObj.rows[0].object_type}`,
    );
  }
  if (lt.cardinality === "one_to_many" || lt.cardinality === "one_to_one") {
    const dup = await client.query(
      `SELECT 1 FROM link_records WHERE tenant_id=$1 AND workspace_id=$2 AND link_type=$3 AND to_id=$4 AND superseded_at IS NULL`,
      [ctx.tenantId, ctx.workspaceId, linkType, toId],
    );
    if (dup.rows.length > 0) {
      throw new RuntimeError(RUNTIME_ERRORS.CARDINALITY, `${linkType} 基数 ${lt.cardinality}：to 端 ${toId} 已有关系`);
    }
  }
  if (lt.cardinality === "many_to_one" || lt.cardinality === "one_to_one") {
    const dup = await client.query(
      `SELECT 1 FROM link_records WHERE tenant_id=$1 AND workspace_id=$2 AND link_type=$3 AND from_id=$4 AND superseded_at IS NULL`,
      [ctx.tenantId, ctx.workspaceId, linkType, fromId],
    );
    if (dup.rows.length > 0) {
      throw new RuntimeError(RUNTIME_ERRORS.CARDINALITY, `${linkType} 基数 ${lt.cardinality}：from 端 ${fromId} 已有关系`);
    }
  }
  await client.query(
    `INSERT INTO link_records (tenant_id, workspace_id, ontology_release, link_type, from_type, from_id, to_type, to_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.tenantId, ctx.workspaceId, releaseId, linkType, fromObj.rows[0].object_type, fromId, toObj.rows[0].object_type, toId, ctx.actorId],
  );
  await writeAudit(client, ctx, "link.create", linkType, `${fromId}->${toId}`, {});
  await writeOutbox(client, ctx, "link.created", { linkType, fromId, toId });
}

export async function listLinks(
  client: pg.PoolClient,
  ctx: ActorContext,
  opts: { linkType?: string; fromId?: string; toId?: string } = {},
): Promise<Array<{ linkType: string; fromType: string; fromId: string; toType: string; toId: string }>> {
  const conditions = ["tenant_id=$1", "workspace_id=$2", "superseded_at IS NULL"];
  const params: unknown[] = [ctx.tenantId, ctx.workspaceId];
  if (opts.linkType) { params.push(opts.linkType); conditions.push(`link_type=$${params.length}`); }
  if (opts.fromId) { params.push(opts.fromId); conditions.push(`from_id=$${params.length}`); }
  if (opts.toId) { params.push(opts.toId); conditions.push(`to_id=$${params.length}`); }
  const { rows } = await client.query(
    `SELECT link_type, from_type, from_id, to_type, to_id FROM link_records WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return rows.map((r) => ({ linkType: r.link_type, fromType: r.from_type, fromId: r.from_id, toType: r.to_type, toId: r.to_id }));
}
