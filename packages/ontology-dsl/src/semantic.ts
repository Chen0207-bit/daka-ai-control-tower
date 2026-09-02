import { DIAGNOSTIC_CODES, type Diagnostic, type DiagnosticCode } from "./diagnostics";
import {
  collectTypeFields,
  mergeSchemaFiles,
  typeExists,
  type MergedSchema,
  type SectionEntry,
  type SourceRef,
} from "./model";
import type { ParsedFile } from "./parse";

/**
 * 语义校验（spec §7–§11 的引用/类型/基数一致性，诊断码 DSL2xxx）。
 * 前置条件：语法校验已无 error。
 */

type Ctx = {
  out: Diagnostic[];
  posOf: (source: SourceRef, suffix?: string) => { line: number; col: number };
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function report(
  ctx: Ctx,
  code: DiagnosticCode,
  source: SourceRef,
  message: string,
  suggestion?: string,
  suffix?: string,
  severity: "error" | "warning" = "error",
): void {
  const pos = ctx.posOf(source, suffix);
  ctx.out.push({
    code,
    severity,
    file: source.file,
    line: pos.line,
    col: pos.col,
    path: suffix ? `${source.path}.${suffix}` : source.path,
    message,
    suggestion,
  });
}

function propertyBags(entry: SectionEntry): Array<{ bag: string; props: Record<string, unknown> }> {
  if (!isPlainObject(entry.def)) return [];
  const def = entry.def as Record<string, unknown>;
  const bags: Array<{ bag: string; props: Record<string, unknown> }> = [];
  for (const bag of ["properties", "derived", "inputs", "metrics"]) {
    if (isPlainObject(def[bag])) bags.push({ bag, props: def[bag] as Record<string, unknown> });
  }
  return bags;
}

/** 扫描全部 property 袋：enum ref 存在性、ref 误用、TBD/draft 提醒。 */
function checkPropertyBags(ctx: Ctx, merged: MergedSchema): void {
  const valueSetIds = new Set(merged.valueSets.map((v) => v.id));
  const sections: SectionEntry[][] = [
    merged.interfaces,
    merged.objectTypes,
    merged.actions,
    merged.projections,
  ];
  for (const entries of sections) {
    for (const entry of entries) {
      for (const { bag, props } of propertyBags(entry)) {
        for (const [propName, prop] of Object.entries(props)) {
          if (!isPlainObject(prop)) continue;
          const suffix = `${bag}.${propName}`;
          if (prop.type === "enum") {
            if (typeof prop.ref === "string" && !valueSetIds.has(prop.ref)) {
              report(
                ctx,
                DIAGNOSTIC_CODES.UNKNOWN_VALUESET_REF,
                entry.source,
                `enum ref "${prop.ref}" 指向不存在的 valueSet`,
                `已定义: ${[...valueSetIds].join(", ") || "(无)"}`,
                `${suffix}.ref`,
              );
            }
          } else if (prop.ref !== undefined) {
            report(
              ctx,
              DIAGNOSTIC_CODES.ENUM_MISUSE,
              entry.source,
              `只有 type: enum 才能携带 ref；当前 type 是 "${String(prop.type)}"`,
              "移除 ref 或将 type 改为 enum",
              `${suffix}.ref`,
            );
          }
          if (prop.status === "TBD" || prop.status === "draft") {
            report(
              ctx,
              DIAGNOSTIC_CODES.DRAFT_MARKER,
              entry.source,
              `属性 "${propName}" 标记为 ${String(prop.status)}，待客户确认后收紧`,
              undefined,
              suffix,
              "warning",
            );
          }
        }
      }
    }
  }
}

function checkImplements(ctx: Ctx, merged: MergedSchema): void {
  for (const obj of merged.objectTypes) {
    if (!isPlainObject(obj.def)) continue;
    const def = obj.def as Record<string, unknown>;
    const implementsList = Array.isArray(def.implements) ? (def.implements as string[]) : [];
    for (const ifaceId of implementsList) {
      const iface = merged.interfaces.find((t) => t.id === ifaceId);
      if (!iface) {
        report(
          ctx,
          DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF,
          obj.source,
          `implements 引用不存在的 interface "${ifaceId}"`,
          `已定义 interface: ${merged.interfaces.map((t) => t.id).join(", ") || "(无)"}`,
          "implements",
        );
        continue;
      }
      // 属性一致性：同名属性必须与接口声明完全一致
      const ifaceProps = isPlainObject((iface.def as Record<string, unknown>).properties)
        ? ((iface.def as Record<string, unknown>).properties as Record<string, unknown>)
        : {};
      const ownProps = isPlainObject(def.properties) ? (def.properties as Record<string, unknown>) : {};
      for (const [propName, ifaceProp] of Object.entries(ifaceProps)) {
        const own = ownProps[propName];
        if (own === undefined) continue; // 未重定义 = 继承，合法
        const keys = ["type", "ref", "required", "immutable"];
        for (const key of keys) {
          const a = isPlainObject(ifaceProp) ? ifaceProp[key] : undefined;
          const b = isPlainObject(own) ? own[key] : undefined;
          if (a !== b) {
            report(
              ctx,
              DIAGNOSTIC_CODES.INTERFACE_MISMATCH,
              obj.source,
              `属性 "${propName}" 的 ${key} 与接口 ${ifaceId} 不一致（${String(a)} ≠ ${String(b)}）`,
              "重定义必须与接口完全一致，或删除重定义直接继承",
              `properties.${propName}.${key}`,
            );
          }
        }
      }
    }
    // properties 与 derived 键不得重复
    const props = isPlainObject(def.properties) ? Object.keys(def.properties) : [];
    const derived = isPlainObject(def.derived) ? Object.keys(def.derived as Record<string, unknown>) : [];
    for (const k of derived) {
      if (props.includes(k)) {
        report(
          ctx,
          DIAGNOSTIC_CODES.INTERFACE_MISMATCH,
          obj.source,
          `properties 与 derived 重复定义 "${k}"`,
          "派生字段与存储字段必须不同名",
          `derived.${k}`,
        );
      }
    }
  }
}

function checkTypeRefs(ctx: Ctx, merged: MergedSchema): void {
  for (const link of merged.linkTypes) {
    if (!isPlainObject(link.def)) continue;
    for (const key of ["from", "to"] as const) {
      const t = link.def[key];
      if (typeof t === "string" && !typeExists(merged, t)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF, link.source, `linkType 端点 "${t}" 不存在`, undefined, key);
      }
    }
  }
  for (const action of merged.actions) {
    if (!isPlainObject(action.def)) continue;
    const target = action.def.target;
    if (typeof target === "string" && !merged.objectTypes.some((t) => t.id === target)) {
      report(ctx, DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF, action.source, `action.target "${target}" 不是已定义 objectType`, undefined, "target");
    }
  }
  for (const proj of merged.projections) {
    if (!isPlainObject(proj.def)) continue;
    const basedOn = Array.isArray(proj.def.basedOn) ? (proj.def.basedOn as string[]) : [];
    if (basedOn.length === 0) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_PROJECTION_BASES, proj.source, "projection.basedOn 不能为空", undefined, "basedOn");
    }
    const seen = new Set<string>();
    for (const t of basedOn) {
      if (seen.has(t)) {
        report(ctx, DIAGNOSTIC_CODES.INVALID_PROJECTION_BASES, proj.source, `projection.basedOn 含重复 "${t}"`, undefined, "basedOn");
      }
      seen.add(t);
      if (!typeExists(merged, t)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF, proj.source, `projection.basedOn 引用不存在的类型 "${t}"`, undefined, "basedOn");
      }
    }
  }
  for (const conn of merged.connectors) {
    if (!isPlainObject(conn.def) || !isPlainObject(conn.def.mapping)) continue;
    for (const t of Object.keys(conn.def.mapping)) {
      if (!merged.objectTypes.some((x) => x.id === t)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF, conn.source, `connector.mapping 引用不存在的 objectType "${t}"`, undefined, `mapping.${t}`);
      }
    }
  }
  for (const rule of merged.rules) {
    if (!isPlainObject(rule.def) || !Array.isArray(rule.def.scope)) continue;
    for (const t of rule.def.scope as string[]) {
      if (!typeExists(merged, t)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF, rule.source, `rule.scope 引用不存在的类型 "${t}"`, undefined, "scope");
      }
    }
  }
}

function checkRoles(ctx: Ctx, merged: MergedSchema): void {
  const roleIds = new Set(merged.roleDefinitions.map((r) => r.id));
  for (const action of merged.actions) {
    if (!isPlainObject(action.def)) continue;
    const roles = Array.isArray(action.def.actorRoles) ? (action.def.actorRoles as string[]) : [];
    if (roles.length === 0) {
      report(ctx, DIAGNOSTIC_CODES.EMPTY_ACTOR_ROLES, action.source, "action.actorRoles 不能为空", undefined, "actorRoles");
    }
    for (const r of roles) {
      if (!roleIds.has(r)) {
        report(
          ctx,
          DIAGNOSTIC_CODES.UNKNOWN_ROLE_REF,
          action.source,
          `actorRoles 引用未定义角色 "${r}"`,
          `在 roleDefinitions 中声明；已定义: ${[...roleIds].join(", ") || "(无)"}`,
          "actorRoles",
        );
      }
    }
  }
  for (const policy of merged.policies) {
    if (!isPlainObject(policy.def)) continue;
    const roles = Array.isArray(policy.def.roles) ? (policy.def.roles as string[]) : [];
    for (const r of roles) {
      if (!roleIds.has(r)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_ROLE_REF, policy.source, `policy.roles 引用未定义角色 "${r}"`, undefined, "roles");
      }
    }
  }
}

const POLICY_VERBS = new Set(["read", "write", "*"]);

function checkPolicies(ctx: Ctx, merged: MergedSchema): void {
  const actionIds = new Set(merged.actions.map((a) => a.id));
  for (const policy of merged.policies) {
    if (!isPlainObject(policy.def)) continue;
    const resources = Array.isArray(policy.def.resources) ? (policy.def.resources as string[]) : [];
    const actions = Array.isArray(policy.def.actions) ? (policy.def.actions as string[]) : [];
    const fields = Array.isArray(policy.def.fields) ? (policy.def.fields as string[]) : [];
    const wildcardResources = resources.includes("*");
    for (const r of resources) {
      if (r === "*") continue;
      if (!typeExists(merged, r)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_POLICY_REF, policy.source, `policy.resources 引用不存在的类型 "${r}"`, undefined, "resources");
      }
    }
    for (const a of actions) {
      if (POLICY_VERBS.has(a)) continue;
      if (!actionIds.has(a)) {
        report(ctx, DIAGNOSTIC_CODES.UNKNOWN_POLICY_REF, policy.source, `policy.actions 引用不存在的 action "${a}"`, undefined, "actions");
      }
    }
    // 字段存在性：字段须出现在至少一个被引用类型的字段集中
    if (!fields.includes("*")) {
      const knownFields = new Set<string>();
      const resourceTypes = wildcardResources
        ? merged.objectTypes.map((t) => t.id)
        : resources.filter((r) => r !== "*");
      for (const t of resourceTypes) {
        for (const f of collectTypeFields(merged, t).fields) knownFields.add(f);
      }
      for (const f of fields) {
        if (!knownFields.has(f)) {
          report(
            ctx,
            DIAGNOSTIC_CODES.UNKNOWN_POLICY_REF,
            policy.source,
            `policy.fields 引用字段 "${f}" 在 resources 所列类型中不存在`,
            undefined,
            "fields",
          );
        }
      }
    }
  }
}

/** 收集 AST 中出现的全部 path / valuePath。 */
function collectAstPaths(node: unknown, out: string[]): void {
  if (!isPlainObject(node)) return;
  for (const key of ["path", "valuePath", "over"] as const) {
    const v = node[key];
    if (typeof v === "string" && key !== "over") out.push(v);
  }
  if (Array.isArray(node.args)) node.args.forEach((c) => collectAstPaths(c, out));
  if (node.arg !== undefined) collectAstPaths(node.arg, out);
}

function leafOf(path: string): string {
  const parts = path.split(".");
  return parts[parts.length - 1];
}

function checkRulePaths(ctx: Ctx, merged: MergedSchema): void {
  for (const rule of merged.rules) {
    if (!isPlainObject(rule.def)) continue;
    const scope = Array.isArray(rule.def.scope) ? (rule.def.scope as string[]) : [];
    const scopeTypes = scope.length > 0 ? scope : merged.objectTypes.map((t) => t.id);
    const knownLeaves = new Set<string>();
    for (const t of scopeTypes) {
      for (const f of collectTypeFields(merged, t).fields) knownLeaves.add(f);
    }
    const paths: string[] = [];
    collectAstPaths(rule.def.when, paths);
    for (const p of paths) {
      const leaf = leafOf(p);
      if (!knownLeaves.has(leaf)) {
        report(
          ctx,
          DIAGNOSTIC_CODES.UNKNOWN_RULE_PATH,
          rule.source,
          `rule path "${p}" 的叶子字段 "${leaf}" 在 scope 类型 [${scopeTypes.join(", ")}] 中不存在`,
          "在 objectType 的 properties 或 derived 中声明该字段",
          "when",
        );
      }
    }
  }
  for (const action of merged.actions) {
    if (!isPlainObject(action.def)) continue;
    const preconditions = Array.isArray(action.def.preconditions) ? action.def.preconditions : [];
    const target = typeof action.def.target === "string" ? action.def.target : undefined;
    const targetFields = target ? collectTypeFields(merged, target).fields : new Set<string>();
    const inputFields = isPlainObject(action.def.inputs)
      ? new Set(Object.keys(action.def.inputs))
      : new Set<string>();
    preconditions.forEach((node, i) => {
      const paths: string[] = [];
      collectAstPaths(node, paths);
      for (const p of paths) {
        const root = p.split(".")[0];
        const leaf = leafOf(p);
        if (root === "input") {
          if (!inputFields.has(leaf)) {
            report(ctx, DIAGNOSTIC_CODES.UNKNOWN_RULE_PATH, action.source, `precondition 引用未知输入 "${p}"`, undefined, `preconditions[${i}]`);
          }
        } else if (root === "target") {
          if (target && !targetFields.has(leaf)) {
            report(
              ctx,
              DIAGNOSTIC_CODES.UNKNOWN_RULE_PATH,
              action.source,
              `precondition 引用 "${p}"，但 ${target} 无字段 "${leaf}"（含 derived）`,
              "在 target 类型的 properties/derived 中声明",
              `preconditions[${i}]`,
            );
          }
        } else {
          report(
            ctx,
            DIAGNOSTIC_CODES.UNKNOWN_RULE_PATH,
            action.source,
            `action precondition path 必须以 input. 或 target. 开头，当前是 "${p}"`,
            undefined,
            `preconditions[${i}]`,
          );
        }
      }
    });
  }
}

export function validateSemantics(files: ParsedFile[]): { merged: MergedSchema; diagnostics: Diagnostic[] } {
  const merged = mergeSchemaFiles(files);
  const byFile = new Map(files.map((f) => [f.file, f]));
  const ctx: Ctx = {
    out: [],
    posOf: (source, suffix) => {
      const file = byFile.get(source.file);
      const path = suffix ? `${source.path}.${suffix}` : source.path;
      return file?.positions.get(path) ?? file?.positions.get(source.path) ?? { line: 0, col: 0 };
    },
  };
  checkPropertyBags(ctx, merged);
  checkImplements(ctx, merged);
  checkTypeRefs(ctx, merged);
  checkRoles(ctx, merged);
  checkPolicies(ctx, merged);
  checkRulePaths(ctx, merged);
  // valueSet draft 提醒
  for (const vs of merged.valueSets) {
    if (isPlainObject(vs.def) && (vs.def.status === "draft" || vs.def.status === "proposed")) {
      report(
        ctx,
        DIAGNOSTIC_CODES.DRAFT_MARKER,
        vs.source,
        `valueSet "${vs.id}" 状态为 ${String(vs.def.status)}，口径待客户确认`,
        undefined,
        "status",
        "warning",
      );
    }
  }
  return { merged, diagnostics: ctx.out };
}
