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
  // allow 覆盖：若某 policy 显式允许这些角色读该字段，则取消默认遮罩
  for (const [, p] of Object.entries(manifest.policies)) {
    if (p.effect !== "allow") continue;
    if (!p.roles.some((r) => ctx.roles.includes(r))) continue;
    if (!matches(p.resources, objectType)) continue;
    if (!(p.actions.includes("read") || p.actions.includes("*"))) continue;
    if (p.fields.includes("*")) masked.clear();
    else for (const f of p.fields) masked.delete(f);
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
    out[k] = masked.has(k) ? "***masked***" : v;
  }
  return out;
}
