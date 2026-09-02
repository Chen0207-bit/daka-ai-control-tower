import type { ParsedFile } from "./parse";

/**
 * 将一组 ParsedFile 合并为逻辑 ontology 文档（语法校验通过后才调用）。
 * 每个条目记录来源 file/path，供语义诊断定位。
 */

export interface SourceRef {
  file: string;
  path: string;
}

export interface SectionEntry<T = unknown> {
  id: string;
  def: T;
  source: SourceRef;
}

export interface MergedSchema {
  meta: Record<string, unknown> | undefined;
  metaSource: SourceRef | undefined;
  valueSets: SectionEntry[];
  interfaces: SectionEntry[];
  objectTypes: SectionEntry[];
  linkTypes: SectionEntry[];
  actions: SectionEntry[];
  rules: SectionEntry[];
  policies: SectionEntry[];
  roleDefinitions: SectionEntry[];
  projections: SectionEntry[];
  connectors: SectionEntry[];
}

const MERGED_SECTIONS = [
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mergeSchemaFiles(files: ParsedFile[]): MergedSchema {
  const merged: MergedSchema = {
    meta: undefined,
    metaSource: undefined,
    valueSets: [],
    interfaces: [],
    objectTypes: [],
    linkTypes: [],
    actions: [],
    rules: [],
    policies: [],
    roleDefinitions: [],
    projections: [],
    connectors: [],
  };
  for (const file of files) {
    if (!isPlainObject(file.value)) continue;
    if (file.value.meta !== undefined && merged.meta === undefined) {
      merged.meta = file.value.meta as Record<string, unknown>;
      merged.metaSource = { file: file.file, path: "meta" };
    }
    for (const section of MERGED_SECTIONS) {
      const defs = file.value[section];
      if (!isPlainObject(defs)) continue;
      for (const [id, def] of Object.entries(defs)) {
        merged[section].push({ id, def, source: { file: file.file, path: `${section}.${id}` } });
      }
    }
  }
  return merged;
}

/** 收集 objectType 的全部属性名（含 implements 继承与 derived 派生）。 */
export function collectTypeFields(
  merged: MergedSchema,
  typeName: string,
): { fields: Set<string>; derived: Set<string> } {
  const fields = new Set<string>();
  const derived = new Set<string>();
  const objectType = merged.objectTypes.find((t) => t.id === typeName);
  if (objectType && isPlainObject(objectType.def)) {
    const def = objectType.def as Record<string, unknown>;
    if (isPlainObject(def.properties)) {
      for (const k of Object.keys(def.properties)) fields.add(k);
    }
    if (isPlainObject(def.derived)) {
      for (const k of Object.keys(def.derived)) {
        fields.add(k);
        derived.add(k);
      }
    }
    if (Array.isArray(def.implements)) {
      for (const ifaceId of def.implements) {
        const iface = merged.interfaces.find((t) => t.id === ifaceId);
        if (iface && isPlainObject(iface.def) && isPlainObject((iface.def as Record<string, unknown>).properties)) {
          for (const k of Object.keys((iface.def as Record<string, unknown>).properties as Record<string, unknown>)) {
            fields.add(k);
          }
        }
      }
    }
  }
  return { fields, derived };
}

export function typeExists(merged: MergedSchema, name: string): boolean {
  return (
    merged.objectTypes.some((t) => t.id === name) || merged.interfaces.some((t) => t.id === name)
  );
}
