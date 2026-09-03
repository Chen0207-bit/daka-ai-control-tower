/**
 * Runtime ExecutionTrace DTO（客户端镜像，type-only，无 node 依赖）。
 * 必须随 @daka/ontology-runtime 的 trace.ts 同步演进；
 * 契约测试（app/workbench/workbench.test.tsx）会断言 stage 列表与 runtime TRACE_STAGES 完全一致。
 */

export const TRACE_SCHEMA_VERSION = 1;

/** 规范 stage 名（与 Runtime TRACE_STAGES 一一对应；前端按此顺序渲染时间线）。 */
export const RUNTIME_TRACE_STAGES = [
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

export type RuntimeTraceStage = (typeof RUNTIME_TRACE_STAGES)[number];

export type TraceSpanStatus = "ok" | "failed" | "skipped";

export type TraceMode = "execute" | "plan";

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
  /** 规范 stage 或未来新增 stage（未知 stage 前端必须兼容展示，不得丢弃） */
  stage: string;
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

/** GET /v1/traces/:traceId 响应（摘要字段 + 完整内嵌 trace）。 */
export interface StoredTrace {
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
  trace: ExecutionTrace;
}

/** GET /v1/traces 列表项（摘要级，不含 spans）。 */
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

/**
 * Action execute 响应契约：
 *  - 成功：{ runId, status, result, trace }（trace 内嵌，traceId 只从 trace.traceId 读取）
 *  - 失败：HTTP 非 2xx，body { error: {code,message}, trace }（失败链同样有内嵌 trace）
 * 顶层不再暴露独立 traceId/runId 作为 trace 定位符。
 */
export interface ExecuteActionResponse {
  runId: string | null;
  status: "completed" | "replayed" | "planned";
  result: Record<string, unknown>;
  trace: ExecutionTrace;
}
