import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PositionCostPrice } from "../../src/components/portfolio/position-cost-price";

const render = (props: Parameters<typeof PositionCostPrice>[0]) =>
  renderToStaticMarkup(createElement(PositionCostPrice, props));

it("shows the per-unit cost and valuation price with the price's own date in CNY", () => {
  const html = render({
    symbol: "sh600000",
    cost: 9.8,
    price: 12.35,
    currency: "CNY",
    at: "2026-11-18",
  });
  expect(html).toContain("成本 9.80 CNY");
  expect(html).toContain("现价 12.35 CNY");
  expect(html).toContain('title="原价时点 2026-11-18"');
});

it("keeps the ETF's third price decimal from the existing chart precision", () => {
  const html = render({
    symbol: "sh510300",
    cost: 3.9,
    price: 3.876,
    currency: "CNY",
    at: "2026-11-18",
  });
  expect(html).toContain("成本 3.900 CNY");
  expect(html).toContain("现价 3.876 CNY");
});

it("keeps a missing cost explicit instead of deriving it from the fractional USDT price", () => {
  const html = render({
    symbol: "cxDOGEUSDT",
    cost: null,
    price: 0.00012345,
    currency: "USDT",
    at: "2026-11-19T08:00:00.000Z",
  });
  expect(html).toContain("成本 缺失");
  expect(html).toContain("现价 0.00012345 USDT");
  expect(html).toContain('title="原价时点 2026-11-19T08:00:00.000Z"');
  expect(html).not.toContain("成本 0");
});

it("keeps a missing price and its date independent of the recorded cost", () => {
  const html = render({
    symbol: "sh600000",
    cost: 100,
    price: null,
    currency: "CNY",
    at: null,
  });
  expect(html).toContain("成本 100.00 CNY");
  expect(html).toContain("现价 缺失");
  expect(html).toContain('title="原价时点 未知"');
});
