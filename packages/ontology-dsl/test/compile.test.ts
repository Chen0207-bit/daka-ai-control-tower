import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileIR } from "../src/compile";
import { buildCanonicalIR } from "../src/ir";
import { validateSchemaDir } from "../src/validate";
import { runCli } from "../src/commands";
import { fileURLToPath } from "node:url";

const REAL_SCHEMA_DIR = fileURLToPath(new URL("../../../ontology/schema/v1", import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ontology-compile-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function compileDir(schemaDir: string) {
  const result = validateSchemaDir(schemaDir);
  if (!result.merged) throw new Error("schema 校验失败");
  return compileIR(buildCanonicalIR(result.merged));
}

describe("编译确定性", () => {
  it("同一 schema 两次编译产物字节一致", () => {
    const a = compileDir(REAL_SCHEMA_DIR);
    const b = compileDir(REAL_SCHEMA_DIR);
    expect(a.fingerprint).toBe(b.fingerprint);
    for (const name of Object.keys(a.files)) {
      expect(a.files[name]).toBe(b.files[name]);
    }
  });

  it("文件拆分/命名不影响产物（按内容合并与排序）", () => {
    // 把真实 schema 的每个文件复制到乱序命名的临时目录，产物应与原目录一致
    const scrambled = join(dir, "scrambled");
    mkdirSync(scrambled, { recursive: true });
    const names = readdirSync(REAL_SCHEMA_DIR).filter((n) => n.endsWith(".yaml")).sort();
    // 逆序重命名（z_ 前缀保持 .yaml 后缀，内容不变）
    names.forEach((n, i) => {
      const content = readFileSync(join(REAL_SCHEMA_DIR, n), "utf8");
      writeFileSync(join(scrambled, `z${String(names.length - i).padStart(2, "0")}.yaml`), content, "utf8");
    });
    const a = compileDir(REAL_SCHEMA_DIR);
    const b = compileDir(scrambled);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.files["ontology.manifest.json"]).toBe(a.files["ontology.manifest.json"]);
  });

  it("产物六件齐全且 manifest 含指纹", () => {
    const a = compileDir(REAL_SCHEMA_DIR);
    expect(Object.keys(a.files).sort()).toEqual(
      [
        "ontology.fingerprint",
        "ontology.index-plan.json",
        "ontology.manifest.json",
        "ontology.openapi.json",
        "ontology.schema.json",
        "ontology.types.ts",
      ].sort(),
    );
    const manifest = JSON.parse(a.files["ontology.manifest.json"]);
    expect(manifest.fingerprint).toBe(a.fingerprint);
    expect(manifest.meta.name).toBe("daka-business-ontology");
    expect(manifest.objectTypes.PaymentSchedule.derived.unsettledAmount).toBeDefined();
    // interface 属性已解析进 fields
    expect(manifest.objectTypes.FootballClub.fields.canonicalName.origin).toBe("interface");
  });

  it("check-generated 无漂移 exit 0；篡改后 exit 1", () => {
    const out = join(dir, "gen");
    expect(runCli(["compile", REAL_SCHEMA_DIR, "--out", out])).toBe(0);
    expect(runCli(["check-generated", REAL_SCHEMA_DIR, "--out", out])).toBe(0);
    const manifestPath = join(out, "ontology.manifest.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8") + " ", "utf8");
    expect(runCli(["check-generated", REAL_SCHEMA_DIR, "--out", out])).toBe(1);
  });

  it("types.ts 含 decimal→string 与 enum 字面量联合", () => {
    const a = compileDir(REAL_SCHEMA_DIR);
    const types = a.files["ontology.types.ts"];
    expect(types).toContain("amount: string;");
    // valueSet 值在 IR 中字典序排列（确定性）
    expect(types).toContain('"disputed" | "due" | "overdue" | "paid" | "planned" | "waived"');
    expect(types).toContain("export interface PaymentScheduleDerived");
  });

  it("openapi 含对象/动作/投影端点与健康检查", () => {
    const a = compileDir(REAL_SCHEMA_DIR);
    const openapi = JSON.parse(a.files["ontology.openapi.json"]);
    expect(openapi.paths["/v1/objects/Contract"]).toBeDefined();
    expect(openapi.paths["/v1/actions/recordPayment/execute"]).toBeDefined();
    expect(openapi.paths["/v1/projections/paymentCalendar"]).toBeDefined();
    expect(openapi.paths["/health/live"]).toBeDefined();
  });

  it("index-plan 覆盖状态枚举/外键/时间字段", () => {
    const a = compileDir(REAL_SCHEMA_DIR);
    const plan = JSON.parse(a.files["ontology.index-plan.json"]);
    const keys = plan.indexes.map((x: { objectType: string; column: string }) => `${x.objectType}.${x.column}`);
    expect(keys).toContain("Contract.status");
    expect(keys).toContain("Contract.documentId");
    expect(keys).toContain("PaymentSchedule.dueAt");
    expect(plan.tenantIsolation).toEqual(["tenant_id", "workspace_id"]);
  });
});
