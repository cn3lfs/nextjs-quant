import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("~/components/backtest/ma-baseline-panel", () => ({
  MaBaselinePanel: () =>
    createElement("section", { "aria-label": "双均线基线" }, "SMA5/20"),
}));
import { BacktestView } from "~/components/workbench/backtest-view";
it("default backtest entry exposes one baseline and leaves retired controls closed", () => {
  const html = renderToStaticMarkup(
    createElement(BacktestView, {
      state: { loaded: null } as Parameters<typeof BacktestView>[0]["state"],
    }),
  );
  expect(html).toContain("双均线基线");
  expect(html).toContain("SMA5/20");
  expect(html).toContain("查看已弃用策略与历史结果");
  expect(html).not.toContain("旧双均线趋势模拟");
  expect(html).not.toContain("最低量比");
});
