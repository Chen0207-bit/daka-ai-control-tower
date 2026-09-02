import { DIAGNOSTIC_CODES, type Diagnostic } from "./diagnostics";
import type { ParsedFile } from "./parse";

/**
 * 受限规则 AST 校验（spec §8）。
 * 只允许闭集操作符；任何未知 op、未知属性、函数式字符串都是 DSL1013。
 * 该 AST 同时用于 rules.when 与 actions.*.preconditions。
 */

export const RULE_OPS = [
  "all",
  "any",
  "not",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "dateBefore",
  "dateAfter",
  "exists",
  "missing",
  "sum",
  "count",
] as const;

export type RuleOp = (typeof RULE_OPS)[number];

const PATH_RE = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isRulePath(s: unknown): s is string {
  return typeof s === "string" && PATH_RE.test(s);
}

interface AstCtx {
  file: ParsedFile;
  out: Diagnostic[];
}

function reportAst(ctx: AstCtx, path: string, message: string, suggestion?: string): void {
  const pos = ctx.file.positions.get(path) ?? { line: 0, col: 0 };
  ctx.out.push({
    code: DIAGNOSTIC_CODES.INVALID_RULE_AST,
    severity: "error",
    file: ctx.file.file,
    line: pos.line,
    col: pos.col,
    path,
    message,
    suggestion: suggestion ?? `允许的操作符: ${RULE_OPS.join(", ")}`,
  });
}

function checkPathField(ctx: AstCtx, node: Record<string, unknown>, path: string, key: string): void {
  if (!isRulePath(node[key])) {
    reportAst(ctx, `${path}.${key}`, `${key} 必须是点分隔字段路径，如 schedule.dueAt`);
  }
}

function checkValueOrValuePath(ctx: AstCtx, node: Record<string, unknown>, path: string): void {
  const hasValue = "value" in node;
  const hasValuePath = "valuePath" in node;
  if (hasValue === hasValuePath) {
    reportAst(ctx, path, "必须且只能提供 value 或 valuePath 之一");
    return;
  }
  if (hasValuePath && !isRulePath(node.valuePath)) {
    reportAst(ctx, `${path}.valuePath`, "valuePath 必须是点分隔字段路径");
  }
}

/** 校验单个 AST 节点；path 为 YAML 路径（用于定位行列）。 */
export function validateRuleNode(ctx: AstCtx, node: unknown, path: string, depth = 0): void {
  if (depth > 16) {
    reportAst(ctx, path, "AST 嵌套过深（>16）");
    return;
  }
  if (!isPlainObject(node)) {
    reportAst(ctx, path, "规则节点必须是 mapping");
    return;
  }
  const op = node.op;
  if (typeof op !== "string" || !(RULE_OPS as readonly string[]).includes(op)) {
    reportAst(ctx, `${path}.op`, `非法操作符 "${String(op)}"；禁止任意源码/eval`);
    return;
  }
  // 未知属性检查
  const allowedKeys: Record<string, string[]> = {
    all: ["op", "args"],
    any: ["op", "args"],
    not: ["op", "arg"],
    eq: ["op", "path", "value", "valuePath"],
    ne: ["op", "path", "value", "valuePath"],
    gt: ["op", "path", "value", "valuePath"],
    gte: ["op", "path", "value", "valuePath"],
    lt: ["op", "path", "value", "valuePath"],
    lte: ["op", "path", "value", "valuePath"],
    in: ["op", "path", "value"],
    dateBefore: ["op", "path", "value", "valuePath", "offsetDays"],
    dateAfter: ["op", "path", "value", "valuePath", "offsetDays"],
    exists: ["op", "path"],
    missing: ["op", "path"],
    sum: ["op", "over", "path", "as"],
    count: ["op", "over", "as"],
  };
  for (const key of Object.keys(node)) {
    if (!allowedKeys[op].includes(key)) {
      reportAst(ctx, `${path}.${key}`, `操作符 "${op}" 不允许属性 "${key}"`, `允许: ${allowedKeys[op].join(", ")}`);
    }
  }

  switch (op) {
    case "all":
    case "any": {
      if (!Array.isArray(node.args) || node.args.length === 0) {
        reportAst(ctx, `${path}.args`, `${op} 需要非空 args 数组`);
        return;
      }
      node.args.forEach((child, i) => validateRuleNode(ctx, child, `${path}.args[${i}]`, depth + 1));
      return;
    }
    case "not": {
      validateRuleNode(ctx, node.arg, `${path}.arg`, depth + 1);
      return;
    }
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      checkPathField(ctx, node, path, "path");
      checkValueOrValuePath(ctx, node, path);
      return;
    }
    case "in": {
      checkPathField(ctx, node, path, "path");
      if (!Array.isArray(node.value) || node.value.length === 0) {
        reportAst(ctx, `${path}.value`, "in 需要非空数组 value");
      }
      return;
    }
    case "dateBefore":
    case "dateAfter": {
      checkPathField(ctx, node, path, "path");
      const hasValue = "value" in node;
      const hasValuePath = "valuePath" in node;
      if (hasValue === hasValuePath) {
        reportAst(ctx, path, "必须且只能提供 value 或 valuePath 之一");
      } else if (hasValue) {
        const v = node.value;
        const ok =
          v === "now" ||
          (typeof v === "string" && !Number.isNaN(Date.parse(v)));
        if (!ok) {
          reportAst(ctx, `${path}.value`, "时间比较 value 必须是 \"now\" 或可解析的 ISO 日期");
        }
      } else if (!isRulePath(node.valuePath)) {
        reportAst(ctx, `${path}.valuePath`, "valuePath 必须是点分隔字段路径");
      }
      if (node.offsetDays !== undefined && !Number.isInteger(node.offsetDays)) {
        reportAst(ctx, `${path}.offsetDays`, "offsetDays 必须是整数");
      }
      return;
    }
    case "exists":
    case "missing": {
      checkPathField(ctx, node, path, "path");
      return;
    }
    case "sum":
    case "count": {
      checkPathField(ctx, node, path, "over");
      if (op === "sum") checkPathField(ctx, node, path, "path");
      if (!isRulePath(node.as)) {
        reportAst(ctx, `${path}.as`, `${op} 需要 as 命名聚合结果`);
      }
      return;
    }
  }
}
