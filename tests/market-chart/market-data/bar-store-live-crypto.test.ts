import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Bar } from "~/lib/domain";
const mocks = vi.hoisted(() => ({ crypto: vi.fn(), live: vi.fn() }));
vi.mock("~/server/data-sources/binance/binance-klines", () => ({
  binanceKlines: mocks.crypto,
}));
vi.mock("~/server/market/free-chart-sources", () => ({
  freeChartHistory: mocks.live,
}));
import { readBars } from "~/server/market/bar-store/read-bars";
const bar = (date: string, close = 10): Bar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 100,
  amount: 1000,
});
it("loads a requested crypto historical window instead of filtering only today's tail", async () => {
  mocks.crypto.mockClear();
  const row = bar("2025-12-31");
  mocks.crypto.mockResolvedValue({
    version: "fixture-1",
    source: "binance-spot",
    bars: [row],
    formingDates: [],
    historyExhausted: false,
  });
  const input = {
    instrument: { market: "crypto" as const, symbol: "cxETHUSDT" },
    period: "day" as const,
    adjustment: "none" as const,
    limit: 1,
    to: "2025-12-31",
    now: Date.parse("2026-01-03T04:01Z"),
  };
  expect((await readBars(input)).bars).toEqual([row]);
  expect(mocks.crypto).toHaveBeenCalledWith(
    expect.objectContaining({ before: Date.parse("2026-01-01T00:00Z") }),
  );
  await readBars(input);
  expect(mocks.crypto).toHaveBeenCalledTimes(1);
  mocks.crypto.mockClear();
});
it("crypto shares the column store, derives UTC 4h, reuses warm data and incrementally refreshes the tail", async () => {
  const rows = [1, 2, 3, 4].map((h) => bar(`2026-01-03T0${h}:00:00+00:00`));
  mocks.crypto.mockResolvedValue({
    version: "fixture-1",
    source: "binance-spot",
    bars: rows,
    formingDates: [],
    historyExhausted: true,
  });
  const input = {
    instrument: { market: "crypto" as const, symbol: "cxBTCUSDT" },
    period: "4h" as const,
    adjustment: "none" as const,
    limit: 1,
    now: Date.parse("2026-01-03T04:01Z"),
  };
  const result = await readBars(input);
  expect(result.bars).toEqual([
    { ...rows[0]!, date: rows[3]!.date, volume: 400, amount: 4000 },
  ]);
  expect(mocks.crypto).toHaveBeenCalledWith(
    expect.objectContaining({ period: "1h" }),
  );
  expect((await readBars(input)).bars).toEqual(result.bars);
  expect(mocks.crypto).toHaveBeenCalledTimes(1);
  mocks.crypto.mockResolvedValue({
    version: "fixture-1",
    source: "binance-spot",
    bars: [...rows.slice(-1), bar("2026-01-03T05:00:00+00:00", 11)],
    formingDates: [],
    historyExhausted: false,
  });
  const latest = await readBars({
    ...input,
    now: Date.parse("2026-01-03T05:00Z"),
  });
  expect(latest.barStore.formingDates).toEqual(["2026-01-03T08:00:00+00:00"]);
  expect(latest.bars.at(-1)?.close).toBe(11);
  expect(mocks.crypto).toHaveBeenCalledTimes(2);
});
it("live A-share overlay is labelled partial and cannot overwrite the raw cached history", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "live-source"),
    rows = [bar("2026-01-08"), bar("2026-01-09")];
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  const bytes = Buffer.alloc(64);
  rows.forEach((b, i) => {
    const at = i * 32;
    bytes.writeUInt32LE(Number(b.date.replaceAll("-", "")), at);
    for (const offset of [4, 8, 12, 16]) bytes.writeUInt32LE(1000, at + offset);
    bytes.writeFloatLE(1000, at + 20);
    bytes.writeUInt32LE(100, at + 24);
  });
  await writeFile(join(root, "vipdoc/sh/lday/sh600000.day"), bytes);
  mocks.live.mockResolvedValue({
    bars: [...rows, bar("2026-01-12", 11)],
    source: "tdx-7709",
    historyExhausted: false,
  });
  const input = {
    instrument: { market: "cn-equity" as const, symbol: "sh600000" },
    root,
    period: "day" as const,
    adjustment: "none" as const,
    now: Date.parse("2026-01-12T10:00+08:00"),
  };
  const live = await readBars({ ...input, live: true });
  expect(live.barStore.overlay).toEqual({
    source: "tdx-7709",
    date: "2026-01-12",
    completed: false,
  });
  expect(live.barStore.formingDates).toEqual(["2026-01-12"]);
  expect(live.bars).toHaveLength(3);
  expect((await readBars(input)).bars).toEqual(rows);
  expect(mocks.live).toHaveBeenCalledTimes(1);
});
