import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authorizeFact,
  authorizeLinkCreate,
  authorizeLinkRead,
  evaluatePolicy,
  loadManifest,
  makeContext,
  maskedFields,
  maskRecord,
  type ActorContext,
} from "../src/index";

/**
 * 治理资源授权映射单元测试（无 DB）：验证 FactAssertion 与 Link 路由
 * 通过编译后的 policy 模型授权，而非硬编码角色。证据见 07_TRACEABILITY.md。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const manifest = loadManifest(`${ROOT}/ontology/.generated/ontology.manifest.json`);

const role = (roles: string[]): ActorContext =>
  makeContext({ tenantId: "t", workspaceId: "w", actorId: "a", roles });

describe("事实治理授权（FactAssertion）", () => {
  it("read：管理层/管家/系统代理/法务复核/财务复核均可读", () => {
    for (const r of ["executiveViewer", "dataSteward", "systemAgent", "legalReviewer", "financeReviewer"]) {
      expect(authorizeFact(manifest, role([r]), "read").allowed, `read ${r}`).toBe(true);
    }
  });

  it("verify(→confirmFact)：dataSteward/legalReviewer/financeReviewer 允许", () => {
    for (const r of ["dataSteward", "legalReviewer", "financeReviewer"]) {
      expect(authorizeFact(manifest, role([r]), "verify").allowed, `verify ${r}`).toBe(true);
    }
  });

  it("verify：systemAgent 与 executiveViewer 被拒绝（P0）", () => {
    expect(authorizeFact(manifest, role(["systemAgent"]), "verify").allowed).toBe(false);
    expect(authorizeFact(manifest, role(["executiveViewer"]), "verify").allowed).toBe(false);
  });

  it("reject(→rejectFact)：复核角色允许，systemAgent/executiveViewer 拒绝", () => {
    expect(authorizeFact(manifest, role(["dataSteward"]), "reject").allowed).toBe(true);
    expect(authorizeFact(manifest, role(["legalReviewer"]), "reject").allowed).toBe(true);
    expect(authorizeFact(manifest, role(["systemAgent"]), "reject").allowed).toBe(false);
    expect(authorizeFact(manifest, role(["executiveViewer"]), "reject").allowed).toBe(false);
  });

  it("supersede(→supersedeFact)：仅 dataSteward 允许", () => {
    expect(authorizeFact(manifest, role(["dataSteward"]), "supersede").allowed).toBe(true);
    expect(authorizeFact(manifest, role(["legalReviewer"]), "supersede").allowed).toBe(false);
    expect(authorizeFact(manifest, role(["financeReviewer"]), "supersede").allowed).toBe(false);
    expect(authorizeFact(manifest, role(["systemAgent"]), "supersede").allowed).toBe(false);
    expect(authorizeFact(manifest, role(["executiveViewer"]), "supersede").allowed).toBe(false);
  });

  it("propose(→write)：systemAgent/dataSteward 允许，executiveViewer/legalReviewer 拒绝", () => {
    expect(authorizeFact(manifest, role(["systemAgent"]), "propose").allowed).toBe(true);
    expect(authorizeFact(manifest, role(["dataSteward"]), "propose").allowed).toBe(true);
    expect(authorizeFact(manifest, role(["executiveViewer"]), "propose").allowed).toBe(false);
    expect(authorizeFact(manifest, role(["legalReviewer"]), "propose").allowed).toBe(false);
  });
});

describe("关系治理授权（Link）", () => {
  it("创建：委托 linkType.from 端点类型 write 授权", () => {
    // contractParties(Contract→Party)：legalOperator 可写 Contract
    expect(authorizeLinkCreate(manifest, role(["legalOperator"]), "contractParties").allowed).toBe(true);
    // paymentSettlesSchedule(Payment→PaymentSchedule)：financeOperator 可写 Payment
    expect(authorizeLinkCreate(manifest, role(["financeOperator"]), "paymentSettlesSchedule").allowed).toBe(true);
    // executiveViewer 无任何对象 write → 拒绝
    expect(authorizeLinkCreate(manifest, role(["executiveViewer"]), "contractParties").allowed).toBe(false);
  });

  it("读取：列出全部按 Link 通配 read；按 linkType 读委托 from 端点", () => {
    expect(authorizeLinkRead(manifest, role(["executiveViewer"])).allowed).toBe(true);
    expect(authorizeLinkRead(manifest, role(["dataSteward"])).allowed).toBe(true);
    expect(authorizeLinkRead(manifest, role(["legalOperator"]), "contractParties").allowed).toBe(true);
  });
});

describe("字段级遮罩（maskRecord，compiled manifest 驱动）", () => {
  const PARTY = {
    id: "p1",
    legalName: "演示相对方（演示推演）",
    partyType: "company",
    registrationIdentifier: "REG-SECRET-91310000",
  };

  it("executiveViewer：highly_confidential 字段被精确替换为 ***masked***，其余字段保留", () => {
    const masked = maskRecord(manifest, role(["executiveViewer"]), "Party", PARTY);
    expect(masked.registrationIdentifier).toBe("***masked***");
    expect(masked.legalName).toBe(PARTY.legalName);
    expect(masked.partyType).toBe(PARTY.partyType);
  });

  it("deny 优先：executiveViewer 虽有 fields:* 的通配 allow，显式 deny 字段仍遮罩", () => {
    // executiveAggregatedRead(allow */*) 与 sensitiveFieldMaskForExecutive(deny) 同时命中 → deny 胜
    expect(maskedFields(manifest, role(["executiveViewer"]), "Party").has("registrationIdentifier")).toBe(true);
  });

  it("字段级 deny 不阻断行级读：executiveViewer 行授权通过、敏感字段由遮罩收口", () => {
    expect(evaluatePolicy(manifest, role(["executiveViewer"]), "Party", "read").allowed).toBe(true);
    // 但按字段求值时 deny 依然生效（双层语义：行授权 + 字段遮罩）
    expect(evaluatePolicy(manifest, role(["executiveViewer"]), "Party", "read", "registrationIdentifier").allowed).toBe(false);
    expect(evaluatePolicy(manifest, role(["executiveViewer"]), "Party", "read", "legalName").allowed).toBe(true);
  });

  it("有权限角色（dataSteward / legalOperator）看到原值", () => {
    for (const r of ["dataSteward", "legalOperator"]) {
      const masked = maskRecord(manifest, role([r]), "Party", PARTY);
      expect(masked.registrationIdentifier, r).toBe(PARTY.registrationIdentifier);
    }
  });

  it("default deny：无字段级 allow 的角色（financeOperator）默认遮罩 highly_confidential", () => {
    const masked = maskRecord(manifest, role(["financeOperator"]), "Party", PARTY);
    expect(masked.registrationIdentifier).toBe("***masked***");
  });

  it("Talent.identityIdentifier 同样遮罩；无敏感字段类型零开销原样返回", () => {
    const talent = { id: "t1", canonicalName: "演示人物", identityIdentifier: "ID-SECRET-110101" };
    expect(maskRecord(manifest, role(["executiveViewer"]), "Talent", talent).identityIdentifier).toBe("***masked***");
    const contract = { id: "c1", title: "x" };
    expect(maskRecord(manifest, role(["executiveViewer"]), "Contract", contract)).toEqual(contract);
  });
});
