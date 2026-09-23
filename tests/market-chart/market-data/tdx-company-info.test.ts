import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

type Query = { data?: unknown; isFetching: boolean; error: unknown };
const categories: Query = { data: undefined, isFetching: false, error: null };
const content: Query = { data: undefined, isFetching: false, error: null };
vi.mock("../../../src/trpc/react", () => ({
  api: {
    tdxCompanyInfo: { useQuery: () => categories },
    tdxCompanyInfoContent: { useQuery: () => content },
  },
}));
const { TdxCompanyInfo } =
  await import("../../../src/components/market/tdx-company-info");

const render = () =>
  renderToStaticMarkup(createElement(TdxCompanyInfo, { symbol: "sh600519" }));

describe("F10 公司资料", () => {
  it("默认折叠，并且两级都按需加载才请求", () => {
    const source = readFileSync(
      "src/components/market/tdx-company-info.tsx",
      "utf8",
    );
    // 展开折叠区才拉栏目清单
    expect(source).toContain("enabled: open");
    // 选中某个非空栏目才拉正文
    expect(source).toContain("enabled: Boolean(category?.length)");
    expect(source).toContain("onToggle");
    const html = render();
    expect(html).toContain("公司资料 F10");
    expect(html).not.toContain("<details open");
  });
  it("渲染栏目按钮，空栏目不可点", () => {
    categories.data = [
      { name: "公司概况", filename: "600519.txt", start: 0, length: 12664 },
      { name: "业内点评", filename: "600519b.txt", start: 0, length: 0 },
    ];
    const html = render();
    expect(html).toContain("公司概况");
    expect(html).toContain("业内点评（空）");
    expect(html).toMatch(/业内点评（空）[\s\S]{0,40}?<\/button>/);
    expect(html).toContain("disabled");
    categories.data = undefined;
  });
  it("披露 F10 只作阅读参考，不参与指标计算", () => {
    expect(render()).toContain("不参与任何指标计算");
  });
});
