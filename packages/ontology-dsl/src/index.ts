export { runCli } from "./commands";
export { compileIR, computeFingerprint } from "./compile";
export type { CompiledArtifacts } from "./compile";
export { DIAGNOSTIC_CODES, formatDiagnostic } from "./diagnostics";
export type { Diagnostic, DiagnosticCode, Severity } from "./diagnostics";
export { diffIR } from "./diff";
export type { ChangeClass, DiffResult, OntologyChange } from "./diff";
export { buildCanonicalIR, stableStringify } from "./ir";
export type { CanonicalIR, IRAction, IRPolicy, IRProjection, IRProperty, IRRule } from "./ir";
export { collectTypeFields, mergeSchemaFiles, typeExists } from "./model";
export type { MergedSchema, SectionEntry, SourceRef } from "./model";
export { loadSchemaDir, parseYamlFile } from "./parse";
export type { ParsedFile, SourcePosition } from "./parse";
export { isRulePath, RULE_OPS, validateRuleNode } from "./rule-ast";
export { validateSemantics } from "./semantic";
export {
  CARDINALITIES,
  CONNECTOR_KINDS,
  DATA_SCOPES,
  HANDLER_RE,
  KNOWN_SECTIONS,
  POLICY_EFFECTS,
  PRIMITIVE_TYPES,
  PROPERTY_ATTRIBUTES,
  SEVERITIES,
  SUPPORTED_DSL_MAJORS,
  validateSyntax,
} from "./syntax";
export { renderDiagnostics, validateSchemaDir } from "./validate";
export type { ValidateResult } from "./validate";
