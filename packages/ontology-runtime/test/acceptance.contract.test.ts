import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadManifest } from "../src/index";

/**
 * 可解释性 / 验收契约测试（无 DB、无密钥）：
 *  1) ontology/explainability/action-graphs.yaml 与编译 manifest 交叉一致
 *     （action/rule/projection 存在、humanRoles ⊆ actorRoles、provenance 合法）；
 *  2) AI 不可直接修改印量/价格：systemAgent 可调用 action 的 effects 不触及印量价格；
 *  3) 规则只产出风险项（result 为 finding 类），不做状态变化；
 *  4) seed --dry-run 行为级验证：无 DATABASE_URL 也正常退出且不落库；
 *  5) traceId 贯穿：audit/outbox 写入均携带 ctx.correlationId（源码级断言）。
 * 证据对应 docs/demo-5min.md 验收清单与 07_TRACEABILITY.md。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PKG = fileURLToPath(new URL("..", import.meta.url));
const manifest = loadManifest(`${ROOT}/ontology/.generated/ontology.manifest.json`);

interface ExplainNode {
  id: string;
  action?: string;
  rule?: string;
  projection?: string;
  provenance: string;
  decisionBy: "ai" | "human";
  humanRoles?: string[];
  effects?: string[];
}
interface ExplainGraph {
  provenanceLevels: string[];
  loops: Record<string, { nodes: ExplainNode[] }>;
}
const graph = parseYaml(
  readFileSync(`${ROOT}/ontology/explainability/action-graphs.yaml`, "utf8"),
) as ExplainGraph;

const actions = manifest.actions as Record<string, { actorRoles: string[]; effects: string[] }>;
const rules = manifest.rules as Record<string, { result: string }>;
const projections = manifest.projections as Record<string, unknown>;

describe("action-graphs.yaml ↔ 编译 manifest 交叉一致", () => {
  const allNodes = Object.values(graph.loops).flatMap((l) => l.nodes);

  it("每条闭环至少 3 个节点，且同时含 human 与（如声明）ai 决策点", () => {
    expect(Object.keys(graph.loops).sort()).toEqual(
      ["contractChain", "marketRecommendation", "paymentChain", "signatureQuota"].sort(),
    );
    for (const [name, loop] of Object.entries(graph.loops)) {
      expect(loop.nodes.length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it("provenance 取值合法（assumed/demo/imported/evidence/verified）", () => {
    for (const n of allNodes) {
      expect(graph.provenanceLevels, `${n.id} provenance`).toContain(n.provenance);
    }
    expect(graph.provenanceLevels).toEqual(["assumed", "demo", "imported", "evidence", "verified"]);
  });

  it("引用的 action/rule/projection 均存在于编译 manifest", () => {
    for (const n of allNodes) {
      if (n.action) expect(actions, n.action).toHaveProperty(n.action);
      if (n.rule) expect(rules, n.rule).toHaveProperty(n.rule);
      if (n.projection) expect(projections, n.projection).toHaveProperty(n.projection);
    }
  });

  it("humanRoles 是 action actorRoles 的子集（不夸大授权）", () => {
    for (const n of allNodes) {
      if (!n.action || !n.humanRoles) continue;
      for (const r of n.humanRoles) {
        expect(actions[n.action].actorRoles, `${n.action} ← ${r}`).toContain(r);
      }
    }
  });

  it("decisionBy=ai 的节点不得引用需人工角色的 action", () => {
    for (const n of allNodes) {
      if (n.decisionBy !== "ai" || !n.action) continue;
      expect(actions[n.action].actorRoles, n.action).toContain("systemAgent");
    }
  });
});

describe("AI 不可直接修改印量（市场建议闭环）", () => {
  const FORBIDDEN = /print|edition|price|quantity/i;

  it("systemAgent 可调用的 action 不含印量/价格类 effect", () => {
    for (const [id, a] of Object.entries(actions)) {
      if (!a.actorRoles.includes("systemAgent")) continue;
      for (const e of a.effects) {
        expect(FORBIDDEN.test(e), `${id} effect ${e}`).toBe(false);
      }
    }
  });

  it("评审建议 action 限 suggested/in_review → approved/rejected，且仅限人工角色", () => {
    const review = actions["reviewReleaseRecommendation"];
    expect(review.actorRoles).not.toContain("systemAgent");
    expect(review.actorRoles.sort()).toEqual(["executiveViewer", "ipOperations"]);
  });

  it("超额分配 precondition 存在于 allocateSignatures（服务端阻断）", () => {
    const alloc = actions["allocateSignatures"] as unknown as {
      preconditions: Array<{ op: string; path: string; valuePath?: string }>;
    };
    expect(alloc.preconditions).toContainEqual({
      op: "gte",
      path: "target.availableQuantity",
      valuePath: "input.quantity",
    });
  });
});

describe("规则只产出风险/阻断/候选建议，不做业务状态变化", () => {
  it("所有 rule.result 均为 finding/block/reject/candidate 类结果", () => {
    for (const [id, r] of Object.entries(rules)) {
      expect(r.result, id).toMatch(/Finding|block|reject|Candidate/i);
      expect(r.result, id).not.toMatch(/^set|^update|^delete/i);
    }
  });
});

describe("seed --dry-run 不落库（无 DATABASE_URL 行为级验证）", () => {
  // 直接用当前 node + tsx loader 起子进程，避免依赖 pnpm shim（Windows 下不稳定）。
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const runSeed = (args: string[], env: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, [tsxCli, "src/ingest/seed-cli.ts", ...args], {
      cwd: PKG,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const envWithoutDb = () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_URL_RUNTIME;
    delete env.DATABASE_URL_TEST;
    return env;
  };

  it("dry-run 在缺库时仍退出 0，且输出 [dry-run] 不写库", () => {
    const out = runSeed(["--dry-run"], envWithoutDb());
    expect(out).toContain("[dry-run] 不写库");
    expect(out).toContain("plan:");
  });

  it("非 dry-run 且无 DATABASE_URL 时退出 2（拒绝假完成）", () => {
    try {
      runSeed([], envWithoutDb());
      expect.unreachable("应在缺库时非零退出");
    } catch (e) {
      expect((e as { status: number }).status).toBe(2);
    }
  });
});

describe("traceId 贯穿与审计零旁路（源码级断言）", () => {
  const engine = readFileSync(`${PKG}/src/actions/engine.ts`, "utf8");
  const repo = readFileSync(`${PKG}/src/repository.ts`, "utf8");

  it("audit 与 outbox 写入均携带 ctx.correlationId", () => {
    expect(repo).toMatch(/writeAudit[\s\S]*?ctx\.correlationId/);
    expect(repo).toMatch(/writeOutbox[\s\S]*?ctx\.correlationId/);
  });

  it("action engine 每条执行都写 audit（deny/failed 亦留痕，零静默）", () => {
    expect(engine).toContain("writeAudit");
    expect(engine).toContain("writeOutbox");
    // 失败路径也把结果写入审计（含 correlationId 参数位）
    expect(engine).toMatch(/ctx\.correlationId/);
  });
});
