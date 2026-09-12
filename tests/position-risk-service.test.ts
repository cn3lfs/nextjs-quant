import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  pagePositionRisk,
  positionRiskPageSchema,
} from "../src/server/position-risk-service";
import type { NavDay } from "../src/lib/trade-review-nav";
import { PositionRiskResults } from "../src/components/position-risk-results";
vi.mock("../src/components/chart", () => ({
  PositionRiskChart: () => createElement("div", { role: "img" }),
}));
const dates = Array.from(
  { length: 1800 },
  (_, i) => new Date(Date.UTC(2020, 0, i + 1)),
)
  .filter((d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
  .slice(0, 1265)
  .map((d) => d.toISOString().slice(0, 10));
const days: NavDay[] = dates.map((date, i) => ({
  date,
  positions: { stock: 1 },
  positionValues: {
    stock: { value: i === 4 ? null : i + 1, reason: i === 4 ? "缺行情" : null },
  },
  marketValue: {
    value: i === 4 ? null : i + 1,
    reason: i === 4 ? "缺行情" : null,
  },
  nav: { value: 2000, reason: null },
  cash: { value: 2000 - i - 1, reason: null },
  reverseRepoPrincipal: { value: 0, reason: null },
  dailyReturn: { value: 0, reason: null },
}));
it("1265天服务端排序分页，曲线和摘要覆盖全区间且空值置后", () => {
  const page = positionRiskPageSchema.parse({ sort: "date", desc: false });
  const first = pagePositionRisk(days, page),
    second = pagePositionRisk(days, { ...page, pageIndex: 1 });
  expect(first.rowCount).toBe(1265);
  expect(first.rows.map((p) => p.date)).toEqual(dates.slice(0, 10));
  expect(second.rows.map((p) => p.date)).toEqual(dates.slice(10, 20));
  expect(first.curve).toHaveLength(1265);
  expect(second.curve).toEqual(first.curve);
  expect(second.summary).toEqual(first.summary);
  expect(first.summary).toEqual({
    maxSingleWeight: 1265 / 2000,
    maxSingleWeightDate: dates.at(-1),
    medianEffectivePositions: 1,
    availableDays: 1264,
  });
  expect(
    pagePositionRisk(days, { ...page, pageIndex: 126 }).rows.map((p) => p.date),
  ).toEqual(dates.slice(1260));
  expect(pagePositionRisk(days, { ...page, pageIndex: 127 }).rows).toEqual([]);
  for (const desc of [true, false])
    expect(
      pagePositionRisk(days, {
        ...page,
        sort: "maxSingleWeight",
        desc,
        pageIndex: 126,
      }).rows.at(-1)!.date,
    ).toBe(dates[4]);
  expect(() => positionRiskPageSchema.parse({ pageSize: 101 })).toThrow();
  expect(() => positionRiskPageSchema.parse({ sort: "nav" })).toThrow();
  const html = renderToStaticMarkup(
    createElement(PositionRiskResults, {
      data: first,
      table: {
        pagination: { pageIndex: 0, pageSize: 10 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
      },
    }),
  );
  for (const text of [
    "等效持仓只数",
    "赫芬达尔（分母：总资产）",
    "赫芬达尔（分母：持仓市值）",
    "逆回购",
    "缺行情",
    "1265",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain(dates[10]);
});
it("空数据摘要留空并列峰值取最早日", () => {
  const page = positionRiskPageSchema.parse({});
  expect(pagePositionRisk([], page)).toEqual({
    rows: [],
    rowCount: 0,
    curve: [],
    summary: {
      maxSingleWeight: null,
      maxSingleWeightDate: null,
      medianEffectivePositions: null,
      availableDays: 0,
    },
  });
  expect(
    pagePositionRisk([days[0]!, { ...days[0]!, date: dates[1]! }], page).summary
      .maxSingleWeightDate,
  ).toBe(dates[0]);
});
it("新增入口精确接线、刷新失效、排序归首页且颜色只取token", () => {
  const container = readFileSync(
    "src/components/position-risk-container.tsx",
    "utf8",
  );
  expect(container).toContain("api.tradeReviewPositionRisk.useQuery");
  expect(container).toContain("onPaginationChange: setPagination");
  expect(container).toMatch(
    /setPagination\(\(p\) => \(\{ \.\.\.p, pageIndex: 0 \}\)\)/,
  );
  const parent = readFileSync(
    "src/components/trade-review-container.tsx",
    "utf8",
  );
  expect(parent).toContain("utils.tradeReviewPositionRisk.invalidate()");
  expect(parent).toContain("<PositionRiskContainer");
  expect(parent).toContain(
    'key={`position-risk:${account}:${batches.data?.map((b) => b.id).join(",")}`}',
  );
  const chart = readFileSync("src/components/chart.tsx", "utf8")
    .split("export function PositionRiskChart")[1]!
    .split("export function PriceChart")[0]!;
  expect(chart).toContain('getPropertyValue("--primary")');
  expect(chart).not.toMatch(/#[0-9a-f]{3,8}/i);
  expect(chart).toContain("positionRiskCurveSegments(points, key)");
});
