import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

// Isolated negative control: bypass visibility without editing application files.
vi.mock("~/components/workbench/keep-alive", async (original) => {
  const actual =
    await original<typeof import("~/components/workbench/keep-alive")>();
  return process.env.QUANT_TEST_BYPASS_RISK_VISIBILITY === "1"
    ? { ...actual, usePanelVisible: () => true }
    : actual;
});

const fixture = vi.hoisted(() => ({
  view: "concentration",
  queries: [] as {
    name: string;
    input: { account: string };
    enabled: boolean;
  }[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) =>
      react.useState(initial === "concentration" ? fixture.view : initial),
  };
});
vi.mock("~/trpc/react", () => ({
  api: Object.fromEntries(
    ["tradeReviewPositionRisk", "tradeReviewHoldingsCorrelation"].map(
      (name) => [
        name,
        {
          useQuery(input: { account: string }, options: { enabled: boolean }) {
            fixture.queries.push({ name, input, enabled: options.enabled });
            return { data: undefined, isLoading: true };
          },
        },
      ],
    ),
  ),
}));
import { PositionRiskContainer } from "~/components/backtest/position-risk-container";
import { PanelVisibility } from "~/components/workbench/keep-alive";

beforeEach(() => {
  fixture.queries = [];
  fixture.view = "concentration";
});
it.each(["concentration", "correlation"])(
  "queries only the selected risk view %s for the supplied account",
  (view) => {
    fixture.view = view;
    const html = renderToStaticMarkup(
      createElement(PositionRiskContainer, { account: "account-fixture" }),
    );
    expect(html).toContain('aria-label="持仓风险分析"');
    expect(html).toContain("持仓集中度");
    expect(html).toContain("持仓相关性");
    expect(fixture.queries.map((q) => q.input.account)).toEqual([
      "account-fixture",
      "account-fixture",
    ]);
    expect(fixture.queries.filter((q) => q.enabled).map((q) => q.name)).toEqual(
      [
        view === "concentration"
          ? "tradeReviewPositionRisk"
          : "tradeReviewHoldingsCorrelation",
      ],
    );
  },
);
it.each(["concentration", "correlation"])(
  "does not query hidden or unselected accounts in %s",
  (view) => {
    fixture.view = view;
    renderToStaticMarkup(
      createElement(PanelVisibility, {
        visible: false,
        children: createElement(PositionRiskContainer, {
          account: "account-fixture",
        }),
      }),
    );
    expect(fixture.queries.some((q) => q.enabled)).toBe(false);
    fixture.queries = [];
    renderToStaticMarkup(createElement(PositionRiskContainer, { account: "" }));
    expect(fixture.queries.some((q) => q.enabled)).toBe(false);
  },
);
