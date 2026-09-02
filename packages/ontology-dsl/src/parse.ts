import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { LineCounter, parseDocument, isMap, isPair, isScalar, isSeq, type Document, type Node } from "yaml";
import { DIAGNOSTIC_CODES, type Diagnostic } from "./diagnostics";

export interface SourcePosition {
  line: number;
  col: number;
}

export interface ParsedFile {
  /** 相对加载根目录路径（POSIX 分隔符） */
  file: string;
  /** 解析成功时的 JS 值；解析失败为 undefined */
  value: unknown;
  /** path("a.b.c") → 源码位置；文件级问题用空串 "" 查询 */
  positions: Map<string, SourcePosition>;
  diagnostics: Diagnostic[];
}

function collectPositions(
  node: Node | null,
  lineCounter: LineCounter,
  basePath: string,
  out: Map<string, SourcePosition>,
): void {
  if (node == null) return;
  if (isMap(node)) {
    for (const item of node.items) {
      if (!isPair(item) || !isScalar(item.key)) continue;
      const key = String(item.key.value);
      const path = basePath ? `${basePath}.${key}` : key;
      const offset = item.key.range?.[0];
      if (offset != null && !out.has(path)) {
        const pos = lineCounter.linePos(offset);
        out.set(path, { line: pos.line, col: pos.col });
      }
      collectPositions(item.value as Node | null, lineCounter, path, out);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, i) => {
      collectPositions(item as Node | null, lineCounter, `${basePath}[${i}]`, out);
    });
  }
}

export function parseYamlFile(root: string, absPath: string): ParsedFile {
  const file = relative(root, absPath).split(sep).join("/");
  const positions = new Map<string, SourcePosition>();
  const diagnostics: Diagnostic[] = [];
  const text = readFileSync(absPath, "utf8");
  const lineCounter = new LineCounter();
  let doc: Document;
  try {
    doc = parseDocument(text, { lineCounter, prettyErrors: false });
  } catch (err) {
    diagnostics.push({
      code: DIAGNOSTIC_CODES.YAML_PARSE,
      severity: "error",
      file,
      line: 0,
      col: 0,
      path: "",
      message: err instanceof Error ? err.message : String(err),
      suggestion: "检查 YAML 缩进与引号配对",
    });
    return { file, value: undefined, positions, diagnostics };
  }
  for (const error of doc.errors) {
    // 不同错误类型位置来源不同：优先 linePos，退化用字符偏移换算
    const fromLinePos = error.linePos?.[0];
    const fromOffset = error.pos?.[0] != null ? lineCounter.linePos(error.pos[0]) : undefined;
    const pos = fromLinePos ?? fromOffset;
    diagnostics.push({
      code: DIAGNOSTIC_CODES.YAML_PARSE,
      severity: "error",
      file,
      line: pos?.line ?? 0,
      col: pos?.col ?? 0,
      path: "",
      message: error.message,
      suggestion: "检查 YAML 缩进与引号配对",
    });
  }
  collectPositions(doc.contents as Node | null, lineCounter, "", positions);
  const value = doc.errors.length > 0 ? undefined : doc.toJS();
  return { file, value, positions, diagnostics };
}

/**
 * 加载一个 schema 目录：按文件名字典序读取全部 *.yaml（确定性顺序）。
 */
export function loadSchemaDir(dir: string): ParsedFile[] {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new Error(`schema 路径不是目录: ${dir}`);
  }
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
    .sort();
  return names.map((n) => parseYamlFile(dir, join(dir, n)));
}
