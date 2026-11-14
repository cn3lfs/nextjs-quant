import { expect, it } from "vitest";
import { SnapshotSerializer } from "~/server/screening/snapshot-serializer";
import type { Snapshot } from "~/lib/domain";
const source: Snapshot = {
  id: "same-id",
  hash: "same-hash",
  symbol: "sh600000",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 1,
  bars: [
    {
      date: "2026-09-08",
      open: 1.123456789,
      high: 3,
      low: 1,
      close: 2,
      volume: 100,
      amount: 200,
    },
  ],
};
it("compares actual content even when IDs and hashes are unchanged", () => {
  const cache = new SnapshotSerializer();
  expect(cache.stringify(source)).toBe(JSON.stringify(source));
  expect(cache.stringify(structuredClone(source))).toBe(JSON.stringify(source));
  for (const field of [
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
  ] as const) {
    const revised = structuredClone(source);
    revised.bars[0]![field] += 1;
    expect(cache.stringify(revised)).toBe(JSON.stringify(revised));
  }
  const renamed = { ...source, name: "中文名称", createdAt: 2 };
  expect(cache.stringify(renamed)).toBe(JSON.stringify(renamed));
  const changedDate = structuredClone(source);
  changedDate.bars[0]!.date = "2026-09-09";
  expect(cache.stringify(changedDate)).toBe(JSON.stringify(changedDate));
  const extended = { ...source, bars: [...source.bars, ...source.bars] };
  expect(cache.stringify(extended)).toBe(JSON.stringify(extended));
});
it("falls back without dropping extra fields or nonfinite JSON values and survives eviction", () => {
  const cache = new SnapshotSerializer(1000);
  cache.stringify(source);
  const extra = { ...source, bars: [{ ...source.bars[0]!, extra: "retain" }] };
  expect(cache.stringify(extra)).toBe(JSON.stringify(extra));
  const unusual = { ...source, bars: [{ ...source.bars[0]!, close: NaN }] };
  expect(cache.stringify(unusual)).toBe(JSON.stringify(unusual));
  for (let i = 0; i < 20; i++) cache.stringify({ ...source, id: `other-${i}` });
  expect(cache.stringify(source)).toBe(JSON.stringify(source));
});
it("does not mistake an inherited date plus an extra field for the cached bar shape", () => {
  const cache = new SnapshotSerializer();
  cache.stringify(source);
  const { date, ...values } = source.bars[0]!;
  const bar = Object.assign(Object.create({ date }), values, {
    extra: "preserve",
  });
  const revised = { ...source, bars: [bar] };
  expect(cache.stringify(revised)).toBe(JSON.stringify(revised));
});
it("preserves reordered JSON fields rather than reusing canonical output", () => {
  const cache = new SnapshotSerializer();
  cache.stringify(source);
  const { date, ...numbers } = source.bars[0]!;
  const reordered = { ...source, bars: [{ ...numbers, date }] };
  expect(cache.stringify(reordered)).toBe(JSON.stringify(reordered));
  expect(cache.stringify(source)).toBe(JSON.stringify(source));
});
