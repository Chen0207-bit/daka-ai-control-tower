import type { ActorContext } from "./context";
import type { RuntimeManifest } from "./manifest";

/**
 * Policy Engine（应用层）：deny 优先，默认拒绝；返回带 reason 的判定。
 * RLS 是数据库底线（另见 migrations/postgres/0001_init.sql）。
 */

export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policyId?: string;
}

/** 遮罩哨兵值：被遮罩字段在 JSON 响应边界精确返回该字符串（数据库存储值不变）。 */
export const MASKED_VALUE = "***masked***";

function matches(list: string[], value: string): boolean {
  return list.includes("*") || list.includes(value);
}

export function evaluatePolicy(
  manifest: RuntimeManifest,
  ctx: Pick<ActorContext, "roles">,
  resource: string,
  action: string,
  field?: string,
): PolicyDecision {
  const matched: Array<{ id: string; effect: string }> = [];
  for (const [id, p] of Object.entries(manifest.policies)) {
    const roleHit = p.roles.some((r) => ctx.roles.includes(r));
    if (!roleHit) continue;
    if (!matches(p.resources, resource)) continue;
    // write 动词映射: read/write 或具体 action id
    const actionHit =
      matches(p.actions, action) ||
      (action === "write" && p.actions.includes("write")) ||
      (p.actions.includes("write") && action !== "read");
    if (!actionHit) continue;
    // 行级授权（field undefined）只由整资源 policy（fields:["*"]）决定；
    // 字段级 policy（如 sensitiveFieldMaskForExecutive）不阻断行读取，只经 maskedFields/maskRecord 在响应边界遮罩。
    if (field === undefined && !p.fields.includes("*")) continue;
    if (field !== undefined && !matches(p.fields, field)) continue;
    matched.push({ id, effect: p.effect });
  }
  const deny = matched.find((m) => m.effect === "deny");
  if (deny) return { allowed: false, reason: `deny policy ${deny.id} 命中`, policyId: deny.id };
  const allow = matched.find((m) => m.effect === "allow");
  if (allow) return { allowed: true, reason: `allow policy ${allow.id}`, policyId: allow.id };
  return { allowed: false, reason: "deny_unless_granted：无匹配 allow policy" };
}

/** 字段遮罩：返回该角色集合在指定类型上被 deny 读取的字段（叠加 highly_confidential 默认遮罩）。 */
export function maskedFields(
  manifest: RuntimeManifest,
  ctx: Pick<ActorContext, "roles">,
  objectType: string,
): Set<string> {
  const masked = new Set<string>();
  const t = manifest.objectTypes[objectType];
  if (!t) return masked;
  for (const [name, prop] of Object.entries(t.properties)) {
    if (prop.security === "highly_confidential") masked.add(name);
  }
  // allow 覆盖：只有显式列出字段名的 allow policy 才解除该字段的默认遮罩。
  // 通配 fields:["*"] 的 allow 只授予行级读取（由 evaluatePolicy 判定），不解除
  // highly_confidential 默认遮罩 —— 否则任何整资源读授权都会顺带暴露未来新增的
  // 敏感字段（DeepSeek 复核 P2-3）。授权角色要见原值，须在 policy 中显式列字段。
  for (const [, p] of Object.entries(manifest.policies)) {
    if (p.effect !== "allow") continue;
    if (!p.roles.some((r) => ctx.roles.includes(r))) continue;
    if (!matches(p.resources, objectType)) continue;
    if (!(p.actions.includes("read") || p.actions.includes("*"))) continue;
    for (const f of p.fields) if (f !== "*") masked.delete(f);
  }
  for (const [id, p] of Object.entries(manifest.policies)) {
    if (p.effect !== "deny") continue;
    if (!p.roles.some((r) => ctx.roles.includes(r))) continue;
    if (!matches(p.resources, objectType)) continue;
    if (!(p.actions.includes("read") || p.actions.includes("*"))) continue;
    for (const f of p.fields) if (f !== "*") masked.add(f);
    if (p.fields.includes("*")) {
      // deny * 罕见，整表遮罩
      for (const name of Object.keys(t.properties)) masked.add(name);
    }
    void id;
  }
  return masked;
}

export function maskRecord(
  manifest: RuntimeManifest,
  ctx: Pick<ActorContext, "roles">,
  objectType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const masked = maskedFields(manifest, ctx, objectType);
  if (masked.size === 0) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = masked.has(k) ? MASKED_VALUE : v;
  }
  return out;
}

/**
 * 治理资源授权映射（P3 修复：事实治理与关系路由必须走编译后的 policy 模型）。
 *
 * 资源/动作命名约定（避免与普通 objectType 混淆）：
 * - `FactAssertion` 是治理资源。它虽是 objectType，但其状态迁移通过 `confirmFact`/`rejectFact`/
 *   `supersedeFact` 治理动作授权，创建 proposed 事实通过 `write` 授权（`proposeFact` 只产生 proposed 状态，
 *   不产生 verified）。这与普通对象把 `write` 当作「任意创建/更新」的语义一致。
 * - `Link` 是运行时治理资源标识，不是 manifest objectType（`typeExists` 只认 objectType/interface）。
 *   因此读取关系图（列出全部 links）按 `Link` 授权（只匹配 `resources:["*"]` 的通配 read），
 *   创建具体关系则委托给 `linkType.from` 端点 objectType（复用该类型既有的 `write` 授权）。
 */
export const FACT_RESOURCE = "FactAssertion";
export const LINK_RESOURCE = "Link";

/** 事实治理 API 动词 → 编译 manifest 中的 policy action。 */
export type FactVerb = "read" | "propose" | "verify" | "reject" | "supersede";

const FACT_ACTION: Record<FactVerb, string> = {
  read: "read",
  propose: "write",
  verify: "confirmFact",
  reject: "rejectFact",
  supersede: "supersedeFact",
};

/** linkType 的 from 端点 objectType（作为关系创建/读取的授权资源）。 */
export function linkFromType(manifest: RuntimeManifest, linkType: string): string | undefined {
  return manifest.linkTypes[linkType]?.from;
}

export function authorizeFact(
  manifest: RuntimeManifest,
  ctx: Pick<ActorContext, "roles">,
  verb: FactVerb,
): PolicyDecision {
  return evaluatePolicy(manifest, ctx, FACT_RESOURCE, FACT_ACTION[verb]);
}

export function authorizeLinkRead(
  manifest: RuntimeManifest,
  ctx: Pick<ActorContext, "roles">,
  linkType?: string,
): PolicyDecision {
  const resource = linkType ? (linkFromType(manifest, linkType) ?? LINK_RESOURCE) : LINK_RESOURCE;
  return evaluatePolicy(manifest, ctx, resource, "read");
}

export function authorizeLinkCreate(
  manifest: RuntimeManifest,
  ctx: Pick<ActorContext, "roles">,
  linkType: string,
): PolicyDecision {
  return evaluatePolicy(manifest, ctx, linkFromType(manifest, linkType) ?? LINK_RESOURCE, "write");
}
