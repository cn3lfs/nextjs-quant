import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dates: ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"],
}));
vi.mock("../src/server/db", () => ({ sqlite: () => ({}) }));
vi.mock("../src/server/settings", async (original) => ({
  ...(await original<typeof import("../src/server/settings")>()),
  settings: () => ({ tdxRoot: "fixture", calendar: state.dates }),
}));
vi.mock("../src/server/data-health", async (original) => ({
  ...(await original<typeof import("../src/server/data-health")>()),
  fullLocalCalendarReference: async () => ({
    days: state.dates,
    coverage: { start: state.dates[0], end: state.dates.at(-1), count: 4 },
  }),
}));
vi.mock("../src/server/delivery-store", () => ({
  DeliveryStore: class {
    fills() {
      return state.dates.map((tradeDate) => ({ tradeDate }));
    }
    cashFlows() {
      return [];
    }
  },
}));
vi.mock("../src/server/trade-review-service", async (original) => ({
  ...(await original<typeof import("../src/server/trade-review-service")>()),
  buildTradeReviewSnapshot: async () => ({
    nav: {
      days: state.dates.map((date, i) => ({
        date,
        dailyReturn: { value: i === 1 ? null : 0.01 },
      })),
    },
    replayInput: { nav: { tradingDays: state.dates } },
  }),
}));
vi.mock("../src/server/research-store", () => ({
  ResearchStore: class {
    result() {
      return {
        spec: {
          start: state.dates[0],
          end: state.dates[3],
          validationStart: state.dates[2],
          initialCapital: 100,
        },
        partitions: ["development", "validation"].map((partition, p) => ({
          partition,
          simulation: {
            nav: state.dates
              .slice(p * 2, p * 2 + 2)
              .map((date, i) => ({ date, value: 100 + i, stale: [] })),
          },
        })),
      };
    }
    dataset() {
      return { calendar: state.dates };
    }
  },
}));
import { createCaller } from "../src/server/api/root";

it("both tRPC routes validate and forward window, minPeriods, basis and pagination", async () => {
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
  const research = await caller.strategyResearchRollingPerformance({
    ...params,
    id: "fixture",
    partition: "validation",
  });
  expect(research.rowCount).toBe(2);
  expect(research.rows).toHaveLength(1);
  expect(research.rows[0]).toMatchObject({
    startDate: state.dates[2],
    endDate: state.dates[3],
    tradingDays: 2,
    basis: "simple",
  });
  await expect(
    caller.tradeReviewRollingPerformance({ account: "fixture", pageSize: 101 }),
  ).rejects.toThrow();
  await expect(
    caller.strategyResearchRollingPerformance({
      id: "fixture",
      partition: "development",
      window: 2,
      minPeriods: 3,
    }),
  ).rejects.toThrow("最少日数不能超过窗口");
});
