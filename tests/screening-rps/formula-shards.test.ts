import { expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bar } from "../../src/lib/domain";
vi.mock("../../src/server/data-sources/tdx/tdx", () => ({
  scan: vi.fn(),
  readSnapshot: vi.fn(),
}));
import { readSnapshot } from "../../src/server/data-sources/tdx/tdx";
import {
  mergeFormulaParts,
  scanFormulaRange,
} from "../../src/server/screening/formula-screening";
import {
  formulaRanges,
  formulaThreads,
} from "../../src/server/screening/formula-shards";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "formula-shards-"));

/** 40 securities: rising/falling closes, read errors, empty and stale histories. */
const securities = Array.from({ length: 40 }, (_, i) => ({
  symbol: `sz${String(i).padStart(6, "0")}`,
  name: `S${i}`,
}));
vi.mocked(readSnapshot).mockImplementation(async (_root, symbol) => {
  const i = Number(symbol.slice(2));
  if (i % 11 === 3) throw new Error(`读取失败 ${symbol}`);
  const days = i % 13 === 5 ? 0 : i % 7 === 2 ? 25 : 30;
  const bars: Bar[] = Array.from({ length: days }, (_, d) => {
    const close = 10 + (i % 2 ? d : -d * 0.1) + (i % 5);
    return {
      date: `2026-01-${String(d + 1).padStart(2, "0")}`,
      open: close,
      close,
      high: close + 1,
      low: close - 1,
      volume: 100 + i,
      amount: 1000,
    };
  });
  return {
    id: symbol,
    symbol,
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 0,
    hash: symbol,
    bars,
  };
});
const formula = {
  name: "测试",
  source: "选股:C>MA(C,N1);",
  parameters: { N1: 3 },
};
const work = { root: "fixture", now: Date.parse("2026-02-01T00:00:00+08:00") };

it("ranges scanned separately merge into exactly the sequential scan", async () => {
  const whole = mergeFormulaParts([
    await scanFormulaRange(work, formula, securities),
  ]);
  expect(whole.candidates.length).toBeGreaterThan(0);
  expect(whole.errors.length).toBeGreaterThan(0);
  expect(whole.excluded.length).toBeGreaterThan(0);
  for (const count of [3, 7]) {
    const parts = [];
    for (const range of formulaRanges(securities, count))
      parts.push(await scanFormulaRange(work, formula, range));
    expect(mergeFormulaParts(parts)).toEqual(whole);
  }
});

it("splits into contiguous ranges and uses all cores but two", () => {
  expect(formulaRanges([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
    [1, 2, 3],
    [4, 5, 6],
    [7],
  ]);
  expect(formulaRanges([1, 2], 4)).toEqual([[1], [2]]);
  expect(formulaThreads(100)).toBe(1);
  expect(formulaThreads(6000)).toBeGreaterThanOrEqual(1);
  expect(formulaThreads(6000)).toBeLessThanOrEqual(8);
});
