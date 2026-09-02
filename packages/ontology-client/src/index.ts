/**
 * Ontology Runtime typed client。浏览器只访问同源 Worker /v1/*，不持有数据库凭证。
 * 演示部署的 actor 通过请求头声明；生产接入时由 SSO 会话替换。
 */

export interface ClientOptions {
  baseUrl?: string;
  actorId?: string;
  roles?: string[];
  tenantId?: string;
  workspaceId?: string;
}

export interface ApiError {
  code: string;
  message: string;
}

export class OntologyApiError extends Error {
  constructor(public readonly status: number, public readonly apiError: ApiError) {
    super(`${apiError.code}: ${apiError.message}`);
  }
}

export interface PaymentCalendarItem {
  id: string;
  amount: string;
  currency: string;
  dueAt: string;
  status: string;
  triggerCondition?: string;
  settledAmount: number;
  unsettledAmount: number;
  isOverdue: boolean;
}

export interface PaymentCalendar {
  projection: "paymentCalendar";
  items: PaymentCalendarItem[];
  totals: { unsettledAmount: number; overdueAmount: number };
}

export interface SignatureLotView {
  id: string;
  lotNumber: string;
  receivedQuantity: number;
  buckets: { received: number; available: number; allocated: number; consumed: number; returned: number };
}

export interface SignatureOverview {
  projection: "signatureOverview";
  entitlements: Array<{ id: string; grantedQuantity: number; unit: string }>;
  lots: SignatureLotView[];
  totals: { available: number; allocated: number; consumed: number };
}

export interface BossInboxItem {
  kind: "risk" | "payment_overdue" | "release_recommendation";
  id: string;
  severity?: string;
  title?: string;
  amount?: number;
  type?: string;
  demo: boolean;
}

export interface FactView {
  id: string;
  subjectType: string;
  subjectId: string;
  predicate: string;
  objectValue: unknown;
  status: "proposed" | "verified" | "rejected" | "superseded";
  evidenceAnchorId: string | null;
  recordedAt: string;
  assertedBy: string;
}

export interface RecommendationView {
  id: string;
  recommendationType: string;
  status: string;
  rationale: string;
  createdBy: string;
  createdAt: string;
  reviewComment?: string;
}

export interface AuditEventView {
  occurred_at: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: Record<string, unknown>;
  correlation_id: string;
}

export interface ExecuteResultView {
  runId: string;
  status: "completed" | "replayed";
  result: Record<string, unknown>;
}

export function createOntologyClient(opts: ClientOptions = {}) {
  const base = opts.baseUrl ?? "";
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    "x-actor-id": opts.actorId ?? "demo-viewer",
    "x-actor-roles": (opts.roles ?? ["executiveViewer"]).join(","),
    ...(opts.tenantId ? { "x-tenant-id": opts.tenantId } : {}),
    ...(opts.workspaceId ? { "x-workspace-id": opts.workspaceId } : {}),
  });

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...headers(), ...(init?.headers as Record<string, string> | undefined) } });
    const body: unknown = await res.json();
    if (!res.ok) {
      const err = (body as { error?: ApiError }).error ?? { code: String(res.status), message: "请求失败" };
      throw new OntologyApiError(res.status, err);
    }
    return body as T;
  }

  return {
    meta: () => call<{ name: string; version: string; fingerprint: string; counts: Record<string, number> }>("/v1/meta/ontology"),
    paymentCalendar: () => call<PaymentCalendar>("/v1/projections/paymentCalendar"),
    signatureOverview: () => call<SignatureOverview>("/v1/projections/signatureOverview"),
    bossActionInbox: () => call<{ projection: string; items: BossInboxItem[] }>("/v1/projections/bossActionInbox"),
    marketRecommendation: () => call<{ observations: unknown[]; recommendations: RecommendationView[] }>("/v1/projections/marketRecommendation"),
    contractRiskList: () => call<{ risks: Array<Record<string, unknown> & { id: string }>; rightsGrants: unknown[] }>("/v1/projections/contractRiskList"),
    listFacts: (status?: string) => call<{ items: FactView[] }>(`/v1/facts${status ? `?status=${status}` : ""}`),
    verifyFact: (id: string, reviewComment?: string) =>
      call(`/v1/facts/${id}/verify`, { method: "POST", body: JSON.stringify({ reviewComment }) }),
    rejectFact: (id: string, rejectionReason: string) =>
      call(`/v1/facts/${id}/reject`, { method: "POST", body: JSON.stringify({ rejectionReason }) }),
    executeAction: (actionId: string, req: { targetId: string; input: Record<string, unknown>; idempotencyKey: string; expectedVersion?: number }) =>
      call<ExecuteResultView>(`/v1/actions/${actionId}/execute`, { method: "POST", body: JSON.stringify(req) }),
    audit: (limit = 50) => call<{ items: AuditEventView[] }>(`/v1/audit?limit=${limit}`),
    health: () => call<{ status: string; fingerprint?: string }>("/health/ready"),
  };
}

export type OntologyClient = ReturnType<typeof createOntologyClient>;
