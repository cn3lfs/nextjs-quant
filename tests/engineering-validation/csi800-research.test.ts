import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import {
  runClassicDiagnostics,
  classicFactorInventory,
} from "../../scripts/lib/csi800-factor-diagnostics";
import { csi800ClassicFactors } from "../../packages/quant-backtest/src/csi800-factors";
import type { ClassicPriceInput } from "../../scripts/lib/csi800-factor-data";
import type { ClassicWeek } from "../../packages/quant-backtest/src/csi800-composite";

it("IC diagnostics respect direction, tied ranks, label maturity and actual non-overlap", async () => {
  const out = await mkdtemp(join(tmpdir(), "csi800-diagnostic-"));
  try {
    const dates: string[] = [];
    for (let n = 0; dates.length < 330; n++) {
      const d = new Date(Date.UTC(2020, 0, 1 + n));
      if (![0, 6].includes(d.getUTCDay()))
        dates.push(d.toISOString().slice(0, 10));
    }
    const bars = (k: number) =>
      dates.map((date, i) => ({
        date,
        open: 10 + (k * i) / 100,
        close: 10 + (k * i) / 100,
        high: 11 + (k * i) / 100,
        low: 9 + (k * i) / 100,
        amount: 1e8,
        volume: 1e7,
      }));
    const stocks = Array.from({ length: 30 }, (_, i) => ({
      symbol: `sh${600000 + i}`,
      bars: bars(i + 1),
      actions: [],
    }));
    const price: ClassicPriceInput = {
      version: "csi800-frozen-1",
      start: dates[275]!,
      end: dates.at(-1)!,
      initial: 1e6,
      stocks,
      benchmark: bars(0),
    };
    const weeks: ClassicWeek[] = [275, 280, 285, 290, 295, 325].map(
      (index) => ({
        date: dates[index]!,
        nextDate: dates[index + 1]!,
        marketBudget: 1,
        rows: stocks.map((s, i) => ({
          symbol: s.symbol,
          values: csi800ClassicFactors.map((f) => (f.id === "bias-60" ? 1 : i)),
          volatility: 0.01,
          amihud: 1,
          positiveEquity: true,
          reportDate: null,
          announcementDate: null,
          availableFrom: null,
          marketCap: 1000,
        })),
      }),
    );
    await runClassicDiagnostics(price, weeks, weeks[0]!.date, out);
    const result = JSON.parse(
      await readFile(join(out, "factor-diagnostics.json"), "utf8"),
    );
    expect(result.observations).toHaveLength(5);
    expect(
      result.observations[0].factors.find(
        (f: { id: string }) => f.id === "momentum-120-20",
      ).ic,
    ).toBeCloseTo(1);
    expect(
      result.observations[0].factors.find(
        (f: { id: string }) => f.id === "volatility-20",
      ).ic,
    ).toBeCloseTo(-1);
    expect(
      result.observations[0].factors.find(
        (f: { id: string }) => f.id === "bias-60",
      ).ic,
    ).toBeNull();
    expect(
      result.summaries.find(
        (f: { phase: string; id: string }) =>
          f.phase === "development" && f.id === "momentum-120-20",
      ).nonoverlap.count,
    ).toBe(2);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

it("all existing factor IDs have an explicit disposition rather than disappearing", () => {
  const inventory = classicFactorInventory();
  const keys = inventory.map((r) => `${r.namespace}:${r.id}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(
    inventory.filter((r) => r.namespace === "technical").length,
  ).toBeGreaterThanOrEqual(94);
  expect(
    inventory.filter((r) => r.namespace === "local-data").length,
  ).toBeGreaterThanOrEqual(197);
  expect(inventory.every((r) => !!r.classification && !!r.reason)).toBe(true);
  expect(csi800ClassicFactors).toHaveLength(29);
});
