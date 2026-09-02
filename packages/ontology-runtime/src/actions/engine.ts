import { createHash } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "../context";
import { RUNTIME_ERRORS, RuntimeError } from "../errors";
import type { RuntimeManifest } from "../manifest";
import { evaluatePolicy } from "../policy";
import { evaluateRule } from "../rules/evaluator";
import { ensureRelease, getObject, writeAudit, writeOutbox, type ObjectRecord } from "../repository";

/**
 * Action Runtime（spec §7, 02_ARCHITECTURE §5）。
 * 执行顺序: authenticate context → authorize → validate input → idempotency →
 * load target/expected version → preconditions → handler effects → audit/outbox。
 * handler 只能来自注册表；DSL/客户端不得注入 effect。
 */

export interface HandlerContext {
  client: pg.PoolClient;
  ctx: ActorContext;
  manifest: RuntimeManifest;
  releaseId: string;
  actionId: string;
  target: ObjectRecord;
  input: Record<string, unknown>;
}

export type ActionHandler = (h: HandlerContext) => Promise<Record<string, unknown> | void>;

/** 派生字段解析器：precondition/rule 中的 target.availableQuantity 等。 */
export type DerivedResolver = (client: pg.PoolClient, ctx: ActorContext, targetId: string) => Promise<unknown>;

export interface ActionEngineOptions {
  handlers: Record<string, ActionHandler>;
  derived?: Record<string, Record<string, DerivedResolver>>;
  /** 非 object_records 存储的 target（如 FactAssertion）的加载器 */
  targetLoaders?: Record<string, (client: pg.PoolClient, ctx: ActorContext, id: string) => Promise<ObjectRecord | null>>;
}

/** 规范化序列化（key 排序），避免 jsonb 重排键导致的幂等误判。 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function inputFingerprint(actionId: string, targetId: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ actionId, input, targetId })).digest("hex");
}

export interface ExecuteRequest {
  targetId: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  expectedVersion?: number;
}

export interface ExecuteResult {
  runId: string;
  status: "completed" | "replayed";
  result: Record<string, unknown>;
}

export async function executeAction(
  pool: pg.Pool,
  manifest: RuntimeManifest,
  opts: ActionEngineOptions,
  ctx: ActorContext,
  actionId: string,
  req: ExecuteRequest,
): Promise<ExecuteResult> {
  const action = manifest.actions[actionId];
  if (!action) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `action "${actionId}" 不在 manifest 中`);

  // authorize（应用层；RLS 兜底）
  const decision = evaluatePolicy(manifest, ctx, action.target, actionId);
  if (!decision.allowed) {
    throw new RuntimeError(RUNTIME_ERRORS.POLICY_DENY, `403: ${decision.reason}`, { policyId: decision.policyId });
  }
  if (!action.actorRoles.some((r) => ctx.roles.includes(r))) {
    throw new RuntimeError(RUNTIME_ERRORS.POLICY_DENY, `403: 角色不在 action.actorRoles [${action.actorRoles.join(", ")}]`);
  }

  const handler = opts.handlers[action.handler];
  if (!handler) {
    throw new RuntimeError(RUNTIME_ERRORS.UNKNOWN_HANDLER, `handler "${action.handler}" 未注册`);
  }

  // 输入校验（manifest 声明的 inputs）
  const inputErrors: string[] = [];
  for (const [name, prop] of Object.entries(action.inputs)) {
    const v = req.input[name];
    if ((v === undefined || v === null) && prop.required) inputErrors.push(`${name}: 必填`);
  }
  for (const key of Object.keys(req.input)) {
    if (!(key in action.inputs)) inputErrors.push(`${key}: 未知输入`);
  }
  if (inputErrors.length > 0) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `action 输入校验失败: ${inputErrors.join("; ")}`, inputErrors);
  }
  if (action.idempotent && !req.idempotencyKey) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "该 action 要求 idempotencyKey");
  }

  const fingerprint = inputFingerprint(actionId, req.targetId, req.input);

  const { withTx } = await import("../db/client");
  return withTx(pool, ctx, async (client) => {
    // 幂等：同 key 直接返回已存结果；同 key 不同载荷 → 409
    const existing = await client.query(
      `SELECT id, result, input, target_id FROM action_runs
       WHERE tenant_id=$1 AND workspace_id=$2 AND idempotency_key=$3`,
      [ctx.tenantId, ctx.workspaceId, req.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const samePayload = inputFingerprint(actionId, row.target_id, row.input) === fingerprint;
      if (!samePayload) {
        throw new RuntimeError(RUNTIME_ERRORS.IDEMPOTENCY_REPLAY_MISMATCH, `idempotencyKey "${req.idempotencyKey}" 已用于不同载荷`);
      }
      return { runId: row.id, status: "replayed", result: row.result ?? {} };
    }

    const loader = opts.targetLoaders?.[action.target];
    const target = loader
      ? await loader(client, ctx, req.targetId)
      : await getObject(client, ctx, action.target, req.targetId);
    if (!target) throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `${action.target} ${req.targetId} 不存在`);
    if (req.expectedVersion !== undefined && target.version !== req.expectedVersion) {
      throw new RuntimeError(RUNTIME_ERRORS.VERSION_CONFLICT, `版本冲突: 期望 ${req.expectedVersion}，实际 ${target.version}`);
    }

    // preconditions（受限 AST；target.* 支持 derived 解析器）
    const resolve = (path: string): unknown => {
      const [root, ...rest] = path.split(".");
      const leaf = rest.join(".");
      if (root === "input") return req.input[leaf];
      if (root === "target") {
        if (leaf in target.data) return target.data[leaf];
        return undefined; // derived 在异步层处理
      }
      return undefined;
    };
    // 异步 derived 预取
    const derivedCache = new Map<string, unknown>();
    const derivedResolvers = opts.derived?.[action.target] ?? {};
    const collectDerivedPaths = (node: unknown, out: string[]): void => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      for (const k of ["path", "valuePath"] as const) {
        const v = n[k];
        if (typeof v === "string" && v.startsWith("target.")) {
          const leaf = v.slice("target.".length);
          if (!(leaf in target.data) && leaf in derivedResolvers) out.push(leaf);
        }
      }
      if (Array.isArray(n.args)) n.args.forEach((c) => collectDerivedPaths(c, out));
      if (n.arg !== undefined) collectDerivedPaths(n.arg, out);
    };
    const derivedPaths: string[] = [];
    for (const pc of action.preconditions) collectDerivedPaths(pc, derivedPaths);
    for (const leaf of derivedPaths) {
      derivedCache.set(leaf, await derivedResolvers[leaf](client, ctx, req.targetId));
    }
    const resolveFull = (path: string): unknown => {
      const v = resolve(path);
      if (v !== undefined) return v;
      if (path.startsWith("target.")) return derivedCache.get(path.slice("target.".length));
      return undefined;
    };

    for (const pc of action.preconditions) {
      if (!evaluateRule(pc, resolveFull)) {
        throw new RuntimeError(RUNTIME_ERRORS.PRECONDITION_FAILED, `前置条件未满足: ${JSON.stringify(pc)}`);
      }
    }

    // effects（handler 在同一事务内执行）；release 取当前 manifest 对应登记
    const releaseId = await ensureRelease(client, manifest, ctx.actorId);
    const result = (await handler({ client, ctx, manifest, releaseId, actionId, target, input: req.input })) ?? {};

    const run = await client.query(
      `INSERT INTO action_runs (tenant_id, workspace_id, idempotency_key, action_type, actor_id, actor_roles, target_type, target_id, input, expected_version, status, result, correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12) RETURNING id`,
      [
        ctx.tenantId, ctx.workspaceId, req.idempotencyKey, actionId, ctx.actorId, ctx.roles,
        action.target, req.targetId, JSON.stringify(req.input), req.expectedVersion ?? null,
        JSON.stringify(result), ctx.correlationId,
      ],
    );
    await writeAudit(client, ctx, `action.${actionId}`, action.target, req.targetId, { input: req.input, result });
    await writeOutbox(client, ctx, "action.executed", { actionId, targetId: req.targetId, runId: run.rows[0].id });
    return { runId: run.rows[0].id, status: "completed", result };
  });
}
