import manifestJson from "../../ontology/.generated/ontology.manifest.json";
import {
  assertSupported,
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
      return json({ items });
    }

    if (path === "/v1/objects" && request.method === "POST") {
      const body = await readJson(request);
      const type = String(body.type ?? "");
      const data = (body.data ?? {}) as Record<string, unknown>;
      const policy = evaluatePolicy(manifest, ctx, type, "write");
      if (!policy.allowed) return json({ error: { code: RUNTIME_ERRORS.POLICY_DENY, message: policy.reason } }, 403);
      const created = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        return createObject(c, ctx, manifest, releaseId, type, data, typeof body.id === "string" ? body.id : undefined);
      });
      return json(created, 201);
    }

    if (path === "/v1/links" && request.method === "GET") {
      const items = await withTx(pool, ctx, (c) =>
        listLinks(c, ctx, {
          linkType: url.searchParams.get("linkType") ?? undefined,
          fromId: url.searchParams.get("fromId") ?? undefined,
          toId: url.searchParams.get("toId") ?? undefined,
        }),
      );
      return json({ items });
    }

    if (path === "/v1/links" && request.method === "POST") {
      const body = await readJson(request);
      const created = await withTx(pool, ctx, async (c) => {
        const releaseId = await ensureRelease(c, manifest, ctx.actorId);
        await createLink(c, ctx, manifest, releaseId, String(body.linkType), String(body.from), String(body.to));
        return { ok: true };
      });
      return json(created, 201);
    }

    if (path === "/v1/facts" && request.method === "GET") {
      const items = await withTx(pool, ctx, (c) =>
        listFacts(c, ctx, {
          status: url.searchParams.get("status") ?? undefined,
          subjectId: url.searchParams.get("subjectId") ?? undefined,
        }),
      );
      return json({ items });
    }

    if (path === "/v1/facts" && request.method === "POST") {
      const body = await readJson(request);
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

    return json({ error: { code: "ONTO-404-NOT-FOUND", message: `未匹配路由 ${path}` } }, 404);
  } catch (err) {
    return errorResponse(err);
  }
}
