import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "./context";
import type { RuntimeManifest } from "./manifest";
import { MASKED_VALUE, maskedFields } from "./policy";

/**
 * ExecutionTrace / TraceSpan 协议（可观察本体工作台前端消费类型）。
 * 覆盖 action received → ontology resolved → policy → validation → facts loaded →
 * preconditions → writeset planned → transaction → rules → projection → audit/outbox。
 * - traceId 贯穿持久化与查询；correlationId 复用 ActorContext。
 * - 失败链的 committed 恒为 false，绝不伪造 committed。
 * - spans 持久化与 API 输出前都经过 sanitize（脱敏 + 截断 + 限深）。
 */

export const TRACE_SCHEMA_VERSION = 1;

/** 规范 stage 名；前端按此渲染时间线。 */
export const TRACE_STAGES = [
  "action.received",
  "ontology.resolved",
  "policy",
  "validation",
  "facts.loaded",
  "preconditions",
  "writeset.planned",
  "transaction",
  "rules",
  "projection",
  "audit.outbox",
] as const;

export type TraceStage = (typeof TRACE_STAGES)[number];

export type TraceSpanStatus = "ok" | "failed" | "skipped";

export type TraceMode = "execute" | "plan";

/** 终态：failed 族细分到可被前端着色；committed 只在 completed/replayed 为 true。 */
export type TraceStatus =
  | "completed"
  | "replayed"
  | "planned"
  | "denied"
  | "precondition_failed"
  | "validation_failed"
  | "not_found"
  | "failed";

export interface TraceSpan {
  stage: TraceStage;
  status: TraceSpanStatus;
  startedAt: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface ExecutionTrace {
  schemaVersion: number;
  traceId: string;
  correlationId: string;
  runId: string | null;
  actionId: string;
  targetType: string;
  targetId: string;
  tenantId: string;
  workspaceId: string;
  actorId: string;
  mode: TraceMode;
  status: TraceStatus;
  committed: boolean;
  error: { code: string; message: string } | null;
  durationMs: number;
  createdAt: string;
  spans: TraceSpan[];
}

export interface TraceWriteOp {
  op: "insert" | "update" | "delete";
  table: string;
  count: number;
}

/** 敏感键脱敏：命中的值整体替换（不保留长度/结构信息）。 */
const SENSITIVE_KEY_RE = /(passw|secret|token|apikey|api_key|authorization|cookie|credential)/i;
const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 500;

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactValue(val, depth + 1);
  }
  return out;
}

/**
 * trace 属性脱敏：
 * 1) 敏感键整体 redact；递归限深/截断（防超大 payload 打爆 trace 存储）。
 * 2) 已知 objectType 的 data 快照按 compiled manifest 字段级 policy 遮罩（复用 maskedFields）。
 */
export function sanitizeTraceAttributes(
  manifest: RuntimeManifest | null,
  ctx: Pick<ActorContext, "roles">,
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  let work = attrs;
  if (manifest) {
    const t = (attrs.targetType ?? attrs.objectType) as string | undefined;
    const data = attrs.targetData;
    if (t && manifest.objectTypes[t] && data && typeof data === "object") {
      const masked = maskedFields(manifest, ctx, t);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        out[k] = masked.has(k) ? MASKED_VALUE : v;
      }
      work = { ...attrs, targetData: out };
    }
  }
  return redactValue(work, 0) as Record<string, unknown>;
}

const STATUS_FOR_CODE: Record<string, TraceStatus> = {
  "ONTO-403-POLICY-DENY": "denied",
  "ONTO-422-PRECONDITION": "precondition_failed",
  "ONTO-400-VALIDATION": "validation_failed",
  "ONTO-404-NOT-FOUND": "not_found",
};
const FAILED_STATUSES: ReadonlySet<TraceStatus> = new Set([
  "denied",
  "precondition_failed",
  "validation_failed",
  "not_found",
  "failed",
]);

export function traceStatusForErrorCode(code: string): TraceStatus {
  return STATUS_FOR_CODE[code] ?? "failed";
}

/** committed 只允许成功终态（防御性：失败链永不伪造 committed）。 */
export function committedFor(status: TraceStatus): boolean {
  return status === "completed" || status === "replayed";
}

export function isFailedTrace(t: ExecutionTrace): boolean {
  return FAILED_STATUSES.has(t.status) ? t.committed === false : true;
}

interface OpenSpan {
  stage: TraceStage;
  startedAt: number;
  startedAtIso: string;
  attributes: Record<string, unknown>;
}

export class TraceRecorder {
  readonly traceId = randomUUID();
  private readonly createdAtMs = Date.now();
  private readonly open = new Map<TraceStage, OpenSpan>();
  private readonly spans: TraceSpan[] = [];
  private writeset = new Map<string, TraceWriteOp>();
  private auditEvents = 0;
  private outboxEvents = 0;

  constructor(
    private readonly ctx: Pick<ActorContext, "tenantId" | "workspaceId" | "actorId" | "correlationId" | "roles">,
    private readonly actionId: string,
    private readonly targetType: string,
    private readonly targetId: string,
    private readonly mode: TraceMode,
  ) {}

  start(stage: TraceStage, attributes: Record<string, unknown> = {}): void {
    this.open.set(stage, { stage, startedAt: Date.now(), startedAtIso: new Date().toISOString(), attributes });
  }

  ok(stage: TraceStage, attributes: Record<string, unknown> = {}): void {
    this.end(stage, "ok", attributes);
  }

  skip(stage: TraceStage, reason: string): void {
    this.end(stage, "skipped", { reason });
  }

  fail(stage: TraceStage, code: string, message: string, attributes: Record<string, unknown> = {}): void {
    this.end(stage, "failed", attributes, { code, message });
  }

  /** 失败路径：把所有仍打开的 span 标记为 failed（定位实际失败的阶段），未打开的不动。 */
  failOpen(code: string, message: string): void {
    for (const stage of this.open.keys()) this.fail(stage, code, message);
  }

  private end(stage: TraceStage, status: TraceSpanStatus, attributes: Record<string, unknown>, error?: { code: string; message: string }): void {
    const s = this.open.get(stage) ?? { stage, startedAt: Date.now(), startedAtIso: new Date().toISOString(), attributes: {} };
    this.open.delete(stage);
    this.spans.push({
      stage: s.stage,
      status,
      startedAt: s.startedAtIso,
      durationMs: Math.max(0, Date.now() - s.startedAt),
      attributes: { ...s.attributes, ...attributes },
      ...(error ? { error } : {}),
    });
  }

  /** 记录事务内观察到的写操作（writeset planned 阶段；按 op+table 聚合计数）。 */
  recordWrite(op: "insert" | "update" | "delete", table: string): void {
    const key = `${op}:${table}`;
    const cur = this.writeset.get(key);
    this.writeset.set(key, { op, table, count: (cur?.count ?? 0) + 1 });
  }

  recordAuditEvent(): void {
    this.auditEvents += 1;
  }

  recordOutboxEvent(): void {
    this.outboxEvents += 1;
  }

  /** 结束并产出（未脱敏的）trace；输出前必须过 sanitizeTrace。 */
  finish(status: TraceStatus, runId: string | null, error: { code: string; message: string } | null): ExecutionTrace {
    for (const s of this.open.keys()) this.skip(s, "aborted by terminal status");
    // writeset / audit 汇总 span：执行链内未显式记录时才合成
    if (!this.spans.some((s) => s.stage === "writeset.planned")) {
      const writeset = [...this.writeset.values()];
      this.spans.push({
        stage: "writeset.planned",
        status: writeset.length > 0 || status === "planned" ? "ok" : "skipped",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        attributes: { writes: writeset, note: "事务内观察到的实际写操作（op+表+次数）" },
      });
    }
    if (!this.spans.some((s) => s.stage === "audit.outbox")) {
      this.spans.push({
        stage: "audit.outbox",
        status: this.auditEvents + this.outboxEvents > 0 ? "ok" : "skipped",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        attributes: { auditEvents: this.auditEvents, outboxEvents: this.outboxEvents },
      });
    }
    return {
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId: this.traceId,
      correlationId: this.ctx.correlationId,
      runId,
      actionId: this.actionId,
      targetType: this.targetType,
      targetId: this.targetId,
      tenantId: this.ctx.tenantId,
      workspaceId: this.ctx.workspaceId,
      actorId: this.ctx.actorId,
      mode: this.mode,
      status,
      committed: committedFor(status),
      error,
      durationMs: Math.max(0, Date.now() - this.createdAtMs),
      createdAt: new Date(this.createdAtMs).toISOString(),
      spans: this.spans,
    };
  }
}

export function sanitizeTrace(manifest: RuntimeManifest | null, ctx: Pick<ActorContext, "roles">, trace: ExecutionTrace): ExecutionTrace {
  return { ...trace, spans: trace.spans.map((s) => ({ ...s, attributes: sanitizeTraceAttributes(manifest, ctx, s.attributes) })) };
}

/** 包装 PoolClient：拦截写语句生成 writeset 计数（只读语句不记录）。 */
export function instrumentClient(client: pg.PoolClient, recorder: TraceRecorder): pg.PoolClient {
  const proxied = Object.create(client) as pg.PoolClient;
  const original = client.query.bind(client) as pg.PoolClient["query"];
  const wrapped = ((queryTextOrConfig: unknown, values?: unknown) => {
    const sql = typeof queryTextOrConfig === "string" ? queryTextOrConfig : String((queryTextOrConfig as { text?: string })?.text ?? "");
    const m = /\b(?:insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)/i.exec(sql);
    if (m) {
      const verb = /^insert/i.test(sql.trim()) ? "insert" : /^update/i.test(sql.trim()) ? "update" : "delete";
      recorder.recordWrite(verb, m[1]);
      if (m[1] === "audit_events") recorder.recordAuditEvent();
      if (m[1] === "outbox_events") recorder.recordOutboxEvent();
    }
    return (original as (q: unknown, v?: unknown) => ReturnType<pg.PoolClient["query"]>)(queryTextOrConfig, values);
  }) as pg.PoolClient["query"];
  proxied.query = wrapped;
  return proxied;
}

/** trace 持久化：独立事务、尽力而为；trace 写失败不影响业务结果（不向上抛）。 */
export async function persistTraceSafe(pool: pg.Pool, trace: ExecutionTrace, actorRoles: string[]): Promise<void> {
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [trace.tenantId]);
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [trace.workspaceId]);
      await client.query(
        `INSERT INTO action_traces
           (trace_id, tenant_id, workspace_id, run_id, action_type, actor_id, actor_roles,
            target_type, target_id, mode, status, error_code, committed, duration_ms, correlation_id, trace)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          trace.traceId, trace.tenantId, trace.workspaceId, trace.runId, trace.actionId, trace.actorId,
          actorRoles, trace.targetType, trace.targetId, trace.mode, trace.status, trace.error?.code ?? null,
          trace.committed, trace.durationMs, trace.correlationId, JSON.stringify(trace),
        ],
      );
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
      throw new Error("trace persist failed");
    } finally {
      client.release();
    }
  } catch {
    // 尽力而为：trace 持久化失败不回滚业务事务，也不向上抛
  }
}

export interface TraceQuery {
  traceId?: string;
  correlationId?: string;
  actionId?: string;
  status?: string;
  limit?: number;
}

export interface TraceSummary {
  traceId: string;
  runId: string | null;
  actionType: string;
  actorId: string;
  targetType: string;
  targetId: string | null;
  mode: string;
  status: string;
  errorCode: string | null;
  committed: boolean;
  durationMs: number;
  correlationId: string;
  createdAt: string;
}

export interface StoredTraceRow extends TraceSummary {
  trace: ExecutionTrace;
}

/** 持久化 trace 查询（列表不含 spans，摘要级；单条详情返回完整 trace）。 */
export async function queryTraces(client: pg.PoolClient, ctx: ActorContext, q: TraceQuery): Promise<TraceSummary[]> {
  const conditions = ["tenant_id=$1", "workspace_id=$2"];
  const params: unknown[] = [ctx.tenantId, ctx.workspaceId];
  if (q.traceId) { params.push(q.traceId); conditions.push(`trace_id=$${params.length}`); }
  if (q.correlationId) { params.push(q.correlationId); conditions.push(`correlation_id=$${params.length}`); }
  if (q.actionId) { params.push(q.actionId); conditions.push(`action_type=$${params.length}`); }
  if (q.status) { params.push(q.status); conditions.push(`status=$${params.length}`); }
  params.push(Math.min(Math.max(q.limit ?? 50, 1), 500));
  const { rows } = await client.query(
    `SELECT trace_id, run_id, action_type, actor_id, target_type, target_id, mode, status,
            error_code, committed, duration_ms, correlation_id, created_at
     FROM action_traces WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    traceId: r.trace_id, runId: r.run_id, actionType: r.action_type, actorId: r.actor_id,
    targetType: r.target_type, targetId: r.target_id, mode: r.mode, status: r.status,
    errorCode: r.error_code, committed: r.committed, durationMs: r.duration_ms,
    correlationId: r.correlation_id, createdAt: r.created_at,
  }));
}

export async function getTrace(client: pg.PoolClient, ctx: ActorContext, traceId: string): Promise<StoredTraceRow | null> {
  const { rows } = await client.query(
    `SELECT trace_id, run_id, action_type, actor_id, target_type, target_id, mode, status,
            error_code, committed, duration_ms, correlation_id, created_at, trace
     FROM action_traces WHERE tenant_id=$1 AND workspace_id=$2 AND trace_id=$3`,
    [ctx.tenantId, ctx.workspaceId, traceId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    traceId: r.trace_id, runId: r.run_id, actionType: r.action_type, actorId: r.actor_id,
    targetType: r.target_type, targetId: r.target_id, mode: r.mode, status: r.status,
    errorCode: r.error_code, committed: r.committed, durationMs: r.duration_ms,
    correlationId: r.correlation_id, createdAt: r.created_at, trace: r.trace as ExecutionTrace,
  };
}
