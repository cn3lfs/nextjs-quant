import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import type {
  TripleScreenInput,
  TripleScreenSeries,
} from "../../trading-strategies/src/theory-multiperiod.js";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";

const time = (minutes: number) =>
  new Date(Date.UTC(2020, 1, 10, 9, 30) + minutes * 60000).toISOString();
function bar(date: string, close: number): Bar {
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10000,
    amount: close * 10000,
  };
}
function series(
  period: TripleScreenSeries["period"],
  slots: TripleScreenSeries["slots"],
): TripleScreenSeries {
  return {
    period,
    sourceHash: "portfolio-fixture",
    adjustmentId: "raw",
    calendarHash: "crypto-calendar",
    slots,
  };
}
function request(blocked = false): PortfolioRequest {
  const bars = [
    18, 20, 21, 21, 16, 16, 22, 22, 22, 22, 22, 22, 17, 20, 21, 21,
  ].map((close, i) => bar(time(i * 5), close));
  const input: TripleScreenInput = {
    market: "crypto",
    variant: "day-hour-five",
    tick: 0.01,
    background: series(
      "day",
      Array.from({ length: 40 }, (_, i) => {
        const date = new Date(Date.UTC(2020, 0, i + 1))
          .toISOString()
          .slice(0, 10);
        return {
          bar: bar(date, 100 + i * i),
          availableAt: new Date(Date.UTC(2020, 0, i + 2)).toISOString(),
        };
      }),
    ),
    setup: series(
      "60m",
      [20, 19, 18, 17].map((close, i) => ({
        bar: bar(time((i - 2) * 60), close),
        availableAt: time((i - 2) * 60),
      })),
    ),
    execution: series(
      "5m",
      bars.map((b) => ({ bar: b, availableAt: b.date, priceScale: 1 })),
    ),
  };
  return {
    market: "crypto",
    initial: 100000,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map((b) => b.date),
    strategies: [
      {
        id: "triple-fill",
        version: 1,
        market: "crypto",
        period: "5m",
        universe: { kind: "symbols", symbols: ["BTCUSDT"] },
        entry: {
          kind: "triple-screen",
          variant: "day-hour-five",
          side: "entry",
        },
        exit: {
          rule: {
            kind: "triple-screen",
            variant: "day-hour-five",
            side: "exit",
          },
        },
        sizing: { kind: "weight", weight: 0.1 },
        sleeve: "swing",
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        external: { tripleScreen: input },
        execution: (b) => ({
          minimum: 0.001,
          step: 0.001,
          maximum: 1000000,
          evidence: "fixture",
          tradable: !blocked || (b?.date !== time(10) && b?.date !== time(25)),
          limitUp: null,
          limitDown: null,
        }),
      },
    ],
  };
}

describe("triple screen actual portfolio state", () => {
  it("rejects a buy without inventing a position, retries from a new completed signal and retains blocked exit", () => {
    const result = runPortfolio(request(true));
    expect(result.orders[0]).toMatchObject({
      side: "buy",
      signalAt: time(5),
      status: "rejected",
      attempts: 1,
    });
    expect(result.fills).toHaveLength(3);
    expect(result.fills[0]).toMatchObject({
      side: "buy",
      signalAt: time(10),
      date: time(15),
    });
    expect(result.fills[1]).toMatchObject({
      side: "sell",
      signalAt: time(20),
      date: time(30),
      holdingAfter: 0,
    });
    expect(result.orders.find((order) => order.side === "sell")).toMatchObject({
      signalAt: time(20),
      status: "filled",
      attempts: 2,
    });
    // The old negative-force preparation remains observable after sale but is not reusable.
    expect(result.fills[2]).toMatchObject({
      side: "buy",
      signalAt: time(65),
      date: time(70),
    });
    expect(result.orders.filter((order) => order.side === "buy")).toHaveLength(
      3,
    );
  });
  it("records last actual full exit and requires a new completed setup before reentry", () => {
    const result = runPortfolio(request());
    expect(result.fills.map((fill) => [fill.side, fill.date])).toEqual([
      ["buy", time(10)],
      ["sell", time(25)],
      ["buy", time(70)],
    ]);
    expect(result.orders.filter((order) => order.side === "buy")).toHaveLength(
      2,
    );
  });
  it("future replay extension preserves the earlier completed fills and orders", () => {
    const full = request(true);
    const end = time(45);
    const prefix = {
      ...full,
      end,
      calendar: full.calendar.filter((date) => date <= end),
      instruments: full.instruments.map((instrument) => {
        const input = instrument.external!.tripleScreen!;
        const trim = (s: TripleScreenSeries): TripleScreenSeries => ({
          ...s,
          slots: s.slots.filter((slot) => slot.availableAt <= end),
        });
        return {
          ...instrument,
          bars: instrument.bars.filter((b) => b.date <= end),
          signalBars: instrument.signalBars.filter((b) => b.date <= end),
          external: {
            tripleScreen: {
              ...input,
              execution: trim(input.execution),
              setup: trim(input.setup),
              background: trim(input.background),
            },
          },
        };
      }),
    };
    const a = runPortfolio(prefix),
      b = runPortfolio(full);
    expect(a.fills).toEqual(b.fills.filter((fill) => fill.date <= end));
    expect(a.orders).toEqual(b.orders.filter((order) => order.signalAt <= end));
  });
});
