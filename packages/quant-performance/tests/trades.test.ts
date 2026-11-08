import { expect, it } from "vitest";
import {
  pairPositionCycles,
  evaluateTrades,
  createPerformanceReport,
  queryPerformanceReport,
  type TradeFill,
  type TradeCycle,
} from "../src/index.js";
const fill = (
  date: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
  fee = 1,
  symbol = "A",
): TradeFill => ({ date, symbol, side, quantity, price, fee });
it("pairs additions and trims as one cycle and excludes open partial profits", () => {
  const fills = [
    fill("2025-01-02", "buy", 100, 10),
    fill("2025-01-03", "buy", 100, 12),
    fill("2025-01-06", "sell", 50, 15),
    fill("2025-01-07", "sell", 150, 11),
    fill("2025-01-08", "buy", 100, 10),
    fill("2025-01-09", "sell", 50, 12),
  ];
  const before = structuredClone(fills),
    cycles = pairPositionCycles(fills),
    r = evaluateTrades(cycles);
  expect(cycles).toHaveLength(2);
  expect(cycles[0]!.netPnl).toBe(196);
  expect(cycles[1]!.netPnl).toBeNull();
  expect(fills).toEqual(before);
  expect(r).toMatchObject({ closedTrades: 1, openTrades: 1, winningTrades: 1 });
  expect(r.averageWin.value).toBe(196);
  expect(r.averageLoss.value).toBeNull();
  expect(r.profitFactor.value).toBeNull();
});
it("applies dividend, bonus and funded rights before same-day fills without granting entry-date distributions", () => {
  const actions = [
    { date: "2025-01-02", symbol: "A", dividend: 9, bonus: 0 },
    {
      date: "2025-01-03",
      symbol: "A",
      dividend: 1,
      bonus: 0.1,
      rights: 0.1,
      rightsPrice: 5,
    },
  ];
  const cycles = pairPositionCycles(
    [fill("2025-01-02", "buy", 100, 10), fill("2025-01-03", "sell", 120, 10)],
    actions,
  );
  // -1001 +100 dividend -50 subscription +1200 sale -1 fee.
  expect(cycles[0]!.netPnl).toBe(248);
});
it("separates symbols and repeated same-day cycles without mixing cash flows", () => {
  const r = pairPositionCycles([
    fill("2025-01-02", "buy", 1, 10, 0),
    fill("2025-01-02", "buy", 1, 20, 0, "B"),
    fill("2025-01-03", "sell", 1, 12, 0),
    fill("2025-01-03", "buy", 1, 15, 0),
    fill("2025-01-03", "sell", 1, 10, 0),
    fill("2025-01-03", "sell", 1, 25, 0, "B"),
  ]);
  expect(r.map((t) => t.netPnl)).toEqual([2, 5, -5]);
  expect(new Set(r.map((t) => t.id)).size).toBe(3);
});
it("distinguishes payoff ratio, profit factor and a win rate including flat outcomes", () => {
  const cycles = [100, 300, -50, 0].map((netPnl, i) => ({
    id: String(i),
    symbol: "A",
    openedAt: "2025-01-02",
    closedAt: "2025-01-03",
    netPnl,
  }));
  const r = evaluateTrades(cycles);
  expect(r.averageWin.value).toBe(200);
  expect(r.averageLoss.value).toBe(50);
  expect(r.payoffRatio.value).toBe(4);
  expect(r.profitFactor.value).toBe(8);
  expect(r.winRate.value).toBe(0.5);
  expect(r.expectancy.value).toBe(87.5);
});
it("keeps missing ratios explicit for empty, all losing and flat samples", () => {
  expect(evaluateTrades([]).winRate).toMatchObject({ value: null });
  const cycle: TradeCycle = {
    id: "1",
    symbol: "A",
    openedAt: "2025-01-02",
    closedAt: "2025-01-03",
    netPnl: -1,
  };
  const losing = evaluateTrades([cycle]);
  expect(losing.winRate.value).toBe(0);
  expect(losing.profitFactor.value).toBe(0);
  expect(losing.payoffRatio.value).toBeNull();
  const flat = evaluateTrades([{ ...cycle, netPnl: 1e-10 }]);
  expect(flat.flatTrades).toBe(1);
  expect(flat.winRate.value).toBe(0);
  expect(flat.averageWin.value).toBeNull();
});
it("rejects oversells, reversed dates, invalid costs, duplicate identities and fabricated open profits", () => {
  expect(() => pairPositionCycles([fill("2025-01-02", "sell", 1, 10)])).toThrow(
    "超过",
  );
  expect(() =>
    pairPositionCycles([
      fill("2025-01-03", "buy", 1, 10),
      fill("2025-01-02", "sell", 1, 12),
    ]),
  ).toThrow("顺序");
  expect(() =>
    pairPositionCycles([fill("2025-01-02", "buy", 1, 10, -1)]),
  ).toThrow("费用");
  expect(() =>
    pairPositionCycles(
      [fill("2025-01-02", "buy", 1, 10)],
      [{ date: "2025-01-03", symbol: "A", dividend: 0, bonus: 0, rights: 0.1 }],
    ),
  ).toThrow("公司行动");
  const cycle: TradeCycle = {
    id: "1",
    symbol: "A",
    openedAt: "2025-01-02",
    closedAt: null,
    netPnl: null,
  };
  expect(() => evaluateTrades([cycle, cycle])).toThrow("唯一性");
  expect(() => evaluateTrades([{ ...cycle, netPnl: 100 }])).toThrow("未平仓");
  expect(() =>
    evaluateTrades([{ ...cycle, closedAt: "2025-01-03", netPnl: NaN }]),
  ).toThrow("净损益");
});
it("adds versioned trade statistics to reports and distinguishes absent evidence from zero trades", () => {
  const points = [{ date: "2025-01-03", value: 100 }];
  expect(createPerformanceReport(100, points).trades).toBeNull();
  const report = createPerformanceReport(100, points, []);
  expect(report.version).toBe("performance-report-v2");
  expect(report.trades!.closedTrades).toBe(0);
  expect(
    queryPerformanceReport(100, points, { frequency: "year" }, []).trades!
      .winRate.value,
  ).toBeNull();
});
