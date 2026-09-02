import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { ActorContext } from "../context";
import type { RuntimeManifest } from "../manifest";
import { createObject } from "../repository";
import { evaluateRule } from "./evaluator";
import { derivedResolvers } from "../derived";

/**
 * Rule Runner：把 DSL rules 应用到当前事实集，产出/更新 RiskFinding。
 * 受限 AST 由 evaluator 求值；每条规则的结果是注册行为（result → executor）。
 */

export interface RuleFinding {
  ruleId: string;
  severity: string;
  subjectType: string;
  subjectId: string;
  explanation: string;
}

/** 为规则作用域内每行记录构造路径解析器：别名.字段 与裸字段均可解析。 */
function rowResolver(row: { objectType: string; id: string; data: Record<string, unknown> }, derived: Record<string, unknown>): (path: string) => unknown {
  return (path: string) => {
    const parts = path.split(".");
    const leaf = parts[parts.length - 1];
    if (leaf in derived) return derived[leaf];
    return row.data[leaf];
  };
}

export async function runRules(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
): Promise<RuleFinding[]> {
  const findings: RuleFinding[] = [];
  for (const [ruleId, rule] of Object.entries(manifest.rules)) {
    const scopeTypes = rule.scope.length > 0 ? rule.scope : Object.keys(manifest.objectTypes);
    for (const type of scopeTypes) {
      if (!manifest.objectTypes[type]) continue;
      const { rows } = await client.query(
        `SELECT id, object_type, data FROM object_records
         WHERE tenant_id=$1 AND workspace_id=$2 AND object_type=$3 AND superseded_at IS NULL`,
        [ctx.tenantId, ctx.workspaceId, type],
      );
      for (const row of rows) {
        // 预取 derived 字段
        const derived: Record<string, unknown> = {};
        const resolvers = derivedResolvers[type] ?? {};
        for (const [name, resolver] of Object.entries(resolvers)) {
          derived[name] = await resolver(client, ctx, row.id);
        }
        // FactAssertion 规则走 fact_assertions 表
        let hit = false;
        try {
          hit = evaluateRule(rule.when, rowResolver({ objectType: type, id: row.id, data: row.data }, derived));
        } catch {
          hit = false;
        }
        if (hit) {
          findings.push({
            ruleId,
            severity: rule.severity,
            subjectType: type,
            subjectId: row.id,
            explanation: rule.description ?? ruleId,
          });
        }
      }
    }
    // verifiedFactMissingEvidence: 直接扫 fact_assertions
    if (ruleId === "verifiedFactMissingEvidence") {
      const { rows } = await client.query(
        `SELECT id FROM fact_assertions
         WHERE tenant_id=$1 AND workspace_id=$2 AND status='verified' AND evidence_anchor_id IS NULL AND review_comment IS NULL`,
        [ctx.tenantId, ctx.workspaceId],
      );
      for (const r of rows) {
        findings.push({ ruleId, severity: rule.severity, subjectType: "FactAssertion", subjectId: r.id, explanation: rule.description ?? ruleId });
      }
    }
  }
  return findings;
}

/** 将 findings 物化为 RiskFinding 对象（create-or-update：同 rule+subject 的 open 风险不重复建）。 */
export async function materializeFindings(
  client: pg.PoolClient,
  ctx: ActorContext,
  manifest: RuntimeManifest,
  releaseId: string,
  findings: RuleFinding[],
): Promise<string[]> {
  const created: string[] = [];
  for (const f of findings) {
    const existing = await client.query(
      `SELECT id FROM object_records
       WHERE tenant_id=$1 AND workspace_id=$2 AND object_type='RiskFinding' AND superseded_at IS NULL
         AND data->>'ruleId'=$3 AND data->>'subjectId'=$4 AND data->>'status'='open'`,
      [ctx.tenantId, ctx.workspaceId, f.ruleId, f.subjectId],
    );
    if (existing.rows.length > 0) continue;
    const rec = await createObject(client, ctx, manifest, releaseId, "RiskFinding", {
      ruleId: f.ruleId,
      subjectId: f.subjectId,
      riskType: f.ruleId,
      severity: f.severity,
      status: "open",
      explanation: `[演示推演] ${f.explanation}（subject ${f.subjectType}/${f.subjectId}）`,
    }, randomUUID());
    created.push(rec.id);
  }
  return created;
}
