/**
 * Trace adapter（以 Runtime DTO 为唯一事实源）：
 * - 真实模式：POST /v1/actions/:id/execute 发送 `mode: "plan" | "execute"`（绝不发送 dryRun），
 *   traceId 只从内嵌 `trace.traceId` 读取；失败响应（403/422/…）同样携带内嵌 trace，如实展示。
 *   无 trace 可用时抛出 WorkbenchApiError —— 调用方必须显式报错，禁止静默降级 MOCK。
 * - MOCK 模式：仅由用户显式选择，buildMockTrace 生成，committed 恒为 false。
 */
import type { ExecutionTrace, TraceMode, TraceSpan } from "@daka/ontology-client";
import {
  WORKBENCH_STAGES,
  type PaymentObligationView,
  type TraceDoc,
  type UiStage,
} from "./trace-types";

export class WorkbenchApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number | null,
    public readonly apiError: { code: string; message: string } | null = null,
  ) {
    super(message);
  }
}

export interface ExecuteOutcome {
  trace: TraceDoc;
  /** 非 null 表示业务层失败（denied / precondition_failed / …），trace 仍然真实 */
  apiError: { code: string; message: string } | null;
  httpStatus: number;
  result: Record<string, unknown> | null;
}

const STAGE_DEF = new Map(WORKBENCH_STAGES.map((s) => [s.id, s]));

function spanStatusToUi(status: TraceSpan["status"]): UiStage["status"] {
  return status === "ok" ? "done" : status === "failed" ? "failed" : "skipped";
}

/**
 * Runtime ExecutionTrace → UI TraceDoc（确定性映射）。
 * 已知 stage 按规范序排列；trace 中未出现的已知阶段标记 pending（失败后的阶段绝不伪成功）；
 * 未知 stage 收入 extraStages 兼容展示。
 */
export function mapRuntimeTrace(t: ExecutionTrace): TraceDoc {
  const bySpan = new Map<string, TraceSpan>();
  const extra: UiStage[] = [];
  for (const span of t.spans) {
    if (STAGE_DEF.has(span.stage)) bySpan.set(span.stage, span);
    else {
      extra.push({
        id: span.stage,
        label: `未知阶段 · ${span.stage}`,
        known: false,
        status: spanStatusToUi(span.status),
        why: "Runtime 返回了本界面尚未命名的阶段。",
        how: "兼容展示原始 span，不丢弃任何执行证据。",
        durationMs: span.durationMs,
        ...(span.error ? { error: span.error } : {}),
        attributes: span.attributes,
      });
    }
  }
  const stages: UiStage[] = WORKBENCH_STAGES.map((def) => {
    const span = bySpan.get(def.id);
    if (!span) return { id: def.id, label: def.label, known: true, status: "pending" as const, why: def.why, how: def.how };
    return {
      id: def.id,
      label: def.label,
      known: true,
      status: spanStatusToUi(span.status),
      why: def.why,
      how: def.how,
      durationMs: span.durationMs,
      ...(span.error ? { error: span.error } : {}),
      attributes: span.attributes,
    };
  });
  // 顺序以规范序为准（WORKBENCH_STAGES 迭代顺序）；同一 stage 多 span 时 Map 语义保留最后一个
  return {
    traceId: t.traceId,
    correlationId: t.correlationId,
    runId: t.runId,
    actionId: t.actionId,
    targetType: t.targetType,
    targetId: t.targetId,
    actorId: t.actorId,
    mode: t.mode,
    status: t.status,
    committed: t.committed,
    error: t.error,
    durationMs: t.durationMs,
    createdAt: t.createdAt,
    stages,
    extraStages: extra,
  };
}

export interface ApiHeaders {
  actorId: string;
  roles: string[];
  tenantId?: string;
  workspaceId?: string;
}

function buildHeaders(h: ApiHeaders): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-actor-id": h.actorId,
    "x-actor-roles": h.roles.join(","),
    ...(h.tenantId ? { "x-tenant-id": h.tenantId } : {}),
    ...(h.workspaceId ? { "x-workspace-id": h.workspaceId } : {}),
  };
}

async function parseJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractEmbeddedTrace(body: Record<string, unknown> | null): ExecutionTrace | null {
  const trace = body?.trace as ExecutionTrace | undefined;
  if (trace && typeof trace.traceId === "string" && Array.isArray(trace.spans)) return trace;
  return null;
}

/**
 * 执行 Action 并取回真实 trace。
 * - 请求体使用 `mode`（plan|execute），绝不发送 dryRun。
 * - traceId 只读内嵌 trace.traceId；顶层 traceId/runId 不作为 trace 定位符。
 * - 业务失败（403/422/409…）且带内嵌 trace：正常返回 ExecuteOutcome（apiError 非空）。
 * - 无内嵌 trace（网络失败 / 5xx / 契约违规）：抛 WorkbenchApiError，调用方必须显式报错。
 */
export async function executeWithTrace(
  baseUrl: string,
  headers: ApiHeaders,
  actionId: string,
  req: { targetId: string; input: Record<string, unknown>; idempotencyKey: string; mode: TraceMode; expectedVersion?: number },
): Promise<ExecuteOutcome> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/actions/${actionId}/execute`, {
      method: "POST",
      headers: buildHeaders(headers),
      body: JSON.stringify(req),
    });
  } catch (e) {
    throw new WorkbenchApiError(`无法连接 Ontology Runtime API：${e instanceof Error ? e.message : String(e)}`, null);
  }
  const body = await parseJson(res);
  const trace = extractEmbeddedTrace(body);
  if (!trace) {
    const apiError = (body?.error as { code: string; message: string } | undefined) ?? null;
    const detail = apiError ? `${apiError.code}: ${apiError.message}` : `HTTP ${res.status}`;
    throw new WorkbenchApiError(`真实 Runtime 响应缺少内嵌 trace（契约违规），已阻止静默降级。${detail}`, res.status, apiError);
  }
  const apiError = res.ok ? null : ((body?.error as { code: string; message: string } | undefined) ?? { code: String(res.status), message: "执行失败" });
  return {
    trace: mapRuntimeTrace(trace),
    apiError,
    httpStatus: res.status,
    result: (body?.result as Record<string, unknown> | undefined) ?? null,
  };
}

/** 刷新后按 traceId 重新打开同一 Trace（GET /v1/traces/:traceId）。 */
export async function fetchStoredTrace(baseUrl: string, headers: ApiHeaders, traceId: string): Promise<TraceDoc> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/traces/${encodeURIComponent(traceId)}`, { headers: buildHeaders(headers) });
  } catch (e) {
    throw new WorkbenchApiError(`无法连接 Ontology Runtime API：${e instanceof Error ? e.message : String(e)}`, null);
  }
  const body = await parseJson(res);
  if (!res.ok) {
    const apiError = (body?.error as { code: string; message: string } | undefined) ?? null;
    throw new WorkbenchApiError(apiError ? `${apiError.code}: ${apiError.message}` : `HTTP ${res.status}`, res.status, apiError);
  }
  const trace = extractEmbeddedTrace(body);
  if (!trace) throw new WorkbenchApiError("GET /v1/traces/:id 响应缺少内嵌 trace（契约违规）", res.status);
  return mapRuntimeTrace(trace);
}

/** 真实模式左栏：paymentCalendar 投影 → 付款义务列表。 */
export async function loadPaymentObligations(baseUrl: string, headers: ApiHeaders): Promise<PaymentObligationView[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/projections/paymentCalendar`, { headers: buildHeaders(headers) });
  } catch (e) {
    throw new WorkbenchApiError(`无法连接 Ontology Runtime API：${e instanceof Error ? e.message : String(e)}`, null);
  }
  const body = await parseJson(res);
  if (!res.ok) {
    const apiError = (body?.error as { code: string; message: string } | undefined) ?? null;
    throw new WorkbenchApiError(apiError ? `${apiError.code}: ${apiError.message}` : `HTTP ${res.status}`, res.status, apiError);
  }
  const items = (body?.items as Array<Record<string, unknown>> | undefined) ?? [];
  return items.map((it) => {
    const amount = String(it.amount ?? "0");
    const currency = String(it.currency ?? "CNY");
    const n = Number(amount);
    return {
      id: String(it.id),
      label: `付款计划 ${String(it.id).slice(-4)} · ${currency}`,
      amount: `${currency === "CNY" ? "¥" : ""}${Number.isFinite(n) ? n.toLocaleString("zh-CN") : amount} ${currency}`.trim(),
      rawAmount: amount,
      currency,
      dueAt: String(it.dueAt ?? "").slice(0, 10),
      status: String(it.status ?? "unknown"),
      settledAmount: Number(it.settledAmount ?? 0),
      unsettledAmount: Number(it.unsettledAmount ?? 0),
    };
  });
}

/** 本体元信息（fingerprint / 版本），用于 Workbench 展示编译产物指纹。 */
export async function loadOntologyMeta(baseUrl: string, headers: ApiHeaders): Promise<{ version: string; fingerprint: string }> {
  const res = await fetch(`${baseUrl}/v1/meta/ontology`, { headers: buildHeaders(headers) });
  const body = await parseJson(res);
  if (!res.ok || !body) throw new WorkbenchApiError("无法读取本体元信息", res.status);
  return { version: String(body.version ?? "?"), fingerprint: String(body.fingerprint ?? "?") };
}

// ---------------------------------------------------------------------------
// MOCK：仅用户显式选择「演示推演模式」时使用。committed 恒为 false（不写 PostgreSQL）。
// ---------------------------------------------------------------------------

export interface MockTraceOptions {
  actionId?: string;
  targetId?: string;
  amount?: string;
  mode?: TraceMode;
  seed?: number;
}

/** 确定性 mock trace：不调用任何网络，不写任何数据；全部产出物标注 MOCK。 */
export function buildMockTrace(opts: MockTraceOptions = {}): TraceDoc {
  const mode: TraceMode = opts.mode ?? "plan";
  const actionId = opts.actionId ?? "recordPayment";
  const targetId = opts.targetId ?? "mock-pay-0102";
  const amount = opts.amount ?? "500000";
  const committed = false; // MOCK 永不写入 PostgreSQL
  const stages: UiStage[] = WORKBENCH_STAGES.map((def, i) => {
    // plan 模式下 8 及以后阶段为 skipped（与真实 Runtime 行为一致）
    const skippedByPlan = mode === "plan" && ["transaction", "rules", "projection", "audit.outbox"].includes(def.id);
    const skippedWriteset = mode === "plan" && def.id === "writeset.planned";
    return {
      id: def.id,
      label: def.label,
      known: true,
      status: skippedByPlan || skippedWriteset ? ("skipped" as const) : ("done" as const),
      why: def.why,
      how: def.how,
      durationMs: 0,
      attributes: {
        mock: true,
        note: `MOCK 演示推演（seed=${opts.seed ?? 0}），未写入 PostgreSQL`,
        order: i + 1,
        ...(def.id === "action.received" ? { inputEcho: { amount, currency: "CNY" } } : {}),
      },
    };
  });
  return {
    traceId: `mock-trace-${mode}-${opts.seed ?? 0}`,
    correlationId: "mock-correlation",
    runId: null,
    actionId,
    targetType: "PaymentSchedule",
    targetId,
    actorId: "mock-finance",
    mode,
    status: mode === "plan" ? "planned" : "completed",
    committed,
    error: null,
    durationMs: 0,
    createdAt: new Date(0).toISOString(),
    stages,
    extraStages: [],
  };
}

export const MOCK_OBLIGATIONS: PaymentObligationView[] = [
  { id: "mock-pay-NU-H2", label: "纽卡斯尔联 · 年度授权费 MG 下半年度分期（MOCK）", amount: "¥610,000 CNY", rawAmount: "610000", currency: "CNY", dueAt: "2026-09-10", status: "planned" },
  { id: "mock-pay-ACM-03", label: "AC 米兰 · 人物资源第三批签名包干（MOCK）", amount: "¥460,000 CNY", rawAmount: "460000", currency: "CNY", dueAt: "2026-10-15", status: "planned" },
  { id: "mock-pay-SVC-Q3", label: "共享服务 · 海外代理协调费（MOCK）", amount: "¥86,000 CNY", rawAmount: "86000", currency: "CNY", dueAt: "2026-09-25", status: "due" },
];
