import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dates: Array.from(
    { length: 22 },
    (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`,
  ),
}));
vi.mock("../src/server/db", () => ({ sqlite: () => ({}) }));
vi.mock("../src/server/infra/settings", async (original) => ({
  ...(await original<typeof import("../src/server/infra/settings")>()),
  settings: () => ({ tdxRoot: "fixture", calendar: state.dates }),
}));
vi.mock("../src/server/market/data-health", async (original) => ({
  ...(await original<typeof import("../src/server/market/data-health")>()),
  fullLocalCalendarReference: async () => ({
    days: state.dates,
    coverage: { start: state.dates[0], end: state.dates.at(-1), count: 4 },
  }),
}));
vi.mock("../src/server/portfolio/delivery-store", () => ({
  DeliveryStore: class {
    fills() {
      return state.dates.map((tradeDate) => ({ tradeDate }));
    }
    cashFlows() {
      return [];
    }
  },
}));
vi.mock("../src/server/portfolio/trade-review-service", async (original) => ({
  ...(await original<
    typeof import("../src/server/portfolio/trade-review-service")
  >()),
  buildTradeReviewSnapshot: async () => ({
    nav: {
      days: state.dates.map((date, i) => ({
        date,
        positions: { sh600000: i + 1, sz000001: 100 - i },
        positionValues: {
          stock: {
            value: i === 1 ? null : 10,
            reason: i === 1 ? "缺行情" : null,
          },
        },
        marketValue: {
          value: i === 1 ? null : 10,
          reason: i === 1 ? "缺行情" : null,
        },
        nav: { value: 100, reason: null },
        dailyReturn: { value: i === 1 ? null : 0.01 },
      })),
    },
    replayInput: {
      nav: { tradingDays: state.dates },
      trades: {
        bars: Object.fromEntries(
          ["sh600000", "sz000001"].map((symbol) => [
            symbol,
            state.dates.map((date, i) => ({ date, close: i % 2 ? 101 : 100 })),
          ]),
        ),
      },
    },
  }),
}));
import { createCaller } from "../src/server/api/root";
it("U5账户路由从复盘收盘价取收益，传递分页及20日门槛", async () => {
  const caller = createCaller({ headers: new Headers() });
  const result = await caller.tradeReviewHoldingsCorrelation({
    account: "fixture",
    pageSize: 1,
    pageIndex: 1,
  });
  expect(result.rowCount).toBe(2);
  expect(result.rows.map((r) => r.symbol)).toEqual(["sz000001"]);
  expect(result.rows[0]!.cells[0]!.overlapDays).toBe(21);
  expect(result.rows[0]!.cells[0]!.value).toBeCloseTo(1, 12);
  expect(result.pairCount).toEqual({ available: 1, insufficient: 0 });
  await expect(
    caller.tradeReviewHoldingsCorrelation({ account: " " }),
  ).rejects.toThrow();
  await expect(
    caller.tradeReviewHoldingsCorrelation({ account: "fixture", pageSize: 21 }),
  ).rejects.toThrow();
});
