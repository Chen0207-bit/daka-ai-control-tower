import { stableStringify, type CanonicalIR, type IRAction, type IRProperty } from "./ir";

/**
 * 兼容性分析（spec §12）。
 * 输入为两份 Canonical IR（编译产物），输出分级变更清单与建议版本升级幅度。
 */

export type ChangeClass = "additive" | "compatible" | "data-migration-required" | "breaking";

export interface OntologyChange {
  class: ChangeClass;
  kind: string;
  path: string;
  detail: string;
}

export interface DiffResult {
  changes: OntologyChange[];
  highest: ChangeClass | "none";
  suggestedBump: "major" | "minor" | "patch" | "none";
}

const RANK: Record<ChangeClass, number> = {
  additive: 0,
  compatible: 1,
  "data-migration-required": 2,
  breaking: 3,
};

const CARDINALITY_RANK: Record<string, number> = {
  one_to_one: 0,
  one_to_many: 1,
  many_to_one: 1,
  many_to_many: 2,
};

/** 存在无损转换的类型对 */
const LOSSLESS_TYPE_CONVERSIONS = new Set(["integer>decimal", "string>text", "date>datetime"]);

const SECURITY_RANK: Record<string, number> = { internal: 0, confidential: 1, highly_confidential: 2 };

function push(out: OntologyChange[], cls: ChangeClass, kind: string, path: string, detail: string): void {
  out.push({ class: cls, kind, path, detail });
}

function diffProperties(
  out: OntologyChange[],
  owner: string,
  base: Record<string, IRProperty>,
  target: Record<string, IRProperty>,
): void {
  for (const name of Object.keys(base)) {
    const b = base[name];
    const t = target[name];
    const path = `${owner}.${name}`;
    if (!t) {
      push(out, "breaking", "property-removed", path, `属性 "${name}" 被删除`);
      continue;
    }
    if (b.type !== t.type || b.ref !== t.ref) {
      const conversion = `${b.type}>${t.type}`;
      if (b.ref === t.ref && LOSSLESS_TYPE_CONVERSIONS.has(conversion)) {
        push(out, "data-migration-required", "property-type-widened", path, `类型 ${b.type} → ${t.type}（存在无损转换，需回填）`);
      } else {
        push(out, "breaking", "property-type-changed", path, `类型/引用变化 ${b.type}${b.ref ? `(${b.ref})` : ""} → ${t.type}${t.ref ? `(${t.ref})` : ""}`);
      }
    }
    if (!b.required && t.required) {
      push(out, "breaking", "property-required-tightened", path, "可选属性变为必填（无默认值）");
    }
    if (b.required && !t.required) {
      push(out, "compatible", "property-required-loosened", path, "必填属性变为可选");
    }
    if (!b.immutable && t.immutable) {
      push(out, "breaking", "property-immutable-tightened", path, "属性变为不可变");
    }
    if (b.immutable && !t.immutable) {
      push(out, "compatible", "property-immutable-loosened", path, "属性取消不可变");
    }
    const bs = SECURITY_RANK[b.security] ?? 0;
    const ts = SECURITY_RANK[t.security] ?? 0;
    if (ts > bs) push(out, "compatible", "property-security-tightened", path, `密级提升 ${b.security} → ${t.security}`);
    if (ts < bs) push(out, "breaking", "property-security-loosened", path, `密级降低 ${b.security} → ${t.security}，需人工评审`);
  }
  for (const name of Object.keys(target)) {
    if (base[name]) continue;
    const t = target[name];
    if (t.required) {
      push(out, "breaking", "property-added-required", `${owner}.${name}`, "新增必填属性（无默认值）");
    } else {
      push(out, "additive", "property-added", `${owner}.${name}`, "新增可选属性");
    }
  }
}

function diffActions(out: OntologyChange[], base: Record<string, IRAction>, target: Record<string, IRAction>): void {
  for (const id of Object.keys(base)) {
    const b = base[id];
    const t = target[id];
    if (!t) {
      push(out, "breaking", "action-removed", `actions.${id}`, "Action 被删除");
      continue;
    }
    if (b.handler !== t.handler) {
      push(out, "breaking", "action-handler-changed", `actions.${id}.handler`, `handler ${b.handler} → ${t.handler}`);
    }
    if (b.target !== t.target) {
      push(out, "breaking", "action-target-changed", `actions.${id}.target`, `target ${b.target} → ${t.target}`);
    }
    if (stableStringify(b.preconditions) !== stableStringify(t.preconditions)) {
      push(out, "breaking", "action-preconditions-changed", `actions.${id}.preconditions`, "前置条件变化（行为契约改变）");
    }
    const removedRoles = b.actorRoles.filter((r) => !t.actorRoles.includes(r));
    const addedRoles = t.actorRoles.filter((r) => !b.actorRoles.includes(r));
    if (removedRoles.length > 0) {
      push(out, "breaking", "action-roles-narrowed", `actions.${id}.actorRoles`, `移除角色 ${removedRoles.join(", ")}`);
    }
    if (addedRoles.length > 0) {
      push(out, "compatible", "action-roles-widened", `actions.${id}.actorRoles`, `新增角色 ${addedRoles.join(", ")}`);
    }
    diffProperties(out, `actions.${id}.inputs`, b.inputs, t.inputs);
  }
  for (const id of Object.keys(target)) {
    if (!base[id]) push(out, "additive", "action-added", `actions.${id}`, "新增 Action");
  }
}

export function diffIR(base: CanonicalIR, target: CanonicalIR): DiffResult {
  const out: OntologyChange[] = [];

  // objectTypes（含 interface 解析后字段以捕获继承变化）
  for (const id of Object.keys(base.objectTypes)) {
    const b = base.objectTypes[id];
    const t = target.objectTypes[id];
    if (!t) {
      push(out, "breaking", "objectType-removed", `objectTypes.${id}`, "objectType 被删除");
      continue;
    }
    diffProperties(out, `objectTypes.${id}`, b.properties, t.properties);
    diffProperties(out, `objectTypes.${id}.derived`, b.derived, t.derived);
    const removedIfaces = b.implements.filter((i) => !t.implements.includes(i));
    const addedIfaces = t.implements.filter((i) => !b.implements.includes(i));
    for (const i of removedIfaces) push(out, "breaking", "interface-unimplemented", `objectTypes.${id}.implements`, `不再实现 ${i}`);
    for (const i of addedIfaces) push(out, "additive", "interface-implemented", `objectTypes.${id}.implements`, `新增实现 ${i}`);
  }
  for (const id of Object.keys(target.objectTypes)) {
    if (!base.objectTypes[id]) push(out, "additive", "objectType-added", `objectTypes.${id}`, "新增 objectType");
  }

  // interfaces
  for (const id of Object.keys(base.interfaces)) {
    const b = base.interfaces[id];
    const t = target.interfaces[id];
    if (!t) {
      push(out, "breaking", "interface-removed", `interfaces.${id}`, "interface 被删除");
      continue;
    }
    diffProperties(out, `interfaces.${id}`, b.properties, t.properties);
  }
  for (const id of Object.keys(target.interfaces)) {
    if (!base.interfaces[id]) push(out, "additive", "interface-added", `interfaces.${id}`, "新增 interface");
  }

  // valueSets：扩大=compatible，缩减=breaking
  for (const id of Object.keys(base.valueSets)) {
    const b = base.valueSets[id];
    const t = target.valueSets[id];
    if (!t) {
      push(out, "breaking", "valueSet-removed", `valueSets.${id}`, "valueSet 被删除");
      continue;
    }
    const removed = b.values.filter((v) => !t.values.includes(v));
    const added = t.values.filter((v) => !b.values.includes(v));
    if (removed.length > 0) push(out, "breaking", "valueSet-shrunk", `valueSets.${id}`, `移除枚举值 ${removed.join(", ")}`);
    if (added.length > 0) push(out, "compatible", "valueSet-expanded", `valueSets.${id}`, `新增枚举值 ${added.join(", ")}`);
  }
  for (const id of Object.keys(target.valueSets)) {
    if (!base.valueSets[id]) push(out, "additive", "valueSet-added", `valueSets.${id}`, "新增 valueSet");
  }

  // linkTypes：基数收紧=breaking，放宽=compatible，同级变化=breaking
  for (const id of Object.keys(base.linkTypes)) {
    const b = base.linkTypes[id];
    const t = target.linkTypes[id];
    if (!t) {
      push(out, "breaking", "linkType-removed", `linkTypes.${id}`, "linkType 被删除");
      continue;
    }
    if (b.from !== t.from || b.to !== t.to) {
      push(out, "breaking", "linkType-endpoint-changed", `linkTypes.${id}`, `端点 ${b.from}→${b.to} 变为 ${t.from}→${t.to}`);
    }
    if (b.cardinality !== t.cardinality) {
      const br = CARDINALITY_RANK[b.cardinality] ?? 0;
      const tr = CARDINALITY_RANK[t.cardinality] ?? 0;
      if (tr > br) push(out, "compatible", "cardinality-loosened", `linkTypes.${id}.cardinality`, `${b.cardinality} → ${t.cardinality}`);
      else if (tr < br) push(out, "breaking", "cardinality-tightened", `linkTypes.${id}.cardinality`, `${b.cardinality} → ${t.cardinality}`);
      else push(out, "breaking", "cardinality-changed", `linkTypes.${id}.cardinality`, `${b.cardinality} → ${t.cardinality}（同级语义变化）`);
    }
  }
  for (const id of Object.keys(target.linkTypes)) {
    if (!base.linkTypes[id]) push(out, "additive", "linkType-added", `linkTypes.${id}`, "新增 linkType");
  }

  diffActions(out, base.actions, target.actions);

  // rules/policies/projections/connectors：新增 additive，删除/修改 breaking（行为安全）
  for (const [section, baseMap, targetMap] of [
    ["rules", base.rules, target.rules],
    ["policies", base.policies, target.policies],
    ["projections", base.projections, target.projections],
    ["connectors", base.connectors, target.connectors],
  ] as const) {
    for (const id of Object.keys(baseMap)) {
      const b = (baseMap as Record<string, unknown>)[id];
      const t = (targetMap as Record<string, unknown>)[id];
      if (!t) {
        push(out, "breaking", `${section}-removed`, `${section}.${id}`, `${section} 条目被删除`);
      } else if (stableStringify(b) !== stableStringify(t)) {
        push(out, "breaking", `${section}-changed`, `${section}.${id}`, `${section} 条目内容变化（行为契约）`);
      }
    }
    for (const id of Object.keys(targetMap)) {
      if (!(baseMap as Record<string, unknown>)[id]) {
        push(out, "additive", `${section}-added`, `${section}.${id}`, `新增 ${section} 条目`);
      }
    }
  }

  let highest: DiffResult["highest"] = "none";
  for (const c of out) {
    if (highest === "none" || RANK[c.class] > RANK[highest as ChangeClass]) highest = c.class;
  }
  const suggestedBump: DiffResult["suggestedBump"] =
    highest === "breaking"
      ? "major"
      : highest === "data-migration-required"
        ? "minor"
        : highest === "compatible" || highest === "additive"
          ? "patch"
          : "none";
  out.sort((a, b) => RANK[b.class] - RANK[a.class] || a.path.localeCompare(b.path));
  return { changes: out, highest, suggestedBump };
}
