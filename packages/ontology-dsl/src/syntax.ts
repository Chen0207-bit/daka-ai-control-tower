import { DIAGNOSTIC_CODES, type Diagnostic } from "./diagnostics";
import type { ParsedFile } from "./parse";
import { validateRuleNode } from "./rule-ast";

export const KNOWN_SECTIONS = [
  "meta",
  "imports",
  "valueSets",
  "interfaces",
  "objectTypes",
  "linkTypes",
  "actions",
  "rules",
  "policies",
  "roleDefinitions",
  "projections",
  "connectors",
] as const;

export const PRIMITIVE_TYPES = [
  "uuid",
  "string",
  "text",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uri",
  "json",
] as const;

export const PROPERTY_ATTRIBUTES = [
  "type",
  "ref",
  "required",
  "immutable",
  "security",
  "status",
  "description",
] as const;

export const CARDINALITIES = [
  "one_to_one",
  "one_to_many",
  "many_to_one",
  "many_to_many",
] as const;

export const SUPPORTED_DSL_MAJORS = ["1"] as const;

export const DATA_SCOPES = ["tenant", "workspace", "aggregated_only"] as const;

export const HANDLER_RE = /^[a-z][A-Za-z0-9_.]*$/;
export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export const POLICY_EFFECTS = ["allow", "deny"] as const;
export const CONNECTOR_KINDS = ["yaml"] as const;

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/;
const CAMEL_RE = /^[a-z][A-Za-z0-9]*$/;
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

function closestType(t: string): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const candidate of PRIMITIVE_TYPES) {
    const d = editDistance(t, candidate);
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return bestD <= 3 ? best : undefined;
}

/** 校验类型表达式：原始类型或 list<原始类型>；enum 单独处理。 */
function isValidTypeExpr(t: string): boolean {
  if ((PRIMITIVE_TYPES as readonly string[]).includes(t)) return true;
  const m = /^list<([a-z]+)>$/.exec(t);
  return m != null && (PRIMITIVE_TYPES as readonly string[]).includes(m[1]);
}

interface Ctx {
  file: ParsedFile;
  out: Diagnostic[];
}

function report(
  ctx: Ctx,
  code: Diagnostic["code"],
  path: string,
  message: string,
  suggestion?: string,
): void {
  const pos = ctx.file.positions.get(path) ?? { line: 0, col: 0 };
  ctx.out.push({
    code,
    severity: "error",
    file: ctx.file.file,
    line: pos.line,
    col: pos.col,
    path,
    message,
    suggestion,
  });
}

function checkId(ctx: Ctx, path: string, id: string, re: RegExp, kind: string): void {
  if (!re.test(id)) {
    report(
      ctx,
      DIAGNOSTIC_CODES.INVALID_ID,
      path,
      `${kind} ID "${id}" 不符合命名规则 ${re}`,
      kind.includes("Type") || kind === "interface" ? "使用 PascalCase，如 RightsGrant" : "使用 camelCase，如 paymentStatus",
    );
  }
}

function validateMeta(ctx: Ctx, meta: unknown): void {
  if (!isPlainObject(meta)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_META, "meta", "meta 必须是 mapping");
    return;
  }
  const name = meta.name;
  if (typeof name !== "string" || !KEBAB_RE.test(name)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_META, "meta.name", "meta.name 必填且为 kebab-case");
  }
  const version = meta.version;
  if (typeof version !== "string" || !SEMVER_RE.test(version)) {
    report(
      ctx,
      DIAGNOSTIC_CODES.INVALID_SEMVER,
      "meta.version",
      `meta.version "${String(version)}" 不是合法 SemVer`,
      "形如 1.0.0 或 1.0.0-rc.1",
    );
  }
  const dsl = meta.dsl;
  if (typeof dsl !== "string" || !(SUPPORTED_DSL_MAJORS as readonly string[]).includes(dsl)) {
    report(
      ctx,
      DIAGNOSTIC_CODES.INVALID_META,
      "meta.dsl",
      `meta.dsl "${String(dsl)}" 不受支持；当前支持的 DSL major: ${SUPPORTED_DSL_MAJORS.join(", ")}`,
      `设置 dsl: "${SUPPORTED_DSL_MAJORS[0]}"`,
    );
  }
}

function validateProperties(ctx: Ctx, sectionPath: string, properties: unknown, bag = "properties"): void {
  if (properties === undefined) return;
  if (!isPlainObject(properties)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${sectionPath}.${bag}`, `${bag} 必须是 mapping`);
    return;
  }
  for (const [propName, prop] of Object.entries(properties)) {
    const propPath = `${sectionPath}.${bag}.${propName}`;
    checkId(ctx, propPath, propName, CAMEL_RE, "property");
    if (!isPlainObject(prop)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, propPath, "property 定义必须是 mapping");
      continue;
    }
    for (const attr of Object.keys(prop)) {
      if (!(PROPERTY_ATTRIBUTES as readonly string[]).includes(attr)) {
        report(
          ctx,
          DIAGNOSTIC_CODES.UNKNOWN_ATTRIBUTE,
          `${propPath}.${attr}`,
          `未知 property 属性 "${attr}"`,
          `允许: ${PROPERTY_ATTRIBUTES.join(", ")}`,
        );
      }
    }
    const type = prop.type;
    if (typeof type !== "string") {
      report(ctx, DIAGNOSTIC_CODES.UNKNOWN_TYPE, `${propPath}.type`, "property 缺少字符串 type");
      continue;
    }
    if (type === "enum") {
      const ref = prop.ref;
      if (typeof ref !== "string" || !CAMEL_RE.test(ref)) {
        report(
          ctx,
          DIAGNOSTIC_CODES.INVALID_ENUM_REF,
          `${propPath}.ref`,
          "type: enum 必须带 camelCase 的 ref 指向 valueSet",
          "如 {type: enum, ref: paymentStatus}",
        );
      }
      continue;
    }
    if (!isValidTypeExpr(type)) {
      const near = closestType(type);
      report(
        ctx,
        DIAGNOSTIC_CODES.UNKNOWN_TYPE,
        `${propPath}.type`,
        `未知类型 "${type}"`,
        near ? `是否想用 "${near}"？合法类型: ${PRIMITIVE_TYPES.join(", ")}, list<T>, enum` : `合法类型: ${PRIMITIVE_TYPES.join(", ")}, list<T>, enum`,
      );
    }
  }
}

function validateValueSets(ctx: Ctx, valueSets: unknown): void {
  if (!isPlainObject(valueSets)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "valueSets", "valueSets 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(valueSets)) {
    const path = `valueSets.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "valueSet");
    if (!isPlainObject(def) || !Array.isArray(def.values) || def.values.some((v) => typeof v !== "string")) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, `valueSet "${id}" 必须含 values: 字符串数组`);
    }
  }
}

function validateTypeSection(ctx: Ctx, section: "interfaces" | "objectTypes", defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, section, `${section} 必须是 mapping`);
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `${section}.${id}`;
    checkId(ctx, path, id, PASCAL_RE, "objectType");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, `${section} 条目必须是 mapping`);
      continue;
    }
    if (def.implements !== undefined) {
      const ok = Array.isArray(def.implements) && def.implements.every((i) => typeof i === "string" && PASCAL_RE.test(i));
      if (!ok) {
        report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.implements`, "implements 必须是 PascalCase 字符串数组");
      }
    }
    validateProperties(ctx, path, def.properties);
  }
}

function validateLinkTypes(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "linkTypes", "linkTypes 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `linkTypes.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "linkType");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "linkType 条目必须是 mapping");
      continue;
    }
    for (const key of ["from", "to"] as const) {
      const v = def[key];
      if (typeof v !== "string" || !PASCAL_RE.test(v)) {
        report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.${key}`, `linkType.${key} 必须是 PascalCase 类型引用`);
      }
    }
    const c = def.cardinality;
    if (typeof c !== "string" || !(CARDINALITIES as readonly string[]).includes(c)) {
      report(
        ctx,
        DIAGNOSTIC_CODES.INVALID_CARDINALITY,
        `${path}.cardinality`,
        `非法 cardinality "${String(c)}"`,
        `允许: ${CARDINALITIES.join(", ")}`,
      );
    }
  }
}

function validateActions(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "actions", "actions 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `actions.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "action");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "action 条目必须是 mapping");
      continue;
    }
    if (typeof def.target !== "string" || !PASCAL_RE.test(def.target)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.target`, "action.target 必须是 PascalCase objectType 引用");
    }
    if (typeof def.handler !== "string" || !HANDLER_RE.test(def.handler)) {
      report(
        ctx,
        DIAGNOSTIC_CODES.INVALID_HANDLER,
        `${path}.handler`,
        `非法 handler key "${String(def.handler)}"`,
        "形如 payment.record；handler 必须由 Runtime 代码注册，DSL 不含可执行代码",
      );
    }
    if (!Array.isArray(def.actorRoles) || def.actorRoles.some((r) => typeof r !== "string" || !CAMEL_RE.test(r))) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.actorRoles`, "actorRoles 必须是 camelCase 字符串数组");
    }
    validateProperties(ctx, path, def.inputs);
    if (def.preconditions !== undefined) {
      if (!Array.isArray(def.preconditions)) {
        report(ctx, DIAGNOSTIC_CODES.INVALID_RULE_AST, `${path}.preconditions`, "preconditions 必须是受限 AST 节点数组");
      } else {
        def.preconditions.forEach((node, i) =>
          validateRuleNode({ file: ctx.file, out: ctx.out }, node, `${path}.preconditions[${i}]`),
        );
      }
    }
    if (def.effects !== undefined && (!Array.isArray(def.effects) || def.effects.some((e) => typeof e !== "string"))) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.effects`, "effects 必须是字符串契约列表");
    }
  }
}

function validateRules(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "rules", "rules 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `rules.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "rule");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "rule 条目必须是 mapping");
      continue;
    }
    if (typeof def.severity !== "string" || !(SEVERITIES as readonly string[]).includes(def.severity)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.severity`, `非法 severity "${String(def.severity)}"`, `允许: ${SEVERITIES.join(", ")}`);
    }
    if (def.scope !== undefined && (!Array.isArray(def.scope) || def.scope.some((s) => typeof s !== "string" || !PASCAL_RE.test(s)))) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.scope`, "scope 必须是 PascalCase 类型引用数组");
    }
    validateRuleNode({ file: ctx.file, out: ctx.out }, def.when, `${path}.when`);
    if (typeof def.result !== "string" || def.result.length === 0) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.result`, "rule.result 必须是声明式结果标识字符串");
    }
  }
}

function validatePolicies(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "policies", "policies 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `policies.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "policy");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "policy 条目必须是 mapping");
      continue;
    }
    if (typeof def.effect !== "string" || !(POLICY_EFFECTS as readonly string[]).includes(def.effect)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.effect`, `非法 effect "${String(def.effect)}"`, "允许: allow, deny");
    }
    for (const key of ["roles", "resources", "actions", "fields"] as const) {
      const v = def[key];
      if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string")) {
        report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.${key}`, `policy.${key} 必须是非空字符串数组`);
      }
    }
  }
}

function validateProjections(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "projections", "projections 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `projections.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "projection");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "projection 条目必须是 mapping");
      continue;
    }
    if (!Array.isArray(def.basedOn) || def.basedOn.some((t) => typeof t !== "string" || !PASCAL_RE.test(t))) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.basedOn`, "basedOn 必须是 PascalCase 类型引用数组");
    }
    validateProperties(ctx, path, def.metrics);
  }
}

function validateConnectors(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "connectors", "connectors 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `connectors.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "connector");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "connector 条目必须是 mapping");
      continue;
    }
    if (typeof def.kind !== "string" || !(CONNECTOR_KINDS as readonly string[]).includes(def.kind)) {
      report(
        ctx,
        DIAGNOSTIC_CODES.INVALID_CONNECTOR_KIND,
        `${path}.kind`,
        `非法 connector kind "${String(def.kind)}"`,
        `v1 内置: ${CONNECTOR_KINDS.join(", ")}；其他 kind 由 Runtime 注册`,
      );
    }
    if (def.mapping !== undefined && !isPlainObject(def.mapping)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, `${path}.mapping`, "connector.mapping 必须是 mapping");
    }
  }
}

function validateRoleDefinitions(ctx: Ctx, defs: unknown): void {
  if (!isPlainObject(defs)) {
    report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "roleDefinitions", "roleDefinitions 必须是 mapping");
    return;
  }
  for (const [id, def] of Object.entries(defs)) {
    const path = `roleDefinitions.${id}`;
    checkId(ctx, path, id, CAMEL_RE, "role");
    if (!isPlainObject(def)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, path, "role 条目必须是 mapping");
      continue;
    }
    const scope = def.dataScope;
    if (typeof scope !== "string" || !(DATA_SCOPES as readonly string[]).includes(scope)) {
      report(
        ctx,
        DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE,
        `${path}.dataScope`,
        `非法 dataScope "${String(scope)}"`,
        `允许: ${DATA_SCOPES.join(", ")}`,
      );
    }
  }
}

/**
 * 对一组已解析文件做语法/结构校验（含跨文件重复 ID）。
 * 解析失败的文件其 diagnostics 已在 ParsedFile 中，不在此重复报告。
 */
export function validateSyntax(files: ParsedFile[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seenIds = new Map<string, { file: string; line: number; col: number }>();

  for (const file of files) {
    const ctx: Ctx = { file, out };
    if (file.value === undefined) continue;
    if (!isPlainObject(file.value)) {
      report(ctx, DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE, "", "schema 文件顶层必须是 mapping");
      continue;
    }
    for (const key of Object.keys(file.value)) {
      if (!(KNOWN_SECTIONS as readonly string[]).includes(key)) {
        report(
          ctx,
          DIAGNOSTIC_CODES.UNKNOWN_SECTION,
          key,
          `未知顶层 section "${key}"`,
          `允许: ${KNOWN_SECTIONS.join(", ")}`,
        );
      }
    }

    if (file.value.meta !== undefined) validateMeta(ctx, file.value.meta);
    if (file.value.valueSets !== undefined) validateValueSets(ctx, file.value.valueSets);
    if (file.value.interfaces !== undefined) validateTypeSection(ctx, "interfaces", file.value.interfaces);
    if (file.value.objectTypes !== undefined) validateTypeSection(ctx, "objectTypes", file.value.objectTypes);
    if (file.value.linkTypes !== undefined) validateLinkTypes(ctx, file.value.linkTypes);
    if (file.value.roleDefinitions !== undefined) validateRoleDefinitions(ctx, file.value.roleDefinitions);
    if (file.value.actions !== undefined) validateActions(ctx, file.value.actions);
    if (file.value.rules !== undefined) validateRules(ctx, file.value.rules);
    if (file.value.policies !== undefined) validatePolicies(ctx, file.value.policies);
    if (file.value.projections !== undefined) validateProjections(ctx, file.value.projections);
    if (file.value.connectors !== undefined) validateConnectors(ctx, file.value.connectors);

    // 跨文件重复 ID（按 section 维度）
    for (const section of KNOWN_SECTIONS) {
      const defs = file.value[section];
      if (!isPlainObject(defs) || section === "meta" || section === "imports") continue;
      for (const id of Object.keys(defs)) {
        const key = `${section}.${id}`;
        const pos = file.positions.get(key) ?? { line: 0, col: 0 };
        const prev = seenIds.get(key);
        if (prev) {
          out.push({
            code: DIAGNOSTIC_CODES.DUPLICATE_ID,
            severity: "error",
            file: file.file,
            line: pos.line,
            col: pos.col,
            path: key,
            message: `重复 ID "${id}"；首次定义于 ${prev.file}:${prev.line}:${prev.col}`,
            suggestion: "重命名或合并两处定义",
          });
        } else {
          seenIds.set(key, { file: file.file, line: pos.line, col: pos.col });
        }
      }
    }
  }

  return out;
}
