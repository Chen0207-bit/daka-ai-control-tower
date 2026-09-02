import { RUNTIME_ERRORS, RuntimeError } from "../errors";

/**
 * 受限规则 AST 求值器（spec §8）。无 eval/Function/动态代码。
 * 求值上下文是路径解析函数，由调用方（action 引擎/投影/规则执行器）提供。
 */

export type PathResolver = (path: string) => unknown;

const DAY_MS = 24 * 3600 * 1000;

function toComparable(v: unknown): unknown {
  if (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    return Date.parse(v);
  }
  return v;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  const ca = toComparable(a);
  const cb = toComparable(b);
  switch (op) {
    case "eq": return ca === cb;
    case "ne": return ca !== cb;
    case "gt": return typeof ca === "number" && typeof cb === "number" ? ca > cb : Number(ca) > Number(cb);
    case "gte": return typeof ca === "number" && typeof cb === "number" ? ca >= cb : Number(ca) >= Number(cb);
    case "lt": return typeof ca === "number" && typeof cb === "number" ? ca < cb : Number(ca) < Number(cb);
    case "lte": return typeof ca === "number" && typeof cb === "number" ? ca <= cb : Number(ca) <= Number(cb);
    default: throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `未知比较操作符 ${op}`);
  }
}

export function evaluateRule(node: unknown, resolve: PathResolver, now: number = Date.now()): boolean {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "规则节点必须是对象");
  }
  const n = node as Record<string, unknown>;
  const op = n.op;
  if (typeof op !== "string") throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, "规则节点缺 op");

  switch (op) {
    case "all":
      return (n.args as unknown[]).every((c) => evaluateRule(c, resolve, now));
    case "any":
      return (n.args as unknown[]).some((c) => evaluateRule(c, resolve, now));
    case "not":
      return !evaluateRule(n.arg, resolve, now);
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = resolve(String(n.path));
      const b = n.valuePath !== undefined ? resolve(String(n.valuePath)) : n.value;
      return compare(op, a, typeof b === "string" && DECIMAL_LIKE.test(b) ? Number(b) : b);
    }
    case "in": {
      const a = resolve(String(n.path));
      return Array.isArray(n.value) && n.value.includes(a);
    }
    case "dateBefore":
    case "dateAfter": {
      const a = resolve(String(n.path));
      if (a == null) return false;
      const at = Date.parse(String(a));
      if (Number.isNaN(at)) return false;
      let bt: number;
      if (n.valuePath !== undefined) {
        const bv = resolve(String(n.valuePath));
        if (bv == null) return false;
        bt = Date.parse(String(bv));
      } else if (n.value === "now") {
        bt = now;
      } else {
        bt = Date.parse(String(n.value));
      }
      const offset = typeof n.offsetDays === "number" ? n.offsetDays * DAY_MS : 0;
      return op === "dateBefore" ? at < bt + offset : at > bt + offset;
    }
    case "exists":
      return resolve(String(n.path)) != null;
    case "missing":
      return resolve(String(n.path)) == null;
    case "sum":
    case "count":
      // 聚合节点由调用方展开为数值后再比较；直接求值时返回真值判断
      return Boolean(resolve(String(n.over)));
    default:
      throw new RuntimeError(RUNTIME_ERRORS.VALIDATION, `禁止的操作符 "${op}"（受限 AST，不允许任意代码）`);
  }
}

const DECIMAL_LIKE = /^-?\d+(\.\d+)?$/;
