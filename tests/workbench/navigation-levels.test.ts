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
import { Sidebar } from "../../src/components/workbench/sidebar";

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
          children: createElement("a", { href: "/lab" }, "策略研究"),
        }),
      }),
    }),
  );
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('href="/lab"');
  expect(navItems.map((item) => item.href)).toEqual(
    expect.arrayContaining(["/lab", "/?tab=intraday", "/intel/review"]),
  );
});

it("the two-level sidebar opens the active workspace and marks its linked subpage", () => {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      active: "/accounts/alerts",
      badges: { "/accounts/alerts": { count: 2, bad: true } },
    }),
  );
  expect(html.match(/\bnav-group-toggle(?: active)?"/g)).toHaveLength(7);
  expect(html).toMatch(/aria-expanded="true"[^<]*>.*?选股筛选/);
  expect(html).toContain('class="nav-group-items" data-collapsed="false"');
  expect(
    html.match(/class="nav-group-items" data-collapsed="true"/g),
  ).toHaveLength(6);
  const activeLink = html.match(
    /<a(?=[^>]*\baria-current="page")(?=[^>]*\bhref="\/accounts\/alerts")[^>]*>.*?<\/a>/,
  )?.[0];
  expect(activeLink).toContain("历史信号");
  expect(activeLink).toMatch(
    /<em class="[^"]*\bnav-badge\b[^"]*\bbad\b[^"]*">2<\/em>/,
  );
});

it("every workspace subpage, including former tabs, remains a unique route", () => {
  expect(
    navGroups.every(
      (group) => group.label.length > 0 && group.items.length > 0,
    ),
  ).toBe(true);
  expect(navItems.some((item) => item.href === "/research")).toBe(false);
  expect(navItemFor("/lab/data-guide")?.href).toBe("/lab/data-guide");
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
  expect(navItemFor("/lab/reports/report/abc")?.title).toBe("研究报告详情");
  expect(navItemFor("/system/ui-gallery")).toBeUndefined();
  expect(searchNav("rps")[0]?.href).toBe("/scan?tab=rps");
  expect(searchNav("历史信号").map((item) => item.href)).toContain(
    "/accounts/alerts",
  );
});

it("resolves the active subpage from pathname plus tab without changing old hrefs", () => {
  // 同一个 /scan 路径承载三个工作区的子页；只有 tab 能区分当前活跃项。
  expect(navItemFor("/scan", "tab=rps")?.href).toBe("/scan?tab=rps");
  expect(navItemFor("/scan", "tab=crypto&pair=BTCUSDT")?.href).toBe(
    "/scan?tab=crypto",
  );
  expect(navItemFor("/", "tab=overview")?.href).toBe("/?tab=overview");
  expect(navItemFor("/", "tab=intraday")?.href).toBe("/?tab=intraday");
  // 无关查询参数仍落在路径级页面，不误判成某个子页。
  expect(navItemFor("/scan", "symbol=sh600519")?.href).toBe("/scan");
  // 旧深链与既有单参数调用保持可用。
  expect(navItemFor("/scan?tab=formula")?.href).toBe("/scan?tab=formula");
  expect(navItemFor("/accounts/alerts")?.group).toBe("选股筛选");
  expect(navItemFor("/lab/reports")?.group).toBe("资讯研报");
  expect(navItemFor("/lab/data-guide")?.group).toBe("系统设置");
  for (const group of navGroups)
    expect(group.subtitle.length).toBeGreaterThan(0);
});

it("breakout overlay keeps dashed lines and moves labels outside the chart canvas", () => {
  const source = readFileSync(
    "src/components/market/charts/market-chart.tsx",
    "utf8",
  );
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
