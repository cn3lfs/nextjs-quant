import { expect, it } from "vitest";
import { cashAdjustedSignals } from "../../src/server/backtest/cash-adjusted-signals";
import { backtest } from "../../src/server/backtest/quant";
import { defaultStrategy } from "../../src/lib/domain";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
import type { CashDividendPlan } from "../../src/lib/portfolio/cash-dividends";
const bars = [8, 9, 10, 11, 12, 13, 9.2, 9.5, 10].map((p, i) => ({
  date: `2025-01-${String(i + 1).padStart(2, "0")}`,
  open: p,
  close: p,
  high: p + 1,
  low: p - 1,
  volume: 10000,
  amount: p * 10000,
}));
const plan: CashDividendPlan = {
  version: "cash-dividends-2",
  signalStart: "2025-01-01",
  reconciliationHash: "a".repeat(64),
  taxBps: 0,
  events: [
    {
      id: "cash",
      announcement: "2025-01-01",
      record: "2025-01-06",
      ex: "2025-01-07",
      pay: "2025-01-08",
      perShare: 4,
    },
  ],
};
const strategy = {
  ...defaultStrategy,
  fast: 2,
  slow: 3,
  minChange: -100,
  maxChange: 100,
  minVolumeRatio: 0,
};
const costs = {
  ...defaultBacktestCosts,
  commissionBps: 0,
  minimumCommission: 0,
  slippageBps: 0,
  sellTaxBps: 0,
};
it("preserves raw inputs and earlier prices when future dividends are added; tax does not alter gross price factors", () => {
  const original = structuredClone(bars),
    adjusted = cashAdjustedSignals(bars, plan);
  expect(adjusted.bars.slice(0, 6)).toEqual(bars.slice(0, 6));
  expect(adjusted.bars[6]!.close).toBeCloseTo((9.2 * 13) / 9, 12);
  expect(bars).toEqual(original);
  expect(adjusted.bars.map((b) => [b.volume, b.amount])).toEqual(
    bars.map((b) => [b.volume, b.amount]),
  );
  const future = structuredClone(plan);
  future.events.push({
    ...plan.events[0]!,
    id: "future",
    record: "2025-01-20",
    ex: "2025-01-21",
    pay: "2025-01-22",
    perShare: 2,
  });
  expect(cashAdjustedSignals(bars, future).bars).toEqual(adjusted.bars);
  expect(cashAdjustedSignals(bars, { ...plan, taxBps: 2000 }).bars).toEqual(
    adjusted.bars,
  );
});
it("applies skipped cash dates at the next observed bar and rejects impossible reference prices", () => {
  const skipped = bars.filter((b) => b.date !== "2025-01-07");
  expect(cashAdjustedSignals(skipped, plan).metadata.changes[0]).toMatchObject({
    effectiveDate: "2025-01-07",
    appliedOn: "2025-01-08",
    factor: 13 / 9,
  });
  expect(() =>
    cashAdjustedSignals(bars, {
      ...plan,
      events: [{ ...plan.events[0]!, perShare: 13 }],
    }),
  ).toThrow("参考价非正");
});
it("avoids a mechanical ex-dividend trend exit while retaining raw fills and legacy replay", () => {
  const adjusted = backtest(bars, strategy, "s", 100000, costs, 3, plan);
  const legacyPlan = { ...plan, version: "cash-dividends-1" as const };
  const legacy = backtest(bars, strategy, "s", 100000, costs, 3, legacyPlan);
  expect(adjusted.engineVersion).toBe("backtest-5");
  expect(adjusted.assumptions).not.toContain(
    "单只 A 股、不复权；跨除权事件不能用于正式收益评价",
  );
  expect(legacy.engineVersion).toBe("backtest-4");
  expect(legacy.signalAdjustment).toBeUndefined();
  expect(adjusted.trades.filter((t) => t.side === "sell")).toHaveLength(0);
  expect(legacy.trades.some((t) => t.side === "sell")).toBe(true);
  expect(adjusted.trades[0]!.price).toBe(12);
  expect(backtest(bars, strategy, "s", 100000, costs, 3, legacyPlan)).toEqual(
    legacy,
  );
  expect(() =>
    backtest(bars, strategy, "s", 100000, costs, 3, {
      ...plan,
      signalStart: "2025-01-03",
    }),
  ).toThrow("预热");
});
it("future events cannot change earlier trades or equity, and pre-entry dividends earn no entitlement", () => {
  const original = backtest(bars, strategy, "s", 100000, costs, 3, plan);
  const future = structuredClone(plan);
  future.events.push({
    ...plan.events[0]!,
    id: "later",
    record: "2025-01-20",
    ex: "2025-01-21",
    pay: "2025-01-22",
    perShare: 2,
  });
  const extended = backtest(bars, strategy, "s", 100000, costs, 3, future);
  expect(extended.trades).toEqual(original.trades);
  expect(extended.equity).toEqual(original.equity);
  const late = backtest(bars, strategy, "s", 100000, costs, 7, plan);
  expect(late.signalAdjustment!.changes).toHaveLength(1);
  expect(late.dividends!.strategy.paid).toBe(0);
  expect(late.dividends!.benchmark.paid).toBe(0);
});
