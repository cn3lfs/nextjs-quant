import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const queries = vi.hoisted(() => [] as { name: string; input: unknown }[]);
vi.mock("~/trpc/react", () => ({
  api: new Proxy(
    {},
    {
      get: (_, name: string) => {
        if (name === "useUtils") return () => ({});
        if (name.startsWith("strategyResearch"))
          throw new Error("Retired API used by current account view");
        return {
          useQuery: (input: unknown) => {
            queries.push({ name, input });
            return {};
          },
        };
      },
    },
  ),
}));
import { PeriodPerformanceContainer } from "~/components/backtest/period-performance-container";
import { RollingPerformanceContainer } from "~/components/backtest/rolling-performance-container";
import { StrategyAdmissionContainer } from "~/components/research/strategy-admission-container";
beforeEach(() => {
  queries.length = 0;
});
it.each([
  [
    PeriodPerformanceContainer,
    "tradeReviewPeriodPerformance",
    "分段与收益矩阵",
  ],
  [RollingPerformanceContainer, "tradeReviewRollingPerformance", "滚动绩效"],
  [StrategyAdmissionContainer, "tradeReviewAdmission", "导出准入 JSON"],
] as const)("%s queries only the selected account", (View, query, label) => {
  const html = renderToStaticMarkup(
    createElement(View, { account: "review-fixture" }),
  );
  expect(html).toContain(label);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatchObject({
    name: query,
    input: { account: "review-fixture", pageIndex: 0, pageSize: 10 },
  });
});
