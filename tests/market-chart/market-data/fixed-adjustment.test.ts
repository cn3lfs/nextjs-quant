import { expect, it } from "vitest";
import {
  adjustmentFactors,
  applyAdjustmentAtAnchor,
  applyAdjustmentByDate,
} from "tstdx/local";
import { prepareStrategy, researchCandidates } from "trading-strategies";
import {
  causalResearchPrices,
  hasCausalPriceProof,
  requiresCausalPriceBasis,
} from "~/server/research/causal-price-basis";
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

it("prevents a future split from flipping an absolute-price rule and binds the selected signals", () => {
  const start = [bar("2026-01-01", 10), bar("2026-01-02", 10)];
  const extended = [...start, bar("2026-01-05", 5)];
  const split = {
    date: "2026-01-05",
    category: 11,
    name: "扩缩股",
    shrinkRatio: 2,
  };
  const strategy = {
    ...researchCandidates(["sh600000"], "cn-equity")[0]!.strategy,
    entry: {
      kind: "formula" as const,
      source: "P:=MA(C,2); 选股:P>N1;",
      parameters: { N1: 8 },
    },
  };
  expect(requiresCausalPriceBasis(strategy)).toBe(true);
  expect(
    requiresCausalPriceBasis({
      ...strategy,
      entry: { kind: "formula", source: "选股:C>MA(C,2);" },
    }),
  ).toBe(true);
  expect(
    requiresCausalPriceBasis({ ...strategy, exit: { rule: strategy.entry } }),
  ).toBe(true);
  expect(
    requiresCausalPriceBasis(
      researchCandidates(["sh600000"], "cn-equity").find(
        (c) => c.family === "double-breakout",
      )!.strategy,
    ),
  ).toBe(true);
  const before = causalResearchPrices(start, [], "fixture-actions", []);
  const after = causalResearchPrices(extended, [split], "fixture-actions", []);
  const forward = applyAdjustmentByDate(
    extended,
    adjustmentFactors(extended, [split]),
    "forward",
  );
  expect(prepareStrategy(strategy, before.bars).evaluate(1).entry).toBe(true);
  expect(prepareStrategy(strategy, after.bars).evaluate(1).entry).toBe(true);
  expect(prepareStrategy(strategy, forward).evaluate(1).entry).toBe(false);
  expect(after.bars.slice(0, start.length)).toEqual(before.bars);
  expect(hasCausalPriceProof(after.proof, extended, after.bars)).toBe(true);
  expect(hasCausalPriceProof(after.proof, extended, forward)).toBe(false);
  expect(() =>
    causalResearchPrices(extended, [], "fixture-actions", [
      { reason: "unparsed record" },
    ]),
  ).toThrow("GBBQ evidence");
});
