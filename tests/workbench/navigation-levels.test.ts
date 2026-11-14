import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Menu, MenuItem, MenuGroup } from "../../src/components/ui/menu";
import {
  navGroups,
  navItemFor,
  navItems,
  searchNav,
  tabHref,
} from "../../src/components/workbench/navigation";

it("navigation preserves native links, selected route and expanded group", () => {
  const html = renderToStaticMarkup(
    createElement(Menu, {
      label: "工作台",
      children: createElement(MenuGroup, {
        label: "研究",
        icon: null,
        active: true,
        children: createElement(MenuItem, {
          active: true,
          children: createElement("a", { href: "/strategies" }, "策略研究"),
        }),
      }),
    }),
  );
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('href="/strategies"');
  expect(navItems.map((item) => item.href)).toEqual(
    expect.arrayContaining(["/strategies", "/intraday", "/cls-review"]),
  );
});

it("navigation is one grouped layer: every page, including former tabs, is a route", () => {
  // Group names and order can evolve; every item remains a unique real destination.
  expect(
    navGroups.every(
      (group) => group.label.length > 0 && group.items.length > 0,
    ),
  ).toBe(true);
  expect(navItems.some((item) => item.href === "/research")).toBe(false);
  expect(navItemFor("/research/data-guide")?.href).toBe("/research/data-guide");
  const hrefs = navItems.map((item) => item.href);
  expect(new Set(hrefs).size).toBe(hrefs.length);
  expect(hrefs[0]).toBe("/");
  for (const tab of [
    "market",
    "screen",
    "signals",
    "tasks",
    "settings",
    "analysis",
    "backtest",
    "news",
    "reports",
  ] as const)
    expect(navItemFor(tabHref(tab))?.tab).toBe(tab);
  expect(navItemFor("/reports/report/abc")?.title).toBe("研究报告详情");
  expect(navItemFor("/ui-gallery")).toBeUndefined();
  expect(searchNav("rps")[0]?.href).toBe("/rps");
  expect(searchNav("台账").map((item) => item.href)).toContain(
    "/signal-ledger",
  );
});

it("breakout overlay keeps dashed lines and moves labels outside the chart canvas", () => {
  const source = readFileSync("src/components/market/chart.tsx", "utf8");
  const base = readFileSync(
    "src/components/market/market-chart-base.ts",
    "utf8",
  );
  const overlay = base.slice(
    base.indexOf("for (const item of overlay?.lines"),
    base.indexOf("n.markers.setMarkers"),
  );
  expect(overlay).toContain("lineStyle: 2");
  expect(overlay).toContain("lastValueVisible: false");
  expect(overlay).not.toContain("title: item.title");
  const legend = readFileSync(
    "src/components/market/market-chart-legend.tsx",
    "utf8",
  );
  expect(legend).toContain('data-testid="chart-level-legend"');
  expect(source.indexOf("<MarketChartLegend")).toBeGreaterThan(-1);
  expect(source.indexOf("<MarketChartLegend")).toBeLessThan(
    source.indexOf("ref={ref}", source.indexOf("<MarketChartLegend")),
  );
});
