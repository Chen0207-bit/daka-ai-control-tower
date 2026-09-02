import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIAGNOSTIC_CODES } from "../src/diagnostics";
import { validateSchemaDir } from "../src/validate";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ontology-sem-"));
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

const BASE_META = "meta:\n  name: test-ontology\n  version: 1.0.0\n  dsl: \"1\"\n";

describe("语义校验 DSL2xxx", () => {
  it("implements 引用不存在 interface → DSL2001", () => {
    write("meta.yaml", BASE_META);
    write("a.yaml", "objectTypes:\n  Club:\n    implements: [MissingIface]\n    properties:\n      id: {type: uuid}\n");
    const result = validateSchemaDir(dir);
    expect(codes(result)).toContain(DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF);
    expect(result.exitCode).toBe(1);
  });

  it("linkType 端点不存在 → DSL2001", () => {
    write("meta.yaml", BASE_META);
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      id: {type: uuid}\nlinkTypes:\n  bad: {from: Contract, to: Ghost, cardinality: one_to_many}\n");
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.UNKNOWN_TYPE_REF);
  });

  it("enum ref 指向不存在 valueSet → DSL2002", () => {
    write("meta.yaml", BASE_META);
    write("a.yaml", "objectTypes:\n  Contract:\n    properties:\n      status: {type: enum, ref: nope}\n");
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.UNKNOWN_VALUESET_REF);
  });

  it("interface 属性重定义不一致 → DSL2003", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "interfaces:\n  IPAsset:\n    properties:\n      canonicalName: {type: string, required: true}\nobjectTypes:\n  Club:\n    implements: [IPAsset]\n    properties:\n      canonicalName: {type: integer, required: true}\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INTERFACE_MISMATCH);
  });

  it("properties 与 derived 同名 → DSL2003", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  Lot:\n    properties:\n      balance: {type: integer}\n    derived:\n      balance: {type: integer}\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INTERFACE_MISMATCH);
  });

  it("action 引用未定义角色 / 空 actorRoles → DSL2004/DSL2005", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\nroleDefinitions:\n  admin: {dataScope: tenant}\nactions:\n  a1:\n    target: C\n    handler: x.y\n    actorRoles: [ghost]\n  a2:\n    target: C\n    handler: x.z\n    actorRoles: []\n",
    );
    const codes_ = codes(validateSchemaDir(dir));
    expect(codes_).toContain(DIAGNOSTIC_CODES.UNKNOWN_ROLE_REF);
    expect(codes_).toContain(DIAGNOSTIC_CODES.EMPTY_ACTOR_ROLES);
  });

  it("rule path 叶子字段不在 scope 类型中 → DSL2006", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  S:\n    properties:\n      dueAt: {type: datetime}\nrules:\n  r1:\n    severity: high\n    scope: [S]\n    when: {op: gt, path: schedule.unsettledAmount, value: 0}\n    result: x\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.UNKNOWN_RULE_PATH);
  });

  it("rule path 引用 derived 字段 → 合法", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  S:\n    properties:\n      dueAt: {type: datetime}\n    derived:\n      unsettledAmount: {type: decimal}\nrules:\n  r1:\n    severity: high\n    scope: [S]\n    when: {op: gt, path: schedule.unsettledAmount, value: 0}\n    result: x\n",
    );
    const result = validateSchemaDir(dir);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("policy 引用不存在的 resource/action/field → DSL2007", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\nroleDefinitions:\n  admin: {dataScope: tenant}\npolicies:\n  p1:\n    effect: allow\n    roles: [admin]\n    resources: [Ghost]\n    actions: [read, nopeAction]\n    fields: [nopeField]\n",
    );
    const codes_ = codes(validateSchemaDir(dir));
    expect(codes_.filter((c) => c === DIAGNOSTIC_CODES.UNKNOWN_POLICY_REF).length).toBeGreaterThanOrEqual(3);
  });

  it("projection basedOn 为空或重复 → DSL2008", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\nprojections:\n  bad: {basedOn: [C, C]}\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INVALID_PROJECTION_BASES);
  });

  it("非 enum 携带 ref → DSL2009", () => {
    write("meta.yaml", BASE_META);
    write("a.yaml", "objectTypes:\n  C:\n    properties:\n      x: {type: string, ref: abc}\n");
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.ENUM_MISUSE);
  });

  it("TBD 标记产生 warning 而非 error", () => {
    write("meta.yaml", BASE_META);
    write("a.yaml", "objectTypes:\n  C:\n    properties:\n      x: {type: string, status: TBD}\n");
    const result = validateSchemaDir(dir);
    const d = result.diagnostics.find((x) => x.code === DIAGNOSTIC_CODES.DRAFT_MARKER);
    expect(d).toBeDefined();
    expect(d!.severity).toBe("warning");
    expect(result.exitCode).toBe(0);
  });

  it("action precondition 必须以 input./target. 开头 → DSL2006", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\nroleDefinitions:\n  admin: {dataScope: tenant}\nactions:\n  a1:\n    target: C\n    handler: x.y\n    actorRoles: [admin]\n    preconditions:\n      - {op: eq, path: other.field, value: 1}\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.UNKNOWN_RULE_PATH);
  });
});

describe("rule AST 语法 DSL1013", () => {
  it("未知操作符（eval 风格）被拒绝", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "rules:\n  evil:\n    severity: high\n    when: {op: eval, path: x.y}\n    result: z\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INVALID_RULE_AST);
  });

  it("比较操作符必须 value/valuePath 二选一", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "rules:\n  bad:\n    severity: low\n    when: {op: eq, path: a.b}\n    result: z\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INVALID_RULE_AST);
  });

  it("all 需要非空 args；嵌套节点递归校验", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "rules:\n  bad:\n    severity: low\n    when: {op: all, args: [{op: nope}]}\n    result: z\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INVALID_RULE_AST);
  });

  it("非法 handler key → DSL1012", () => {
    write("meta.yaml", BASE_META);
    write(
      "a.yaml",
      "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\nroleDefinitions:\n  admin: {dataScope: tenant}\nactions:\n  a1:\n    target: C\n    handler: \"Payment.Record!\"\n    actorRoles: [admin]\n",
    );
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INVALID_HANDLER);
  });

  it("非法 connector kind → DSL1014", () => {
    write("meta.yaml", BASE_META);
    write("a.yaml", "connectors:\n  c1: {kind: kafka}\n");
    expect(codes(validateSchemaDir(dir))).toContain(DIAGNOSTIC_CODES.INVALID_CONNECTOR_KIND);
  });
});
