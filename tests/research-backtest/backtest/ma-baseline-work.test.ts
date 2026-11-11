import { beforeEach, expect, it, vi } from "vitest";
vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/data-sources/tdx/tdx-benchmark", () => ({
  readBenchmarkSnapshot: vi.fn(),
}));
vi.mock("~/server/backtest/backtest-actions", () => ({
  readBacktestActions: vi.fn(),
}));
import { readSnapshot } from "~/server/data-sources/tdx/tdx";
import { readBenchmarkSnapshot } from "~/server/data-sources/tdx/tdx-benchmark";
import { readBacktestActions } from "~/server/backtest/backtest-actions";
import { executeMaBaseline } from "~/server/backtest/ma-baseline-work";
import { maBaselineInputSchema } from "~/lib/backtest/ma-baseline";
import type { Snapshot } from "~/lib/domain";
import { factorStrategyPresets, factorStrategySchema } from "trading-strategies";

const source: Snapshot = {
  id: "fixture",
  symbol: "sh600519",
  period: "5m",
  source: "tdx-local",
  adjustment: "none",
  hash: "file-hash",
  createdAt: 1,
  bars: ["2026-10-09", "2026-10-12"].flatMap((day) =>
    Array.from({ length: 48 }, (_, i) => {
      const m = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
      return {
        date: `${day}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 1000,
        amount: 10000,
      };
    }),
  ),
};
const work = {
  type: "ma-baseline" as const,
  root: "fixture",
  input: maBaselineInputSchema.parse({
    symbol: "sh600519",
    start: "2026-10-12",
    end: "2026-10-12",
  }),
};
beforeEach(() => {
  vi.mocked(readSnapshot).mockResolvedValue(structuredClone(source));
  vi.mocked(readBenchmarkSnapshot).mockResolvedValue({
    ...source,
    hash: "calendar-hash",
    bars: [
      { ...source.bars[0]!, date: "2026-10-09" },
      { ...source.bars[0]!, date: "2026-10-12" },
    ],
  } as Awaited<ReturnType<typeof readBenchmarkSnapshot>>);
  vi.mocked(readBacktestActions).mockResolvedValue({
    version: "backtest-actions-1",
    status: "partial",
    symbol: source.symbol,
    start: "2026-10-09",
    end: "2026-10-12",
    source: {
      file: "fixture/gbbq",
      modified: 1,
      fetchedAt: 2,
      hash: "actions-hash",
    },
    events: [],
    warnings: [],
  });
});
it("freezes exactly 20 warmup bars plus the selected window and source hashes", async () => {
  const result = await executeMaBaseline(work);
  expect(result.inputSnapshot.bars).toHaveLength(68);
  expect(result.manifest).toMatchObject({
    sourceFileHash: "file-hash",
    calendarHash: "calendar-hash",
    actionHash: "actions-hash",
    warmupBars: 20,
  });
  expect(result.result.evaluated).toBe(48);
  expect(result.result.fills).toEqual([]);
  expect(result.manifest.dataHash).toBe(
    (await executeMaBaseline(work)).manifest.dataHash,
  );
});
it("freezes a multi-day factor warmup and rejects a missing warmup slot", async () => {
  const strategy = structuredClone(factorStrategyPresets[0]!);
  strategy.entry.conditions[0]!.left = {
    id: "qlib-MA",
    parameters: { period: 60 },
  };
  const days = ["2026-10-08", "2026-10-09", "2026-10-12"];
  const extended = {
    ...source,
    bars: days.flatMap((day) =>
      source.bars
        .slice(0, 48)
        .map((bar) => ({ ...bar, date: day + bar.date.slice(10) })),
    ),
  };
  vi.mocked(readSnapshot).mockResolvedValue(extended);
  const calendar = {
    ...source,
    bars: days.map((day) => ({ ...source.bars[0]!, date: day })),
  };
  vi.mocked(readBenchmarkSnapshot).mockResolvedValue(calendar);
  const factorWork = {
    ...work,
    input: { ...work.input, strategy: factorStrategySchema.parse(strategy) },
  };
  const archive = await executeMaBaseline(factorWork);
  expect(archive.manifest.warmupBars).toBe(60);
  expect(archive.inputSnapshot.bars).toHaveLength(108);
  expect(archive.inputSnapshot.warmupCalendar).toEqual([
    "2026-10-08",
    "2026-10-09",
  ]);
  expect(archive.result.input.strategy).toEqual(factorWork.input.strategy);
  expect(archive.result.strategyId).toBe("factor-combination-v1");
  vi.mocked(readSnapshot).mockResolvedValue({
    ...extended,
    bars: extended.bars.filter((_, i) => i !== 80),
  });
  await expect(executeMaBaseline(factorWork)).rejects.toThrow("预热未完整");
});
it("rejects missing days, missing bars and repaired input rather than silently continuing", async () => {
  vi.mocked(readSnapshot).mockResolvedValueOnce({
    ...source,
    bars: source.bars.slice(0, -1),
  });
  await expect(executeMaBaseline(work)).rejects.toThrow("缺日");
  vi.mocked(readSnapshot).mockResolvedValueOnce({
    ...source,
    sourceNote: "丢弃1条",
  });
  await expect(executeMaBaseline(work)).rejects.toThrow("修复或丢弃");
});
it("rejects known corporate actions including warmup and missing evidence", async () => {
  const actions = await readBacktestActions(source, "fixture");
  vi.mocked(readBacktestActions).mockResolvedValueOnce({
    ...actions,
    status: "missing",
  });
  await expect(executeMaBaseline(work)).rejects.toThrow("公司行动来源");
  vi.mocked(readBacktestActions).mockResolvedValueOnce({
    ...actions,
    events: [
      {
        date: "2026-10-09",
        category: 1,
        name: "除权",
        dividend: 1,
        rightsPrice: 0,
        bonusRatio: 0,
        rightsRatio: 0,
      },
    ],
  });
  await expect(executeMaBaseline(work)).rejects.toThrow("预热包含");
});
