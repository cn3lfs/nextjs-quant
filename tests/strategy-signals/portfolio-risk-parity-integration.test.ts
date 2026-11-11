import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import type { BacktestActions } from "~/server/backtest/backtest-actions";
import {
  evaluateStrategy,
  riskParityPeriod,
  riskParityRidge,
} from "trading-strategies";
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
  const day = new Date("2022-01-03T00:00:00Z");
  while (dates.length < 420) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const symbols = ["sh600000", "sh600001", "sz000001"];
  const make = (symbol: string, k: number): Snapshot => {
    let close = 20;
    return {
      id: symbol,
      symbol,
      period: "day",
      source: "tdx-local",
      adjustment: "none",
      createdAt: 1,
      hash: symbol,
      bars: dates.map((date, i) => {
        close *=
          1 +
          (k === 0
            ? 0.001 + 0.01 * Math.sin(i * 0.7)
            : k === 1
              ? 0.002 + 0.02 * Math.cos(i * 0.3)
              : 0.001 + 0.015 * Math.sin(i * 0.7 + 0.3));
        return {
          date,
          open: close,
          close,
          high: close * 1.01,
          low: close * 0.99,
          volume: 1000000,
          amount: 100000000,
        };
      }),
    };
  };
  const sources = new Map(
    [make("sh000300", 0), ...symbols.map((s, i) => make(s, i))].map((s) => [
      s.symbol,
      s,
    ]),
  );
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      sources.get(symbol)!,
    ),
    readLocalFinancialHistory: vi.fn(async () => {
      throw new Error("risk parity should not read reports");
    }),
    readLocalFinancialSeries: vi.fn(async () => {
      throw new Error("risk parity should not read series");
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
    input: {
      strategyId: "allocation-risk-parity",
      symbols,
      start: dates[300]!,
      end: dates[390]!,
      initial: 1000000,
    },
  };
}
it("captures exactly60aligned simple ratio returns from61past closes, without extra source IO", async () => {
  const f = fixture();
  const capture = await captureStrategyCandidates(
    { ...f.input, asOf: f.asOf },
    "fixture",
    f.readers,
  );
  expect(capture.exclusions).toEqual([]);
  expect(capture.candidates).toHaveLength(3);
  expect(f.readers.readSnapshot).toHaveBeenCalledTimes(4);
  for (const candidate of capture.candidates) {
    const series = candidate.returns!;
    expect(series).toHaveLength(riskParityPeriod);
    expect(series[0]!.date).toBe(f.dates[291]);
    expect(series.at(-1)!.date).toBe(f.asOf);
    const bars = f.sources.get(candidate.symbol)!.bars;
    for (let i = 0; i < 60; i++)
      expect(series[i]!.value).toBeCloseTo(
        bars[291 + i]!.close / bars[290 + i]!.close - 1,
        14,
      );
    const mean = series.reduce((sum, r) => sum + r.value, 0) / 60;
    const deviation = Math.sqrt(
      series.reduce((sum, r) => sum + (r.value - mean) ** 2, 0) / 59,
    );
    expect(candidate.values.volatility).toBeCloseTo(deviation, 12);
  }
  const output = evaluateStrategy(
    { strategyId: f.input.strategyId },
    { asOf: f.asOf, candidates: capture.candidates },
  );
  if (output.kind !== "weights") throw new Error("weights required");
  const rows = output.weights.map(
    (w) => capture.candidates.find((c) => c.symbol === w.symbol)!.returns!,
  );
  const means = rows.map(
    (series) => series.reduce((sum, r) => sum + r.value, 0) / 60,
  );
  const covariance = rows.map((a, i) =>
    rows.map(
      (b, j) =>
        a.reduce(
          (sum, r, k) =>
            sum + (r.value - means[i]!) * (b[k]!.value - means[j]!),
          0,
        ) / 59,
    ),
  );
  const ridge =
    (covariance.reduce((sum, r, i) => sum + r[i]!, 0) / 3) * riskParityRidge;
  for (let i = 0; i < 3; i++) covariance[i]![i]! += ridge;
  const contributions = output.weights.map(
    (w, i) =>
      w.weight *
      covariance[i]!.reduce(
        (sum, c, j) => sum + c * output.weights[j]!.weight,
        0,
      ),
  );
  const total = contributions.reduce((sum, value) => sum + value, 0);
  for (const contribution of contributions)
    expect(contribution / total).toBeCloseTo(1 / 3, 6);
  const inverse = capture.candidates.map((c) => 1 / c.values.volatility!),
    denominator = inverse.reduce((sum, v) => sum + v, 0);
  expect(
    output.weights.some(
      (w) =>
        Math.abs(
          w.weight -
            inverse[
              capture.candidates.findIndex((c) => c.symbol === w.symbol)
            ]! /
              denominator,
        ) > 0.001,
    ),
  ).toBe(true);
});
it("risk parity executes the real historical shared-cash task and ignores later prices", async () => {
  const f = fixture();
  const run = await executeStrategyCenterPortfolio(
    f.input,
    "fixture",
    f.readers,
  );
  expect(run.quality).toBe("rule-check-only");
  expect(run.result.fills.length).toBeGreaterThan(0);
  expect(f.readers.readSnapshot).toHaveBeenCalledTimes(4);
  expect(
    run.frozen.decisions.every((d) =>
      d.capture.candidates.every(
        (c) => c.returns?.length === 60 && c.returns.at(-1)!.date === d.date,
      ),
    ),
  ).toBe(true);
  for (const schedule of run.frozen.schedule) {
    expect(Object.keys(schedule.weights).sort()).toEqual([...f.symbols].sort());
    expect(
      Object.values(schedule.weights).reduce((a, b) => a + b, 0),
    ).toBeCloseTo(1, 12);
  }
  for (const fill of run.result.fills) {
    expect(fill.signalDate < fill.date).toBe(true);
    expect(fill.quantity % 100).toBe(0);
  }
  expect(run.result.curve.every((row) => row.cash >= -1e-7)).toBe(true);
  for (const source of f.sources.values())
    for (const bar of source.bars)
      if (bar.date > f.input.end) {
        bar.open = 1000;
        bar.close = 1000;
        bar.high = 1001;
        bar.low = 999;
      }
  const later = await executeStrategyCenterPortfolio(
    f.input,
    "fixture",
    f.readers,
  );
  expect(later.frozen.schedule).toEqual(run.frozen.schedule);
  expect(later.result).toEqual(run.result);
});
it("missing or short observations do not manufacture aligned covariance samples", async () => {
  const f = fixture();
  const stock = f.sources.get(f.symbols[0]!)!;
  stock.bars.splice(330, 1);
  const missing = await captureStrategyCandidates(
    { ...f.input, symbols: [stock.symbol], asOf: f.asOf },
    "fixture",
    f.readers,
  );
  expect(missing.candidates).toEqual([]);
  expect(missing.exclusions[0]!.reason).toContain("日历不一致");
  stock.bars = stock.bars.filter((bar) => bar.date >= f.dates[330]!);
  const short = await captureStrategyCandidates(
    { ...f.input, symbols: [stock.symbol], asOf: f.asOf },
    "fixture",
    f.readers,
  );
  expect(short.candidates).toEqual([]);
  expect(short.exclusions[0]!.reason).toContain("61");
});
