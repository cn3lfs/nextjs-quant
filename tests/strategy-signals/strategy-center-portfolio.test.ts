import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import type { BacktestActions } from "~/server/backtest/backtest-actions";
import type { FinancialReportSnapshot } from "trading-strategy-core/financial";
import type { LocalFactorSource } from "trading-strategy-core/factors";
vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/backtest/backtest-actions", () => ({
  readBacktestActions: vi.fn(),
}));
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: vi.fn(),
  readLocalFinancialSeries: vi.fn(),
}));
import {
  executeStrategyCenterPortfolio,
  strategyCenterPortfolioSchema,
} from "~/server/strategies/strategy-center-portfolio";
function fixture() {
  const dates: string[] = [];
  const d = new Date("2022-01-03T00:00:00Z");
  while (dates.length < 440) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const source = (symbol: string, k = 1): Snapshot => ({
    id: symbol,
    symbol,
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 1,
    hash: `${symbol}-hash`,
    bars: dates.map((date, i) => ({
      date,
      open: 10 + i * 0.01 * k,
      close: 10.01 + i * 0.01 * k,
      high: 10.1 + i * 0.01 * k,
      low: 9.9 + i * 0.01 * k,
      volume: 1000000,
      amount: 100000000,
    })),
  });
  const benchmark = source("sh000300"),
    stock = source("sh600519", 2),
    second = source("sz000001", 1);
  const sources = new Map([benchmark, stock, second].map((s) => [s.symbol, s]));
  const actions: BacktestActions = {
    version: "backtest-actions-1",
    status: "partial",
    symbol: stock.symbol,
    start: dates[0]!,
    end: dates.at(-1)!,
    events: [],
    warnings: [],
    source: {
      file: "fixture/gbbq",
      modified: 1,
      fetchedAt: 2,
      hash: "actions-hash",
    },
  };
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      sources.get(symbol)!,
    ),
    readBacktestActions: vi.fn(async () => actions),
    readLocalFinancialHistory: vi.fn(async () => ({
      reports: [] as FinancialReportSnapshot[],
    })),
    readLocalFinancialSeries: vi.fn(
      async () =>
        ({
          namespace: "GP",
          filename: "fixture",
          sourceSha256: "series-hash",
          records: [],
        }) as LocalFactorSource,
    ),
  };
  const input = {
    strategyId: "allocation-equal",
    symbols: [stock.symbol, second.symbol],
    start: dates[300]!,
    end: dates[390]!,
    initial: 1000000,
  };
  return { dates, benchmark, stock, second, actions, readers, input };
}
it("validates two-year horizon, real dates, duplicate symbols, capital and asset range", () => {
  const { input } = fixture();
  for (const change of [
    { end: "2026-01-01" },
    { start: "2024-02-30" },
    { end: "2020-01-01" },
    { initial: 0 },
    { symbols: ["sh688001"] },
    { symbols: ["sh600519", "sh600519"] },
    { strategyId: "ma" },
  ])
    expect(
      strategyCenterPortfolioSchema.safeParse({ ...input, ...change }).success,
    ).toBe(false);
});
it("runs weekly shared-cash next-open replay with 50/50 weights and reproducible frozen evidence", async () => {
  const f = fixture();
  const run = await executeStrategyCenterPortfolio(
    f.input,
    "fixture",
    f.readers,
  );
  expect(run.quality).toBe("rule-check-only");
  expect(run.frozen.schedule.length).toBeGreaterThan(10);
  expect(run.frozen.schedule[0]!.weights).toEqual({
    sh600519: 0.5,
    sz000001: 0.5,
  });
  expect(run.result.fills.length).toBeGreaterThan(0);
  for (const fill of run.result.fills)
    expect(fill.date > fill.signalDate).toBe(true);
  expect(run.result.curve.every((day) => day.cash >= -1e-7)).toBe(true);
  expect(f.readers.readSnapshot).toHaveBeenCalledTimes(3);
  expect(f.readers.readBacktestActions).toHaveBeenCalledTimes(2);
  expect(run.frozen.benchmark).toHaveLength(361);
  expect(run.frozen.sources).toHaveLength(2);
  expect(run.frozen.strategyBuildHash).toBeTruthy();
  expect(run.inputHash).toMatch(/^[0-9a-f]{64}$/);
  const replay = await executeStrategyCenterPortfolio(
    f.input,
    "fixture",
    f.readers,
  );
  expect(replay.inputHash).toBe(run.inputHash);
  expect(replay.result).toEqual(run.result);
});
it("uses the calendar's last weekly session including a holiday-shortened week", async () => {
  const f = fixture();
  const holiday = f.dates[314]!;
  expect(new Date(holiday).getUTCDay()).toBe(5);
  for (const source of [f.benchmark, f.stock, f.second])
    source.bars = source.bars.filter((b) => b.date !== holiday);
  const run = await executeStrategyCenterPortfolio(
    f.input,
    "fixture",
    f.readers,
  );
  expect(run.frozen.schedule.some((s) => s.date === f.dates[313])).toBe(true);
  expect(run.frozen.schedule.some((s) => s.date === holiday)).toBe(false);
});
it("does not treat an end-of-window midweek day as a weekly close", async () => {
  const f = fixture();
  const wednesday = f.dates[307]!;
  expect(new Date(wednesday).getUTCDay()).toBe(3);
  const run = await executeStrategyCenterPortfolio(
    { ...f.input, end: wednesday },
    "fixture",
    f.readers,
  );
  expect(run.frozen.schedule.some((s) => s.date === wednesday)).toBe(false);
});
it("ranks from each historical date and ignores later prices", async () => {
  const f = fixture();
  const input = { ...f.input, strategyId: "rank-momentum" };
  const original = await executeStrategyCenterPortfolio(
    input,
    "fixture",
    f.readers,
  );
  for (const b of f.stock.bars.filter((b) => b.date > input.end))
    b.close *= 100;
  const replay = await executeStrategyCenterPortfolio(
    input,
    "fixture",
    f.readers,
  );
  expect(replay.frozen.schedule).toEqual(original.frozen.schedule);
  expect(replay.result).toEqual(original.result);
  expect(original.frozen.decisions[0]!.capture).not.toHaveProperty(
    "benchmarkBars",
  );
  expect(original.frozen.decisions[0]!.capture.evidence[0]).not.toHaveProperty(
    "bars",
  );
  expect(
    original.frozen.decisions[0]!.capture.evidence[0]!.priceRange,
  ).toBeTruthy();
});
it("rejects missing action evidence and all unsupported noncash actions", async () => {
  const f = fixture();
  f.actions.status = "missing";
  await expect(
    executeStrategyCenterPortfolio(f.input, "fixture", f.readers),
  ).rejects.toThrow("公司行动来源缺失");
  f.actions.status = "partial";
  f.actions.events = [
    {
      date: f.input.start,
      category: 1,
      name: "bonus",
      dividend: 0,
      bonusRatio: 0.1,
      rightsRatio: 0,
      rightsPrice: 0,
    },
  ];
  await expect(
    executeStrategyCenterPortfolio(f.input, "fixture", f.readers),
  ).rejects.toThrow("非现金公司行动");
});
it("rejects repaired stock/benchmark inputs and incomplete trading calendars", async () => {
  const f = fixture();
  f.stock.sourceNote = "repaired";
  await expect(
    executeStrategyCenterPortfolio(f.input, "fixture", f.readers),
  ).rejects.toThrow("修复");
  delete f.stock.sourceNote;
  f.stock.bars.splice(320, 1);
  await expect(
    executeStrategyCenterPortfolio(f.input, "fixture", f.readers),
  ).rejects.toThrow("日历不一致");
  f.benchmark.sourceNote = "repaired calendar";
  await expect(
    executeStrategyCenterPortfolio(f.input, "fixture", f.readers),
  ).rejects.toThrow("修复");
});
it("refuses short prehistory and coverage beyond the known benchmark", async () => {
  const f = fixture();
  await expect(
    executeStrategyCenterPortfolio(
      { ...f.input, start: f.dates[100]! },
      "fixture",
      f.readers,
    ),
  ).rejects.toThrow("270");
  await expect(
    executeStrategyCenterPortfolio(
      { ...f.input, end: "2024-01-01" },
      "fixture",
      f.readers,
    ),
  ).rejects.toThrow("基准覆盖");
});

it("checks cancellation before IO and between stock captures", async () => {
  const f = fixture();
  const stopped = new AbortController();
  stopped.abort();
  await expect(
    executeStrategyCenterPortfolio(
      f.input,
      "fixture",
      f.readers,
      stopped.signal,
    ),
  ).rejects.toThrow();
  expect(f.readers.readSnapshot).not.toHaveBeenCalled();
  const mid = new AbortController();
  f.readers.readBacktestActions.mockImplementationOnce(async () => {
    mid.abort();
    return f.actions;
  });
  await expect(
    executeStrategyCenterPortfolio(f.input, "fixture", f.readers, mid.signal),
  ).rejects.toThrow();
  expect(f.readers.readBacktestActions).toHaveBeenCalledTimes(1);
});
