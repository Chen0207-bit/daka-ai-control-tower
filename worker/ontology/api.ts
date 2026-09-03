import manifestJson from "../../ontology/.generated/ontology.manifest.json";
import {
  assertSupported,
  authorizeFact,
  authorizeLinkCreate,
  authorizeLinkRead,
  FACT_RESOURCE,
  bossActionInbox,
  buildDataPack,
  buildHandlers,
  contractRiskList,
  createLink,
  createObject,
  createPool,
  derivedResolvers,
  ensureRelease,
  evaluatePolicy,
  executeAction,
  factTargetLoader,
  listFacts,
  listLinks,
  listObjects,
  marketRecommendation,
  maskFactRecord,
  maskRecord,
  materializeFindings,
  paymentCalendar,
  proposeFact,
  rejectFact,
  runRules,
  signatureOverview,
  supersedeFact,
  validateDataPack,
  planDataPack,
  applyDataPack,
  verifyFact,
  withTx,
  RUNTIME_ERRORS,
  RuntimeError,
  type ActorContext,
  type RuntimeManifest,
} from "@daka/ontology-runtime";
import { makeContext } from "@daka/ontology-runtime";
import type pg from "pg";
import { createWorkerPool } from "./pool";

/**
 * Ontology Runtime API（Cloudflare Worker 装配层）。
 * 核心逻辑全部在 @daka/ontology-runtime（可独立测试）；本文件只做环境适配与路由。
 * manifest 在构建期内联（编译产物，禁止运行时解释原始 YAML）。
 */

const manifest = manifestJson as unknown as RuntimeManifest;
assertSupported(manifest);

export interface OntologyEnv {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string; // 本地 dev 直连接口（可选）
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: jsonHeaders });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 演示部署的 actor 上下文来自请求头（无真实 IdP；生产接入时替换为 SSO 校验）。 */
function actorFromHeaders(request: Request): ActorContext {
  const h = request.headers;
  const tenantId = h.get("x-tenant-id") ?? "d0000000-0000-4000-8000-000000000001";
  const workspaceId = h.get("x-workspace-id") ?? "d0000000-0000-4000-8000-000000000002";
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(workspaceId)) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "x-tenant-id / x-workspace-id 必须是 UUID");
  }
  const roles = (h.get("x-actor-roles") ?? "executiveViewer")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return makeContext({
    tenantId,
    workspaceId,
    actorId: h.get("x-actor-id") ?? "demo-viewer",
    roles,
    correlationId: h.get("x-correlation-id") ?? undefined,
  });
}

function httpStatusFor(code: string): number {
  if (code.includes("403")) return 403;
  if (code.includes("404")) return 404;
  if (code.includes("409")) return 409;
  if (code.includes("422")) return 422;
  if (code.includes("400")) return 400;
  return 500;
}

function errorResponse(err: unknown): Response {
  if (err instanceof RuntimeError) {
    return json({ error: { code: err.code, message: err.message } }, httpStatusFor(err.code));
  }
  // PostgreSQL 唯一约束冲突 → 409（不含内部细节）
  if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
    return json({ error: { code: "ONTO-409-CONFLICT", message: "记录已存在（唯一约束）" } }, 409);
  }
  console.error(JSON.stringify({ event: "ontology_api_error", error: err instanceof Error ? err.message : String(err) }));
  return json({ error: { code: "ONTO-500-INTERNAL", message: "内部错误" } }, 500);
}

function getPool(env: OntologyEnv): pg.Pool {
  if (env.HYPERDRIVE?.connectionString) return createWorkerPool(env.HYPERDRIVE.connectionString);
  if (env.DATABASE_URL) return createPool(env.DATABASE_URL);
  throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "Ontology Runtime 未配置数据库连接（HYPERDRIVE/DATABASE_URL）");
}

const PROJECTION_FNS: Record<string, (pool: pg.Pool, ctx: ActorContext, m: RuntimeManifest) => Promise<unknown>> = {
  contractRiskList,
  paymentCalendar,
  signatureOverview,
  bossActionInbox,
  marketRecommendation,
};

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "请求体必须是 JSON object");
  }
}

/** 路由匹配；返回 undefined 表示非 /v1 路径。 */
export async function handleOntologyApi(request: Request, env: OntologyEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/v1/") && !path.startsWith("/health/")) return undefined;

  try {
    if (path === "/health/live") return json({ status: "live" });
    if (path === "/health/ready") {
      try {
        const pool = getPool(env);
        await pool.query("SELECT 1");
        return json({ status: "ready", ontology: manifest.meta.version, fingerprint: manifest.fingerprint });
      } catch (err) {
        return json({ status: "not_ready", error: err instanceof Error ? err.message : String(err) }, 503);
      }
    }

    const ctx = actorFromHeaders(request);
    const pool = getPool(env);

    if (path === "/v1/meta/ontology" && request.method === "GET") {
      return json({
        name: manifest.meta.name,
        version: manifest.meta.version,
        dsl: manifest.meta.dsl,
        fingerprint: manifest.fingerprint,
        counts: {
          objectTypes: Object.keys(manifest.objectTypes).length,
          linkTypes: Object.keys(manifest.linkTypes).length,
          actions: Object.keys(manifest.actions).length,
          rules: Object.keys(manifest.rules).length,
          policies: Object.keys(manifest.policies).length,
          projections: Object.keys(manifest.projections).length,
        },
      });
    }

    if (path === "/v1/objects" && request.method === "GET") {
      const type = url.searchParams.get("type");
      if (!type) throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "缺 type 参数");
      const policy = evaluatePolicy(manifest, ctx, type, "read");
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const items = await withTx(pool, ctx, (c) => listObjects(c, ctx, type));
      // 字段级遮罩在响应边界统一生效（compiled manifest 驱动；deny 优先），与投影读路径一致
      return json({ items: items.map((r) => ({ ...r, data: maskRecord(manifest, ctx, type, r.data) })) });
    }

    if (path === "/v1/objects" && request.method === "POST") {
      const body = await readJson(request);
      const type = String(body.type ?? "");
      // FactAssertion 是治理资源（状态迁移经 /v1/facts），不得经普通对象路由创建
      if (type === FACT_RESOURCE) {
        throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "FactAssertion 是治理资源，请使用 /v1/facts 提交/治理事实");
      }
      const data = (body.data ?? {}) as Record<string, unknown>;
      const policy = evaluatePolicy(manifest, ctx, type, "write");
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const created = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        return createObject(c, ctx, manifest, releaseId, type, data, typeof body.id === "string" ? body.id : undefined);
      });
      // 创建回显同样走遮罩：写权限不隐含敏感字段读权限
      return json({ ...created, data: maskRecord(manifest, ctx, type, created.data) }, 201);
    }

    if (path === "/v1/links" && request.method === "GET") {
      const linkType = url.searchParams.get("linkType") ?? undefined;
      const policy = authorizeLinkRead(manifest, ctx, linkType);
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const items = await withTx(pool, ctx, (c) =>
        listLinks(c, ctx, {
          linkType,
          fromId: url.searchParams.get("fromId") ?? undefined,
          toId: url.searchParams.get("toId") ?? undefined,
        }),
      );
      return json({ items });
    }

    if (path === "/v1/links" && request.method === "POST") {
      const body = await readJson(request);
      const linkType = String(body.linkType);
      if (!manifest.linkTypes[linkType]) throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `linkType "${linkType}" 不在 manifest 中`);
      const policy = authorizeLinkCreate(manifest, ctx, linkType);
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const created = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        await createLink(c, ctx, manifest, releaseId, linkType, String(body.from), String(body.to));
        return { ok: true };
      });
      return json(created, 201);
    }

    if (path === "/v1/facts" && request.method === "GET") {
      const policy = authorizeFact(manifest, ctx, "read");
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const items = await withTx(pool, ctx, (c) =>
        listFacts(c, ctx, {
          status: url.searchParams.get("status") ?? undefined,
          subjectId: url.searchParams.get("subjectId") ?? undefined,
        }),
      );
      // 事实值遮罩在响应边界逐条生效（subjectType+predicate → compiled manifest 字段级 policy）；
      // 只影响 JSON 响应，不改变数据库存储值/审核状态/证据引用/审计链
      return json({ items: items.map((f) => maskFactRecord(manifest, ctx, f)) });
    }

    if (path === "/v1/facts" && request.method === "POST") {
      const body = await readJson(request);
      const policy = authorizeFact(manifest, ctx, "propose");
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const fact = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        return proposeFact(c, ctx, manifest, releaseId, {
          subjectType: String(body.subjectType),
          subjectId: String(body.subjectId),
          predicate: String(body.predicate),
          objectValue: body.objectValue,
          confidence: typeof body.confidence === "number" ? body.confidence : undefined,
          evidenceAnchorId: typeof body.evidenceAnchorId === "string" ? body.evidenceAnchorId : undefined,
        });
      });
      return json(fact, 201);
    }

    const factAction = /^\/v1\/facts\/([0-9a-f-]{36})\/(verify|reject|supersede)$/.exec(path);
    if (factAction && request.method === "POST") {
      const [, factId, verb] = factAction;
      const policy = authorizeFact(manifest, ctx, verb as "verify" | "reject" | "supersede");
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const body = await readJson(request);
      const result = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        if (verb === "verify") {
          await verifyFact(c, ctx, factId, typeof body.reviewComment === "string" ? body.reviewComment : undefined);
          return { id: factId, status: "verified" };
        }
        if (verb === "reject") {
          await rejectFact(c, ctx, factId, String(body.rejectionReason ?? ""));
          return { id: factId, status: "rejected" };
        }
        const repl = body.replacementFact as { predicate: string; objectValue: unknown; evidenceAnchorId: string };
        const newId = await supersedeFact(c, ctx, manifest, releaseId, factId, repl, String(body.reason ?? ""));
        return { oldId: factId, newId, status: "superseded" };
      });
      return json(result);
    }

    const actionExec = /^\/v1\/actions\/([a-z][A-Za-z0-9]*)\/execute$/.exec(path);
    if (actionExec && request.method === "POST") {
      const body = await readJson(request);
      const result = await executeAction(
        pool,
        manifest,
        { handlers: buildHandlers(), derived: derivedResolvers, targetLoaders: { FactAssertion: factTargetLoader } },
        ctx,
        actionExec[1],
        {
          targetId: String(body.targetId),
          input: (body.input ?? {}) as Record<string, unknown>,
          idempotencyKey: String(body.idempotencyKey ?? ""),
          expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
        },
      );
      return json(result);
    }

    const proj = /^\/v1\/projections\/([a-z][A-Za-z0-9]*)$/.exec(path);
    if (proj && request.method === "GET") {
      const fn = PROJECTION_FNS[proj[1]];
      if (!fn) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `projection "${proj[1]}" 不存在`);
      const data = await fn(pool, ctx, manifest);
      return json(data);
    }

    if (path === "/v1/ingest/validate" && request.method === "POST") {
      const body = await request.json();
      const pack = buildDataPack(body as Parameters<typeof buildDataPack>[0]);
      const errors = validateDataPack(pack, manifest);
      return json({ valid: errors.length === 0, errors, plan: planDataPack(pack) });
    }

    if (path === "/v1/ingest/apply" && request.method === "POST") {
      const body = await request.json();
      const pack = buildDataPack(body as Parameters<typeof buildDataPack>[0]);
      const result = await applyDataPack(pool, manifest, pack, { actorId: ctx.actorId });
      return json(result);
    }

    const ingestJob = /^\/v1\/ingest\/jobs\/([0-9a-f-]{36})$/.exec(path);
    if (ingestJob && request.method === "GET") {
      const job = await withTx(pool, ctx, async (c) => {
        const { rows } = await c.query(
          `SELECT id, connector_id, batch_id, status, stats, created_at, completed_at FROM ingest_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`,
          [ctx.tenantId, ctx.workspaceId, ingestJob[1]],
        );
        return rows[0] ?? null;
      });
      if (!job) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, "job 不存在");
      return json(job);
    }

    if (path === "/v1/audit" && request.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
      const items = await withTx(pool, ctx, async (c) => {
        const { rows } = await c.query(
          `SELECT occurred_at, actor_id, action, entity_type, entity_id, detail, correlation_id
           FROM audit_events WHERE tenant_id=$1 AND workspace_id=$2 ORDER BY seq DESC LIMIT $3`,
          [ctx.tenantId, ctx.workspaceId, limit],
        );
        return rows;
      });
      return json({ items });
    }

    if (path === "/v1/rules/run" && request.method === "POST") {
      const result = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        const findings = await runRules(c, ctx, manifest);
        const created = await materializeFindings(c, ctx, manifest, releaseId, findings);
        return { findings: findings.length, created: created.length, items: findings };
      });
      return json(result);
    }

    // 可观测性：核心指标（API 层 latency 由 Worker 平台提供；此处为业务指标）
    if (path === "/v1/metrics" && request.method === "GET") {
      const metrics = await withTx(pool, ctx, async (c) => {
        const q = async (sql: string) => (await c.query(sql, [ctx.tenantId, ctx.workspaceId])).rows[0] as Record<string, unknown>;
        const actions = await q(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='completed')::int AS completed FROM action_runs WHERE tenant_id=$1 AND workspace_id=$2`);
        const facts = await q(`SELECT count(*) FILTER (WHERE status='proposed')::int AS proposed, count(*) FILTER (WHERE status='verified')::int AS verified FROM fact_assertions WHERE tenant_id=$1 AND workspace_id=$2`);
        const ingest = await q(`SELECT count(*)::int AS jobs, count(*) FILTER (WHERE status='failed' OR status='partial')::int AS failed FROM ingest_jobs WHERE tenant_id=$1 AND workspace_id=$2`);
        const risks = await q(`SELECT count(*)::int AS open FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='RiskFinding' AND data->>'status'='open' AND superseded_at IS NULL`);
        return {
          action_runs: actions,
          fact_review_queue: facts,
          ingest,
          open_risks: risks.open,
          projection_lag_seconds: 0, // 投影为请求时纯推导，无滞后
        };
      });
      return json(metrics);
    }

    // 数据质量报告：缺引用/负余额/证据缺失/时态冲突
    if (path === "/v1/dq/report" && request.method === "GET") {
      const report = await withTx(pool, ctx, async (c) => {
        const issues: Array<{ rule: string; count: number; samples: string[] }> = [];
        const orphanLinks = await c.query(
          `SELECT l.id FROM link_records l
           LEFT JOIN object_records f ON f.tenant_id=l.tenant_id AND f.workspace_id=l.workspace_id AND f.id=l.from_id AND f.superseded_at IS NULL
           LEFT JOIN object_records t ON t.tenant_id=l.tenant_id AND t.workspace_id=l.workspace_id AND t.id=l.to_id AND t.superseded_at IS NULL
           WHERE l.tenant_id=$1 AND l.workspace_id=$2 AND l.superseded_at IS NULL AND (f.id IS NULL OR t.id IS NULL)`,
          [ctx.tenantId, ctx.workspaceId],
        );
        if (orphanLinks.rows.length > 0) issues.push({ rule: "link_reference_missing", count: orphanLinks.rows.length, samples: orphanLinks.rows.slice(0, 5).map((r) => r.id) });
        const noEvidence = await c.query(
          `SELECT id FROM fact_assertions WHERE tenant_id=$1 AND workspace_id=$2 AND status='verified' AND evidence_anchor_id IS NULL AND review_comment IS NULL`,
          [ctx.tenantId, ctx.workspaceId],
        );
        if (noEvidence.rows.length > 0) issues.push({ rule: "verified_fact_missing_evidence", count: noEvidence.rows.length, samples: noEvidence.rows.slice(0, 5).map((r) => r.id) });
        const temporalConflict = await c.query(
          `SELECT id FROM fact_assertions WHERE tenant_id=$1 AND workspace_id=$2 AND valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_from > valid_to`,
          [ctx.tenantId, ctx.workspaceId],
        );
        if (temporalConflict.rows.length > 0) issues.push({ rule: "temporal_conflict", count: temporalConflict.rows.length, samples: temporalConflict.rows.slice(0, 5).map((r) => r.id) });
        const failedIngest = await c.query(
          `SELECT record_key FROM ingest_records WHERE tenant_id=$1 AND workspace_id=$2 AND status='failed'`,
          [ctx.tenantId, ctx.workspaceId],
        );
        if (failedIngest.rows.length > 0) issues.push({ rule: "ingest_record_failed", count: failedIngest.rows.length, samples: failedIngest.rows.slice(0, 5).map((r) => r.record_key) });
        return { checkedAt: new Date().toISOString(), issues, healthy: issues.length === 0 };
      });
      return json(report);
    }

    // ingest 错误队列（失败记录列表）
    const ingestErrors = /^\/v1\/ingest\/jobs\/([0-9a-f-]{36})\/errors$/.exec(path);
    if (ingestErrors && request.method === "GET") {
      const items = await withTx(pool, ctx, async (c) => {
        const { rows } = await c.query(
          `SELECT record_key, record_type, error FROM ingest_records WHERE tenant_id=$1 AND workspace_id=$2 AND job_id=$3 AND status='failed'`,
          [ctx.tenantId, ctx.workspaceId, ingestErrors[1]],
        );
        return rows;
      });
      return json({ items });
    }

    return json({ error: { code: "ONTO-404-NOT-FOUND", message: `未匹配路由 ${path}` } }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
