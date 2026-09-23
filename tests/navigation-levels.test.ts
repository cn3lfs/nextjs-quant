import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Menu, MenuItem, MenuGroup } from "../src/components/ui/menu";
import { routeTabs } from "../src/components/workbench/navigation";

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
  expect(routeTabs.map((item) => item.href)).toEqual(
    expect.arrayContaining(["/research", "/intraday", "/cls-review"]),
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
