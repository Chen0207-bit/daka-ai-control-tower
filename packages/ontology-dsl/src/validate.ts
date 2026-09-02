import { formatDiagnostic, type Diagnostic } from "./diagnostics";
import { loadSchemaDir } from "./parse";
import { validateSyntax } from "./syntax";

export interface ValidateResult {
  diagnostics: Diagnostic[];
  /** 进程退出码：0 = 无 error，1 = 有 error，2 = 路径不可用等运行错误 */
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
  const diagnostics = [...files.flatMap((f) => f.diagnostics), ...validateSyntax(files)];
  const hasError = diagnostics.some((d) => d.severity === "error");
  return { diagnostics, exitCode: hasError ? 1 : 0 };
}

export function renderDiagnostics(result: ValidateResult): string {
  if (result.diagnostics.length === 0) return "OK: 无诊断";
  return result.diagnostics.map(formatDiagnostic).join("\n");
}

export function runCli(argv: string[]): number {
  const [command, target] = argv;
  if (command !== "validate" || !target) {
    process.stderr.write("usage: ontology-dsl validate <schema-dir>\n");
    return 2;
  }
  const result = validateSchemaDir(target);
  const text = renderDiagnostics(result);
  if (result.exitCode === 0) {
    process.stdout.write(`${text}\n`);
  } else {
    process.stderr.write(`${text}\n`);
  }
  return result.exitCode;
}
