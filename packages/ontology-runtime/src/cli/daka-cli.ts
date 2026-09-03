/**
 * DAKA 业务问答 CLI（只读）——直接回答：
 *   过去 N 年应付/实付了哪些账单？每笔挂在哪份合同上？甲方乙方是谁？合同给了哪些权利？
 *
 * 用法（在 packages/ontology-runtime 下，或仓库根 `pnpm cli ...`）：
 *   pnpm run cli contracts                          # 全部合同 + 甲乙方 + 付款计划数
 *   pnpm run cli payments [--from 2023-01-01] [--to 2026-12-31] [--status planned|paid|...] [--contract DEMO-2026-001]
 *   pnpm run cli rights <合同 id/编号/尾号>           # 该合同授予的权利清单
 *   pnpm run cli chain <付款计划 id/尾号>             # 一条账单的全链路（计划→实付→合同→主体→权利）
 *   pnpm run cli ask "过去三年我付了哪些钱，都对应哪份合同？"   # 自然语言（本地规则路由，零 key 离线可用；
 *                                                             #   配 GLM_API_KEY 后用 GLM 路由。两者都只能选白名单查询，不生成 SQL）
 *
 * 边界：
 * - 只读。连接走 daka_runtime + RLS（app.tenant_id/app.workspace_id），不持有写权限以外任何特权。
 * - NL 模式下 GLM 只能输出白名单工具调用（JSON），金额/主体/权利全部来自 SQL 结果，模型无权编造数字。
 * - 数据全部标注来源（演示推演数据包 / 真实导入），演示数据不冒充客户事实。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPool, withTx } from "../db/client";
import { makeContext } from "../context";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

// ---------------------------------------------------------------- 环境与上下文

function loadEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [".dev.vars", ".env"]) {
    const p = `${ROOT}/${name}`;
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const ENV = { ...loadEnvFile(), ...process.env };
const DB_URL = ENV.DATABASE_URL_RUNTIME ?? ENV.DATABASE_URL;
const TENANT = ENV.DAKA_TENANT_ID ?? "d0000000-0000-4000-8000-000000000001";
const WS = ENV.DAKA_WORKSPACE_ID ?? "d0000000-0000-4000-8000-000000000002";
const ctx = makeContext({ tenantId: TENANT, workspaceId: WS, actorId: "daka-cli", roles: ["dataSteward"] });

if (!DB_URL) {
  console.error("缺少 DATABASE_URL（.dev.vars 或环境变量）");
  process.exit(2);
}

// ---------------------------------------------------------------- SQL 查询层（白名单，全部只读）

interface Row extends Record<string, unknown> { id: string; data: Record<string, unknown> }

async function q<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = createPool(DB_URL!);
  try {
    return await withTx(pool, ctx, async (c) => (await c.query(sql, params)).rows as T[]);
  } finally {
    await pool.end();
  }
}

const PARTY_ROLE: Record<string, string> = { licensor: "甲方（授权方）", licensee: "乙方（被授权方）" };

async function queryContracts() {
  return q<Row & { parties: { name: string; role: string }[]; schedules: number; rights: number }>(`
    SELECT o.id, o.data,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name', p.data->>'legalName', 'role', p.data->>'partyType'))
        FROM link_records l JOIN object_records p
          ON p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.id=l.to_id AND p.superseded_at IS NULL
        WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
          AND l.link_type='contractParties' AND l.from_id=o.id AND l.superseded_at IS NULL
      ), '[]'::jsonb) AS parties,
      (SELECT count(*)::int FROM link_records l WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
        AND l.link_type='contractHasPaymentSchedule' AND l.from_id=o.id AND l.superseded_at IS NULL) AS schedules,
      (SELECT count(*)::int FROM link_records l WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
        AND l.link_type='contractGrantsRights' AND l.from_id=o.id AND l.superseded_at IS NULL) AS rights
    FROM object_records o
    WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_type='Contract' AND o.superseded_at IS NULL
    ORDER BY o.data->>'signedAt'`, [TENANT, WS]);
}

async function queryPayments(filter: { from?: string; to?: string; status?: string; contract?: string }) {
  const cond = ["o.tenant_id=$1", "o.workspace_id=$2", "o.object_type='PaymentSchedule'", "o.superseded_at IS NULL"];
  const params: unknown[] = [TENANT, WS];
  if (filter.from) { params.push(filter.from); cond.push(`o.data->>'dueAt' >= $${params.length}`); }
  if (filter.to) { params.push(filter.to + "T23:59:59Z"); cond.push(`o.data->>'dueAt' <= $${params.length}`); }
  if (filter.status === "overdue") {
    // 逾期是推导口径（与 paymentCalendar 一致）：到期已过且未结清，不依赖存储 status 字段
    cond.push(`(o.data->>'dueAt')::timestamptz < now()`);
    cond.push(`COALESCE((SELECT SUM((p.data->>'amount')::numeric) FROM link_records l JOIN object_records p
      ON p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.id=l.from_id AND p.superseded_at IS NULL
      WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
        AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL), 0) < (o.data->>'amount')::numeric`);
  } else if (filter.status) { params.push(filter.status); cond.push(`o.data->>'status' = $${params.length}`); }
  if (filter.contract) {
    params.push(`%${filter.contract}%`);
    cond.push(`EXISTS (
      SELECT 1 FROM link_records l JOIN object_records c
        ON c.tenant_id=l.tenant_id AND c.workspace_id=l.workspace_id AND c.id=l.from_id AND c.superseded_at IS NULL
      WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
        AND l.link_type='contractHasPaymentSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL
        AND (c.id::text ILIKE $${params.length} OR c.data->>'contractNumber' ILIKE $${params.length} OR c.data->>'title' ILIKE $${params.length}))`);
  }
  return q<Row & { settled: string; contract_id: string | null; contract_title: string | null; contract_number: string | null; payments: { id: string; amount: string; currency: string; paidAt: string; ref: string | null }[] }>(`
    SELECT o.id, o.data,
      COALESCE(SUM((p.data->>'amount')::numeric), 0)::text AS settled,
      c.id AS contract_id, c.data->>'title' AS contract_title, c.data->>'contractNumber' AS contract_number,
      COALESCE(jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.data->>'amount', 'currency', p.data->>'currency',
        'paidAt', p.data->>'paidAt', 'ref', p.data->>'transactionReference') ORDER BY p.data->>'paidAt')
        FILTER (WHERE p.id IS NOT NULL), '[]'::jsonb) AS payments
    FROM object_records o
    LEFT JOIN link_records l ON l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
      AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL
    LEFT JOIN object_records p ON p.tenant_id=o.tenant_id AND p.workspace_id=o.workspace_id
      AND p.object_type='Payment' AND p.id=l.from_id AND p.superseded_at IS NULL
    LEFT JOIN link_records cl ON cl.tenant_id=o.tenant_id AND cl.workspace_id=o.workspace_id
      AND cl.link_type='contractHasPaymentSchedule' AND cl.to_id=o.id AND cl.superseded_at IS NULL
    LEFT JOIN object_records c ON c.tenant_id=o.tenant_id AND c.workspace_id=o.workspace_id
      AND c.object_type='Contract' AND c.id=cl.from_id AND c.superseded_at IS NULL
    WHERE ${cond.join(" AND ")}
    GROUP BY o.id, o.data, c.id, c.data ORDER BY o.data->>'dueAt'`, params);
}

async function queryRights(contractKey: string) {
  return q<Row>(`
    SELECT r.id, r.data FROM object_records r
    JOIN link_records l ON l.tenant_id=r.tenant_id AND l.workspace_id=r.workspace_id
      AND l.link_type='contractGrantsRights' AND l.to_id=r.id AND l.superseded_at IS NULL
    JOIN object_records c ON c.tenant_id=l.tenant_id AND c.workspace_id=l.workspace_id
      AND c.id=l.from_id AND c.superseded_at IS NULL
    WHERE r.tenant_id=$1 AND r.workspace_id=$2 AND r.object_type='RightsGrant' AND r.superseded_at IS NULL
      AND (c.id::text ILIKE $3 OR c.data->>'contractNumber' ILIKE $3 OR c.data->>'title' ILIKE $3)`, [TENANT, WS, `%${contractKey}%`]);
}

async function queryChain(scheduleKey: string) {
  return q<Row & { contract: Row | null; payments: unknown[] }>(`
    SELECT o.id, o.data,
      (SELECT row_to_json(c) FROM object_records c JOIN link_records l
        ON l.tenant_id=c.tenant_id AND l.workspace_id=c.workspace_id AND l.from_id=c.id AND l.superseded_at IS NULL
       WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
         AND l.link_type='contractHasPaymentSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL LIMIT 1) AS contract,
      COALESCE((SELECT jsonb_agg(p.data || jsonb_build_object('id', p.id)) FROM link_records l JOIN object_records p
        ON p.tenant_id=l.tenant_id AND p.workspace_id=l.workspace_id AND p.id=l.from_id AND p.superseded_at IS NULL
       WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id
         AND l.link_type='paymentSettlesSchedule' AND l.to_id=o.id AND l.superseded_at IS NULL), '[]'::jsonb) AS payments
    FROM object_records o
    WHERE o.tenant_id=$1 AND o.workspace_id=$2 AND o.object_type='PaymentSchedule' AND o.superseded_at IS NULL
      AND o.id::text ILIKE $3`, [TENANT, WS, `%${scheduleKey}%`]);
}

async function dataBanner(): Promise<string> {
  // 以 ingest_jobs 中已 apply 的数据包为准（对象级 sourceSystem 覆盖不全）
  const packs = await q<{ connector_id: string; pack_fingerprint: string | null }>(
    `SELECT DISTINCT connector_id, pack_fingerprint FROM ingest_jobs
     WHERE tenant_id=$1 AND workspace_id=$2 AND status='applied'`, [TENANT, WS]);
  const demo = packs.filter((p) => /demo/i.test(p.connector_id));
  if (demo.length > 0) {
    return `数据来源：含演示推演数据包 ${demo.map((p) => `${p.connector_id}@${(p.pack_fingerprint ?? "").slice(0, 8)}`).join("、")}（合成数据，非客户真实事实）`;
  }
  return "数据来源：规范事实库（未发现演示数据包）";
}

// ---------------------------------------------------------------- 展示层

const money = (v: unknown, currency = "CNY") => `${currency === "CNY" ? "¥" : ""}${Number(v ?? 0).toLocaleString("zh-CN")} ${currency}`;
const dateOnly = (v: unknown) => String(v ?? "—").slice(0, 10);
const short = (id: string) => id.slice(-4);

async function cmdContracts() {
  const rows = await queryContracts();
  console.log(`\n合同总览（${rows.length} 份）`);
  for (const c of rows) {
    const d = c.data;
    const parties = (c.parties ?? []).map((p) => `${PARTY_ROLE[p.role] ?? p.role}：${p.name}`).join("；") || "（未关联主体）";
    console.log(`\n▸ [${d.contractNumber ?? short(c.id)}] ${d.title}`);
    console.log(`  状态 ${d.status} · 期限 ${dateOnly(d.effectiveFrom)} ~ ${dateOnly(d.effectiveTo)} · 签署 ${dateOnly(d.signedAt)}`);
    console.log(`  主体：${parties}`);
    console.log(`  付款计划 ${c.schedules} 笔 · 权利授予 ${c.rights} 项`);
  }
}

async function cmdPayments(filter: { from?: string; to?: string; status?: string; contract?: string }) {
  const rows = await queryPayments(filter);
  let totalDue = 0, totalSettled = 0;
  console.log(`\n付款账单（${rows.length} 笔${filter.from || filter.to ? ` · ${filter.from ?? "…"} ~ ${filter.to ?? "…"}` : ""}${filter.status ? ` · 状态=${filter.status}` : ""}）`);
  for (const r of rows) {
    const d = r.data;
    const amount = Number(d.amount);
    const settled = Number(r.settled);
    totalDue += amount; totalSettled += settled;
    console.log(`\n▸ 账单 ${short(r.id)} · ${money(d.amount, String(d.currency))} · 到期 ${dateOnly(d.dueAt)} · 状态 ${d.status}`);
    console.log(`  触发条件：${d.triggerCondition ?? "—"}`);
    console.log(`  已付 ${money(settled, String(d.currency))} · 未结清 ${money(amount - settled, String(d.currency))}`);
    console.log(`  关联合同：${r.contract_title ?? "（未关联）"}${r.contract_number ? ` [${r.contract_number}]` : ""}`);
    for (const p of r.payments ?? []) {
      console.log(`  实付记录：${money(p.amount, p.currency)} · ${dateOnly(p.paidAt)}${p.ref ? ` · 凭证 ${p.ref}` : ""}`);
    }
  }
  console.log(`\n合计：应付 ${money(totalDue)} · 已付 ${money(totalSettled)} · 未结清 ${money(totalDue - totalSettled)}`);
}

async function cmdRights(contractKey: string) {
  const rows = await queryRights(contractKey);
  console.log(`\n合同权利清单（匹配 ${rows.length} 项）`);
  for (const r of rows) {
    const d = r.data;
    console.log(`\n▸ ${d.rightType} · ${dateOnly(d.validFrom)} ~ ${dateOnly(d.validTo)}`);
    console.log(`  地域：${(d.territory as string[] | undefined)?.join("、") ?? "—"} · 渠道：${(d.channel as string[] | undefined)?.join("、") ?? "—"} · 品类：${(d.productCategory as string[] | undefined)?.join("、") ?? "—"}`);
    console.log(`  需审批：${d.approvalRequired ? "是" : "否"}`);
  }
  if (rows.length === 0) console.log("（未找到匹配合同的权利授予）");
}

async function cmdChain(scheduleKey: string) {
  const rows = await queryChain(scheduleKey);
  if (rows.length === 0) { console.log(`未找到付款计划：${scheduleKey}`); return; }
  for (const r of rows) {
    const d = r.data;
    console.log(`\n账单 ${short(r.id)} 全链路`);
    console.log(`  计划：${money(d.amount, String(d.currency))} · 到期 ${dateOnly(d.dueAt)} · 状态 ${d.status}`);
    const pays = (r.payments ?? []) as { amount: string; currency: string; paidAt: string; transactionReference?: string }[];
    for (const p of pays) console.log(`  实付：${money(p.amount, p.currency)} · ${dateOnly(p.paidAt)} · 凭证 ${p.transactionReference ?? "—"}`);
    const contract = r.contract as { id: string; data: Record<string, unknown> } | null;
    if (!contract) { console.log("  合同：（未关联）"); continue; }
    const cd = contract.data;
    console.log(`  合同：[${cd.contractNumber ?? short(contract.id)}] ${cd.title} · 状态 ${cd.status}`);
    const contracts = await queryContracts();
    const full = contracts.find((c) => c.id === contract.id);
    if (full) console.log(`  主体：${(full.parties ?? []).map((p) => `${PARTY_ROLE[p.role] ?? p.role}：${p.name}`).join("；") || "（未关联）"}`);
    const rights = await queryRights(contract.id);
    for (const rg of rights) {
      const rd = rg.data;
      console.log(`  权利：${rd.rightType} · ${(rd.territory as string[] | undefined)?.join("、") ?? "—"} · ${dateOnly(rd.validFrom)} ~ ${dateOnly(rd.validTo)} · 需审批 ${rd.approvalRequired ? "是" : "否"}`);
    }
  }
}

// ---------------------------------------------------------------- NL 模式
// 路由器只能选择白名单工具（contracts/payments/rights/chain），数字全部来自 SQL。
// 默认本地规则路由（零 key、离线、确定性）；配置 GLM_API_KEY 后改用 GLM 路由。

interface RoutePlan { tool: string; params: Record<string, string>; note?: string }

/** GLM 路由用的工具说明（模型只能输出其中一个工具的 JSON 调用）。 */
const TOOL_SPEC = `
你是 DAKA 业务 CLI 的查询路由器。用户用中文提问，你只能从以下 4 个只读工具中选一个，输出严格 JSON（无多余文字）：
{"tool":"contracts","params":{}}
{"tool":"payments","params":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","status":"planned|due|paid|overdue","contract":"合同编号或关键字"}}
{"tool":"rights","params":{"contract":"合同编号或关键字"}}
{"tool":"chain","params":{"schedule":"账单 id 尾号"}}
规则：
- params 里只放用户明确给出的条件；时间词按对话日期推算（如"过去三年"= 三年前同一天到今天）。
- "应付/待付"用 payments 不带 status 或 status=planned/due/overdue；"已付/实付"用 status=paid。
- 问"甲乙方/谁签的"优先 contracts；问"权利/授权范围"用 rights；问"某笔账单的完整来龙去脉"用 chain。
- 无法路由时输出 {"tool":"none","answer":"说明缺什么信息"}。
`;

/** 本地规则路由：时间词/状态词/合同关键字 → 白名单工具调用。 */
function localRoute(question: string): RoutePlan {
  const params: Record<string, string> = {};
  // 时间范围：过去N年 / NNNN年 / 今年
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const years = /过去\s*([0-9]+|[一二两三四五六七八九十])\s*年/.exec(question);
  if (years) {
    const n = CN_NUM[years[1]] ?? Number(years[1]);
    const from = new Date(today); from.setFullYear(from.getFullYear() - n);
    params.from = iso(from); params.to = iso(today);
  }
  const year = /(20\d{2})\s*年/.exec(question);
  if (year && !years) { params.from = `${year[1]}-01-01`; params.to = `${year[1]}-12-31`; }
  if (/今年/.test(question) && !years && !year) { params.from = `${today.getFullYear()}-01-01`; params.to = iso(today); }
  // 状态词（顺序敏感：「应付了」含「付了」，必须先判应付/待付）
  if (/逾期|拖欠/.test(question)) params.status = "overdue";
  else if (/应付|待付|未付/.test(question)) { /* 不设 status：列出全部账单，输出自带已付/未结清 */ }
  else if (/已付|实付|结清|付了/.test(question)) params.status = "paid";
  // 合同关键字：编号（DEMO-2026-001 形态）或 IP 名
  const contractNo = /([A-Z]{2,}-\d{4}-\d{3,})/.exec(question);
  if (contractNo) params.contract = contractNo[1];
  else if (/米兰|ACM/i.test(question)) params.contract = "米兰";
  else if (/纽卡|纽卡斯尔/.test(question)) params.contract = "纽卡斯尔";
  // 账单定位：chain 需要 id 尾号
  const schedKey = /账单\s*([0-9a-f]{4})/i.exec(question);

  // 工具选择（优先级：chain > rights > contracts > payments）
  if (/链路|来龙去脉|怎么来的|溯源/.test(question) && schedKey) return { tool: "chain", params: { schedule: schedKey[1] } };
  if (/权利|权益|授权范围|授权了什么|能做什么/.test(question)) return { tool: "rights", params };
  if (/甲方|乙方|谁签|主体|对手方|跟.*签/.test(question) && !/账单|付款|应付|已付/.test(question)) return { tool: "contracts", params };
  if (/账单|付款|应付|已付|实付|欠款|结清|花了多少|付了|逾期的款|费用|多少(钱|款)/.test(question)) return { tool: "payments", params };
  if (/合同/.test(question)) return { tool: "contracts", params };
  return { tool: "none", params: {}, note: "没能理解问题。可以问：过去 N 年的账单 / 某合同的甲乙方 / 某合同给了哪些权利 / 某笔账单的来龙去脉" };
}

async function routeWithGlm(question: string, key: string): Promise<RoutePlan> {
  const model = ENV.GLM_MODEL || "glm-5.2";
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch("https://open.bigmodel.cn/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `${TOOL_SPEC}\n当前日期：${today}` },
        { role: "user", content: question },
      ],
      thinking: { type: "disabled" },
      max_tokens: 300,
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`GLM HTTP ${res.status}`);
  const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = payload.choices?.[0]?.message?.content ?? "";
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error(`GLM 输出非 JSON：${text.slice(0, 120)}`);
  const parsed = JSON.parse(m[0]) as { tool: string; params?: Record<string, string>; answer?: string };
  if (!["contracts", "payments", "rights", "chain", "none"].includes(parsed.tool)) throw new Error(`GLM 输出了白名单外工具：${parsed.tool}`);
  return { tool: parsed.tool, params: parsed.params ?? {}, note: parsed.answer };
}

async function cmdAsk(question: string) {
  let plan: RoutePlan;
  let router: string;
  if (ENV.GLM_API_KEY) {
    try {
      plan = await routeWithGlm(question, ENV.GLM_API_KEY);
      router = "GLM";
    } catch (e) {
      // GLM 不可用不伪装结果：明确提示并回退到确定性规则路由
      console.log(`（GLM 路由失败：${e instanceof Error ? e.message : String(e)}；已改用本地规则路由）`);
      plan = localRoute(question);
      router = "本地规则";
    }
  } else {
    plan = localRoute(question);
    router = "本地规则";
  }
  console.log(`（${router}路由 → ${plan.tool} ${JSON.stringify(plan.params)}；以下数字全部来自数据库 SQL，非模型生成）`);
  const p = plan.params;
  if (plan.tool === "contracts") await cmdContracts();
  else if (plan.tool === "payments") await cmdPayments({ from: p.from, to: p.to, status: p.status, contract: p.contract });
  else if (plan.tool === "rights") await cmdRights(p.contract ?? "");
  else if (plan.tool === "chain") await cmdChain(p.schedule ?? "");
  else console.log(plan.note ?? "无法路由。可用子命令：contracts / payments / rights / chain");
}

// ---------------------------------------------------------------- 入口

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1] ?? ""; i++; }
    else positional.push(args[i]);
  }
  return { positional, flags };
}

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseFlags(rest);

console.log(`DAKA CLI · tenant ${TENANT.slice(-4)} / ws ${WS.slice(-4)}`);
console.log(await dataBanner());

switch (cmd) {
  case "contracts": await cmdContracts(); break;
  case "payments": await cmdPayments({ from: flags.from, to: flags.to, status: flags.status, contract: flags.contract }); break;
  case "rights": if (!positional[0]) { console.error("用法: rights <合同 id/编号/关键字>"); process.exit(2); } await cmdRights(positional[0]); break;
  case "chain": if (!positional[0]) { console.error("用法: chain <付款计划 id/尾号>"); process.exit(2); } await cmdChain(positional[0]); break;
  case "ask": {
    const question = positional.join(" ");
    if (!question) { console.error('用法: ask "你的问题"'); process.exit(2); }
    await cmdAsk(question);
    break;
  }
  default:
    console.log(`
用法：
  contracts                          全部合同 + 甲乙方 + 付款计划/权利数量
  payments [--from] [--to] [--status] [--contract]   账单清单（金额/到期/状态/已付/关联合同/实付记录）
  rights <合同编号或关键字>            合同授予的权利（地域/渠道/品类/期限/审批）
  chain <账单 id 尾号>                一条账单的全链路（计划→实付→合同→主体→权利）
  ask "过去三年我付了哪些钱？"         自然语言查询（GLM 仅路由，数字全部来自 SQL）
`);
    if (cmd) process.exit(2);
}
