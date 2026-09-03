/**
 * DAKA 业务问答 CLI（只读）——直接回答：
 *   过去 N 年应付/实付了哪些账单？每笔挂在哪份合同上？甲方乙方是谁？合同给了哪些权利？
 *
 * 用法（在 packages/ontology-runtime 下，或仓库根 `pnpm cli ...`）：
 *   pnpm run cli contracts                          # 全部合同 + 甲乙方 + 付款计划数
 *   pnpm run cli payments [--from 2023-01-01] [--to 2026-12-31] [--status planned|paid|overdue] [--contract DEMO-2026-001]
 *   pnpm run cli rights <合同 id/编号/尾号>           # 该合同授予的权利清单
 *   pnpm run cli chain <付款计划 id/尾号>             # 一条账单的全链路（计划→实付→合同→主体→权利）
 *   pnpm run cli ask "过去三年我付了哪些钱？"          # 自然语言（走可观察查询管线，打印答案 + 阶段 trace + 证据）
 *
 * 边界：只读；连接走 daka_runtime + RLS；路由器只选白名单查询；数字全部来自 SQL。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPool } from "../db/client";
import { makeContext } from "../context";
import {
  PARTY_ROLE,
  dataSourceNote,
  queryChain,
  queryContracts,
  queryPayments,
  queryRights,
  runQuery,
  type QueryTrace,
} from "../query/pipeline";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

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

if (!DB_URL) { console.error("缺少 DATABASE_URL（.dev.vars 或环境变量）"); process.exit(2); }

const pool = createPool(DB_URL);
const money = (v: unknown, currency = "CNY") => `${currency === "CNY" ? "¥" : ""}${Number(v ?? 0).toLocaleString("zh-CN")} ${currency}`;
const dateOnly = (v: unknown) => String(v ?? "—").slice(0, 10);
const short = (id: string) => id.slice(-4);

interface Row extends Record<string, unknown> { id: string; data: Record<string, unknown> }

// ---------------------------------------------------------------- 展示层（子命令）

async function cmdContracts() {
  const { rows } = await queryContracts(pool, ctx);
  console.log(`\n合同总览（${rows.length} 份）`);
  for (const c of rows as Array<Row & { parties: { name: string; role: string }[]; schedules: number; rights: number }>) {
    const d = c.data;
    const parties = (c.parties ?? []).map((p) => `${PARTY_ROLE[p.role] ?? p.role}：${p.name}`).join("；") || "（未关联主体）";
    console.log(`\n▸ [${d.contractNumber ?? short(c.id)}] ${d.title}`);
    console.log(`  状态 ${d.status} · 期限 ${dateOnly(d.effectiveFrom)} ~ ${dateOnly(d.effectiveTo)} · 签署 ${dateOnly(d.signedAt)}`);
    console.log(`  主体：${parties}`);
    console.log(`  付款计划 ${c.schedules} 笔 · 权利授予 ${c.rights} 项`);
  }
}

async function cmdPayments(filter: { from?: string; to?: string; status?: string; contract?: string }) {
  const { rows } = await queryPayments(pool, ctx, filter);
  let due = 0, settled = 0;
  console.log(`\n付款账单（${rows.length} 笔${filter.from || filter.to ? ` · ${filter.from ?? "…"} ~ ${filter.to ?? "…"}` : ""}${filter.status ? ` · 状态=${filter.status}` : ""}）`);
  for (const r of rows as Array<Row & { settled: string; contract_title: string | null; contract_number: string | null; payments: { id: string; amount: string; currency: string; paidAt: string; ref: string | null }[] }>) {
    const d = r.data; const amount = Number(d.amount); const st = Number(r.settled);
    due += amount; settled += st;
    console.log(`\n▸ 账单 ${short(r.id)} · ${money(d.amount, String(d.currency))} · 到期 ${dateOnly(d.dueAt)} · 状态 ${d.status}`);
    console.log(`  触发条件：${d.triggerCondition ?? "—"}`);
    console.log(`  已付 ${money(st, String(d.currency))} · 未结清 ${money(amount - st, String(d.currency))}`);
    console.log(`  关联合同：${r.contract_title ?? "（未关联）"}${r.contract_number ? ` [${r.contract_number}]` : ""}`);
    for (const p of r.payments ?? []) console.log(`  实付记录：${money(p.amount, p.currency)} · ${dateOnly(p.paidAt)}${p.ref ? ` · 凭证 ${p.ref}` : ""}`);
  }
  console.log(`\n合计：应付 ${money(due)} · 已付 ${money(settled)} · 未结清 ${money(due - settled)}`);
}

async function cmdRights(contractKey: string) {
  const { rows } = await queryRights(pool, ctx, contractKey);
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
  const { rows } = await queryChain(pool, ctx, scheduleKey);
  if (rows.length === 0) { console.log(`未找到付款计划：${scheduleKey}`); return; }
  for (const r of rows as Array<Row & { contract: Row | null; payments: Array<{ amount: string; currency: string; paidAt: string; transactionReference?: string }> }>) {
    const d = r.data;
    console.log(`\n账单 ${short(r.id)} 全链路`);
    console.log(`  计划：${money(d.amount, String(d.currency))} · 到期 ${dateOnly(d.dueAt)} · 状态 ${d.status}`);
    for (const p of r.payments ?? []) console.log(`  实付：${money(p.amount, p.currency)} · ${dateOnly(p.paidAt)} · 凭证 ${p.transactionReference ?? "—"}`);
    const contract = r.contract;
    if (!contract) { console.log("  合同：（未关联）"); continue; }
    const cd = contract.data;
    console.log(`  合同：[${cd.contractNumber ?? short(contract.id)}] ${cd.title} · 状态 ${cd.status}`);
    const { rows: contracts } = await queryContracts(pool, ctx);
    const full = (contracts as Array<Row & { parties: { name: string; role: string }[] }>).find((c) => c.id === contract.id);
    if (full) console.log(`  主体：${(full.parties ?? []).map((p) => `${PARTY_ROLE[p.role] ?? p.role}：${p.name}`).join("；") || "（未关联）"}`);
    const { rows: rights } = await queryRights(pool, ctx, contract.id);
    for (const rg of rights) { const rd = rg.data; console.log(`  权利：${rd.rightType} · ${(rd.territory as string[] | undefined)?.join("、") ?? "—"} · ${dateOnly(rd.validFrom)} ~ ${dateOnly(rd.validTo)} · 需审批 ${rd.approvalRequired ? "是" : "否"}`); }
  }
}

// ---------------------------------------------------------------- NL 模式

function printTrace(t: QueryTrace) {
  console.log(`\n（意图 ${t.intent} · 参数 ${JSON.stringify(t.params)} · ${t.spans.filter((s) => s.status === "ok").length}/${t.spans.length} 阶段通过 · ${t.durationMs}ms）`);
  for (const s of t.spans) {
    const mark = s.status === "ok" ? "✓" : s.status === "skipped" ? "·" : "✗";
    console.log(`  ${mark} ${s.stage.padEnd(18)} ${s.status === "skipped" ? String(s.attributes.reason) : Object.keys(s.attributes).join(",")}`);
  }
  console.log(`\n${t.answer}`);
  console.log(`\n证据：${t.dataSourceNote}`);
  console.log(`触及对象 ${t.touchedObjects.length} 个 / 关系 ${t.touchedLinks.length} 条；SQL 见 --sql（不默认回显）`);
}

async function cmdAsk(question: string) {
  const trace = await runQuery(pool, ctx, question, { glmKey: ENV.GLM_API_KEY, glmModel: ENV.GLM_MODEL });
  printTrace(trace);
  if (process.argv.includes("--sql")) { console.log(`\nSQL:\n${trace.sql}`); }
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
console.log(await dataSourceNote(pool, ctx));

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
  ask "过去三年我付了哪些钱？"         自然语言查询（可观察管线：意图/时间/实体/plan/查询/规则/校验/答案）
`);
    if (cmd) process.exit(2);
}
