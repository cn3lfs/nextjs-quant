import { expect, it } from "vitest";
import type { StrategyObjectInput } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";

const main = "sh600001";
function candle(i: number, close: number, fields: Partial<Bar> = {}): Bar {
  const open = fields.open ?? close;
  return {
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open,
    close,
    high: Math.max(open, close) + 0.25,
    low: Math.min(open, close) - 0.25,
    volume: 100,
    amount: close * (fields.volume ?? 100),
    ...fields,
  };
}

function request(
  bars: Bar[],
  start: number,
  symbols = [main],
  methodId = "f11-first-limit-up-break",
): PortfolioRequest {
  const rule = { kind: "theory-screener", methodId } as const;
  const strategy: StrategyObjectInput = {
    id: "test",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols },
    entry: { ...rule, side: "entry" },
    exit: { rule: { ...rule, side: "exit" } },
    sizing: { kind: "weight", weight: 0.2 },
  };
  return {
    market: "cn-equity",
    initial: 100000,
    start: bars[start]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.slice(start).map((b) => b.date),
    strategies: [strategy],
    sleeves: [
      { id: "swing", share: 1, riskPerTrade: 1, maxPositions: symbols.length },
    ],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    instruments: symbols.map((symbol) => ({
      symbol,
      market: "cn-equity",
      bars,
      signalBars: bars,
      execution: {
        evidence: "fixture",
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    })),
    observationDetail: "full",
  };
}

it.each([99, 100])(
  "rejects a buy opening at %i against a rule-supplied box stop of 100",
  (open) => {
    const bars = Array.from({ length: 24 }, (_, i) => candle(i, 105));
    for (const i of [4, 14]) bars[i] = candle(i, 105, { high: 110 });
    for (const i of [8, 18]) bars[i] = candle(i, 105, { low: 100 });
    bars.push(candle(24, 112, { open: 105, volume: 200 }), candle(25, open));
    const input = request(bars, 24);
    input.strategies = [
      {
        ...input.strategies[0]!,
        entry: { kind: "pattern-breakout", patterns: ["box"] },
        exit: {},
      },
    ];
    const result = runPortfolio(input);
    expect(result.observations[0]?.decision).toMatchObject({
      entry: true,
      stopLevel: 100,
    });
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      side: "buy",
      status: "rejected",
      signalAt: bars[24]!.date,
      due: bars[25]!.date,
      reason: "缺失或无效初始止损",
    });
    expect(result.fills).toHaveLength(0);
  },
);

it("holds through a low below the frozen screener stop and sells at the open after a closing breach", () => {
  const bars = Array.from({ length: 80 }, (_, i) =>
    candle(i, 100, { high: 105, low: 95 }),
  );
  bars.push(
    candle(80, 107, { open: 103, high: 108, low: 102, volume: 160 }),
    candle(81, 107),
    candle(82, 105, { low: 99 }),
    candle(83, 99, { open: 105 }),
    candle(84, 97, { open: 98 }),
  );
  const result = runPortfolio(request(bars, 80, [main], "f08-wyckoff-sos-jac"));
  expect(
    result.observations.find((o) => o.date === bars[82]!.date)?.decision.exit,
  ).toBe(false);
  expect(
    result.fills.map((f) => [f.side, f.signalAt, f.date, f.price]),
  ).toEqual([
    ["buy", bars[80]!.date, bars[81]!.date, 107],
    ["sell", bars[83]!.date, bars[84]!.date, 98],
  ]);
});

it("applies the instrument's board limit to a 10% signal in single and multi-symbol replays", () => {
  const bars = Array.from({ length: 42 }, (_, i) =>
    candle(i, i >= 40 ? 11 : 10, { volume: i === 40 ? 200 : 100 }),
  );
  for (const symbol of ["sz300001", "sh688001"]) {
    const single = runPortfolio(request(bars, 40, [symbol]));
    const batch = runPortfolio(request(bars, 40, [symbol, main]));
    expect(single.observations[0]?.decision.entry).toBe(false);
    expect(batch.observations.filter((o) => o.symbol === symbol)).toEqual(
      single.observations,
    );
    expect(single.orders).toHaveLength(0);
    expect(batch.fills.map((f) => [f.symbol, f.side])).toEqual([[main, "buy"]]);
  }
});

it.each([0, 100])(
  "rearms a timed exit only on a known false observation (volume %i)",
  (volume) => {
    const bars = Array.from({ length: 68 }, (_, i) => {
      if (i === 40 || i === 66) return candle(i, 11, { volume: 200 });
      return candle(i, 10, { volume: i === 43 ? volume : 100 });
    });
    const input = request(bars, 40);
    input.strategies = [
      {
        ...input.strategies[0]!,
        exit: {
          maxBars: 1,
          timeReentry: { cooldownBars: 0, requireNewSignal: true },
        },
      },
    ];
    // Between the timed exit and the second breakout, only day 43 is eligible
    // to establish a fresh false observation.
    input.memberships = bars
      .slice(42, 66)
      .filter((b) => b.date !== bars[43]!.date)
      .map((b) => ({
        strategyId: "test",
        date: b.date,
        availableAt: b.date,
        symbols: [],
      }));
    const result = runPortfolio(input);
    const entryAt = (i: number) =>
      result.observations.find((o) => o.date === bars[i]!.date)?.decision.entry;
    expect(entryAt(43)).toBe(volume === 0 ? null : false);
    expect(entryAt(66)).toBe(true);
    expect(result.fills.map((f) => [f.side, f.date])).toEqual([
      ["buy", bars[41]!.date],
      ["sell", bars[42]!.date],
      ...(volume === 0 ? [] : [["buy", bars[67]!.date]]),
    ]);
  },
);
