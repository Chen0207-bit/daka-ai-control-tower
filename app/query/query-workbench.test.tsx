/** QueryWorkbench 契约测试：stage 列表对齐 runtime、渲染、真实模式无 MOCK。 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { QUERY_STAGES as RUNTIME_QUERY_STAGES } from "@daka/ontology-runtime";
import { QUERY_STAGE_DEFS, QUERY_STAGES } from "./query-types";
import { QueryWorkbench } from "./query-workbench";

describe("查询管线 stage 契约", () => {
  it("客户端 stage 列表与 runtime QUERY_STAGES 完全一致（顺序敏感）", () => {
    expect([...QUERY_STAGES]).toEqual([...RUNTIME_QUERY_STAGES]);
  });

  it("每个阶段都有中文标签 + why/how 解释", () => {
    expect(QUERY_STAGE_DEFS.map((d) => d.id)).toEqual([...QUERY_STAGES]);
    for (const d of QUERY_STAGE_DEFS) {
      expect(d.label).toMatch(/^\d+ · /);
      expect(d.why.length).toBeGreaterThan(0);
      expect(d.how.length).toBeGreaterThan(0);
    }
  });
});

describe("QueryWorkbench 渲染", () => {
  const html = renderToStaticMarkup(createElement(QueryWorkbench));

  it("渲染问题输入、运行按钮、示例问题", () => {
    expect(html).toContain("query-workbench");
    expect(html).toContain("运行查询");
    expect(html).toContain("过去三年我应付了哪些账单？");
  });

  it("渲染 8 阶段时间线 + 答案/证据两个 tab", () => {
    for (const d of QUERY_STAGE_DEFS) expect(html).toContain(d.label);
    expect(html).toContain("答案");
    expect(html).toContain("证据 / 口径 / 路径");
  });

  it("真实模式：无 MOCK 标识，无降级文案", () => {
    expect(html).not.toContain("MOCK");
    expect(html).not.toContain("演示推演模式");
  });

  it("初始态显示本体图标题与管线标题", () => {
    expect(html).toContain("对象与关系（高亮本次触及）");
    expect(html).toContain("QUERY PIPELINE · 8 STAGES");
  });
});
