/**
 * 稳定诊断码见 ontology/spec/v1.md 第 8 节。
 * 新增诊断必须在此登记，禁止散落字符串。
 */
export const DIAGNOSTIC_CODES = {
  YAML_PARSE: "DSL1001",
  UNKNOWN_SECTION: "DSL1002",
  INVALID_META: "DSL1003",
  INVALID_SEMVER: "DSL1004",
  DUPLICATE_ID: "DSL1005",
  INVALID_ID: "DSL1006",
  UNKNOWN_TYPE: "DSL1007",
  UNKNOWN_ATTRIBUTE: "DSL1008",
  INVALID_SECTION_SHAPE: "DSL1009",
  INVALID_ENUM_REF: "DSL1010",
  INVALID_CARDINALITY: "DSL1011",
  INVALID_HANDLER: "DSL1012",
  INVALID_RULE_AST: "DSL1013",
  INVALID_CONNECTOR_KIND: "DSL1014",
  // 语义校验 DSL2xxx
  UNKNOWN_TYPE_REF: "DSL2001",
  UNKNOWN_VALUESET_REF: "DSL2002",
  INTERFACE_MISMATCH: "DSL2003",
  UNKNOWN_ROLE_REF: "DSL2004",
  EMPTY_ACTOR_ROLES: "DSL2005",
  UNKNOWN_RULE_PATH: "DSL2006",
  UNKNOWN_POLICY_REF: "DSL2007",
  INVALID_PROJECTION_BASES: "DSL2008",
  ENUM_MISUSE: "DSL2009",
  DRAFT_MARKER: "DSL2010",
} as const;

export type DiagnosticCode =
  (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  /** 相对加载根目录的文件路径 */
  file: string;
  /** 1 起始行号；无法定位时为 0 */
  line: number;
  /** 1 起始列号；无法定位时为 0 */
  col: number;
  /** YAML 路径，如 objectTypes.Contract.properties.status.type */
  path: string;
  message: string;
  suggestion?: string;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line > 0 ? `${d.file}:${d.line}:${d.col}` : d.file;
  const suggestion = d.suggestion ? `\n    suggestion: ${d.suggestion}` : "";
  return `${d.severity} ${d.code} ${where} ${d.path}\n    ${d.message}${suggestion}`;
}
