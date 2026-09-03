import { createHash } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "../context";
import { RUNTIME_ERRORS, RuntimeError } from "../errors";
import type { RuntimeManifest } from "../manifest";
import { evaluatePolicy } from "../policy";
import { evaluateRule } from "../rules/evaluator";
import { ensureRelease, getObject, writeAudit, writeOutbox, type ObjectRecord } from "../repository";
import {
  committedFor,
  instrumentClient,
  persistTraceSafe,
  sanitizeTrace,
  traceStatusForErrorCode,
  TraceRecorder,
  type ExecutionTrace,
  type TraceMode,
} from "../trace";

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
  /** plan = dry-run：完整走 policy/validation/facts/preconditions，但绝不落库（无 handler 副作用）。 */
  mode?: TraceMode;
}

export interface ExecuteResult {
  runId: string | null;
  status: "completed" | "replayed" | "planned";
  result: Record<string, unknown>;
}

export async function executeAction(
  pool: pg.Pool,
  manifest: RuntimeManifest,
  opts: ActionEngineOptions,
  ctx: ActorContext,
  actionId: string,
  req: ExecuteRequest,
  recorder?: TraceRecorder,
): Promise<ExecuteResult> {
  const mode: TraceMode = req.mode ?? "execute";
  const rec = recorder;
  rec?.start("action.received", { actionId, targetId: req.targetId, mode, inputKeys: Object.keys(req.input) });
  const fingerprint = inputFingerprint(actionId, req.targetId, req.input);
  rec?.ok("action.received", { idempotencyKeyProvided: Boolean(req.idempotencyKey) });

  const action = manifest.actions[actionId];
  if (!action) {
    rec?.fail("ontology.resolved", RUNTIME_ERRORS.NOT_FOUND, `action "${actionId}" 不在 manifest 中`);
    throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `action "${actionId}" 不在 manifest 中`);
  }
  rec?.start("ontology.resolved");
  const handler = opts.handlers[action.handler];
  if (!handler) {
    rec?.fail("ontology.resolved", RUNTIME_ERRORS.UNKNOWN_HANDLER, `handler "${action.handler}" 未注册`);
    throw new RuntimeError(RUNTIME_ERRORS.UNKNOWN_HANDLER, `handler "${action.handler}" 未注册`);
  }
  rec?.ok("ontology.resolved", { targetType: action.target, handler: action.handler, actorRoles: action.actorRoles });

  // authorize（应用层；RLS 兜底）
  rec?.start("policy");
  const decision = evaluatePolicy(manifest, ctx, action.target, actionId);
  if (!decision.allowed) {
    rec?.fail("policy", RUNTIME_ERRORS.POLICY_DENY, decision.reason ?? "policy deny", { policyId: decision.policyId });
    throw new RuntimeError(RUNTIME_ERRORS.POLICY_DENY, `403: ${decision.reason}`, { policyId: decision.policyId });
  }
  if (!action.actorRoles.some((r) => ctx.roles.includes(r))) {
    rec?.fail("policy", RUNTIME_ERRORS.POLICY_DENY, `角色不在 action.actorRoles [${action.actorRoles.join(", ")}]`, { actorRoles: ctx.roles });
    throw new RuntimeError(RUNTIME_ERRORS.POLICY_DENY, `403: 角色不在 action.actorRoles [${action.actorRoles.join(", ")}]`);
  }
  rec?.ok("policy", { policyId: decision.policyId });

  // 输入校验（manifest 声明的 inputs）
  rec?.start("validation", { inputKeys: Object.keys(req.input) });
  const inputErrors: string[] = [];
  for (const [name, prop] of Object.entries(action.inputs)) {
    const v = req.input[name];
    if ((v === undefined || v === null) && prop.required) inputErrors.push(`${name}: 必填`);
  }
  for (const key of Object.keys(req.input)) {
    if (!(key in action.inputs)) inputErrors.push(`${key}: 未知输入`);
  }
  if (inputErrors.length > 0) {
    rec?.fail("validation", RUNTIME_ERRORS.VALIDATION, inputErrors.join("; "), { errors: inputErrors });
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `action 输入校验失败: ${inputErrors.join("; ")}`, inputErrors);
  }
  if (action.idempotent && !req.idempotencyKey) {
    rec?.fail("validation", RUNTIME_ERRORS.VALIDATION, "该 action 要求 idempotencyKey");
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "该 action 要求 idempotencyKey");
  }
  rec?.ok("validation");

  const { withTx } = await import("../db/client");
  return withTx(
    pool,
    ctx,
    async (client) => {
      rec?.start("transaction", { mode });
      rec?.start("facts.loaded", { targetId: req.targetId });
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
          rec?.fail("facts.loaded", RUNTIME_ERRORS.IDEMPOTENCY_REPLAY_MISMATCH, `idempotencyKey "${req.idempotencyKey}" 已用于不同载荷`);
          throw new RuntimeError(RUNTIME_ERRORS.IDEMPOTENCY_REPLAY_MISMATCH, `idempotencyKey "${req.idempotencyKey}" 已用于不同载荷`);
        }
        rec?.ok("facts.loaded", { replay: true, runId: row.id });
        rec?.ok("transaction", { replay: true });
        rec?.skip("preconditions", "replay：此前已验证");
        return { runId: row.id, status: "replayed", result: row.result ?? {} };
      }

      const loader = opts.targetLoaders?.[action.target];
      const target = loader
        ? await loader(client, ctx, req.targetId)
        : await getObject(client, ctx, action.target, req.targetId);
      if (!target) {
        rec?.fail("facts.loaded", RUNTIME_ERRORS.NOT_FOUND, `${action.target} ${req.targetId} 不存在`);
        throw new RuntimeError(RUNTIME_ERRORS.NOT_FOUND, `${action.target} ${req.targetId} 不存在`);
      }
      if (req.expectedVersion !== undefined && target.version !== req.expectedVersion) {
        rec?.fail("facts.loaded", RUNTIME_ERRORS.VERSION_CONFLICT, `版本冲突: 期望 ${req.expectedVersion}，实际 ${target.version}`);
        throw new RuntimeError(RUNTIME_ERRORS.VERSION_CONFLICT, `版本冲突: 期望 ${req.expectedVersion}，实际 ${target.version}`);
      }
      rec?.ok("facts.loaded", { targetType: action.target, version: target.version, loader: loader ? "custom" : "object_records" });

      // preconditions（受限 AST；target.* 支持 derived 解析器）
      rec?.start("preconditions", { count: action.preconditions.length });
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
          rec?.fail("preconditions", RUNTIME_ERRORS.PRECONDITION_FAILED, `前置条件未满足: ${JSON.stringify(pc)}`);
          throw new RuntimeError(RUNTIME_ERRORS.PRECONDITION_FAILED, `前置条件未满足: ${JSON.stringify(pc)}`);
        }
      }
      rec?.ok("preconditions");

      // plan / dry-run：到此为止的全量检查已完成，但绝不执行 handler、绝不写库
      if (mode === "plan") {
        rec?.ok("transaction", { readOnly: true, note: "dry-run：只读事务，未执行任何写操作" });
        rec?.skip("writeset.planned", "dry-run 不产生写集");
        rec?.skip("rules", "dry-run 不触发规则物化");
        rec?.skip("projection", "dry-run 不触发投影");
        rec?.skip("audit.outbox", "dry-run 不写 audit/outbox");
        return { runId: null, status: "planned", result: { planned: true, targetVersion: target.version } };
      }

      // effects（handler 在同一事务内执行）；release 取当前 manifest 对应登记
      const releaseId = await ensureRelease(client, manifest, ctx.actorId);
      const result = (await handler({ client, ctx, manifest, releaseId, actionId, target, input: req.input })) ?? {};
      rec?.ok("transaction", { releaseId });

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
      // 规则物化与投影在 action 事务外独立执行（/v1/rules/run 与请求时投影），如实标注
      rec?.skip("rules", "规则物化由 /v1/rules/run 独立执行，不在 action 事务内");
      rec?.skip("projection", "投影为请求时纯推导，无物化写入");
      return { runId: run.rows[0].id, status: "completed", result };
    },
    rec ? (c) => instrumentClient(c, rec) : undefined,
  );
}

export interface TracedActionResult {
  ok: boolean;
  result?: ExecuteResult;
  error?: { code: string; message: string };
  trace: ExecutionTrace;
}

/**
 * 可观察执行入口：创建 TraceRecorder 贯穿全链路，结束/失败后脱敏持久化 trace（尽力而为）。
 * 失败不抛出——错误语义进 trace（status/error），由调用方决定 HTTP 语义；失败链 committed 恒为 false。
 */
export async function executeTracedAction(
  pool: pg.Pool,
  manifest: RuntimeManifest,
  opts: ActionEngineOptions,
  ctx: ActorContext,
  actionId: string,
  req: ExecuteRequest,
): Promise<TracedActionResult> {
  const mode: TraceMode = req.mode ?? "execute";
  const target = manifest.actions[actionId];
  const recorder = new TraceRecorder(ctx, actionId, target?.target ?? "unknown", req.targetId, mode);
  let outcome: TracedActionResult | null = null;
  try {
    const result = await executeAction(pool, manifest, opts, ctx, actionId, req, recorder);
    const status = result.status === "planned" ? "planned" : result.status;
    const trace = recorder.finish(status, result.runId, null);
    outcome = { ok: true, result, trace };
  } catch (err) {
    const code = err instanceof RuntimeError ? err.code : "ONTO-500-INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    recorder.failOpen(code, message);
    const trace = recorder.finish(traceStatusForErrorCode(code), null, { code, message });
    outcome = { ok: false, error: { code, message }, trace };
  }
  const sanitized = sanitizeTrace(manifest, ctx, outcome.trace);
  if (sanitized.committed === committedFor(sanitized.status)) {
    // 状态一致才持久化（防御：失败链不写 committed=true 的 trace）
    await persistTraceSafe(pool, sanitized, ctx.roles);
  }
  return outcome;
}
