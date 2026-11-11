import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import type { BacktestActions } from "~/server/backtest/backtest-actions";
import {
  portfolioRpsPeriods,
  portfolioRpsDefinitions,
  portfolioRpsFactorMetadata,
  evaluateStrategy,
} from "trading-strategies";
import { rankRps, rpsPeriods } from "quant-rps";
vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/backtest/backtest-actions", () => ({
  readBacktestActions: vi.fn(),
}));
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: vi.fn(),
  readLocalFinancialSeries: vi.fn(),
}));
import { captureStrategyCandidates } from "~/server/strategies/strategy-center-candidates";
import { executeStrategyCenterPortfolio } from "~/server/strategies/strategy-center-portfolio";
function fixture() {
  const dates: string[] = [];
  const d = new Date("2023-01-02T00:00:00Z");
  while (dates.length < 420) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const symbols = Array.from({ length: 12 }, (_, i) => `sh${600000 + i}`);
  const make = (symbol: string, slope: number): Snapshot => ({
    id: symbol,
    symbol,
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 1,
    hash: symbol,
    bars: dates.map((date, i) => {
      const price = 20 + i * slope;
      return {
        date,
        open: price,
        close: price,
        high: price + 0.1,
        low: price - 0.1,
        volume: 1000000,
        amount: 100000000,
      };
    }),
  });
  const sources = new Map(
    [
      make("sh000300", 0.03),
      ...symbols.map((s, i) => make(s, 0.01 * (i + 1))),
    ].map((s) => [s.symbol, s]),
  );
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      sources.get(symbol)!,
    ),
    readLocalFinancialHistory: vi.fn(async () => {
      throw new Error("RPS should not read reports");
    }),
    readLocalFinancialSeries: vi.fn(async () => {
      throw new Error("RPS should not read financial series");
    }),
    readBacktestActions: vi.fn(
      async (source: {
        symbol: string;
        bars: { date: string }[];
      }): Promise<BacktestActions> => ({
        version: "backtest-actions-1",
        status: "partial",
        symbol: source.symbol,
        start: source.bars[0]!.date,
        end: source.bars.at(-1)!.date,
        events: [],
        warnings: [],
      }),
    ),
  };
  return {
    dates,
    symbols,
    sources,
    readers,
    asOf: dates[350]!,
    input: { symbols, start: dates[300]!, end: dates[390]!, initial: 1000000 },
  };
}
it("uses exactly the seven maintained quant-rps periods without creating a strategy-package dependency", () => {
  expect(portfolioRpsPeriods).toEqual(rpsPeriods);
  expect(portfolioRpsDefinitions).toHaveLength(7);
  for (const d of portfolioRpsDefinitions) {
    expect(d.rule).toContain("不代表全市场RPS");
    expect(d.rule).toContain("周期预设");
    expect(d.capabilities).toEqual(["ohlcv", "cross-section"]);
  }
});
it.each(portfolioRpsPeriods)(
  "RPS%i captures real ratio returns and ranks identically to the existing RPS module",
  async (period) => {
    const f = fixture(),
      key = `rpsReturn${period}`,
      id = `portfolio-rps-${period}`;
    const capture = await captureStrategyCandidates(
      { strategyId: id, symbols: f.symbols, asOf: f.asOf },
      "fixture",
      f.readers,
    );
    expect(capture.exclusions).toEqual([]);
    expect(
      portfolioRpsFactorMetadata[
        key as keyof typeof portfolioRpsFactorMetadata
      ],
    ).toMatchObject({ period, unit: "ratio", skip: 0 });
    for (const candidate of capture.candidates) {
      const bars = f.sources.get(candidate.symbol)!.bars;
      expect(candidate.values[key]).toBeCloseTo(
        bars[350]!.close / bars[350 - period]!.close - 1,
        12,
      );
    }
    const expected = rankRps(
      capture.candidates.map((c) => ({
        symbol: c.symbol,
        return: c.values[key]!,
      })),
    );
    const byRps = [...expected]
      .sort((a, b) => b[1].rps - a[1].rps || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([symbol]) => symbol);
    const output = evaluateStrategy(
      { strategyId: id, parameters: { topK: 3 } },
      { asOf: f.asOf, candidates: capture.candidates },
    );
    expect(output).toMatchObject({
      kind: "weights",
      weights: byRps.map((symbol) => ({ symbol, weight: 1 / 3 })),
    });
    expect(f.readers.readLocalFinancialHistory).not.toHaveBeenCalled();
    expect(f.readers.readLocalFinancialSeries).not.toHaveBeenCalled();
  },
);
it("RPS ties share rank, and a zero-volume endpoint or unavailable lookback remains missing", async () => {
  const f = fixture();
  const first = f.sources.get(f.symbols[0]!)!,
    second = f.sources.get(f.symbols[1]!)!;
  second.bars = structuredClone(first.bars);
  const capture = await captureStrategyCandidates(
    {
      strategyId: "portfolio-rps-5",
      symbols: f.symbols.slice(0, 2),
      asOf: f.asOf,
    },
    "fixture",
    f.readers,
  );
  expect(capture.candidates[0]!.values.rpsReturn5).toBe(
    capture.candidates[1]!.values.rpsReturn5,
  );
  const output = evaluateStrategy(
    { strategyId: "portfolio-rps-5", parameters: { topK: 1 } },
    { asOf: f.asOf, candidates: capture.candidates },
  );
  expect(output).toMatchObject({
    weights: [{ symbol: f.symbols[0], weight: 1 }],
  });
  first.bars[345]!.volume = 0;
  const missing = await captureStrategyCandidates(
    { strategyId: "portfolio-rps-5", symbols: [first.symbol], asOf: f.asOf },
    "fixture",
    f.readers,
  );
  expect(missing.candidates[0]!.values.rpsReturn5).toBeNull();
  const insufficient = await captureStrategyCandidates(
    {
      strategyId: "portfolio-rps-120",
      symbols: [second.symbol],
      asOf: f.dates[50]!,
    },
    "fixture",
    f.readers,
  );
  expect(insufficient.candidates[0]!.values.rpsReturn120).toBeNull();
});
it.each(portfolioRpsPeriods)(
  "RPS%i runs the real historical task and is immune to later prices",
  async (period) => {
    const f = fixture();
    const input = { ...f.input, strategyId: `portfolio-rps-${period}` };
    const run = await executeStrategyCenterPortfolio(
      input,
      "fixture",
      f.readers,
    );
    expect(run.quality).toBe("rule-check-only");
    expect(run.result.fills.length).toBeGreaterThan(0);
    expect(Object.keys(run.frozen.schedule[0]!.weights).sort()).toEqual(
      f.symbols.slice(2).sort(),
    );
    for (const fill of run.result.fills) {
      expect(fill.signalDate < fill.date).toBe(true);
      expect(fill.quantity % 100).toBe(0);
    }
    expect(
      run.frozen.decisions.every(
        (d) => d.capture.factors[0] === `rpsReturn${period}`,
      ),
    ).toBe(true);
    for (const source of f.sources.values())
      for (const b of source.bars)
        if (b.date > f.input.end) {
          b.open = 999;
          b.close = 999;
          b.high = 1000;
          b.low = 998;
        }
    const later = await executeStrategyCenterPortfolio(
      input,
      "fixture",
      f.readers,
    );
    expect(later.frozen.schedule).toEqual(run.frozen.schedule);
    expect(later.result).toEqual(run.result);
  },
);
