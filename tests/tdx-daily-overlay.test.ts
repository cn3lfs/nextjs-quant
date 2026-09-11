import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import { publishDailyIncrement } from "../src/server/tdx-daily-cache";
import { overlayDailyIncrements } from "../src/server/tdx-daily-overlay";
import { put } from "../src/server/db";
import { chartBars } from "../src/server/chart-bars";

it("uses the increment in the actual daily chart response and binds the chart version", async () => {
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-09-11T08:00:00+08:00"));
  try {
    const bars = Array.from({ length: 100 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 10 - 99 + i)).toISOString().slice(0, 10),
      open: 10,
      high: 12,
      low: 9,
      close: 10,
      volume: 100,
      amount: 1000,
    }));
    const source: Snapshot = {
      id: "chart-increment-base",
      hash: "chart-base",
      symbol: "sh600000",
      period: "day",
      source: "tdx-local",
      adjustment: "none",
      createdAt: 1,
      bars,
    };
    put("snapshot", source.id, source);
    const cod = readFileSync("tests/fixtures/tdx-daily-increment/sample.cod");
    cod.write("600000", 0, "ascii");
    publishDailyIncrement({
      market: "sh",
      date: "2026-09-10",
      symbols: [source.symbol],
      observedAt: 3000,
      cod,
      md1: readFileSync("tests/fixtures/tdx-daily-increment/sample.md1"),
    });
    const chart = await chartBars({
      snapshotId: source.id,
      period: "day",
      limit: 100,
    });
    expect(chart.source).toBe("tdx-local+g4day");
    expect(chart.bars.at(-1)!.close).toBe(11);
    expect(chart.bars).toHaveLength(100);
    expect(source.bars.at(-1)!.close).toBe(10);
  } finally {
    now.mockRestore();
  }
});

it("updates chart input by date without altering its original or mixing online/adjusted sources", () => {
  const cod = readFileSync("tests/fixtures/tdx-daily-increment/sample.cod");
  const md1 = readFileSync("tests/fixtures/tdx-daily-increment/sample.md1");
  const bar = {
    date: "2026-09-09",
    open: 10,
    high: 12,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  };
  const source: Snapshot = {
    id: "base",
    hash: "base",
    symbol: "sh600519",
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 1,
    bars: [bar],
  };
  publishDailyIncrement({
    market: "sh",
    date: "2026-09-10",
    symbols: [source.symbol],
    cod,
    md1,
    observedAt: 1000,
  });
  const first = overlayDailyIncrements(source, "2026-09-10");
  expect(first.bars.map((item) => item.date)).toEqual([
    "2026-09-09",
    "2026-09-10",
  ]);
  expect(first.bars[1]!.close).toBe(11);
  expect(source.bars).toEqual([bar]);
  const changed = Buffer.from(md1);
  changed.writeDoubleLE(10.5, 512 + 36);
  publishDailyIncrement({
    market: "sh",
    date: "2026-09-10",
    symbols: [source.symbol],
    cod,
    md1: changed,
    observedAt: 2000,
  });
  const second = overlayDailyIncrements(source, "2026-09-10");
  expect(second.bars[1]!.close).toBe(10.5);
  expect(second.hash).not.toBe(first.hash);
  expect(first.bars[1]!.close).toBe(11);
  expect(overlayDailyIncrements(source, "2026-09-09")).toBe(source);
  const online = { ...source, source: "eastmoney-online", volumeUnit: "手" };
  expect(overlayDailyIncrements(online, "2026-09-10")).toBe(online);
  const minutes = { ...source, period: "5m" as const };
  expect(overlayDailyIncrements(minutes, "2026-09-10")).toBe(minutes);
  const historical = { ...source, historicalAsOf: "2026-09-10" };
  expect(overlayDailyIncrements(historical, "2026-09-10")).toBe(historical);
});
