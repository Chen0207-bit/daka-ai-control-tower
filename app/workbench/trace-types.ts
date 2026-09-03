/**
 * 前端最小 Trace DTO —— 预期对齐 Runtime 分支将暴露的 `GET /v1/traces/:traceId`
 * 与 `/v1/actions/:actionId/execute`（dryRun）。契约未上线前由 mock adapter 兜底，
 * 所有 mock 数据在 UI 上强制标注「DEMO/MOCK」，不伪装真实落库。
 */

export type TraceStageStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** 11 阶段执行流水线（action execute 的标准阶段序） */
export const TRACE_STAGE_IDS = [
  "authorize",
  "validateInput",
  "loadTarget",
  "concurrencyCheck",
  "plan",
  "rules",
  "policyExplain",
  "factAssertions",
  "sqlDiff",
  "projectionRefresh",
  "outboxCommit",
] as const;

export type TraceStageId = (typeof TRACE_STAGE_IDS)[number];

export const TRACE_STAGE_LABELS: Record<TraceStageId, string> = {
  authorize: "1 · 授权检查",
  validateInput: "2 · 输入校验",
  loadTarget: "3 · 加载目标对象",
  concurrencyCheck: "4 · 乐观锁检查",
  plan: "5 · 生成执行计划",
  rules: "6 · Rule 求值",
  policyExplain: "7 · Policy 解释",
  factAssertions: "8 · 事实断言写入",
  sqlDiff: "9 · SQL Diff",
  projectionRefresh: "10 · 投影刷新",
  outboxCommit: "11 · Outbox / 审计提交",
};

export interface TraceStage {
  id: TraceStageId;
  status: TraceStageStatus;
  /** 为什么需要这一步（业务语言） */
  why: string;
  /** 这一步如何产生结果（机制语言） */
  how: string;
  artifacts?: Record<string, string>;
}

export interface TraceSubgraphNode {
  id: string;
  type: string;
  label: string;
}

export interface TraceSubgraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface TraceDoc {
  traceId: string;
  actionId: string;
  targetId: string;
  /** dry-run 不产生落库副作用；commit 才写入规范事实库 */
  mode: "dryRun" | "commit";
  status: "running" | "succeeded" | "failed";
  stages: TraceStage[];
  /** 当前 action 涉及的本体子图（默认只展示子图，避免全图毛线球） */
  subgraph: { nodes: TraceSubgraphNode[]; edges: TraceSubgraphEdge[] };
  yamlSource?: string;
  canonicalIR?: string;
  policyExplain?: string;
  ruleExplain?: string;
  factDiff?: Array<{ op: "create" | "update"; subject: string; predicate: string; value: string }>;
  sqlDiff?: string;
  projectionDiff?: string;
  audit?: Array<{ at: string; actor: string; action: string; entity: string }>;
  outbox?: Array<{ eventId: string; type: string; status: string }>;
}

export interface PaymentObligationView {
  id: string;
  label: string;
  amount: string;
  dueAt: string;
  status: string;
}
