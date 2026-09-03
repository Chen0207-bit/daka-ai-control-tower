/**
 * 查询管线客户端 DTO —— 镜像 @daka/ontology-runtime 的 QueryTrace。
 * stage 列表必须与 runtime QUERY_STAGES 完全一致（契约测试强制）。
 */

export const QUERY_STAGES = [
  "intent.parse",
  "time.resolve",
  "entity.resolve",
  "plan",
  "query.execute",
  "rules.evaluate",
  "validate",
  "answer.generate",
] as const;
export type QueryStage = (typeof QUERY_STAGES)[number];

export type QueryIntent = "contracts" | "payments" | "rights" | "chain" | "none";

export interface QuerySpan {
  stage: QueryStage;
  status: "ok" | "failed" | "skipped";
  startedAt: string;
  durationMs: number;
  attributes: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface GraphNode { id: string; type: string; label: string }
export interface GraphEdge { linkType: string; from: string; to: string; fromType: string; toType: string }

export interface QueryTrace {
  schemaVersion: 1;
  question: string;
  intent: QueryIntent;
  params: Record<string, string>;
  answeredAt: string;
  durationMs: number;
  spans: QuerySpan[];
  touchedObjects: GraphNode[];
  touchedLinks: GraphEdge[];
  sql: string;
  dataSourceNote: string;
  answer: string;
  answerGenerated: boolean;
}

export interface GraphView {
  objects: GraphNode[];
  links: GraphEdge[];
}

export interface QueryStageDef {
  id: QueryStage;
  label: string;
  why: string;
  how: string;
}

export const QUERY_STAGE_DEFS: QueryStageDef[] = [
  { id: "intent.parse", label: "1 · 意图解析", why: "先判断用户到底想要哪类事实：账单、合同、权利还是链路。", how: "关键词/GLM 路由到 4 个白名单只读查询之一，附命中的意图关键词。" },
  { id: "time.resolve", label: "2 · 时间解析", why: "「过去三年/去年/今年」需要落到可执行的日期范围。", how: "正则提取时间短语并按今天推算 from/to；无显式时间则不限。" },
  { id: "entity.resolve", label: "3 · 实体解析", why: "合同编号、IP 名、账单尾号要先定位成查询条件。", how: "正则 + ILIKE 匹配合同编号/主体关键字/账单 id。" },
  { id: "plan", label: "4 · 约束化 plan", why: "把解析结果收敛成一个受约束的查询计划，杜绝自由 SQL。", how: "从 4 个白名单查询函数中选一，并生成参数；模型无权写 SQL。" },
  { id: "query.execute", label: "5 · 执行查询", why: "真正从 PostgreSQL 取事实，并解析触及的对象与关系用于高亮。", how: "只读 SELECT（daka_runtime + RLS），再由触及对象解析子图。" },
  { id: "rules.evaluate", label: "6 · 规则引擎", why: "派生口径（如逾期）需要和经营投影一致，不能各算各的。", how: "逾期=到期已过且未结清，与 paymentCalendar 投影同口径；未触发则跳过。" },
  { id: "validate", label: "7 · 结果校验", why: "确认返回的行结构完整、金额可解析、无幽灵引用。", how: "逐行校验 id 存在、金额可解析；失败即标记，不静默。" },
  { id: "answer.generate", label: "8 · 生成答案", why: "把行结果组织成一句可读的中文回答，附证据。", how: "确定性模板组合（不编造数字）；数字全部来自 SQL 结果。" },
];
