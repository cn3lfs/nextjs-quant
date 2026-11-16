import { expect, it } from "vitest";
import {
  adjustmentFactors,
  applyAdjustmentAtAnchor,
  applyAdjustmentByDate,
} from "tstdx/local";
const bar = (date: string, close: number) => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: 1000,
});
it("keeps the exact anchored prefix when a future bonus and cash dividend arrive", () => {
  const old = [bar("2026-01-01", 10), bar("2026-01-02", 10)];
  const next = [...old, bar("2026-01-03", 5), bar("2026-01-04", 4.9)];
  const oldFactors = adjustmentFactors(old, []),
    factors = adjustmentFactors(next, [
      { date: "2026-01-03", category: 1, name: "除权除息", bonusRatio: 1 },
      { date: "2026-01-04", category: 1, name: "除权除息", dividend: 0.1 },
    ]);
  const anchor = oldFactors[0]!;
  const before = applyAdjustmentAtAnchor(old, oldFactors, anchor);
  const after = applyAdjustmentAtAnchor(next, factors, anchor);
  expect(JSON.stringify(after.slice(0, old.length))).toBe(
    JSON.stringify(before),
  );
  expect(after.slice(0, 3).map((b) => b.close)).toEqual([10, 10, 10]);
  expect(after[3]!.close).toBeCloseTo(10, 12);
  expect(after.map((b) => [b.volume, b.amount])).toEqual(
    next.map((b) => [b.volume, b.amount]),
  );
  expect(applyAdjustmentByDate(next, factors, "forward")[0]!.close).not.toBe(
    before[0]!.close,
  );
});
it("requires the actual frozen anchor and complete date factors, without guessing a neutral multiplier", () => {
  const raw = [bar("2026-01-01", 10), bar("2026-01-02", 9)];
  const factors = adjustmentFactors(raw, []);
  expect(() =>
    applyAdjustmentAtAnchor(raw, factors, { date: raw[0]!.date, factor: 2 }),
  ).toThrow("固定复权锚");
  expect(() =>
    applyAdjustmentAtAnchor(raw, factors.slice(0, 1), factors[0]!),
  ).toThrow("日期因子缺失");
  expect(() =>
    applyAdjustmentAtAnchor(
      raw,
      [{ ...factors[0]!, factor: NaN }],
      factors[0]!,
    ),
  ).toThrow("因子");
});
