import { expect, it, vi } from "vitest";
vi.mock("~/server/market/bar-store/read-bars", () => ({ readBars: vi.fn() }));
import {
  readMaCoverage,
  maCoverageInputSchema,
} from "~/server/backtest/ma-coverage";
import { factorStrategySchema } from "trading-strategies";
const bars = ["2026-10-09", "2026-10-12"].flatMap((day) =>
  Array.from({ length: 48 }, (_, i) => {
    const minutes = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
    return {
      date: `${day}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00+08:00`,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 1000,
      amount: 10000,
    };
  }),
);
it("reads unadjusted five-minute coverage for the selected symbol and reserves the real baseline warmup", async () => {
  const read = vi.fn(async () => ({ symbol: "sh600000", bars }));
  expect(
    await readMaCoverage({ symbol: "sh600000" }, "fixture-root", read),
  ).toMatchObject({
    start: "2026-10-09",
    end: "2026-10-12",
    bars: 96,
    warmupBars: 20,
    earliestStart: "2026-10-12",
    suggestedStart: "2026-10-12",
    suggestedEnd: "2026-10-12",
  });
  expect(read).toHaveBeenCalledExactlyOnceWith({
    instrument: { market: "cn-equity", symbol: "sh600000" },
    root: "fixture-root",
    period: "5m",
    adjustment: "none",
  });
});
it("derives warmup from the actual factor recipe and does not offer a window that cannot reserve it", async () => {
  const strategy = factorStrategySchema.parse({
    id: "factor-combination-v1",
    version: 1,
    name: "60根",
    entry: {
      mode: "all",
      conditions: [
        {
          left: { id: "sma", parameters: { period: 60 } },
          operator: "cross-above",
          right: { constant: 0 },
        },
      ],
    },
    exit: {
      mode: "all",
      conditions: [
        { left: { id: "close" }, operator: "lt", right: { constant: 0 } },
      ],
    },
  });
  expect(
    await readMaCoverage(
      { symbol: "sh600000", strategy },
      "fixture-root",
      async () => ({ symbol: "sh600000", bars }),
    ),
  ).toMatchObject({ warmupBars: 60, suggestedStart: null, suggestedEnd: null });
});
it("rejects unsupported symbols, legacy bare-string requests and empty data explicitly", async () => {
  expect(() => maCoverageInputSchema.parse("sh600000")).toThrow();
  expect(() => maCoverageInputSchema.parse({ symbol: "sh688001" })).toThrow();
  await expect(
    readMaCoverage({ symbol: "sh600000" }, "fixture-root", async () => ({
      symbol: "sh600000",
      bars: [],
    })),
  ).rejects.toThrow("未包含可用");
});
