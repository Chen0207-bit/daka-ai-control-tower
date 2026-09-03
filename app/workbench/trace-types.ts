/**
 * Workbench UI Trace 模型 —— 以 Runtime ExecutionTrace DTO 为唯一事实源。
 * Runtime spans（action.received / ontology.resolved / policy / ...）经 trace-adapter
 * 确定性映射为本模型的 UI 阶段；未知 stage 进入 extraStages 兼容展示，不得丢弃。
 * MOCK 演示数据只在用户显式选择「演示推演模式」时由 buildMockTrace 生成，
 * 且 committed 恒为 false（MOCK 不产生任何 PostgreSQL 写入）。
 */
import type { ExecutionTrace, TraceMode, TraceStatus } from "@daka/ontology-client";

export type UiStageStatus = "pending" | "done" | "failed" | "skipped";

export interface WorkbenchStageDef {
  /** 与 Runtime span.stage 同名 */
  id: string;
  label: string;
  /** 为什么需要这一步（业务语言） */
  why: string;
  /** 这一步如何产生结果（机制语言） */
  how: string;
}

/** 11 个规范阶段：id 顺序与 Runtime TRACE_STAGES 完全一致（契约测试强制）。 */
export const WORKBENCH_STAGES: WorkbenchStageDef[] = [
  { id: "action.received", label: "1 · 接收动作", why: "每一次业务点击都要落成可审计的动作请求。", how: "Worker API 接收 actionId/targetId/input/idempotencyKey/mode，生成 traceId 贯穿全链路。" },
  { id: "ontology.resolved", label: "2 · 解析本体与 Action", why: "前端不直接解释业务语义，Runtime 只信编译产物。", how: "按编译后的 Canonical IR 解析 action 定义：target 类型、注册 handler、允许角色。" },
  { id: "policy", label: "3 · Policy 授权", why: "确认当前操作者有权执行该动作，防止越权改写账目。", how: "编译后的 policy 模型按 actor 角色匹配 allow 规则；拒绝时动作停在本阶段、零写入。" },
  { id: "validation", label: "4 · 输入校验", why: "金额、币种、日期缺失或非法会让台账失真。", how: "按 IR 中 action 的 input 声明逐字段校验（必填、未知输入、idempotencyKey）。" },
  { id: "facts.loaded", label: "5 · 加载目标与幂等检查", why: "付款必须挂在正确的付款计划上，重复提交不得重复入账。", how: "按 targetId 从 PostgreSQL 加载对象并校验乐观锁版本；idempotencyKey 命中则直接 replay。" },
  { id: "preconditions", label: "6 · 前置条件", why: "币种不符、计划已结清等业务约束必须在写入前阻断。", how: "受限 AST 逐条求值（非 eval）；失败返回 422，业务写入为 0。" },
  { id: "writeset.planned", label: "7 · 写集计划", why: "让 DBA/审计能核对这次动作改了哪些表。", how: "事务内拦截写语句，按 op+表聚合计数；plan 模式下恒为空（零写入）。" },
  { id: "transaction", label: "8 · 事务执行", why: "付款、状态重算必须同生共死，不允许半成功。", how: "execute 模式在单事务内执行注册 handler；plan 模式为只读事务，绝不执行 handler。" },
  { id: "rules", label: "9 · Rule 求值", why: "结清状态、逾期标记等派生判断由规则推导而非手填。", how: "规则物化由 /v1/rules/run 独立执行（受限 AST），本阶段如实标注其安排。" },
  { id: "projection", label: "10 · 投影刷新", why: "经营视图读投影，需要知道它会不会变、怎么变。", how: "投影为请求时纯推导（无物化写入）；execute 后重新查询即可见新口径。" },
  { id: "audit.outbox", label: "11 · 审计 / Outbox", why: "跨系统通知与审计回执不能丢，拒绝也要留痕。", how: "业务写入与 audit/outbox 同事务提交；correlationId 关联 Action、Audit、Outbox。" },
];

export interface UiStage {
  id: string;
  label: string;
  /** false = Runtime 返回了未知 stage，兼容展示而非丢弃 */
  known: boolean;
  status: UiStageStatus;
  why: string;
  how: string;
  durationMs?: number;
  error?: { code: string; message: string };
  attributes?: Record<string, unknown>;
}

/** Workbench 展示的 Trace 文档：字段语义与 Runtime ExecutionTrace 一致。 */
export interface TraceDoc {
  traceId: string;
  correlationId: string;
  runId: string | null;
  actionId: string;
  targetType: string;
  targetId: string;
  actorId: string;
  /** plan = dry-run（零写入）；execute = 真实提交 */
  mode: TraceMode;
  status: TraceStatus;
  /** 仅 completed/replayed 为 true；MOCK 恒为 false */
  committed: boolean;
  error: { code: string; message: string } | null;
  durationMs: number;
  createdAt: string;
  /** 规范阶段（含未到达的 pending），按 WORKBENCH_STAGES 顺序 */
  stages: UiStage[];
  /** Runtime 返回的未知 stage：兼容展示，不丢失 */
  extraStages: UiStage[];
}

export type { ExecutionTrace };

/** 左侧业务对象：真实模式来自 paymentCalendar 投影，MOCK 模式来自演示列表。 */
export interface PaymentObligationView {
  id: string;
  label: string;
  /** 展示用金额（已格式化） */
  amount: string;
  /** execute 输入用原始金额字符串 */
  rawAmount: string;
  currency: string;
  dueAt: string;
  status: string;
  settledAmount?: number;
  unsettledAmount?: number;
}
