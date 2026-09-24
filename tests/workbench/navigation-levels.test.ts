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

it("navigation preserves native links, selected route and expanded research group", () => {
  const html = renderToStaticMarkup(
    createElement(Menu, {
      label: "工作台",
      children: createElement(MenuGroup, {
        label: "研究",
        icon: null,
        active: true,
        children: createElement(MenuItem, {
          active: true,
          children: createElement("a", { href: "/research" }, "策略研究"),
        }),
      }),
    }),
  );
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('href="/research"');
  expect(navItems.map((item) => item.href)).toEqual(
    expect.arrayContaining(["/research", "/intraday", "/cls-review"]),
  );
});

it("navigation is one grouped layer: every page, including former tabs, is a route", () => {
  expect(navGroups.map((group) => group.label)).toEqual([
    "今日",
    "分析",
    "数字货币",
    "资源期货",
    "台账",
    "研究",
    "系统",
  ]);
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
  const overlay = source.slice(
    source.indexOf("for (const item of overlay?.lines"),
    source.indexOf("markers?.setMarkers"),
  );
  expect(overlay).toContain("lineStyle: 2");
  expect(overlay).toContain("lastValueVisible: false");
  expect(overlay).not.toContain("title: item.title");
  expect(source.indexOf('data-testid="chart-level-legend"')).toBeLessThan(
    source.indexOf(
      "ref={ref}",
      source.indexOf('data-testid="chart-level-legend"'),
    ),
  );
});
