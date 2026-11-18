import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type {
  BarSeries,
  ReadBarsInput,
} from "~/server/market/bar-store/read-bars";

const mocks = vi.hoisted(() => ({ readBars: vi.fn() }));
vi.mock("~/server/market/bar-store/read-bars", () => ({
  readBars: mocks.readBars,
}));
import { chartBars } from "~/server/charts/chart-bars";
import { cryptoSnapshot } from "~/server/market/crypto-chart";
import { strategyRouter } from "~/server/api/routers/strategy";
import { readArchiveRecord } from "~/server/db/archive-records";
import { put, sqlite } from "~/server/db";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";

const fixture = JSON.parse(
  readFileSync("tests/fixtures/breakout-valid.json", "utf8"),
) as { cutoff: string; bars: Bar[] };
const bars = fixture.bars.filter((bar) => bar.date <= fixture.cutoff);
const caller = strategyRouter.createCaller({ headers: new Headers() });

function series(
  symbol: string,
  period: ChartPeriod,
  rows = period === "day"
    ? bars
    : bars.map((bar) => ({ ...bar, date: `${bar.date}T04:00:00+00:00` })),
): BarSeries {
  const hash = createHash("sha256")
    .update(JSON.stringify({ symbol, period, rows }))
    .digest("hex");
  return {
    id: `snapshot-${symbol}-${period}-${hash.slice(0, 20)}`,
    symbol,
    period,
    market: "crypto",
    source: "binance-spot",
    cryptoSource: "binance",
    adjustment: "none",
    createdAt: 1,
    hash,
    bars: rows,
    barStore: {
      version: "bar-store-1",
      market: "crypto",
      sourceFingerprint: hash,
      sourceVersions: ["fixture"],
      adjustment: "none",
      adjustmentReference: null,
      coverage: {
        from: rows[0]!.date,
        to: rows.at(-1)!.date,
        count: rows.length,
        historyExhausted: true,
      },
      formingDates: [rows.at(-1)!.date],
      excluded: [],
      overlay: null,
    },
  };
}
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.readBars.mockReset();
  mocks.readBars.mockImplementation(async (input: ReadBarsInput) =>
    series(input.instrument.symbol, input.period),
  );
});

it.each([
  ["cxBTCUSDT", "day"],
  ["cxETHUSDT", "4h"],
] as const)(
  "saves the displayed %s %s chart under its own identity accepted by breakout",
  async (symbol, period) => {
    const previous: Snapshot = {
      id: "previous-a-share",
      symbol: "sh600519",
      period: "day",
      market: "cn-equity",
      source: "tdx-local",
      adjustment: "none",
      createdAt: 0,
      hash: "previous",
      bars,
    };
    put("snapshot", previous.id, previous);
    const raw = await cryptoSnapshot(symbol, "day", "binance");
    put("snapshot", raw.id, raw);
    const chart = await chartBars({ snapshotId: raw.id, period });
    // Exercise the same public request made by CzscMarketChart.
    const actual = await caller.breakout({
      snapshotId: chart.id,
      chartSnapshot: true,
    });
    expect(chart.id).toMatch(/^chart-snapshot-/);
    expect(chart.id).not.toBe(raw.id);
    expect(chart.symbol).toBe(symbol);
    expect(chart.period).toBe(period);
    expect(chart.adjustment).toBe("none");
    expect(chart.formingDates).toEqual([chart.bars.at(-1)!.date]);
    expect(readArchiveRecord("chart-snapshot", chart.id)?.bars).toEqual(
      chart.bars,
    );
    expect(actual).toEqual(analyzeBreakout(chart.bars, 0, true));
    expect(actual.points.length).toBeGreaterThan(0);
    expect(readArchiveRecord("snapshot", raw.id)).toEqual(raw);
    await expect(
      caller.breakout({ snapshotId: raw.id, chartSnapshot: true }),
    ).rejects.toThrow("图表快照不匹配");
    expect(readArchiveRecord("snapshot", previous.id)).toEqual(previous);
  },
);

it("keeps refreshed crypto chart content separate from the preceding displayed snapshot", async () => {
  const source: Snapshot = { ...series("cxBTCUSDT", "day"), period: "day" };
  put("snapshot", source.id, source);
  const first = await chartBars({ snapshotId: source.id, period: "day" });
  const updatedBars = bars.map((bar, i) =>
    i === bars.length - 1 ? { ...bar, close: bar.high } : bar,
  );
  mocks.readBars.mockResolvedValue(series(source.symbol, "day", updatedBars));
  const refreshed = await chartBars({ snapshotId: source.id, period: "day" });
  expect(refreshed.id).not.toBe(first.id);
  for (const chart of [first, refreshed]) {
    expect(readArchiveRecord("chart-snapshot", chart.id)?.bars).toEqual(
      chart.bars,
    );
    await expect(
      caller.breakout({ snapshotId: chart.id, chartSnapshot: true }),
    ).resolves.toEqual(analyzeBreakout(chart.bars, 0, true));
  }
});
