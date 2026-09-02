import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileIR } from "./compile";
import { diffIR, type DiffResult } from "./diff";
import { formatDiagnostic, type Diagnostic } from "./diagnostics";
import { buildCanonicalIR, stableStringify, type CanonicalIR } from "./ir";
import { validateSchemaDir } from "./validate";

const USAGE = `usage: daka-ontology <command> [args]

commands:
  validate <schema-dir> [--json]            语法+语义校验（退出码 0/1/2）
  compile <schema-dir> [--out <dir>]        编译 Canonical IR 并写生成物
  check-generated <schema-dir> [--out dir]  校验生成物未漂移（漂移退出码 1）
  diff <old> <new> [--json]                 兼容性分级（breaking 退出码 1）；参数为 schema 目录或 ontology.manifest.json
  inspect <schema-dir>                      打印 IR 摘要与指纹
  seed <pack-dir> --dry-run                 Data Pack 校验与导入计划（不写库）
`;

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 2;
}

function defaultOutDir(schemaDir: string): string {
  return resolve(schemaDir, "..", "..", ".generated");
}

function loadIR(ref: string): { ir?: CanonicalIR; error?: string } {
  const stat = statSync(ref, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    const result = validateSchemaDir(ref);
    if (result.exitCode !== 0 || !result.merged) {
      return { error: `${ref} 校验未通过:\n${result.diagnostics.map(formatDiagnostic).join("\n")}` };
    }
    return { ir: buildCanonicalIR(result.merged) };
  }
  if (stat?.isFile()) {
    try {
      const parsed = JSON.parse(readFileSync(ref, "utf8")) as Record<string, unknown>;
      if (!parsed.meta || !parsed.objectTypes) return { error: `${ref} 不是合法 manifest` };
      delete parsed.fingerprint;
      return { ir: parsed as unknown as CanonicalIR };
    } catch (err) {
      return { error: `${ref} 解析失败: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { error: `路径不存在: ${ref}` };
}

function emitDiagnostics(diagnostics: Diagnostic[], exitCode: number, json: boolean): number {
  if (json) {
    process.stdout.write(stableStringify({ diagnostics, exitCode }));
    return exitCode;
  }
  const text = diagnostics.length === 0 ? "OK: 无诊断" : diagnostics.map(formatDiagnostic).join("\n");
  if (exitCode === 0) process.stdout.write(`${text}\n`);
  else process.stderr.write(`${text}\n`);
  return exitCode;
}

function cmdValidate(args: string[]): number {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) return fail(USAGE);
  const result = validateSchemaDir(dir);
  return emitDiagnostics(result.diagnostics, result.exitCode, args.includes("--json"));
}

function cmdCompile(args: string[]): number {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) return fail(USAGE);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : defaultOutDir(dir);
  const result = validateSchemaDir(dir);
  if (result.exitCode !== 0 || !result.merged) {
    return emitDiagnostics(result.diagnostics, result.exitCode, args.includes("--json"));
  }
  const ir = buildCanonicalIR(result.merged);
  const artifacts = compileIR(ir);
  for (const [name, content] of Object.entries(artifacts.files)) {
    const target = join(outDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  process.stdout.write(
    `compiled ${ir.meta.name}@${ir.meta.version} fingerprint=${artifacts.fingerprint}\n` +
      Object.keys(artifacts.files)
        .map((f) => `  wrote ${join(outDir, f)}`)
        .join("\n") +
      "\n",
  );
  return 0;
}

function cmdCheckGenerated(args: string[]): number {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) return fail(USAGE);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : defaultOutDir(dir);
  const result = validateSchemaDir(dir);
  if (result.exitCode !== 0 || !result.merged) {
    return emitDiagnostics(result.diagnostics, result.exitCode, args.includes("--json"));
  }
  const artifacts = compileIR(buildCanonicalIR(result.merged));
  const drift: string[] = [];
  for (const [name, content] of Object.entries(artifacts.files)) {
    let existing: string | undefined;
    try {
      existing = readFileSync(join(outDir, name), "utf8");
    } catch {
      existing = undefined;
    }
    if (existing !== content) drift.push(name);
  }
  if (drift.length > 0) {
    process.stderr.write(`DSL3001 generated drift: ${drift.join(", ")}；运行 ontology:compile 重新生成\n`);
    return 1;
  }
  process.stdout.write(`OK: 生成物与 schema 一致 (fingerprint=${artifacts.fingerprint})\n`);
  return 0;
}

function cmdDiff(args: string[]): number {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [oldRef, newRef] = positional;
  if (!oldRef || !newRef) return fail(USAGE);
  const base = loadIR(oldRef);
  if (!base.ir) return fail(base.error ?? "old 加载失败");
  const target = loadIR(newRef);
  if (!target.ir) return fail(target.error ?? "new 加载失败");
  const diff: DiffResult = diffIR(base.ir, target.ir);
  if (args.includes("--json")) {
    process.stdout.write(stableStringify(diff));
  } else if (diff.changes.length === 0) {
    process.stdout.write("OK: 无变更\n");
  } else {
    for (const c of diff.changes) {
      process.stdout.write(`[${c.class}] ${c.kind} ${c.path}\n    ${c.detail}\n`);
    }
    process.stdout.write(`highest=${diff.highest} suggestedBump=${diff.suggestedBump}\n`);
  }
  return diff.highest === "breaking" ? 1 : 0;
}

function cmdInspect(args: string[]): number {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) return fail(USAGE);
  const result = validateSchemaDir(dir);
  if (result.exitCode !== 0 || !result.merged) {
    return emitDiagnostics(result.diagnostics, result.exitCode, args.includes("--json"));
  }
  const ir = buildCanonicalIR(result.merged);
  const count = (o: Record<string, unknown>) => Object.keys(o).length;
  process.stdout.write(
    [
      `ontology: ${ir.meta.name}@${ir.meta.version} (dsl ${ir.meta.dsl})`,
      `fingerprint: ${compileIR(ir).fingerprint}`,
      `valueSets=${count(ir.valueSets)} interfaces=${count(ir.interfaces)} objectTypes=${count(ir.objectTypes)} linkTypes=${count(ir.linkTypes)}`,
      `actions=${count(ir.actions)} rules=${count(ir.rules)} policies=${count(ir.policies)} roles=${count(ir.roleDefinitions)} projections=${count(ir.projections)} connectors=${count(ir.connectors)}`,
      `warnings: ${result.diagnostics.filter((d) => d.severity === "warning").length}`,
    ].join("\n") + "\n",
  );
  return 0;
}

/**
 * seed --dry-run（P1 版）：校验 Data Pack 目录结构并打印导入计划，不写库。
 * 完整 validate→plan→apply 链在第 2 期 Runtime 落地。
 */
function cmdSeed(args: string[]): number {
  const packDir = args.find((a) => !a.startsWith("--"));
  if (!packDir || !args.includes("--dry-run")) return fail(USAGE);
  const stat = statSync(packDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return fail(`pack 路径不是目录: ${packDir}`);
  const files = readdirSync(packDir)
    .filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
    .sort();
  if (!files.includes("pack.yaml")) {
    process.stderr.write(`DSL3001 pack 缺少 pack.yaml manifest: ${packDir}\n`);
    return 1;
  }
  const manifestText = readFileSync(join(packDir, "pack.yaml"), "utf8");
  process.stdout.write(
    `[dry-run] pack=${packDir}\nfiles:\n${files.map((f) => `  ${f}`).join("\n")}\n` +
      `manifest.bytes=${Buffer.byteLength(manifestText, "utf8")}\n` +
      "plan: validate → diff → transactional apply（第 2 期 Runtime 执行）；本次不写库\n",
  );
  return 0;
}

export function runCli(argv: string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "validate":
      return cmdValidate(rest);
    case "compile":
      return cmdCompile(rest);
    case "check-generated":
      return cmdCheckGenerated(rest);
    case "diff":
      return cmdDiff(rest);
    case "inspect":
      return cmdInspect(rest);
    case "seed":
      return cmdSeed(rest);
    default:
      return fail(USAGE);
  }
}
