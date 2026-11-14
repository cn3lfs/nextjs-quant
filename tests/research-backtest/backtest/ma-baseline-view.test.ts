import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("~/components/backtest/ma-baseline-panel", () => ({
  MaBaselinePanel: () =>
    createElement("section", { "aria-label": "双均线基线" }, "SMA5/20"),
}));
import { BacktestView } from "~/components/workbench/backtest-view";
it("backtest entry exposes the current workspace without a legacy selector", () => {
  const html = renderToStaticMarkup(
    createElement(BacktestView, {
      loaded: null,
    }),
  );
  expect(html).toContain("双均线基线");
  expect(html).toContain("SMA5/20");
  expect(html).not.toContain("历史策略与结果");
  expect(html).not.toContain("查看已弃用策略");
  expect(html).not.toContain("旧双均线趋势模拟");
  expect(html).not.toContain("最低量比");
});
