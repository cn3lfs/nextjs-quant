import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => [] as string[]);
vi.mock("~/components/research/latest-report", () => ({
  LatestReport: () => createElement("section", null, "latest-current-report"),
}));
vi.mock("~/trpc/react", () => ({
  api: new Proxy(
    {},
    {
      get: (_, name: string) =>
        name === "useUtils"
          ? () => ({})
          : {
              useQuery: () => {
                calls.push(name);
                return {};
              },
              useMutation: () => {
                calls.push(name);
                return {};
              },
            },
    },
  ),
}));
import { EvidenceAnalysis } from "~/components/workbench/evidence-analysis";
import { FinancialQualityPanel } from "~/components/research/financial-quality-panel";

it("renders current evidence research without retired method tabs", () => {
  const html = renderToStaticMarkup(
    createElement(EvidenceAnalysis, {
      loaded: null,
      notify: () => {},
    }),
  );
  expect(html).toContain("研究问题");
  expect(html).toContain("开始研究");
  expect(html).toContain("latest-current-report");
  for (const label of ["方法面板", "CAN SLIM", "威科夫", "缠论"])
    expect(html).not.toContain(label);
});
it("keeps financial data acquisition without the retired fundamental LLM workflow", () => {
  calls.length = 0;
  const html = renderToStaticMarkup(
    createElement(FinancialQualityPanel, { symbol: "sh600519" }),
  );
  expect(html).toContain("获取财务质量档案");
  expect(calls).toContain("financialQualityCreate");
  expect(calls).toContain("financialQualityHistory");
  expect(calls.some((name) => name.startsWith("fundamental"))).toBe(false);
  for (const label of ["基本面五阶段", "郭永清七步骤", "价值投资八步骤"])
    expect(html).not.toContain(label);
});
