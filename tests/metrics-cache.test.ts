import { expect, it, vi } from "vitest";
vi.mock("~/lib/screening-metrics", async (original) => {
  const module = await original<typeof import("~/lib/screening-metrics")>();
  return { ...module, metrics: vi.fn(module.metrics) };
});
import { metrics } from "~/lib/screening-metrics";
import { MetricsCache } from "~/server/screening/metrics-cache";
import { defaultStrategy, type Snapshot } from "~/lib/domain";

const snapshot: Snapshot = {
  id: "fixture",
  symbol: "sh600000",
  period: "day",
  source: "fixture",
  adjustment: "none",
  hash: "original",
  createdAt: 1,
  bars: Array.from({ length: 60 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 100 + i,
    close: 101 + i,
    high: 102 + i,
    low: 99 + i,
    volume: 10000 + i,
    amount: 1000000,
  })),
};

it("reuses unchanged securities, ignores display names, isolates mutable results and invalidates revisions and rules", () => {
  const cache = new MetricsCache();
  const expected = metrics(snapshot.bars, defaultStrategy);
  vi.mocked(metrics).mockClear();
  const first = cache.get(snapshot, defaultStrategy)!;
  first.close = -1;
  expect(
    cache.get(
      { ...snapshot, name: "新名称" },
      { ...defaultStrategy, name: "新策略名" },
    ),
  ).toEqual(expected);
  expect(metrics).toHaveBeenCalledTimes(1);
  const revised = {
    ...snapshot,
    hash: "revision",
    bars: snapshot.bars.map((b) => ({ ...b, close: b.close + 5 })),
  };
  expect(cache.get(revised, defaultStrategy)?.close).toBe(expected!.close + 5);
  cache.get(snapshot, { ...defaultStrategy, minVolumeRatio: 100 });
  expect(metrics).toHaveBeenCalledTimes(3);
});

it("bounds memory with LRU eviction and caches insufficient-history results", () => {
  const cache = new MetricsCache(2);
  vi.mocked(metrics).mockClear();
  const short = { ...snapshot, hash: "short", bars: [] };
  expect(cache.get(short, defaultStrategy)).toBeNull();
  expect(cache.get(short, defaultStrategy)).toBeNull();
  cache.get(snapshot, defaultStrategy);
  cache.get(short, defaultStrategy);
  cache.get({ ...snapshot, hash: "third" }, defaultStrategy);
  cache.get(short, defaultStrategy);
  expect(metrics).toHaveBeenCalledTimes(3);
  cache.get(snapshot, defaultStrategy);
  expect(metrics).toHaveBeenCalledTimes(4);
});
