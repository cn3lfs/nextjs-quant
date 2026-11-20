import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
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
    expect.arrayContaining(["/lab", "/scan?tab=formula", "/intel/review"]),
  );
});

const publicItems = navItems.filter((item) => !item.hidden);
const anchors = (html: string) => html.match(/<a\b[^>]*>.*?<\/a>/gs) ?? [];
const hrefOf = (link: string) =>
  link.match(/\bhref="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");

it.each(publicItems)(
  "opens the owning sidebar group and marks $href current",
  (item) => {
    const location = new URL(item.href, "https://workbench.test");
    const active = navItemFor(location.pathname, location.search)?.href;
    const html = renderToStaticMarkup(
      createElement(Sidebar, {
        active,
        badges: { [item.href]: { count: 2, bad: true } },
      }),
    );
    const nav =
      html.match(/<nav\b[^>]*aria-label="工作台导航"[^>]*>.*?<\/nav>/s)?.[0] ??
      "";
    const groups = nav.match(/<section\b[^>]*>.*?<\/section>/gs) ?? [];
    const current = anchors(nav).filter((link) =>
      /<a\b[^>]*aria-current="page"/.test(link),
    );
    expect(current.map(hrefOf)).toEqual([item.href]);
    expect(current[0]).toMatch(/<em\b[^>]*>2<\/em>/);
    for (const group of navGroups) {
      const hrefs = group.items
        .filter((entry) => !entry.hidden)
        .map((entry) => entry.href);
      const matches = groups.filter((section) =>
        anchors(section).some((link) => hrefOf(link) === hrefs[0]),
      );
      expect(matches, group.label).toHaveLength(1);
      expect(anchors(matches[0]!).map(hrefOf)).toEqual(hrefs);
      const open = group.label === item.group;
      expect(matches[0]).toMatch(
        new RegExp(`<button\\b[^>]*aria-expanded="${open}"`),
      );
      expect(matches[0]).toMatch(
        new RegExp(`<ul\\b[^>]*data-collapsed="${!open}"`),
      );
    }
  },
);

it("resolves every public navigation pathname to a Next page", () => {
  const pagePaths = readdirSync("src/app", {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && /^page\.[jt]sx?$/.test(entry.name))
    .map((entry) =>
      entry.parentPath
        .replaceAll("\\", "/")
        .split("/")
        .slice(2)
        .filter((segment) => !segment.startsWith("(")),
    )
    .filter((segments) => segments.every((segment) => !/^[_@]/.test(segment)));
  for (const item of publicItems) {
    const { pathname } = new URL(item.href, "https://workbench.test");
    const segments = pathname.split("/").slice(1).filter(Boolean);
    expect(
      pagePaths.some(
        (page) =>
          page.length === segments.length &&
          page.every(
            (segment, index) =>
              segment === segments[index] || /^\[\w+\]$/.test(segment),
          ),
      ),
      item.href,
    ).toBe(true);
  }
});

it("keeps stable workspace shortcuts and report detail links", () => {
  expect(navItemFor("/lab/data-guide")?.href).toBe("/lab/data-guide");
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
  expect(searchNav("rps").map((item) => item.href)).toContain("/scan?tab=rps");
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
  // 盘中记录已并入公式选股：不再作为导航/搜索入口，旧深链仍解析归属。
  expect(navItems.map((item) => item.href)).not.toContain("/?tab=intraday");
  expect(searchNav("盘中记录")).toEqual([]);
  expect(navItemFor("/", "tab=intraday")?.group).toBe("选股筛选");
  // 无关查询参数仍落在路径级页面，不误判成某个子页。
  expect(navItemFor("/scan", "symbol=sh600519")?.href).toBe("/scan");
  // 旧深链与既有单参数调用保持可用。
  expect(navItemFor("/scan?tab=formula")?.href).toBe("/scan?tab=formula");
  expect(navItemFor("/accounts/alerts")?.group).toBe("选股筛选");
  expect(navItemFor("/lab/reports")?.group).toBe("资讯研报");
  expect(navItemFor("/lab/data-guide")?.group).toBe("系统设置");
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
