import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES } from "../src/diagnostics";
import { validateSchemaDir } from "../src/validate";

const REAL_SCHEMA_DIR = fileURLToPath(new URL("../../../ontology/schema/v1", import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ontology-dsl-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, name), content, "utf8");
}

function codes(result: ReturnType<typeof validateSchemaDir>): string[] {
  return result.diagnostics.map((d) => d.code);
}

describe("validateSchemaDir：真实 DAKA schema", () => {
  it("ontology/schema/v1 无诊断，exitCode 0", () => {
    const result = validateSchemaDir(REAL_SCHEMA_DIR);
    expect(result.diagnostics).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe("validateSchemaDir：负例诊断", () => {
  it("YAML 解析失败 → DSL1001 带行列", () => {
    write("bad.yaml", "objectTypes:\n  Foo: {type: [\n");
    const result = validateSchemaDir(dir);
    expect(result.exitCode).toBe(1);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.YAML_PARSE);
    expect(d).toBeDefined();
    expect(d!.file).toBe("bad.yaml");
    expect(d!.line).toBeGreaterThan(0);
  });

  it("未知顶层 section → DSL1002 带位置与建议", () => {
    write("a.yaml", "meta:\n  name: ok-name\n  version: 1.0.0\n  dsl: \"1\"\nprinciples:\n  - x\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.UNKNOWN_SECTION);
    expect(d).toBeDefined();
    expect(d!.path).toBe("principles");
    expect(d!.line).toBeGreaterThan(0);
    expect(d!.suggestion).toContain("objectTypes");
  });

  it("非法 SemVer → DSL1004", () => {
    write("meta.yaml", "meta:\n  name: ok-name\n  version: 1.0\n  dsl: \"1\"\n");
    const result = validateSchemaDir(dir);
    expect(codes(result)).toContain(DIAGNOSTIC_CODES.INVALID_SEMVER);
  });

  it("不受支持的 dsl major → DSL1003", () => {
    write("meta.yaml", "meta:\n  name: ok-name\n  version: 1.0.0\n  dsl: \"0\"\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.INVALID_META);
    expect(d).toBeDefined();
    expect(d!.path).toBe("meta.dsl");
  });

  it("跨文件重复 ID → DSL1005 指向两处", () => {
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      id: {type: uuid}\n");
    write("b.yaml", "objectTypes:\n  Contract:\n    properties:\n      id: {type: uuid}\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.DUPLICATE_ID);
    expect(d).toBeDefined();
    expect(d!.file).toBe("b.yaml");
    expect(d!.message).toContain("a.yaml");
  });

  it("objectType ID 非 PascalCase → DSL1006", () => {
    write("a.yaml", "objectTypes:\n  contract:\n    properties:\n      id: {type: uuid}\n");
    const result = validateSchemaDir(dir);
    expect(codes(result)).toContain(DIAGNOSTIC_CODES.INVALID_ID);
  });

  it("未知 property 类型 → DSL1007 带最接近建议", () => {
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      id: {type: uuid4}\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.UNKNOWN_TYPE);
    expect(d).toBeDefined();
    expect(d!.path).toBe("objectTypes.Contract.properties.id.type");
    expect(d!.suggestion).toContain("uuid");
  });

  it("未知 property 属性 → DSL1008", () => {
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      id: {type: uuid, mandatary: true}\n");
    const result = validateSchemaDir(dir);
    expect(codes(result)).toContain(DIAGNOSTIC_CODES.UNKNOWN_ATTRIBUTE);
  });

  it("enum 缺 ref → DSL1010", () => {
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      status: {type: enum}\n");
    const result = validateSchemaDir(dir);
    expect(codes(result)).toContain(DIAGNOSTIC_CODES.INVALID_ENUM_REF);
  });

  it("非法 cardinality → DSL1011", () => {
    write("a.yaml", "linkTypes:\n  contractParties: {from: Contract, to: Party, cardinality: many_to_few}\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.INVALID_CARDINALITY);
    expect(d).toBeDefined();
    expect(d!.suggestion).toContain("one_to_many");
  });

  it("list<T> 合法；list<未知> 非法", () => {
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      tags: {type: list<string>}\n      bad: {type: list<strings>}\n");
    const result = validateSchemaDir(dir);
    const unknown = result.diagnostics.filter((x) => x.code === DIAGNOSTIC_CODES.UNKNOWN_TYPE);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].path).toContain("bad");
  });

  it("非法 roleDefinitions.dataScope → DSL1009", () => {
    write("a.yaml", "roleDefinitions:\n  financeOperator: {description: 财务, dataScope: everywhere}\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.INVALID_SECTION_SHAPE);
    expect(d).toBeDefined();
    expect(d!.path).toBe("roleDefinitions.financeOperator.dataScope");
  });

  it("不存在的路径 → exitCode 2", () => {
    const result = validateSchemaDir(join(dir, "nope"));
    expect(result.exitCode).toBe(2);
  });
});
