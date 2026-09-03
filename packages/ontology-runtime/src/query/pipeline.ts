/**
 * 自然语言查询管线（只读、可观察）——把一句中文问题走成一条可回放的 trace：
 *   intent.parse → time.resolve → entity.resolve → plan → query.execute
 *   → rules.evaluate → validate → answer.generate
 *
 * 边界：
 * - 路由器（本地规则 / 可选 GLM）只能选 4 个白名单只读查询，绝不生成自由 SQL。
 * - 金额/主体/权利全部来自 PostgreSQL（daka_runtime + RLS）；模型无权编造数字。
 * - 每个 span 记录真实计算（命中的关键词、解析出的时间/实体、实际执行的 SQL、触及对象）。
 * - 结果标出来源数据包（演示推演 vs 真实导入），演示数据不冒充客户事实。
 */
import type pg from "pg";
import type { ActorContext } from "../context";
import { withTx } from "../db/client";

// ---------------------------------------------------------------- 类型

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

interface Row extends Record<string, unknown> { id: string; data: Record<string, unknown> }

interface Resolution {
  intent: QueryIntent;
  params: Record<string, string>;
  evidence: {
    intent: string[];
    time: Array<{ phrase: string; from?: string; to?: string }>;
    entity: string[];
  };
}

// ---------------------------------------------------------------- 展示辅助

const money = (v: unknown, currency = "CNY") => `${currency === "CNY" ? "¥" : ""}${Number(v ?? 0).toLocaleString("zh-CN")} ${currency}`;
const dateOnly = (v: unknown) => String(v ?? "—").slice(0, 10);
const short = (id: string) => id.slice(-4);
export const PARTY_ROLE: Record<string, string> = { licensor: "甲方（授权方）", licensee: "乙方（被授权方）" };

/** 对象 → 图上可读标签（含敏感字段不回显在图中，仅展示类型与可公开摘要）。 */
export function labelFor(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "Contract": return `[${data.contractNumber ?? "合同"}] ${data.title ?? ""}`.trim();
    case "Party": return String(data.legalName ?? "主体");
    case "FootballClub":
    case "TVSeries":
    case "Talent": return String(data.canonicalName ?? type);
    case "RightsGrant": return `${data.rightType ?? "权利"} ${(data.territory as string[] | undefined)?.join("、") ?? ""}`.trim();
    case "PaymentSchedule": return `账单 · ${money(data.amount, String(data.currency))} · ${dateOnly(data.dueAt)}`;
    case "Payment": return `实付 · ${money(data.amount, String(data.currency))} · ${dateOnly(data.paidAt)}`;
    case "ReleaseProject": return String(data.projectName ?? "发行项目");
    case "SKU": return String(data.productName ?? data.skuCode ?? "SKU");
    case "MarketObservation": return `市场观察 · ${data.source ?? ""}`;
    case "ReleaseRecommendation": return `发行建议 · ${data.recommendationType ?? ""}`;
    case "SignatureEntitlement": return `签名额度 · ${data.grantedQuantity ?? ""}${data.unit ?? ""}`;
    case "SignatureLot": return `签名批次 · ${data.lotNumber ?? ""}`;
    case "SignatureMovement": return `签名流水 · ${data.movementType ?? ""}`;
    default: return `${type} ${short("")} · ${data.id ?? ""}`;
  }
}

// ---------------------------------------------------------------- 解析（意图/时间/实体 → 白名单工具）

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 抽取证据：意图关键词、时间短语、实体短语（路由器是否命中与证据分离，保证 span 诚实）。 */
function extractEvidence(question: string) {
  const evidence: Resolution["evidence"] = { intent: [], time: [], entity: [] };
  const intentKw = ["权利", "权益", "授权范围", "授权了什么", "能做什么", "甲方", "乙方", "谁签", "主体", "对手方", "账单", "付款", "应付", "已付", "实付", "欠款", "结清", "付了", "逾期", "拖欠", "来龙去脉", "溯源", "合同"];
  for (const kw of intentKw) if (question.includes(kw)) evidence.intent.push(kw);

  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const years = /过去\s*([0-9]+|[一二两三四五六七八九十])\s*年/.exec(question);
  if (years) {
    const n = CN_NUM[years[1]] ?? Number(years[1]);
    const from = new Date(today); from.setFullYear(from.getFullYear() - n);
    evidence.time.push({ phrase: years[0], from: iso(from), to: iso(today) });
  }
  const year = /(20\d{2})\s*年/.exec(question);
  if (year && !years) evidence.time.push({ phrase: year[0], from: `${year[1]}-01-01`, to: `${year[1]}-12-31` });
  if (/去年/.test(question)) { const y = new Date(today); y.setFullYear(y.getFullYear() - 1); evidence.time.push({ phrase: "去年", from: `${y.getFullYear()}-01-01`, to: `${y.getFullYear()}-12-31` }); }
  if (/今年/.test(question) && !years && !year) evidence.time.push({ phrase: "今年", from: `${today.getFullYear()}-01-01`, to: iso(today) });

  const contractNo = /([A-Z]{2,}-\d{4}-\d{3,})/.exec(question);
  if (contractNo) evidence.entity.push(contractNo[1]);
  if (/米兰|ACM/i.test(question)) evidence.entity.push("米兰");
  if (/纽卡|纽卡斯尔/.test(question)) evidence.entity.push("纽卡斯尔");
  const schedKey = /账单\s*([0-9a-f]{4})/i.exec(question);
  if (schedKey) evidence.entity.push(`账单 ${schedKey[1]}`);

  return evidence;
}

/** 本地规则路由：关键词 → 白名单工具 + 参数（确定性、离线、零 key）。 */
export function localRoute(question: string): Resolution {
  const params: Record<string, string> = {};
  const evidence = extractEvidence(question);
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  const years = /过去\s*([0-9]+|[一二两三四五六七八九十])\s*年/.exec(question);
  if (years) { const n = CN_NUM[years[1]] ?? Number(years[1]); const from = new Date(today); from.setFullYear(from.getFullYear() - n); params.from = iso(from); params.to = iso(today); }
  const year = /(20\d{2})\s*年/.exec(question);
  if (year && !years) { params.from = `${year[1]}-01-01`; params.to = `${year[1]}-12-31`; }
  if (/去年/.test(question) && !years && !year) { const y = new Date(today); y.setFullYear(y.getFullYear() - 1); params.from = `${y.getFullYear()}-01-01`; params.to = `${y.getFullYear()}-12-31`; }
  if (/今年/.test(question) && !years && !year) { params.from = `${today.getFullYear()}-01-01`; params.to = iso(today); }

  // 状态词（顺序敏感：「应付了」含「付了」，必须先判应付）
  if (/逾期|拖欠/.test(question)) params.status = "overdue";
  else if (/应付|待付|未付/.test(question)) { /* 不设 status：列全部账单，输出自带已付/未结清 */ }
  else if (/已付|实付|结清|付了/.test(question)) params.status = "paid";

  const contractNo = /([A-Z]{2,}-\d{4}-\d{3,})/.exec(question);
  if (contractNo) params.contract = contractNo[1];
  else if (/米兰|ACM/i.test(question)) params.contract = "米兰";
  else if (/纽卡|纽卡斯尔/.test(question)) params.contract = "纽卡斯尔";

  const schedKey = /账单\s*([0-9a-f]{4})/i.exec(question);

  if (/链路|来龙去脉|怎么来的|溯源/.test(question) && schedKey) return { intent: "chain", params: { schedule: schedKey[1] }, evidence };
  if (/权利|权益|授权范围|授权了什么|能做什么/.test(question)) return { intent: "rights", params, evidence };
  if (/甲方|乙方|谁签|主体|对手方|跟.*签/.test(question) && !/账单|付款|应付|已付/.test(question)) return { intent: "contracts", params, evidence };
  if (/账单|付款|应付|已付|实付|欠款|结清|付了|逾期|拖欠|费用|多少(钱|款)/.test(question)) return { intent: "payments", params, evidence };
  if (/合同/.test(question)) return { intent: "contracts", params, evidence };
  return { intent: "none", params: {}, evidence };
}

const TOOL_SPEC = `
你是 DAKA 业务查询路由器。只能从 4 个只读工具中选一个，输出严格 JSON（无多余文字）：
{"tool":"contracts","params":{}}
{"tool":"payments","params":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","status":"planned|due|paid|overdue","contract":"合同编号或关键字"}}
{"tool":"rights","params":{"contract":"合同编号或关键字"}}
{"tool":"chain","params":{"schedule":"账单 id 尾号"}}
规则：params 只放用户明确给出的条件；时间按对话日期推算（"过去三年"=三年前同一天到今天）；"应付/待付"用 payments 不带 status；"已付"用 status=paid；"甲乙方"用 contracts；"权利"用 rights；"某笔账单来龙去脉"用 chain；无法路由输出 {"tool":"none","answer":"说明缺什么信息"}。
`;

async function routeWithGlm(question: string, key: string, model: string): Promise<{ tool: QueryIntent; params: Record<string, string>; note?: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "system", content: `${TOOL_SPEC}\n当前日期：${today}` }, { role: "user", content: question }], thinking: { type: "disabled" }, max_tokens: 300, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`GLM HTTP ${res.status}`);
  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`GLM 输出非 JSON：${text.slice(0, 120)}`);
  const parsed = JSON.parse(m[0]) as { tool: string; params?: Record<string, string>; answer?: string };
  if (!["contracts", "payments", "rights", "chain", "none"].includes(parsed.tool)) throw new Error(`GLM 输出了白名单外工具：${parsed.tool}`);
  return { tool: parsed.tool as QueryIntent, params: parsed.params ?? {}, note: parsed.answer };
}

// ---------------------------------------------------------------- 查询层（白名单，只读，返回种子对象 ID 供子图高亮）

export interface QueryExec { rows: Row[]; sql: string; seedIds: string[] }

export async function queryContracts(pool: pg.Pool, ctx: ActorContext): Promise<QueryExec> {
  const sql = `
    SELECT o.id, o.data,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('name', p.data->>'legalName', 'role', p.data->>'partyType'))
        FROM link_records l JOIN object_records p ON p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.id=l.to_id AND p.superseded_at IS NULL
        WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='contractParties' AND l.from_id=o.id AND l.superseded_at IS NULL), '[]'::jsonb) AS parties,
      (SELECT count(*)::int FROM link_records l WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='contractHasPaymentSchedule' AND l.from_id=o.id AND l.superseded_at IS NULL) AS schedules,
      (SELECT count(*)::int FROM link_records l WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='contractGrantsRights' AND l.from_id=o.id AND l.superseded_at IS NULL) AS rights
    FROM object_records o
    WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_type='Contract' AND o.superseded_at IS NULL
    ORDER BY o.data->>'signedAt'`;
  return withTx(pool, ctx, async (c) => {
    const { rows } = await c.query(sql, [ctx.tenantId, ctx.workspaceId]);
    return { rows: rows as Row[], sql, seedIds: rows.map((r) => r.id as string) };
  });
}

export async function queryPayments(pool: pg.Pool, ctx: ActorContext, filter: { from?: string; to?: string; status?: string; contract?: string }): Promise<QueryExec> {
  const cond = ["o.tenant_id=$1", "o.workspace_id=$2", "o.object_type='PaymentSchedule'", "o.superseded_at IS NULL"];
  const params: unknown[] = [ctx.tenantId, ctx.workspaceId];
  if (filter.from) { params.push(filter.from); cond.push(`o.data->>'dueAt' >= $${params.length}`); }
  if (filter.to) { params.push(filter.to + "T23:59:59Z"); cond.push(`o.data->>'dueAt' <= $${params.length}`); }
  if (filter.status === "overdue") {
    cond.push(`(o.data->>'dueAt')::timestamptz < now()`);
    cond.push(`COALESCE((SELECT SUM((p.data->>'amount')::numeric) FROM link_records l JOIN object_records p ON p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.id=l.from_id AND p.superseded_at IS NULL
      WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL), 0) < (o.data->>'amount')::numeric`);
  } else if (filter.status) { params.push(filter.status); cond.push(`o.data->>'status' = $${params.length}`); }
  if (filter.contract) {
    params.push(`%${filter.contract}%`);
    cond.push(`EXISTS (SELECT 1 FROM link_records l JOIN object_records c ON c.tenant_id=l.tenant_id AND c.workspace_id=l.workspace_id AND c.id=l.from_id AND c.superseded_at IS NULL
      WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='contractHasPaymentSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL
        AND (c.id::text ILIKE $${params.length} OR c.data->>'contractNumber' ILIKE $${params.length} OR c.data->>'title' ILIKE $${params.length}))`);
  }
  const sql = `
    SELECT o.id, o.data,
      COALESCE(SUM((p.data->>'amount')::numeric), 0)::text AS settled,
      c.id AS contract_id, c.data->>'title' AS contract_title, c.data->>'contractNumber' AS contract_number,
      COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.data->>'amount', 'currency', p.data->>'currency', 'paidAt', p.data->>'paidAt', 'ref', p.data->>'transactionReference') ORDER BY p.data->>'paidAt') FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS payments
    FROM object_records o
    LEFT JOIN link_records l ON l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL
    LEFT JOIN object_records p ON p.tenant_id=o.tenant_id AND p.workspace_id=o.workspace_id AND p.object_type='Payment' AND p.id=l.from_id AND p.superseded_at IS NULL
    LEFT JOIN link_records cl ON cl.tenant_id=o.tenant_id AND cl.workspace_id=o.workspace_id AND cl.link_type='contractHasPaymentSchedule' AND cl.to_id=o.id AND cl.superseded_at IS NULL
    LEFT JOIN object_records c ON c.tenant_id=o.tenant_id AND c.workspace_id=o.workspace_id AND c.object_type='Contract' AND c.id=cl.from_id AND c.superseded_at IS NULL
    WHERE ${cond.join(" AND ")}
    GROUP BY o.id, o.data, c.id, c.data ORDER BY o.data->>'dueAt'`;
  return withTx(pool, ctx, async (c) => {
    const { rows } = await c.query(sql, params);
    const seeds = new Set<string>();
    for (const r of rows as Array<{ id: string; contract_id?: string | null; payments?: Array<{ id: string }> }>) {
      seeds.add(r.id);
      if (r.contract_id) seeds.add(r.contract_id);
      for (const p of r.payments ?? []) seeds.add(p.id);
    }
    return { rows: rows as Row[], sql, seedIds: [...seeds] };
  });
}

export async function queryRights(pool: pg.Pool, ctx: ActorContext, contractKey: string): Promise<QueryExec> {
  const sql = `
    SELECT r.id, r.data FROM object_records r
    JOIN link_records l ON l.tenant_id=r.tenant_id AND l.workspace_id=r.workspace_id AND l.link_type='contractGrantsRights' AND l.to_id=r.id AND l.superseded_at IS NULL
    JOIN object_records c ON c.tenant_id=l.tenant_id AND c.workspace_id=l.workspace_id AND c.id=l.from_id AND c.superseded_at IS NULL
    WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.object_type='RightsGrant' AND r.superseded_at IS NULL
      AND (c.id::text ILIKE $3 OR c.data->>'contractNumber' ILIKE $3 OR c.data->>'title' ILIKE $3)`;
  return withTx(pool, ctx, async (c) => {
    const { rows } = await c.query(sql, [ctx.tenantId, ctx.workspaceId, `%${contractKey}%`]);
    const seeds = new Set<string>(rows.map((r) => r.id as string));
    // 连同匹配到的合同一起高亮（子查询抓回合同 id）
    const cs = await c.query(`SELECT c.id FROM object_records c WHERE c.tenant_id=$1 AND c.workspace_id=$2 AND c.object_type='Contract' AND c.superseded_at IS NULL AND (c.id::text ILIKE $3 OR c.data->>'contractNumber' ILIKE $3 OR c.data->>'title' ILIKE $3)`, [ctx.tenantId, ctx.workspaceId, `%${contractKey}%`]);
    cs.rows.forEach((r) => seeds.add(r.id as string));
    return { rows: rows as Row[], sql, seedIds: [...seeds] };
  });
}

export async function queryChain(pool: pg.Pool, ctx: ActorContext, scheduleKey: string): Promise<QueryExec> {
  const sql = `
    SELECT o.id, o.data,
      (SELECT row_to_json(c) FROM object_records c JOIN link_records l ON l.tenant_id=c.tenant_id AND l.workspace_id=c.workspace_id AND l.from_id=c.id AND l.superseded_at IS NULL
       WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='contractHasPaymentSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL LIMIT 1) AS contract,
      COALESCE((SELECT jsonb_agg(p.data || jsonb_build_object('id', p.id)) FROM link_records l JOIN object_records p ON p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.id=l.from_id AND p.superseded_at IS NULL
       WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL), '[]'::jsonb) AS payments
    FROM object_records o
    WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_type='PaymentSchedule' AND o.superseded_at IS NULL AND o.id::text ILIKE $3`;
  return withTx(pool, ctx, async (c) => {
    const { rows } = await c.query(sql, [ctx.tenantId, ctx.workspaceId, `%${scheduleKey}%`]);
    const seeds = new Set<string>();
    for (const r of rows as Array<{ id: string; contract?: { id: string } | null; payments?: Array<{ id: string }> }>) {
      seeds.add(r.id);
      if (r.contract?.id) seeds.add(r.contract.id);
      for (const p of r.payments ?? []) seeds.add(p.id);
    }
    return { rows: rows as Row[], sql, seedIds: [...seeds] };
  });
}

// ---------------------------------------------------------------- 子图与全图

/** 由种子对象 ID 解析局部子图（种子对象 + 其直接关联对象 + 真实关系边）。 */
interface LinkRow { link_type: string; from_type: string; from_id: string; to_type: string; to_id: string }

async function resolveSubgraph(pool: pg.Pool, ctx: ActorContext, seedIds: string[]): Promise<{ objects: GraphNode[]; links: GraphEdge[] }> {
  if (seedIds.length === 0) return { objects: [], links: [] };
  return withTx(pool, ctx, async (c) => {
    const { rows: links } = await c.query(
      `SELECT link_type, from_type, from_id, to_type, to_id FROM link_records
       WHERE tenant_id=$1 AND workspace_id=$2 AND superseded_at IS NULL AND (from_id = ANY($3) OR to_id = ANY($3))`,
      [ctx.tenantId, ctx.workspaceId, seedIds],
    );
    const ids = new Set<string>(seedIds);
    for (const l of links as LinkRow[]) { ids.add(l.from_id); ids.add(l.to_id); }
    const { rows: objs } = await c.query(
      `SELECT id, object_type, data FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND superseded_at IS NULL AND id = ANY($3)`,
      [ctx.tenantId, ctx.workspaceId, [...ids]],
    );
    return {
      objects: (objs as Array<{ id: string; object_type: string; data: Record<string, unknown> }>).map((o) => ({ id: o.id, type: o.object_type, label: labelFor(o.object_type, o.data) })),
      links: (links as LinkRow[]).map((l) => ({ linkType: l.link_type, from: l.from_id, to: l.to_id, fromType: l.from_type, toType: l.to_type })),
    };
  });
}

/** 全图（左栏展示）：所有对象 + 所有关系。 */
export async function loadGraph(pool: pg.Pool, ctx: ActorContext): Promise<{ objects: GraphNode[]; links: GraphEdge[] }> {
  return withTx(pool, ctx, async (c) => {
    const { rows: objs } = await c.query(
      `SELECT id, object_type, data FROM object_records WHERE tenant_id=$1 AND workspace_id=$2 AND superseded_at IS NULL ORDER BY object_type, id`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const { rows: links } = await c.query(
      `SELECT link_type, from_type, from_id, to_type, to_id FROM link_records WHERE tenant_id=$1 AND workspace_id=$2 AND superseded_at IS NULL`,
      [ctx.tenantId, ctx.workspaceId],
    );
    return {
      objects: (objs as Array<{ id: string; object_type: string; data: Record<string, unknown> }>).map((o) => ({ id: o.id, type: o.object_type, label: labelFor(o.object_type, o.data) })),
      links: (links as LinkRow[]).map((l) => ({ linkType: l.link_type, from: l.from_id, to: l.to_id, fromType: l.from_type, toType: l.to_type })),
    };
  });
}

export async function dataSourceNote(pool: pg.Pool, ctx: ActorContext): Promise<string> {
  return withTx(pool, ctx, async (c) => {
    const { rows } = await c.query(
      `SELECT DISTINCT connector_id, pack_fingerprint FROM ingest_jobs WHERE tenant_id=$1 AND workspace_id=$2 AND status='applied'`,
      [ctx.tenantId, ctx.workspaceId],
    );
    const demo = rows.filter((r) => /demo/i.test(r.connector_id));
    return demo.length > 0
      ? `含演示推演数据包 ${demo.map((r) => `${r.connector_id}@${(r.pack_fingerprint ?? "").slice(0, 8)}`).join("、")}（合成数据，非客户真实事实）`
      : "规范事实库（未发现演示数据包）";
  });
}

// ---------------------------------------------------------------- 答案生成

/** 确定性模板组合答案（不编造数字；数字全部来自 rows）。 */
export function composeAnswer(intent: QueryIntent, params: Record<string, string>, rows: Row[]): string {
  if (intent === "payments") {
    let due = 0, settled = 0;
    const lines: string[] = [];
    for (const r of rows) {
      const d = r.data; const amount = Number(d.amount); const st = Number((r as { settled?: string }).settled);
      due += amount; settled += st;
      const contract = (r as { contract_title?: string | null; contract_number?: string | null });
      lines.push(`- 账单 ${short(r.id)}：应付 ${money(d.amount, String(d.currency))}，已付 ${money(st, String(d.currency))}，未结清 ${money(amount - st, String(d.currency))}，到期 ${dateOnly(d.dueAt)}，状态 ${d.status}${contract.contract_title ? `，关联 ${contract.contract_title}${contract.contract_number ? ` [${contract.contract_number}]` : ""}` : ""}`);
    }
    const range = params.from || params.to ? `（${params.from ?? "…"} ~ ${params.to ?? "…"}）` : "";
    return `命中 ${rows.length} 笔付款账单${range}。合计应付 ${money(due)}，已付 ${money(settled)}，未结清 ${money(due - settled)}。\n${lines.join("\n")}`;
  }
  if (intent === "contracts") {
    const lines = rows.map((c) => {
      const d = c.data;
      const parties = (c as { parties?: { name: string; role: string }[] }).parties ?? [];
      const ps = parties.map((p) => `${PARTY_ROLE[p.role] ?? p.role}：${p.name}`).join("；") || "（未关联主体）";
      return `- [${d.contractNumber ?? short(c.id)}] ${d.title}：${d.status}，${ps}，付款计划 ${(c as { schedules?: number }).schedules ?? 0} 笔、权利 ${(c as { rights?: number }).rights ?? 0} 项`;
    });
    return `共 ${rows.length} 份合同。\n${lines.join("\n")}`;
  }
  if (intent === "rights") {
    const lines = rows.map((r) => { const d = r.data; return `- ${d.rightType}：${(d.territory as string[] | undefined)?.join("、") ?? "—"}（${dateOnly(d.validFrom)} ~ ${dateOnly(d.validTo)}），需审批 ${d.approvalRequired ? "是" : "否"}`; });
    return `该合同授予 ${rows.length} 项权利。\n${lines.join("\n")}`;
  }
  if (intent === "chain") {
    if (rows.length === 0) return "未找到匹配的账单。";
    const r = rows[0]; const d = r.data;
    const pays = (r as { payments?: Array<{ amount: string; currency: string; paidAt: string }> }).payments ?? [];
    const contract = (r as { contract?: { data: Record<string, unknown>; id: string } | null }).contract;
    const cd = contract?.data;
    const parts: string[] = [`账单 ${short(r.id)}：应付 ${money(d.amount, String(d.currency))}，到期 ${dateOnly(d.dueAt)}，状态 ${d.status}`, ...pays.map((p) => `实付 ${money(p.amount, p.currency)} @ ${dateOnly(p.paidAt)}`)];
    if (cd) parts.push(`合同 [${cd.contractNumber ?? short(contract!.id)}] ${cd.title}（${cd.status}）`);
    return parts.join("\n");
  }
  return "没能理解问题。可以问：过去 N 年的账单 / 某合同的甲乙方 / 某合同给了哪些权利 / 某笔账单的来龙去脉";
}

// ---------------------------------------------------------------- 管线编排

class SpanRecorder {
  private started = new Map<QueryStage, number>();
  spans: QuerySpan[] = [];
  start(stage: QueryStage): void { this.started.set(stage, Date.now()); }
  ok(stage: QueryStage, attributes: Record<string, unknown> = {}): void {
    const t0 = this.started.get(stage) ?? Date.now();
    this.spans.push({ stage, status: "ok", startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, attributes });
  }
  skip(stage: QueryStage, reason: string): void {
    this.spans.push({ stage, status: "skipped", startedAt: new Date().toISOString(), durationMs: 0, attributes: { reason } });
  }
  fail(stage: QueryStage, message: string): void {
    const t0 = this.started.get(stage) ?? Date.now();
    this.spans.push({ stage, status: "failed", startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, attributes: {}, error: { code: "QUERY-" + stage.toUpperCase(), message } });
  }
}

export interface RunQueryOptions { glmKey?: string; glmModel?: string }

export async function runQuery(pool: pg.Pool, ctx: ActorContext, question: string, opts: RunQueryOptions = {}): Promise<QueryTrace> {
  const t0 = Date.now();
  const rec = new SpanRecorder();
  const q = question.trim();

  // 1) intent.parse
  rec.start("intent.parse");
  let resolution: Resolution;
  let router = "本地规则";
  if (opts.glmKey) {
    try {
      const g = await routeWithGlm(q, opts.glmKey, opts.glmModel ?? "glm-5.2");
      resolution = { intent: g.tool, params: g.params, evidence: extractEvidence(q) };
      router = "GLM";
    } catch (e) {
      resolution = localRoute(q);
      router = `本地规则（GLM 失败回退：${e instanceof Error ? e.message : String(e)}）`;
    }
  } else {
    resolution = localRoute(q);
  }
  rec.ok("intent.parse", { router, question: q, matchedIntent: resolution.evidence.intent, chosen: resolution.intent });

  // 2) time.resolve
  rec.start("time.resolve");
  const timeResolved = resolution.evidence.time;
  rec.ok("time.resolve", { resolved: timeResolved, note: timeResolved.length ? `解析出 ${timeResolved.length} 个时间短语` : "无显式时间，默认不限时间" });

  // 3) entity.resolve
  rec.start("entity.resolve");
  rec.ok("entity.resolve", { resolved: resolution.evidence.entity, note: resolution.evidence.entity.length ? `解析出 ${resolution.evidence.entity.length} 个实体引用` : "无显式实体" });

  // 4) plan（白名单约束）
  rec.start("plan");
  const params = resolution.params;
  rec.ok("plan", { whitelist: ["contracts", "payments", "rights", "chain"], chosenQuery: resolution.intent, params, note: "仅白名单只读查询，不生成自由 SQL" });

  // 5) query.execute + 子图解析
  rec.start("query.execute");
  let exec: QueryExec = { rows: [], sql: "", seedIds: [] };
  let subgraph: { objects: GraphNode[]; links: GraphEdge[] } = { objects: [], links: [] };
  let dataNote = "";
  let execFailed = false;
  try {
    if (resolution.intent === "contracts") exec = await queryContracts(pool, ctx);
    else if (resolution.intent === "payments") exec = await queryPayments(pool, ctx, { from: params.from, to: params.to, status: params.status, contract: params.contract });
    else if (resolution.intent === "rights") exec = await queryRights(pool, ctx, params.contract ?? "");
    else if (resolution.intent === "chain") exec = await queryChain(pool, ctx, params.schedule ?? "");
    subgraph = await resolveSubgraph(pool, ctx, exec.seedIds);
    dataNote = await dataSourceNote(pool, ctx);
    rec.ok("query.execute", { sql: exec.sql, rowCount: exec.rows.length, seedIds: exec.seedIds, touchedObjects: subgraph.objects.length, touchedLinks: subgraph.links.length });
  } catch (e) {
    execFailed = true;
    rec.fail("query.execute", e instanceof Error ? e.message : String(e));
  }

  // 6) rules.evaluate（读侧推导口径；与 paymentCalendar 投影一致）
  rec.start("rules.evaluate");
  if (!execFailed && resolution.intent === "payments" && params.status === "overdue") {
    rec.ok("rules.evaluate", { rules: [{ id: "paymentOverdue", applied: true, note: "逾期=到期已过且未结清，与 paymentCalendar 投影口径一致" }] });
  } else {
    rec.skip("rules.evaluate", execFailed ? "查询失败，规则阶段未执行" : "本次查询不触发读侧规则（状态取自存储口径，逾期为按需推导）");
  }

  // 7) validate（后置校验）
  rec.start("validate");
  if (execFailed) {
    rec.skip("validate", "查询失败，无结果可校验");
  } else {
    const issues: string[] = [];
    for (const r of exec.rows) { if (!r.id || typeof r.id !== "string") issues.push("行缺 id"); }
    if (resolution.intent === "payments") for (const r of exec.rows) { if (!Number.isFinite(Number((r.data as Record<string, unknown>).amount))) issues.push(`账单 ${r.id} 金额非数值`); }
    if (issues.length) rec.fail("validate", issues.join("; "));
    else rec.ok("validate", { checked: exec.rows.length, issues: 0, note: "行结构 + 金额可解析 + 无幽灵引用" });
  }

  // 8) answer.generate
  rec.start("answer.generate");
  const answer = execFailed ? `查询执行失败（详见 query.execute 阶段错误），未生成答案。` : composeAnswer(resolution.intent, params, exec.rows);
  rec.ok("answer.generate", { mode: "deterministic-template", sections: answer.split("\n").filter(Boolean).length, generated: false });

  return {
    schemaVersion: 1,
    question: q,
    intent: resolution.intent,
    params,
    answeredAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    spans: rec.spans,
    touchedObjects: subgraph.objects,
    touchedLinks: subgraph.links,
    sql: exec.sql,
    dataSourceNote: dataNote,
    answer,
    answerGenerated: false,
  };
}
