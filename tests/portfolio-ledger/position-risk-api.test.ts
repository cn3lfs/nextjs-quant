import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dates: ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"],
}));
vi.mock("../../src/server/db/index", () => ({ sqlite: () => ({}) }));
vi.mock("../../src/server/infra/settings", async (original) => ({
  ...(await original<typeof import("../../src/server/infra/settings")>()),
  settings: () => ({ tdxRoot: "fixture", calendar: state.dates }),
}));
vi.mock("../../src/server/market/data-health", async (original) => ({
  ...(await original<typeof import("../../src/server/market/data-health")>()),
  fullLocalCalendarReference: async () => ({
    days: state.dates,
    coverage: { start: state.dates[0], end: state.dates.at(-1), count: 4 },
  }),
}));
vi.mock("../../src/server/portfolio/delivery-store", () => ({
  DeliveryStore: class {
    fills() {
      return state.dates.map((tradeDate) => ({ tradeDate }));
    }
    cashFlows() {
      return [];
    }
  },
}));
vi.mock("../../src/server/portfolio/trade-review-service", async (original) => ({
  ...(await original<
    typeof import("../../src/server/portfolio/trade-review-service")
  >()),
  buildTradeReviewSnapshot: async () => ({
    nav: {
      days: state.dates.map((date, i) => ({
        date,
        positions: { stock: 1 },
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
    replayInput: { nav: { tradingDays: state.dates } },
  }),
}));
import { createCaller } from "../../src/server/api/root";
it("U11账户tRPC传递服务端排序分页与缺失", async () => {
  const caller = createCaller({ headers: new Headers() });
  const result = await caller.tradeReviewPositionRisk({
    account: "fixture",
    pageSize: 1,
    pageIndex: 1,
    sort: "date",
    desc: false,
  });
  expect(result.rowCount).toBe(4);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]!.date).toBe(state.dates[1]);
  expect(result.rows[0]!.effectivePositions.value).toBeNull();
  expect(result.curve).toHaveLength(4);
  await expect(
    caller.tradeReviewPositionRisk({ account: "fixture", pageSize: 101 }),
  ).rejects.toThrow();
  await expect(
    caller.tradeReviewPositionRisk({ account: " " }),
  ).rejects.toThrow();
});
