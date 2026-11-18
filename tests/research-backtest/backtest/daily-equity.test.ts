import { describe, expect, it } from "vitest";
import { dailyEquity } from "~/lib/backtest/daily-equity";

describe("daily performance observations from intraday equity", () => {
  it("assigns UTC midnight closing candles to the preceding session", () => {
    expect(
      dailyEquity([
        { date: "2026-11-16T23:55:00Z", equity: 100 },
        { date: "2026-11-17T00:00:00+00:00", equity: 110 },
        { date: "2026-11-17T00:05:00Z", equity: 105 },
      ]),
    ).toEqual([
      { date: "2026-11-16", value: 110 },
      { date: "2026-11-17", value: 105 },
    ]);
  });
  it("takes the last mark per exchange-labelled day", () => {
    expect(
      dailyEquity([
        { date: "2026-11-16T09:35:00+08:00", equity: 100 },
        { date: "2026-11-16T15:00:00+08:00", equity: 110 },
        { date: "2026-11-17T15:00:00+08:00", equity: 105 },
      ]),
    ).toEqual([
      { date: "2026-11-16", value: 110 },
      { date: "2026-11-17", value: 105 },
    ]);
  });
  it("preserves daily observations and rejects an out-of-order sequence", () => {
    expect(dailyEquity([{ date: "2026-11-16", equity: 100 }])).toEqual([
      { date: "2026-11-16", value: 100 },
    ]);
    expect(() =>
      dailyEquity([
        { date: "2026-11-17", equity: 100 },
        { date: "2026-11-16", equity: 110 },
      ]),
    ).toThrow("ordered");
  });
});
