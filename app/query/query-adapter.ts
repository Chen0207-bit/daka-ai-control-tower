/**
 * 查询工作台 adapter：调用真实 Worker /v1/query 与 /v1/graph。
 * 失败明确报错（QueryWorkbenchError），绝不降级 MOCK。
 */
import type { GraphView, QueryTrace } from "./query-types";

export class QueryWorkbenchError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
  }
}

export interface QueryHeaders {
  actorId: string;
  roles: string[];
  tenantId?: string;
  workspaceId?: string;
}

function buildHeaders(h: QueryHeaders): Record<string, string> {
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
    const b: unknown = await res.json();
    return typeof b === "object" && b !== null ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function runQuestion(baseUrl: string, headers: QueryHeaders, question: string): Promise<QueryTrace> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/query`, { method: "POST", headers: buildHeaders(headers), body: JSON.stringify({ question }) });
  } catch (e) {
    throw new QueryWorkbenchError(`无法连接 Ontology Runtime：${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await parseJson(res);
  if (!res.ok || !body) {
    const err = (body?.error as { code?: string; message?: string } | undefined);
    throw new QueryWorkbenchError(err ? `${err.code}: ${err.message}` : `HTTP ${res.status}`, res.status);
  }
  if (!Array.isArray(body.spans) || typeof body.answer !== "string") {
    throw new QueryWorkbenchError("查询响应缺少 spans/answer（契约违规）", res.status);
  }
  return body as unknown as QueryTrace;
}

export async function loadGraph(baseUrl: string, headers: QueryHeaders): Promise<GraphView> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/graph`, { headers: buildHeaders(headers) });
  } catch (e) {
    throw new QueryWorkbenchError(`无法连接 Ontology Runtime：${e instanceof Error ? e.message : String(e)}`);
  }
  const body = await parseJson(res);
  if (!res.ok || !body) throw new QueryWorkbenchError(`HTTP ${res.status}`, res.status);
  return { objects: (body.objects ?? []) as GraphView["objects"], links: (body.links ?? []) as GraphView["links"] };
}
