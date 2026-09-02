import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffIR, type ChangeClass } from "../src/diff";
import { buildCanonicalIR, type CanonicalIR } from "../src/ir";
import { mergeSchemaFiles } from "../src/model";
import { loadSchemaDir } from "../src/parse";
import { runCli } from "../src/commands";

let dir: string;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ontology-diff-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSchema(name: string, files: Record<string, string>): string {
  const sub = join(dir, `${name}${counter++}`);
  mkdirSync(sub, { recursive: true });
  for (const [f, content] of Object.entries(files)) {
    writeFileSync(join(sub, f), content, "utf8");
  }
  return sub;
}

function irOf(files: Record<string, string>): CanonicalIR {
  return buildCanonicalIR(mergeSchemaFiles(loadSchemaDir(writeSchema("s", files))));
}

const META = "meta:\n  name: t\n  version: 1.0.0\n  dsl: \"1\"\n";

const BASE_YAML =
  "valueSets:\n  contractStatus: {values: [draft, active, expired]}\nobjectTypes:\n  Party:\n    properties:\n      id: {type: uuid}\n  Contract:\n    properties:\n      id: {type: uuid}\n      title: {type: string, required: true}\n      amount: {type: integer}\n      status: {type: enum, ref: contractStatus}\nlinkTypes:\n  c2p: {from: Contract, to: Party, cardinality: one_to_many}\nroleDefinitions:\n  admin: {dataScope: tenant}\nactions:\n  doIt:\n    target: Contract\n    handler: x.y\n    actorRoles: [admin]\n    inputs:\n      note: {type: string}\n";

function baseIR(): CanonicalIR {
  return irOf({ "meta.yaml": META, "a.yaml": BASE_YAML });
}

function variant(mutate: (yaml: string) => string): CanonicalIR {
  return irOf({ "meta.yaml": META, "a.yaml": mutate(BASE_YAML) });
}

function classes(result: ReturnType<typeof diffIR>): ChangeClass[] {
  return result.changes.map((c) => c.class);
}

describe("diff 兼容性分级", () => {
  it("无变更 → none", () => {
    const r = diffIR(baseIR(), baseIR());
    expect(r.highest).toBe("none");
    expect(r.suggestedBump).toBe("none");
  });

  it("新增可选属性 / 新增枚举无关项 / 新增 action → additive(patch)", () => {
    const v = variant((s) =>
      s
        .replace(
          "      status: {type: enum, ref: contractStatus}",
          "      status: {type: enum, ref: contractStatus}\n      note2: {type: string}",
        )
        .replace(
          "      note: {type: string}",
          "      note: {type: string}\n  doMore:\n    target: Contract\n    handler: x.z\n    actorRoles: [admin]\n",
        ),
    );
    const r = diffIR(baseIR(), v);
    expect(r.highest).toBe("additive");
    expect(r.suggestedBump).toBe("patch");
    expect(classes(r)).not.toContain("breaking");
  });

  it("删除属性 / 属性改型 / 枚举缩减 / 基数收紧 / 新增必填 → breaking(major)", () => {
    const removed = diffIR(baseIR(), variant((s) => s.replace("      title: {type: string, required: true}\n", "")));
    expect(removed.highest).toBe("breaking");
    expect(removed.suggestedBump).toBe("major");
    expect(removed.changes[0].kind).toBe("property-removed");

    const retyped = diffIR(baseIR(), variant((s) => s.replace("amount: {type: integer}", "amount: {type: text}")));
    expect(retyped.highest).toBe("breaking");

    const shrunk = diffIR(baseIR(), variant((s) => s.replace("[draft, active, expired]", "[draft, active]")));
    expect(shrunk.highest).toBe("breaking");
    expect(shrunk.changes[0].kind).toBe("valueSet-shrunk");

    const tightened = diffIR(baseIR(), variant((s) => s.replace("cardinality: one_to_many", "cardinality: one_to_one")));
    expect(tightened.highest).toBe("breaking");

    const reqAdded = diffIR(baseIR(), variant((s) => s.replace("      status: {type: enum, ref: contractStatus}", "      status: {type: enum, ref: contractStatus}\n      must: {type: string, required: true}")));
    expect(reqAdded.highest).toBe("breaking");
  });

  it("枚举扩大 / 必填放宽 / 基数放宽 → compatible(patch)", () => {
    const expanded = diffIR(baseIR(), variant((s) => s.replace("[draft, active, expired]", "[draft, active, expired, terminated]")));
    expect(expanded.highest).toBe("compatible");
    expect(expanded.suggestedBump).toBe("patch");

    const loosened = diffIR(baseIR(), variant((s) => s.replace("title: {type: string, required: true}", "title: {type: string}")));
    expect(loosened.highest).toBe("compatible");

    const card = diffIR(baseIR(), variant((s) => s.replace("cardinality: one_to_many", "cardinality: many_to_many")));
    expect(card.highest).toBe("compatible");
  });

  it("integer→decimal 无损转换 → data-migration-required(minor)", () => {
    const r = diffIR(baseIR(), variant((s) => s.replace("amount: {type: integer}", "amount: {type: decimal}")));
    expect(r.highest).toBe("data-migration-required");
    expect(r.suggestedBump).toBe("minor");
  });

  it("action 输入改型 / 删除 action / 前置条件变化 → breaking", () => {
    const inputChanged = diffIR(baseIR(), variant((s) => s.replace("note: {type: string}", "note: {type: integer}")));
    expect(inputChanged.highest).toBe("breaking");

    const actionRemoved = diffIR(baseIR(), variant((s) => s.replace(/actions:[\s\S]*$/, "")));
    expect(actionRemoved.highest).toBe("breaking");

    const preChanged = diffIR(baseIR(), variant((s) => s.replace("    inputs:", "    preconditions:\n      - {op: gt, path: input.note, value: 0}\n    inputs:")));
    expect(preChanged.highest).toBe("breaking");
  });

  it("CLI diff：breaking 退出码 1，无变更退出码 0", () => {
    const aDir = writeSchema("cliA", {
      "meta.yaml": META,
      "a.yaml": "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\n",
    });
    const bDir = writeSchema("cliB", {
      "meta.yaml": META,
      "a.yaml": "objectTypes:\n  C:\n    properties:\n      id: {type: uuid}\n      x: {type: string}\n",
    });
    expect(runCli(["diff", aDir, aDir])).toBe(0);
    expect(runCli(["diff", aDir, bDir])).toBe(0); // additive
    expect(runCli(["diff", bDir, aDir])).toBe(1); // breaking
  });
});
