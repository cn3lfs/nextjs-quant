import { expect, it, vi, beforeEach } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
import type { StrategyObjectInput } from "trading-strategies";
import type { readBars } from "~/server/market/bar-store/read-bars";
import { aggregateChartBars } from "~/lib/market/bar-aggregation";
const state = vi.hoisted(() => ({ five: [] as Bar[], daily: [] as Bar[] }));
vi.mock("~/server/market/bar-store/corporate-actions", () => ({
  corporateActions: async () => ({ events: new Map(), fingerprint: "actions" }),
}));
vi.mock("~/server/market/bar-store/local-source", () => ({
  localBars: async () => ({
    bars: state.five,
    hash: "full-source",
    sourceVersions: ["original"],
    period: "5m",
  }),
}));
vi.mock("~/server/market/bar-store/binance-archive-source", () => ({
  binanceArchiveSource: async (input: { period: string }) => ({
    period: input.period,
    bars: input.period === "day" ? state.daily : state.five,
  }),
}));
import { loadTheoryMultiperiodSource } from "~/server/research/theory-multiperiod-source";
const bar = (date: string, close = 10): Bar => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: 1000,
});
const days = [
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
];
const calendar = { days, closedDays: [], hash: "calendar", source: "fixture" };
const strategy = (
  market: "cn-equity" | "crypto" = "cn-equity",
  variant: "week-day" | "day-hour-five" = "day-hour-five",
): StrategyObjectInput => ({
  id: "fixture",
  version: 1,
  market,
  period: variant === "week-day" ? "day" : "5m",
  universe: {
    kind: "symbols",
    symbols: [market === "cn-equity" ? "sh600000" : "cxBTCUSDT"],
  },
  entry: { kind: "triple-screen", variant, side: "entry" },
  exit: { rule: { kind: "triple-screen", variant, side: "exit" } },
  sizing: { kind: "weight", weight: 0.1 },
  sleeve: "swing",
});
const read = vi.fn(
  async (input: Parameters<typeof readBars>[0], frozen?: Snapshot) => {
    const bars = input.period === "day" ? state.daily : frozen!.bars;
    if (input.period === "5m" && input.instrument.market === "cn-equity")
      aggregateChartBars(bars, "5m", "5m", input.now!, calendar);
    return {
      bars,
      hash: "slice",
      sourceVersions: frozen?.sourceVersions,
      barStore: {
        priceRepaired: false,
        formingDates: [],
        sourceVersions: [],
        coverage: {},
      },
    };
  },
) as unknown as typeof readBars;
const options = () => ({
  strategy: strategy(),
  start: "2026-11-10",
  end: "2026-11-13",
  config: { tdxRoot: "E:/fixture", binancePublicDataRoot: "D:/fixture" },
  calendar,
  read,
});
beforeEach(() => {
  state.daily = days.map((d) => bar(d));
  state.five = Array.from({ length: 48 }, (_, i) =>
    i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5,
  ).map((m) =>
    bar(
      `2026-11-13T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
    ),
  );
  vi.clearAllMocks();
});
it("shares the configured bar budget across daily and intraday snapshots", async () => {
  const total = state.daily.length + state.five.length;
  try {
    vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", String(total - 1));
    await expect(loadTheoryMultiperiodSource(options())).rejects.toMatchObject({
      code: "BAR_STORE_BUDGET_EXCEEDED",
      diagnostic: {
        period: "5m",
        stage: "output",
        retainedBars: state.daily.length,
        requestedBars: state.five.length,
        maxBars: total - 1,
      },
    });
    vi.stubEnv("QUANT_BAR_STORE_MAX_BARS", String(total));
    expect(
      (await loadTheoryMultiperiodSource(options())).instruments,
    ).toHaveLength(1);
  } finally {
    vi.unstubAllEnvs();
  }
});
it("slices only the registered warmup interval before strict validation, retaining original identity", async () => {
  state.five.unshift(bar("2000-01-03T00:00:00+08:00"));
  const result = await loadTheoryMultiperiodSource(options());
  expect(result.instruments[0]!.bars).toHaveLength(48);
  const call = vi.mocked(read).mock.calls.find((c) => c[0].period === "5m")!;
  expect(call[1]!.sourceVersions).toContain("full-source");
  expect(call[1]!.bars.some((b) => b.date.startsWith("2000"))).toBe(false);
});
it("does not filter an invalid in-window bar to make the run pass", async () => {
  state.five.unshift(bar("2026-11-13T09:30:00+08:00"));
  await expect(loadTheoryMultiperiodSource(options())).rejects.toThrow(
    "交易时段",
  );
});
it("retains an entirely absent execution day in the portfolio clock", async () => {
  const result = await loadTheoryMultiperiodSource(options());
  expect(result.calendar).toContain("2026-11-12T09:35:00+08:00");
  expect(result.start).toBe("2026-11-10T09:35:00+08:00");
  const execution = result.instruments[0]!.execution;
  if (typeof execution !== "function")
    throw new Error("Expected daily execution adapter");
  expect(
    execution({ ...state.five[1]!, close: 20 }, state.five[0])?.limitUp,
  ).toBe(11);
});
it("includes the full crypto end day and preserves explicit unknown price ticks", async () => {
  const result = await loadTheoryMultiperiodSource({
    ...options(),
    strategy: strategy("crypto", "week-day"),
    priceTicks: {},
  });
  const multi = result.instruments[0]!.external!.tripleScreen!;
  expect(multi.execution.slots.at(-1)?.bar?.date).toBe("2026-11-13");
  expect(multi.execution.slots.at(-1)?.availableAt).toBe(
    "2026-11-14T00:00:00Z",
  );
  expect(multi.tick).toBeNull();
});
it("uses the end-labelled crypto execution interval (warmup start, end]", async () => {
  state.five = [
    bar("2026-10-27T00:00:00+00:00"),
    bar("2026-11-13T23:55:00+00:00"),
    bar("2026-11-14T00:00:00+00:00"),
  ];
  const result = await loadTheoryMultiperiodSource({
    ...options(),
    strategy: strategy("crypto"),
    priceTicks: {},
  });
  const instrument = result.instruments[0]!;
  expect(instrument.bars.map((b) => b.date)).toEqual([
    "2026-11-13T23:55:00+00:00",
    "2026-11-14T00:00:00+00:00",
  ]);
  expect(
    instrument.external!.tripleScreen!.execution.slots.flatMap((s) =>
      s.bar ? [s.bar.date] : [],
    ),
  ).toEqual(instrument.bars.map((b) => b.date));
  expect(result.end).toBe("2026-11-14T00:00:00+00:00");
});
