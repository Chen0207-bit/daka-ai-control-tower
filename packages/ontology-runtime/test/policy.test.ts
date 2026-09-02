import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  authorizeFact,
  authorizeLinkCreate,
  authorizeLinkRead,
  loadManifest,
  makeContext,
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
