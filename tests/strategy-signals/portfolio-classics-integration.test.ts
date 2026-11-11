import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import type { BacktestActions } from "~/server/backtest/backtest-actions";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import type { LocalFactorSource } from "trading-strategy-core/factors";
import {
  evaluateStrategy,
  portfolioClassicIds,
  type PortfolioClassicId,
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
function report(
  symbol: string,
  date: string,
  announcement: string,
  availableFrom: string,
  values: Record<number, number>,
): FinancialReportSnapshot {
  const raw = new Array<number>(658).fill(0);
  for (const [id, value] of Object.entries(values)) raw[Number(id) - 1] = value;
  return {
    symbol,
    reportDate: date,
    announcementDate: announcement,
    availableFrom,
    financialCompany: false,
    sourceFilename: `gpcw${date}.dat`,
    sourceSha256: `${symbol}:${date}`,
    contentSha256: `${symbol}:${date}`,
    recordOffset: 1,
    mappingVersion: financialMappingVersion,
    fields: projectFinancialFields(raw, false),
    warnings: [],
  };
}
function fixture() {
  const dates: string[] = [];
  const day = new Date("2023-01-02T00:00:00Z");
  while (day.toISOString().slice(0, 10) <= "2024-09-30") {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const symbols = Array.from({ length: 12 }, (_, i) => `sh${600000 + i}`);
  const snapshot = (symbol: string, k: number): Snapshot => ({
    id: symbol,
    symbol,
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 1,
    hash: `${symbol}-bars`,
    bars: dates.map((date, i) => {
      const price = 20 + 0.02 * i + 0.5 * Math.sin(i / 9) * (1 + k * 0.1);
      return {
        date,
        open: price,
        close: price + 0.01,
        high: price + 0.1,
        low: price - 0.1,
        volume: 1000000,
        amount: 100000000,
      };
    }),
  });
  const sources = new Map(
    [snapshot("sh000300", 0), ...symbols.map((s, i) => snapshot(s, i))].map(
      (s) => [s.symbol, s],
    ),
  );
  const histories = new Map(
    symbols.map((symbol, i) => [
      symbol,
      [
        report(symbol, "2024-06-30", "2024-08-30", "2024-09-02", {
          40: 999999,
          74: 999999,
          75: 1,
          95: 999999,
          96: 999999,
          107: 999999,
          271: 999999,
        }),
        report(symbol, "2024-03-31", "2024-04-30", "2024-05-06", {
          40: 1500,
          74: 300,
          75: 150,
          95: 40,
          96: 36,
          107: 100 + i * 20,
          271: 500 + i * 20,
        }),
        report(symbol, "2023-12-31", "2024-04-01", "2024-04-02", {
          40: 1000,
          74: 1000,
          75: 800 - i * 20,
          95: 100,
          96: 90,
          107: 200,
          271: 450 + i * 20,
        }),
        report(symbol, "2023-03-31", "2023-04-28", "2023-05-04", {
          40: 1000 + i * 10,
          74: 200,
          75: 150,
          95: 20,
          96: 18,
          107: 80,
          271: 400 + i * 20,
        }),
      ],
    ]),
  );
  const series = new Map(
    symbols.map((symbol) => [
      symbol,
      {
        namespace: "GP" as const,
        filename: `gp${symbol}.dat`,
        sourceSha256: `${symbol}-series`,
        records: dates.map((date, offset) => ({
          group: 16,
          date: Number(date.replaceAll("-", "")),
          values: [100, 0] as [number, number],
          offset: offset * 13,
        })),
      } satisfies LocalFactorSource,
    ]),
  );
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      sources.get(symbol)!,
    ),
    // Deliberately return later reports as well: the real adapter must enforce its own PIT check.
    readLocalFinancialHistory: vi.fn(
      async (
        _root: string,
        symbol: string,
        _options: { asOf: string; strict: true; limit: number },
      ) => ({ reports: histories.get(symbol)! }),
    ),
    readLocalFinancialSeries: vi.fn(async (_root: string, symbol: string) =>
      series.get(symbol)!,
    ),
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
        source: {
          file: "fixture/gbbq",
          modified: 1,
          fetchedAt: 2,
          hash: "actions-hash",
        },
      }),
    ),
  };
  return {
    symbols,
    dates,
    sources,
    histories,
    series,
    readers,
    input: {
      symbols,
      start: "2024-05-06",
      end: "2024-06-28",
      initial: 1000000,
    },
    asOf: "2024-05-10",
  };
}
function changeField(
  report: FinancialReportSnapshot,
  id: number,
  value: number | null,
) {
  report.fields = report.fields.map((field) =>
    field.code === `FN${id}`
      ? {
          ...field,
          raw: value,
          value,
          status: value === null ? "missing" : "value",
          reason: value === null ? "missing fixture" : null,
        }
      : field,
  );
}
it("real candidate intake computes exact financial ratios and freezes their underlying field evidence", async () => {
  const f = fixture();
  const expected: Record<PortfolioClassicId, Record<string, number>> = {
    "portfolio-gross-profitability": { grossProfitability: 0.2 },
    "portfolio-cash-accruals": { cashAccrualQuality: 100 / 1500 },
    "portfolio-conservative-investment": { assetGrowth: 0.5 },
    "portfolio-profitability-value": {
      grossProfitability: 0.2,
      bookToPrice: 500 / 1000000,
    },
  };
  for (const id of portfolioClassicIds) {
    const capture = await captureStrategyCandidates(
      { strategyId: id, symbols: f.symbols, asOf: f.asOf },
      "fixture",
      f.readers,
    );
    expect(capture.exclusions).toEqual([]);
    expect(capture.candidates).toHaveLength(12);
    for (const [key, value] of Object.entries(expected[id]))
      expect(capture.candidates[0]!.values[key]).toBeCloseTo(value, 12);
    const output = evaluateStrategy(
      { strategyId: id, parameters: { topK: 1 } },
      { asOf: f.asOf, candidates: capture.candidates },
    );
    expect(output).toMatchObject({
      kind: "weights",
      weights: [{ symbol: f.symbols[11], weight: 1 }],
    });
    const reports = capture.evidence[0]!.reportInputs!;
    expect(reports.some((r) => r.reportDate === "2024-06-30")).toBe(false);
    const fields = new Set(
      reports.flatMap((r) => r.fields.map((field) => field.code)),
    );
    for (const code of ["FN40", "FN74", "FN75", "FN95", "FN107", "FN271"])
      expect(fields.has(code)).toBe(true);
    expect(
      f.readers.readLocalFinancialHistory.mock.calls.every(
        ([, , options]) => options.strict && options.asOf === f.asOf,
      ),
    ).toBe(true);
  }
});
it("normalizes all three valuation percentages to ratio while preserving raw source evidence", async () => {
  const f = fixture();
  const symbol = f.symbols[0]!;
  for (const [strategyId, key, value] of [
    ["rank-value", "earningsYield", 108 / 1000000],
    ["rank-book-value", "bookToPrice", 500 / 1000000],
    ["rank-cashflow", "cashflowYield", 220 / 1000000],
  ] as const) {
    const capture = await captureStrategyCandidates(
      { strategyId, symbols: [symbol], asOf: f.asOf },
      "fixture",
      f.readers,
    );
    expect(capture.candidates[0]!.values[key]).toBeCloseTo(value, 12);
    const evidence = capture.evidence[0]!.factorEvidence as {
      unit: string;
      value: number;
    }[];
    expect(evidence[0]!.unit).toBe("%");
    expect(evidence[0]!.value / 100).toBeCloseTo(value, 12);
  }
  const growth = await captureStrategyCandidates(
    { strategyId: "rank-growth", symbols: [symbol], asOf: f.asOf },
    "fixture",
    f.readers,
  );
  expect(growth.candidates[0]!.values.profitGrowth).toBeCloseTo(1, 12);
});
it("inverse-volatility consumers preserve target weights under common percent-to-ratio scaling", async () => {
  const f = fixture();
  const capture = await captureStrategyCandidates(
    {
      strategyId: "allocation-inverse-volatility",
      symbols: f.symbols,
      asOf: f.asOf,
    },
    "fixture",
    f.readers,
  );
  const output = evaluateStrategy(
    { strategyId: "allocation-inverse-volatility" },
    { asOf: f.asOf, candidates: capture.candidates },
  );
  const legacyScaled = capture.candidates.map((c) => ({
    ...c,
    values: { ...c.values, volatility: c.values.volatility! * 100 },
  }));
  const legacy = evaluateStrategy(
    { strategyId: "allocation-inverse-volatility" },
    { asOf: f.asOf, candidates: legacyScaled },
  );
  if (output.kind !== "weights" || legacy.kind !== "weights")
    throw new Error("weights required");
  for (let i = 0; i < output.weights.length; i++)
    expect(output.weights[i]!.weight).toBeCloseTo(
      legacy.weights[i]!.weight,
      12,
    );
  expect(
    capture.candidates.every(
      (c) => c.values.volatility! > 0 && c.values.volatility! < 0.01,
    ),
  ).toBe(true);
});
it("real source adaptation excludes current zero/negative assets and keeps genuine contraction", async () => {
  const f = fixture(),
    symbol = f.symbols[0]!;
  const latest = f.histories.get(symbol)![1]!;
  for (const asset of [0, -10]) {
    changeField(latest, 40, asset);
    const capture = await captureStrategyCandidates(
      {
        strategyId: "portfolio-conservative-investment",
        symbols: [symbol],
        asOf: f.asOf,
      },
      "fixture",
      f.readers,
    );
    expect(capture.candidates[0]!.values.assetGrowth).toBeNull();
    expect(capture.exclusions[0]!.reason).toContain("assetGrowth");
  }
  changeField(latest, 40, 900);
  expect(
    (
      await captureStrategyCandidates(
        {
          strategyId: "portfolio-conservative-investment",
          symbols: [symbol],
          asOf: f.asOf,
        },
        "fixture",
        f.readers,
      )
    ).candidates[0]!.values.assetGrowth,
  ).toBeCloseTo(-0.1, 12);
});
it("missing gross costs and cash TTM inputs remain unavailable and future disclosures never fill them", async () => {
  const f = fixture(),
    symbol = f.symbols[0]!;
  const records = f.histories.get(symbol)!;
  changeField(records[2]!, 75, null);
  const gross = await captureStrategyCandidates(
    {
      strategyId: "portfolio-gross-profitability",
      symbols: [symbol],
      asOf: f.asOf,
    },
    "fixture",
    f.readers,
  );
  expect(gross.candidates[0]!.values.grossProfitability).toBeNull();
  changeField(records[3]!, 95, null);
  const cash = await captureStrategyCandidates(
    { strategyId: "portfolio-cash-accruals", symbols: [symbol], asOf: f.asOf },
    "fixture",
    f.readers,
  );
  expect(cash.candidates[0]!.values.cashAccrualQuality).toBeNull();
  expect(
    cash.evidence[0]!.reportInputs!.map((r) => r.reportDate),
  ).not.toContain("2024-06-30");
});
it.each(portfolioClassicIds)(
  "%s executes real weekly shared-cash replay with PIT financial evidence",
  async (strategyId) => {
    const f = fixture();
    const run = await executeStrategyCenterPortfolio(
      { ...f.input, strategyId },
      "fixture",
      f.readers,
    );
    expect(run.quality).toBe("rule-check-only");
    expect(run.frozen.schedule.length).toBeGreaterThan(5);
    const selected = f.symbols.slice(2);
    expect(Object.keys(run.frozen.schedule[0]!.weights).sort()).toEqual(
      [...selected].sort(),
    );
    expect(
      Object.values(run.frozen.schedule[0]!.weights).every((w) => w === 0.1),
    ).toBe(true);
    expect(run.result.fills.length).toBeGreaterThan(0);
    expect(
      new Set(
        run.result.fills
          .filter((fill) => fill.side === "buy")
          .map((fill) => fill.symbol),
      ),
    ).toEqual(new Set(selected));
    for (const fill of run.result.fills) {
      expect(fill.signalDate < fill.date).toBe(true);
      expect(fill.quantity % 100).toBe(0);
    }
    expect(run.result.curve.every((point) => point.cash >= -1e-7)).toBe(true);
    const archived = Object.values(run.frozen.reportArchive);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((r) => r.reportDate < "2024-06-30")).toBe(true);
    expect(
      run.frozen.decisions.every((d) =>
        d.capture.evidence.every((e) => e.reportRefs.length === 3),
      ),
    ).toBe(true);
    for (const code of ["FN40", "FN74", "FN75", "FN95", "FN107", "FN271"])
      expect(
        archived.some((r) => r.fields.some((field) => field.code === code)),
      ).toBe(true);
    expect(run.inputHash).toBe(
      createHash("sha256").update(JSON.stringify(run.frozen)).digest("hex"),
    );
    for (const records of f.histories.values())
      for (const field of records[0]!.fields)
        if (field.status === "value") field.value = 999999999;
    const unchanged = await executeStrategyCenterPortfolio(
      { ...f.input, strategyId },
      "fixture",
      f.readers,
    );
    expect(unchanged.frozen.schedule).toEqual(run.frozen.schedule);
    expect(unchanged.result).toEqual(run.result);
    expect(unchanged.inputHash).toBe(run.inputHash);
    expect(
      f.readers.readLocalFinancialHistory.mock.calls.every(
        ([, , options]) =>
          options.strict &&
          options.asOf >= f.input.start &&
          options.asOf <= f.input.end,
      ),
    ).toBe(true);
  },
);
