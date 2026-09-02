import { formatDiagnostic, type Diagnostic } from "./diagnostics";
import type { MergedSchema } from "./model";
import { loadSchemaDir } from "./parse";
import { validateSemantics } from "./semantic";
import { validateSyntax } from "./syntax";

export interface ValidateResult {
  diagnostics: Diagnostic[];
  /** 语法+语义校验通过时的合并文档；有 error 时为 undefined */
  merged?: MergedSchema;
  /** 进程退出码：0 = 无 error（允许 warning），1 = 有 error，2 = 路径不可用等运行错误 */
  exitCode: 0 | 1 | 2;
}

export function validateSchemaDir(dir: string): ValidateResult {
  let files;
  try {
    files = loadSchemaDir(dir);
  } catch (err) {
    return {
      diagnostics: [
        {
          code: "DSL1001",
          severity: "error",
          file: dir,
          line: 0,
          col: 0,
          path: "",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
      exitCode: 2,
    };
  }
  const parseDiags = files.flatMap((f) => f.diagnostics);
  const syntaxDiags = validateSyntax(files);
  const hasSyntaxError = [...parseDiags, ...syntaxDiags].some((d) => d.severity === "error");
  if (hasSyntaxError) {
    return { diagnostics: [...parseDiags, ...syntaxDiags], exitCode: 1 };
  }
  const { merged, diagnostics: semanticDiags } = validateSemantics(files);
  const diagnostics = [...parseDiags, ...syntaxDiags, ...semanticDiags];
  const hasError = diagnostics.some((d) => d.severity === "error");
  return { diagnostics, merged, exitCode: hasError ? 1 : 0 };
}

export function renderDiagnostics(result: ValidateResult): string {
  if (result.diagnostics.length === 0) return "OK: 无诊断";
  return result.diagnostics.map(formatDiagnostic).join("\n");
}
