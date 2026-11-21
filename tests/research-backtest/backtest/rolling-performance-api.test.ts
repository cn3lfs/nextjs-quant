import { afterAll, expect, it, vi } from "vitest";
import { sqlite } from "../../../src/server/db/index";
afterAll(() => sqlite().close());

const state = vi.hoisted(() => ({
  dates: ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"],
}));
// Use a real isolated SQLite connection for the shared review identity; the
// downstream snapshot remains the explicit numeric fixture below.
vi.mock("../../../src/server/db/index", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { migrate } = await import("../../../src/server/db/migrations");
  const db = new Database(":memory:");
  migrate(db);
  return { sqlite: () => db };
});
vi.mock("../../../src/server/infra/settings", async (original) => ({
  ...(await original<typeof import("../../../src/server/infra/settings")>()),
  settings: () => ({ tdxRoot: "fixture", calendar: state.dates }),
}));
vi.mock("../../../src/server/market/data-health", async (original) => ({
  ...(await original<
    typeof import("../../../src/server/market/data-health")
  >()),
  fullLocalCalendarReference: async () => ({
    days: state.dates,
    coverage: { start: state.dates[0], end: state.dates.at(-1), count: 4 },
  }),
}));
vi.mock("../../../src/server/db/delivery-store", () => ({
  exclusiveDeliveryRow: () => "1=1",
  DeliveryStore: class {
    fills() {
      return state.dates.map((tradeDate) => ({ tradeDate }));
    }
    cashFlows() {
      return [];
    }
  },
}));
vi.mock(
  "../../../src/server/portfolio/trade-review-service",
  async (original) => ({
    ...(await original<
      typeof import("../../../src/server/portfolio/trade-review-service")
    >()),
    buildTradeReviewSnapshot: async () => ({
      nav: {
        days: state.dates.map((date, i) => ({
          date,
          dailyReturn: { value: i === 1 ? null : 0.01 },
        })),
      },
      replayInput: { nav: { tradingDays: state.dates } },
    }),
  }),
);
import { createCaller } from "../../../src/server/api/root";

it("account tRPC route validates and forward window, minPeriods, basis and pagination", async () => {
  const caller = createCaller({ headers: new Headers() });
  const params = {
    window: 3,
    minPeriods: 1,
    pageSize: 1,
    pageIndex: 1,
    sort: "endDate" as const,
    desc: false,
    basis: "simple" as const,
  };
  const trade = await caller.tradeReviewRollingPerformance({
    ...params,
    account: "fixture",
  });
  expect(trade.rowCount).toBe(4);
  expect(trade.rows).toHaveLength(1);
  expect(trade.rows[0]).toMatchObject({
    endDate: state.dates[1],
    tradingDays: 2,
    basis: "simple",
    coverage: { nullDays: 1 },
    insufficientCoverage: true,
  });
  await expect(
    caller.tradeReviewRollingPerformance({ account: "fixture", pageSize: 101 }),
  ).rejects.toThrow();
  await expect(
    caller.tradeReviewRollingPerformance({
      account: "fixture",
      window: 2,
      minPeriods: 3,
    }),
  ).rejects.toThrow("最少日数不能超过窗口");
});
