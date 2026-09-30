import { describe, expect, it } from "vitest";
import { periodReturns, tradeRounds } from "~/lib/backtest/trade-rounds";

const bar = (date: string, high: number, low: number) => ({
  date,
  open: low,
  high,
  low,
  close: high,
  volume: 100,
  amount: 1000,
});
const bars = [
  bar("2026-01-02", 10.5, 9.5),
  bar("2026-01-05", 12, 9), // buy here at 10
  bar("2026-01-06", 13, 8),
  bar("2026-01-07", 11, 10), // sell here at 11
  bar("2026-01-08", 15, 7), // buy at 12, never sold
];

describe("tradeRounds", () => {
  it("pairs buy→sell and measures MFE/MAE over the held bars (hand-checked)", () => {
    const rounds = tradeRounds(
      [
        { date: "2026-01-05", side: "buy", price: 10, shares: 100, fee: 5 },
        { date: "2026-01-07", side: "sell", price: 11, shares: 100, fee: 6 },
        { date: "2026-01-08", side: "buy", price: 12, shares: 100, fee: 5 },
      ],
      bars,
    );
    expect(rounds).toHaveLength(2);
    // Bars 01-05..01-07: high 13, low 8.
    expect(rounds[0]).toMatchObject({
      entryDate: "2026-01-05",
      exitDate: "2026-01-07",
      bars: 3,
    });
    expect(rounds[0]!.mfe).toBeCloseTo(13 / 10 - 1, 12);
    expect(rounds[0]!.mae).toBeCloseTo(8 / 10 - 1, 12);
    // (11×100 − 6) / (10×100 + 5) − 1
    expect(rounds[0]!.netReturn).toBeCloseTo(1094 / 1005 - 1, 12);
    // Still open: runs to the last bar, no exit or return.
    expect(rounds[1]).toMatchObject({
      exitDate: null,
      netReturn: null,
      bars: 1,
    });
    expect(rounds[1]!.mfe).toBeCloseTo(15 / 12 - 1, 12);
    expect(rounds[1]!.mae).toBeCloseTo(7 / 12 - 1, 12);
  });

  it("leaves extremes unknown when a trade date is not among the bars", () => {
    const [round] = tradeRounds(
      [
        { date: "2025-12-31", side: "buy", price: 10, shares: 100, fee: 5 },
        { date: "2026-01-07", side: "sell", price: 11, shares: 100, fee: 6 },
      ],
      bars,
    );
    expect(round).toMatchObject({ mfe: null, mae: null, bars: 0 });
    expect(round!.netReturn).not.toBeNull();
  });
});

describe("periodReturns", () => {
  it("chains each period's last value to the previous period's last value", () => {
    const equity = [
      { date: "2026-01-02", value: 100 },
      { date: "2026-01-30", value: 110 },
      { date: "2026-02-27", value: 99 },
      { date: "2026-04-01", value: 120 },
    ];
    const hold = equity.map((p) => ({ ...p, value: p.value * 2 }));
    const months = periodReturns(equity, hold, "month");
    expect(months.map((m) => m.period)).toEqual([
      "2026-01",
      "2026-02",
      "2026-04",
    ]);
    expect(months[0]!.strategy).toBeCloseTo(0.1, 12);
    expect(months[1]!.strategy).toBeCloseTo(99 / 110 - 1, 12);
    expect(months[2]!.strategy).toBeCloseTo(120 / 99 - 1, 12);
    expect(months[1]!.benchmark).toBeCloseTo(99 / 110 - 1, 12);
    const quarters = periodReturns(equity, undefined, "quarter");
    expect(quarters).toEqual([
      {
        period: "2026Q1",
        strategy: expect.closeTo(-0.01, 12),
        benchmark: null,
      },
      {
        period: "2026Q2",
        strategy: expect.closeTo(120 / 99 - 1, 12),
        benchmark: null,
      },
    ]);
    expect(periodReturns(equity, hold, "year")[0]!.strategy).toBeCloseTo(
      0.2,
      12,
    );
  });
});
