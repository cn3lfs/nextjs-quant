import { expect, it } from "vitest";
import { packScreen, unpackScreen } from "../../src/server/screening/screen-wire";
import type { ScreeningResult } from "../../src/server/screening/screening";
import type { Snapshot } from "../../src/lib/domain";
const bar = {
  date: "2026-09-08T15:00:00+08:00",
  open: 10.123456789,
  high: 12,
  low: 9,
  close: 11.010000000000002,
  volume: 123456789,
  amount: 9007199254740991,
};
const snapshot: Snapshot = {
  id: "s",
  symbol: "sh600519",
  period: "5m",
  source: "tdx-local",
  adjustment: "none",
  createdAt: 123,
  hash: "hash",
  name: "贵州茅台",
  bars: [
    bar,
    { ...bar, date: "2026-09-09T09:35:00+08:00", volume: 0, amount: 0 },
  ],
};
const fixture = (): ScreeningResult => ({
  candidates: [],
  snapshots: [
    structuredClone(snapshot),
    { ...structuredClone(snapshot), id: "s2", symbol: "sh600001" },
  ],
  errors: [],
  excluded: [],
  asOf: "2026-09-08T15:00:00+08:00",
  total: 2,
  elapsedMs: 12,
  cacheHit: true,
});
it("columnar transfer preserves all fields, float precision, shared dates and snapshot isolation", () => {
  const original = fixture(),
    packed = packScreen(original);
  expect(packed.dates).toHaveLength(2);
  expect(packed.values).toHaveLength(24);
  const transported = structuredClone(packed, {
    transfer: [packed.values.buffer, packed.dateIndexes.buffer],
  });
  expect(packed.values.byteLength).toBe(0);
  const restored = unpackScreen(transported);
  expect(restored).toEqual(original);
  restored.snapshots[0]!.bars[0]!.close = 999;
  expect(original.snapshots[0]!.bars[0]!.close).toBe(bar.close);
  expect(restored.snapshots[1]!.bars[0]!.close).toBe(bar.close);
  const empty = { ...fixture(), snapshots: [] };
  expect(unpackScreen(packScreen(empty))).toEqual(empty);
});
it.each([false, true])(
  "rejects malformed transfer before returning (lazy=%s)",
  (lazy) => {
    const truncated = packScreen(fixture());
    truncated.values = truncated.values.slice(1);
    expect(() => unpackScreen(truncated, lazy)).toThrow("不完整");
    const overlap = packScreen(fixture());
    overlap.snapshots[1]!.offset = 0;
    expect(() => unpackScreen(overlap, lazy)).toThrow("边界");
    const missing = packScreen(fixture());
    missing.dateIndexes[0] = 100;
    expect(() => unpackScreen(missing, lazy)).toThrow("日期");
  },
);

it("deferred bars materialize independently and preserve assignment and JSON", () => {
  const original = fixture();
  const restored = unpackScreen(packScreen(original), true);
  expect(
    Object.getOwnPropertyDescriptor(restored.snapshots[0]!, "bars")?.get,
  ).toBeTypeOf("function");
  expect(JSON.stringify(restored)).toBe(
    JSON.stringify(unpackScreen(packScreen(original))),
  );
  restored.snapshots[0]!.bars[0]!.close = 500;
  expect(restored.snapshots[1]!.bars[0]!.close).toBe(bar.close);
  expect(original.snapshots[0]!.bars[0]!.close).toBe(bar.close);
  const assigned = unpackScreen(packScreen(original), true).snapshots[0]!;
  assigned.bars = [];
  expect(assigned.bars).toEqual([]);
  expect(
    Object.getOwnPropertyDescriptor(assigned, "bars")?.get,
  ).toBeUndefined();
});
