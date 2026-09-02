import type { IRProperty } from "@daka/ontology-dsl";
import { RUNTIME_ERRORS, RuntimeError } from "./errors";
import type { RuntimeManifest } from "./manifest";

/**
 * 实例校验：object/link/fact 写入前对照 manifest。
 * 只接受 manifest 允许的字段（additionalProperties=false 语义）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?$/;

function checkValue(manifest: RuntimeManifest, prop: IRProperty, value: unknown): string | null {
  const listMatch = /^list<([a-z]+)>$/.exec(prop.type);
  if (listMatch) {
    if (!Array.isArray(value)) return "必须是数组";
    for (const item of value) {
      const err = checkValue(manifest, { ...prop, type: listMatch[1] }, item);
      if (err) return `元素${err}`;
    }
    return null;
  }
  if (prop.type === "enum") {
    const vs = prop.ref ? manifest.valueSets[prop.ref] : undefined;
    if (typeof value !== "string" || !vs || !vs.values.includes(value)) return `必须是枚举 ${prop.ref} 的取值`;
    return null;
  }
  switch (prop.type) {
    case "uuid":
      return typeof value === "string" && UUID_RE.test(value) ? null : "必须是 UUID";
    case "string":
      return typeof value === "string" && value.length <= 512 ? null : "必须是 ≤512 字符字符串";
    case "text":
      return typeof value === "string" ? null : "必须是字符串";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? null : "必须是整数";
    case "decimal":
      return (typeof value === "string" && DECIMAL_RE.test(value)) || (typeof value === "number" && Number.isFinite(value))
        ? null
        : "必须是十进制定点（字符串或有限数）";
    case "boolean":
      return typeof value === "boolean" ? null : "必须是布尔";
    case "date":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : "必须是 ISO 日期";
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? null : "必须是 ISO 时间戳";
    case "uri":
      return typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? null : "必须是 URI";
    case "json":
      return null;
    default:
      return `未知类型 ${prop.type}`;
  }
}

export function validateInstance(
  manifest: RuntimeManifest,
  objectType: string,
  data: Record<string, unknown>,
  opts: { partial?: boolean } = {},
): Record<string, unknown> {
  const t = manifest.objectTypes[objectType];
  if (!t) {
    throw new RuntimeError(RUNTIME_ERRORS.UNKNOWN_TYPE, `objectType "${objectType}" 不在 manifest 中`);
  }
  const errors: string[] = [];
  // 可写字段 = properties + 继承的 interface 属性（derived 只读）
  const writable = new Map<string, IRProperty>();
  for (const [k, v] of Object.entries(t.fields)) {
    if (v.origin !== "derived") writable.set(k, v);
  }
  for (const key of Object.keys(data)) {
    if (key === "id") continue;
    if (!writable.has(key)) {
      if (key in t.derived) errors.push(`${key}: derived 字段由 Runtime 计算，不可写入`);
      else errors.push(`${key}: 未知字段`);
    }
  }
  for (const [name, prop] of writable) {
    if (name === "id") continue;
    const value = data[name];
    if (value === undefined || value === null) {
      if (prop.required && !opts.partial) errors.push(`${name}: 必填`);
      continue;
    }
    const err = checkValue(manifest, prop, value);
    if (err) errors.push(`${name}: ${err}`);
  }
  if (errors.length > 0) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `${objectType} 实例校验失败: ${errors.join("; ")}`, errors);
  }
  // 只保留声明字段（含 id）
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (key === "id" || writable.has(key)) out[key] = data[key];
  }
  return out;
}
