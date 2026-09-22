import { expect, it } from "vitest";
import { SnapshotSerializer } from "~/server/screening/snapshot-serializer";
import type { Snapshot } from "~/lib/domain";
import { packScreen, unpackScreen } from "~/server/screening/screen-wire";
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
const deferred = (snapshot: Snapshot) =>
  unpackScreen(
    packScreen({
      snapshots: [snapshot],
      candidates: [],
      errors: [],
      excluded: [],
      asOf: null,
      total: 1,
      elapsedMs: 0,
    }),
    true,
  ).snapshots[0]!;

it("reuses JSON directly from columnar values and detects revisions despite unchanged IDs", () => {
  const cache = new SnapshotSerializer();
  cache.stringify(source);
  const lazy = deferred(structuredClone(source));
  expect(cache.stringify(lazy)).toBe(JSON.stringify(source));
  expect(Object.getOwnPropertyDescriptor(lazy, "bars")?.get).toBeTypeOf(
    "function",
  );
  for (const field of [
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
  ] as const) {
    cache.stringify(source);
    const revised = structuredClone(source);
    revised.bars[0]![field] += 1;
    const next = deferred(revised);
    expect(cache.stringify(next)).toBe(JSON.stringify(revised));
    expect(Object.getOwnPropertyDescriptor(next, "bars")?.get).toBeUndefined();
  }
  const changedDate = structuredClone(source);
  changedDate.bars[0]!.date = "2026-09-09";
  expect(cache.stringify(deferred(changedDate))).toBe(
    JSON.stringify(changedDate),
  );
  const renamed = deferred(source);
  renamed.name = "新名称";
  expect(cache.stringify(renamed)).toBe(JSON.stringify(renamed));
});

it("deferred cache respects edits after materialization, replacement, eviction and root key order", () => {
  const cache = new SnapshotSerializer();
  cache.stringify(source);
  const accessed = deferred(source);
  accessed.bars[0]!.close = 999;
  expect(cache.stringify(accessed)).toBe(JSON.stringify(accessed));
  const replaced = deferred(source);
  replaced.bars = [];
  expect(cache.stringify(replaced)).toBe(JSON.stringify(replaced));
  const noCache = new SnapshotSerializer(0);
  expect(noCache.stringify(deferred(source))).toBe(JSON.stringify(source));
  cache.stringify(source);
  const reordered = deferred(source);
  const time = reordered.createdAt;
  delete (reordered as Partial<Snapshot>).createdAt;
  reordered.createdAt = time;
  expect(cache.stringify(reordered)).toBe(JSON.stringify(reordered));
});
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
