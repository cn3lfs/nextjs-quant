import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import { evaluateStrategy, portfolioRpsPeriods } from "trading-strategies";
vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: vi.fn(),
  readLocalFinancialSeries: vi.fn(),
}));
vi.mock("~/server/backtest/backtest-actions", () => ({
  readBacktestActions: vi.fn(),
}));
import {
  captureStrategyCandidates,
  strategyCenterCandidatesSchema,
} from "~/server/strategies/strategy-center-candidates";
import {
  executeStrategyCenterPortfolio,
  strategyCenterPortfolioSchema,
} from "~/server/strategies/strategy-center-portfolio";

function fixture() {
  const symbols = ["sh510300", "sz159915", "sh600519"];
  const make = (symbol: string, k: number): Snapshot => {
    let close = 20;
    return {
      id: symbol,
      symbol,
      period: "day",
      source: "tdx-local",
      adjustment: "none",
      createdAt: 1,
      hash: `${symbol}-snapshot`,
      bars: Array.from({ length: 320 }, (_, index) => {
        close *=
          1 +
          (k === 0
            ? 0.004 + 0.001 * Math.sin(index * 0.7)
            : k === 1
              ? 0.002 + 0.0003 * Math.cos(index * 0.3)
              : 0.001 + 0.0002 * Math.sin(index * 0.5 + 0.3));
        return {
          date: new Date(Date.UTC(2023, 0, index + 1))
            .toISOString()
            .slice(0, 10),
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          volume: 1000000,
          amount: 100000000,
        };
      }),
    };
  };
  const sources = new Map(
    [make("sh000300", 0), ...symbols.map(make)].map((row) => [row.symbol, row]),
  );
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      sources.get(symbol)!,
    ),
    readLocalFinancialHistory: vi.fn(async () => {
      throw new Error("fund weights must not read company reports");
    }),
    readLocalFinancialSeries: vi.fn(async () => {
      throw new Error("fund weights must not read company market-cap series");
    }),
    readBacktestActions: vi.fn(async () => {
      throw new Error("fund execution must be rejected before action IO");
    }),
  };
  const asOf = sources.get(symbols[0]!)!.bars[280]!.date;
  return { symbols, sources, readers, asOf };
}

it.each(portfolioRpsPeriods)(
  "captures actual mixed fund/stock RPS%d returns and ranks the complete local pool",
  async (period) => {
    const f = fixture(),
      strategyId = `portfolio-rps-${period}`;
    const capture = await captureStrategyCandidates(
      { strategyId, symbols: f.symbols, asOf: f.asOf },
      "fixture",
      f.readers,
    );
    expect(capture.exclusions).toEqual([]);
    expect(capture.candidates).toHaveLength(3);
    for (const candidate of capture.candidates) {
      const bars = f.sources.get(candidate.symbol)!.bars;
      expect(candidate.values[`rpsReturn${period}`]).toBeCloseTo(
        bars[280]!.close / bars[280 - period]!.close - 1,
        12,
      );
    }
    expect(
      evaluateStrategy(
        { strategyId, parameters: { topK: 1 } },
        { asOf: f.asOf, candidates: capture.candidates },
      ),
    ).toMatchObject({
      kind: "weights",
      weights: [{ symbol: "sh510300", weight: 1 }],
    });
    expect(f.readers.readLocalFinancialHistory).not.toHaveBeenCalled();
    expect(f.readers.readLocalFinancialSeries).not.toHaveBeenCalled();
  },
);

it("builds real fund/stock risk-parity weights from 60 aligned returns and ignores future prices", async () => {
  const f = fixture(),
    input = {
      strategyId: "allocation-risk-parity",
      symbols: f.symbols,
      asOf: f.asOf,
    };
  const capture = await captureStrategyCandidates(input, "fixture", f.readers);
  expect(capture.exclusions).toEqual([]);
  expect(capture.candidates).toHaveLength(3);
  for (const candidate of capture.candidates) {
    expect(candidate.returns).toHaveLength(60);
    expect(candidate.returns!.at(-1)!.date).toBe(f.asOf);
    const bars = f.sources.get(candidate.symbol)!.bars;
    expect(candidate.returns![0]!.value).toBeCloseTo(
      bars[221]!.close / bars[220]!.close - 1,
      14,
    );
  }
  const weights = evaluateStrategy(
    { strategyId: input.strategyId },
    { asOf: f.asOf, candidates: capture.candidates },
  );
  if (weights.kind !== "weights") throw new Error("expected weights");
  expect(weights.weights.map((row) => row.symbol).sort()).toEqual(
    [...f.symbols].sort(),
  );
  expect(weights.weights.reduce((sum, row) => sum + row.weight, 0)).toBeCloseTo(
    1,
    12,
  );
  expect(weights.weights.every((row) => row.weight > 0)).toBe(true);
  for (const source of f.sources.values())
    for (const bar of source.bars.slice(281)) bar.close = 999999;
  const future = await captureStrategyCandidates(input, "fixture", f.readers);
  expect(future.candidates).toEqual(capture.candidates);
  expect(
    evaluateStrategy(
      { strategyId: input.strategyId },
      { asOf: f.asOf, candidates: future.candidates },
    ),
  ).toEqual(weights);
  expect(capture.limitations.join(" ")).toContain(
    "历史撮合仍缺品种规则与费用模型",
  );
});

it.each([
  "rank-momentum",
  "rank-low-volatility",
  "rank-low-beta",
  "allocation-equal",
  "allocation-inverse-volatility",
])(
  "allows %s to calculate mixed local weights without company inputs",
  async (strategyId) => {
    const f = fixture();
    const capture = await captureStrategyCandidates(
      { strategyId, symbols: f.symbols, asOf: f.asOf },
      "fixture",
      f.readers,
    );
    expect(capture.exclusions).toEqual([]);
    const result = evaluateStrategy(
      { strategyId },
      { asOf: f.asOf, candidates: capture.candidates },
    );
    if (result.kind !== "weights") throw new Error("expected weights");
    expect(result.weights).toHaveLength(3);
    expect(f.readers.readLocalFinancialHistory).not.toHaveBeenCalled();
    expect(f.readers.readLocalFinancialSeries).not.toHaveBeenCalled();
  },
);

it("uses shared fund kind and exchange identity while retaining duplicate and max6000 guards", () => {
  const f = fixture(),
    input = { strategyId: "portfolio-rps-5", symbols: f.symbols, asOf: f.asOf };
  expect(strategyCenterCandidatesSchema.safeParse(input).success).toBe(true);
  for (const symbols of [
    ["sz510300"],
    ["sh159915"],
    ["sh000001"],
    ["sh110001"],
    ["sz131810"],
    ["bj830001"],
    ["sz184801"],
    ["sh510300", "sh510300"],
    Array.from(
      { length: 6001 },
      (_, index) => `sh60${String(index).padStart(4, "0")}`,
    ),
  ])
    expect(
      strategyCenterCandidatesSchema.safeParse({ ...input, symbols }).success,
    ).toBe(false);
});

it("rejects fund candidates in every company-financial or market-cap recipe before any IO", async () => {
  const f = fixture();
  for (const strategyId of [
    "rank-value",
    "rank-book-value",
    "rank-cashflow",
    "rank-quality",
    "rank-growth",
    "rank-small-cap",
    "rank-quality-momentum",
    "portfolio-gross-profitability",
    "portfolio-cash-accruals",
    "portfolio-conservative-investment",
    "portfolio-profitability-value",
  ]) {
    const input = { strategyId, symbols: f.symbols, asOf: f.asOf };
    const parsed = strategyCenterCandidatesSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues.map((row) => row.message)).toContain(
        "财务或市值策略不支持基金候选",
      );
    await expect(
      captureStrategyCandidates(input, "fixture", f.readers),
    ).rejects.toThrow("不支持基金候选");
  }
  expect(f.readers.readSnapshot).not.toHaveBeenCalled();
  expect(f.readers.readLocalFinancialHistory).not.toHaveBeenCalled();
  expect(f.readers.readLocalFinancialSeries).not.toHaveBeenCalled();
});

it("continues rejecting fund historical execution before applying any stock costs or actions", async () => {
  const f = fixture(),
    input = {
      strategyId: "portfolio-rps-5",
      symbols: f.symbols,
      start: "2023-09-01",
      end: f.asOf,
      initial: 1000000,
    };
  const parsed = strategyCenterPortfolioSchema.safeParse(input);
  expect(parsed.success).toBe(false);
  if (!parsed.success)
    expect(parsed.error.issues.map((row) => row.message)).toContain(
      "当前组合撮合只支持100股整手股票",
    );
  await expect(
    executeStrategyCenterPortfolio(input, "fixture", f.readers),
  ).rejects.toThrow("100股整手股票");
  expect(f.readers.readSnapshot).not.toHaveBeenCalled();
  expect(f.readers.readBacktestActions).not.toHaveBeenCalled();
});
