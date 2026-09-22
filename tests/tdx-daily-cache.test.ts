import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  publishDailyIncrement,
  readDailyIncrement,
  type DailyIncrementSnapshot,
} from "../src/server/data-sources/tdx/tdx-daily-cache";
import { get } from "../src/server/db";

it("publishes valid rows with explicit gaps while preserving a previous valid bar when a later record is empty", () => {
  const input = {
    market: "sh" as const,
    date: "2026-09-11",
    symbols: ["sh600519", "sh600000"],
    observedAt: 1000,
    allowUnavailable: true,
    cod: readFileSync("tests/fixtures/tdx-daily-increment/sample.cod"),
    md1: readFileSync("tests/fixtures/tdx-daily-increment/sample.md1"),
  };
  const first = publishDailyIncrement(input);
  expect(first.records).toHaveLength(1);
  expect(first.unavailable).toEqual([
    { symbol: "sh600000", reason: "absent-code" },
  ]);
  const noTrade = Buffer.alloc(1024);
  noTrade.writeDoubleLE(11, 512 + 36);
  const later = publishDailyIncrement({
    ...input,
    md1: noTrade,
    observedAt: 2000,
  });
  expect(later.records).toHaveLength(0);
  expect(later.unavailable).toContainEqual({
    symbol: "sh600519",
    reason: "no-trading-vendor-record",
  });
  expect(readDailyIncrement("sh600519", input.date)?.snapshot.id).toBe(
    first.id,
  );
  expect(readDailyIncrement("sh600000", input.date)).toBeNull();
});

it("publishes revisions atomically while preserving old snapshots and rejecting incomplete or stale batches", () => {
  const input = {
    market: "sh" as const,
    date: "2026-09-10",
    symbols: ["sh600519"],
    observedAt: 1000,
    cod: readFileSync("tests/fixtures/tdx-daily-increment/sample.cod"),
    md1: readFileSync("tests/fixtures/tdx-daily-increment/sample.md1"),
  };
  const first = publishDailyIncrement(input);
  expect(publishDailyIncrement(input).id).toBe(first.id);
  const revised = Buffer.from(input.md1);
  revised.writeDoubleLE(10.5, 512 + 36);
  const second = publishDailyIncrement({
    ...input,
    md1: revised,
    observedAt: 2000,
  });
  expect(second.id).not.toBe(first.id);
  expect(readDailyIncrement("sh600519", input.date)?.record.bar.close).toBe(
    10.5,
  );
  expect(get<DailyIncrementSnapshot>(first.id)?.records[0]!.bar.close).toBe(11);
  expect(() => publishDailyIncrement(input)).toThrow("较早");
  expect(() => publishDailyIncrement({ ...input, observedAt: 2000 })).toThrow(
    "冲突",
  );
  expect(() =>
    publishDailyIncrement({
      ...input,
      observedAt: 3000,
      symbols: ["sh600519", "sh600000"],
    }),
  ).toThrow("未齐备");
  expect(readDailyIncrement("sh600519", input.date)?.snapshot.id).toBe(
    second.id,
  );
  expect(readDailyIncrement("sh600000", input.date)).toBeNull();
});
