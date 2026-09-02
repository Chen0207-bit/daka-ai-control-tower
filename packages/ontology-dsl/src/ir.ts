import type { MergedSchema, SectionEntry } from "./model";

/**
 * Canonical IR：Runtime 唯一消费格式。
 * - 深度字典序排序，与 authoring 文件拆分/顺序无关；
 * - interface 属性已解析进 objectType.fields；
 * - 默认值已填充（required=false、immutable=false、security=internal、idempotent=true）。
 */

export interface IRProperty {
  type: string;
  ref?: string;
  required: boolean;
  immutable: boolean;
  security: "internal" | "confidential" | "highly_confidential";
  status?: string;
  description?: string;
}

export interface IRObjectType {
  implements: string[];
  description?: string;
  security?: string;
  properties: Record<string, IRProperty>;
  derived: Record<string, IRProperty>;
  /** properties + derived + 继承的 interface 属性（resolved） */
  fields: Record<string, IRProperty & { origin: "own" | "derived" | "interface" }>;
}

export interface IRAction {
  target: string;
  handler: string;
  actorRoles: string[];
  inputs: Record<string, IRProperty>;
  preconditions: unknown[];
  effects: string[];
  idempotent: boolean;
  description?: string;
}

export interface IRRule {
  severity: string;
  scope: string[];
  when: unknown;
  result: string;
  description?: string;
}

export interface IRPolicy {
  effect: "allow" | "deny";
  roles: string[];
  resources: string[];
  actions: string[];
  fields: string[];
  description?: string;
}

export interface IRProjection {
  basedOn: string[];
  description?: string;
  metrics: Record<string, IRProperty>;
}

export interface CanonicalIR {
  meta: { name: string; version: string; dsl: string; description?: string };
  valueSets: Record<string, { values: string[]; status?: string }>;
  interfaces: Record<string, { description?: string; properties: Record<string, IRProperty> }>;
  objectTypes: Record<string, IRObjectType>;
  linkTypes: Record<string, { from: string; to: string; cardinality: string; status?: string; description?: string }>;
  actions: Record<string, IRAction>;
  rules: Record<string, IRRule>;
  policies: Record<string, IRPolicy>;
  roleDefinitions: Record<string, { description?: string; dataScope: string }>;
  projections: Record<string, IRProjection>;
  connectors: Record<string, { kind: string; description?: string; checkpoint?: string; mapping: Record<string, unknown> }>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

function toIRProperty(raw: unknown): IRProperty {
  const p = isPlainObject(raw) ? raw : {};
  const out: IRProperty = {
    type: typeof p.type === "string" ? p.type : "string",
    required: p.required === true,
    immutable: p.immutable === true,
    security:
      p.security === "confidential" || p.security === "highly_confidential" ? p.security : "internal",
  };
  if (typeof p.ref === "string") out.ref = p.ref;
  if (typeof p.status === "string") out.status = p.status;
  if (typeof p.description === "string") out.description = p.description;
  return out;
}

function toIRProperties(raw: unknown): Record<string, IRProperty> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, IRProperty> = {};
  for (const key of sortedKeys(raw)) out[key] = toIRProperty(raw[key]);
  return out;
}

function entryMap<T>(entries: SectionEntry[], fn: (def: Record<string, unknown>) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const e of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
    out[e.id] = fn(isPlainObject(e.def) ? e.def : {});
  }
  return out;
}

export function buildCanonicalIR(merged: MergedSchema): CanonicalIR {
  const meta = (merged.meta ?? {}) as Record<string, unknown>;

  const interfaces = entryMap(merged.interfaces, (def) => ({
    ...(typeof def.description === "string" ? { description: def.description } : {}),
    properties: toIRProperties(def.properties),
  }));

  const objectTypes: Record<string, IRObjectType> = {};
  for (const entry of [...merged.objectTypes].sort((a, b) => a.id.localeCompare(b.id))) {
    const def = isPlainObject(entry.def) ? entry.def : {};
    const implementsList = Array.isArray(def.implements)
      ? (def.implements as string[]).filter((x) => typeof x === "string").sort()
      : [];
    const properties = toIRProperties(def.properties);
    const derived = toIRProperties(def.derived);
    const fields: IRObjectType["fields"] = {};
    for (const ifaceId of implementsList) {
      const iface = interfaces[ifaceId];
      if (!iface) continue;
      for (const [k, v] of Object.entries(iface.properties)) {
        fields[k] = { ...v, origin: "interface" };
      }
    }
    for (const [k, v] of Object.entries(properties)) {
      fields[k] = { ...v, origin: "own" };
    }
    for (const [k, v] of Object.entries(derived)) {
      fields[k] = { ...v, origin: "derived" };
    }
    objectTypes[entry.id] = {
      implements: implementsList,
      ...(typeof def.description === "string" ? { description: def.description } : {}),
      ...(typeof def.security === "string" ? { security: def.security } : {}),
      properties,
      derived,
      fields: Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  return {
    meta: {
      name: String(meta.name ?? ""),
      version: String(meta.version ?? ""),
      dsl: String(meta.dsl ?? ""),
      ...(typeof meta.description === "string" ? { description: meta.description } : {}),
    },
    valueSets: entryMap(merged.valueSets, (def) => ({
      values: Array.isArray(def.values) ? [...(def.values as string[])].sort() : [],
      ...(typeof def.status === "string" ? { status: def.status } : {}),
    })),
    interfaces,
    objectTypes,
    linkTypes: entryMap(merged.linkTypes, (def) => ({
      from: String(def.from ?? ""),
      to: String(def.to ?? ""),
      cardinality: String(def.cardinality ?? ""),
      ...(typeof def.status === "string" ? { status: def.status } : {}),
      ...(typeof def.description === "string" ? { description: def.description } : {}),
    })),
    actions: entryMap(merged.actions, (def) => ({
      target: String(def.target ?? ""),
      handler: String(def.handler ?? ""),
      actorRoles: Array.isArray(def.actorRoles) ? [...(def.actorRoles as string[])].sort() : [],
      inputs: toIRProperties(def.inputs),
      preconditions: Array.isArray(def.preconditions) ? def.preconditions : [],
      effects: Array.isArray(def.effects) ? [...(def.effects as string[])].sort() : [],
      idempotent: def.idempotent !== false,
      ...(typeof def.description === "string" ? { description: def.description } : {}),
    })),
    rules: entryMap(merged.rules, (def) => ({
      severity: String(def.severity ?? "info"),
      scope: Array.isArray(def.scope) ? [...(def.scope as string[])].sort() : [],
      when: def.when ?? {},
      result: String(def.result ?? ""),
      ...(typeof def.description === "string" ? { description: def.description } : {}),
    })),
    policies: entryMap(merged.policies, (def) => ({
      effect: def.effect === "deny" ? "deny" : "allow",
      roles: Array.isArray(def.roles) ? [...(def.roles as string[])].sort() : [],
      resources: Array.isArray(def.resources) ? [...(def.resources as string[])].sort() : [],
      actions: Array.isArray(def.actions) ? [...(def.actions as string[])].sort() : [],
      fields: Array.isArray(def.fields) ? [...(def.fields as string[])].sort() : [],
      ...(typeof def.description === "string" ? { description: def.description } : {}),
    })),
    roleDefinitions: entryMap(merged.roleDefinitions, (def) => ({
      ...(typeof def.description === "string" ? { description: def.description } : {}),
      dataScope: String(def.dataScope ?? "workspace"),
    })),
    projections: entryMap(merged.projections, (def) => ({
      basedOn: Array.isArray(def.basedOn) ? [...(def.basedOn as string[])].sort() : [],
      ...(typeof def.description === "string" ? { description: def.description } : {}),
      metrics: toIRProperties(def.metrics),
    })),
    connectors: entryMap(merged.connectors, (def) => ({
      kind: String(def.kind ?? ""),
      ...(typeof def.description === "string" ? { description: def.description } : {}),
      ...(typeof def.checkpoint === "string" ? { checkpoint: def.checkpoint } : {}),
      mapping: isPlainObject(def.mapping) ? def.mapping : {},
    })),
  };
}

/** 深度排序 + 2 空格 + LF 的稳定序列化，保证字节级确定性。 */
export function stableStringify(value: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortDeep(value), null, 2) + "\n";
}
