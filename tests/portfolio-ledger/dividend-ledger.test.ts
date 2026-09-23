import { expect, it } from "vitest";
import { DividendLedger } from "../../src/server/backtest/dividend-ledger";
import { backtest } from "../../src/server/backtest/quant";
import { defaultStrategy } from "../../src/lib/domain";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
import type { CashDividendPlan } from "../../src/lib/portfolio/cash-dividends";
const plan = (): CashDividendPlan => ({
  version: "cash-dividends-1",
  reconciliationHash: "a".repeat(64),
  taxBps: 2000,
  events: [
    {
      id: "cash-1",
      announcement: "2025-01-01",
      record: "2025-01-04",
      ex: "2025-01-05",
      pay: "2025-01-07",
      perShare: 1,
    },
  ],
});
it("locks closing entitlement and keeps receivable unavailable until payment close even after shares are sold", () => {
  const l = new DividendLedger(plan());
  expect(l.beforeOpen("2025-01-04", 0)).toBe(0);
  expect(l.afterClose("2025-01-04", 100)).toBe(0);
  expect(l.beforeOpen("2025-01-05", 100)).toBe(0);
  expect(l.receivable).toBe(80);
  l.afterClose("2025-01-05", 0);
  expect(l.beforeOpen("2025-01-07", 0)).toBe(0);
  expect(l.receivable).toBe(80);
  expect(l.afterClose("2025-01-07", 0)).toBe(80);
  expect(l.receivable).toBe(0);
  expect(l.beforeOpen("2025-01-08", 0)).toBe(0);
  l.afterClose("2025-01-08", 0);
  expect(l.snapshot().movements.map((m) => m.phase)).toEqual([
    "entitlement",
    "receivable",
    "payment",
  ]);
  expect(l.snapshot().movements.at(-1)).toMatchObject({
    shares: 100,
    gross: 100,
    tax: 20,
    net: 80,
    effectiveDate: "2025-01-07",
    bookedOn: "2025-01-07",
  });
});
it("record-day sale forfeits entitlement, and skipped observed dates retain actual event dates", () => {
  const sold = new DividendLedger(plan());
  sold.beforeOpen("2025-01-04", 100);
  sold.afterClose("2025-01-04", 0);
  sold.beforeOpen("2025-01-07", 0);
  expect(sold.afterClose("2025-01-07", 0)).toBe(0);
  const skipped = new DividendLedger(plan());
  skipped.beforeOpen("2025-01-03", 0);
  skipped.afterClose("2025-01-03", 100);
  expect(skipped.beforeOpen("2025-01-08", 100)).toBe(80);
  skipped.afterClose("2025-01-08", 100);
  expect(skipped.snapshot().movements[0]).toMatchObject({
    effectiveDate: "2025-01-04",
    bookedOn: "2025-01-08",
    shares: 100,
  });
});
const bars = [10, 10, 10, 10, 9, 9, 9, 9].map((p, i) => ({
  date: `2025-01-${String(i + 1).padStart(2, "0")}`,
  open: p,
  close: p,
  high: p + 1,
  low: p - 1,
  volume: 10000,
  amount: p * 10000,
}));
const strategy = { ...defaultStrategy, fast: 2, slow: 3 };
const costs = {
  ...defaultBacktestCosts,
  commissionBps: 0,
  minimumCommission: 0,
  slippageBps: 0,
  sellTaxBps: 0,
};
it("engine includes receivable in equity without double counting and separates strategy and benchmark entitlements", () => {
  const result = backtest(bars, strategy, "s", 1000, costs, 3, plan());
  expect(result.engineVersion).toBe("backtest-4");
  expect(result.benchmark).toMatchObject({
    cash: 80,
    shares: 100,
    maxDrawdown: 2,
  });
  expect(result.benchmark!.totalReturn).toBeCloseTo(-2, 10);
  expect(result.benchmark!.equity.map((r) => r.value)).toEqual([
    1000, 980, 980, 980, 980,
  ]);
  expect(result.dividends!.strategy.paid).toBe(0);
  expect(result.dividends!.benchmark.paid).toBe(80);
  const future = plan();
  future.events[0]!.pay = "2025-01-20";
  const waiting = backtest(bars, strategy, "s", 1000, costs, 3, future);
  expect(waiting.benchmark!.cash).toBe(0);
  expect(waiting.dividends!.benchmark.receivable).toBe(80);
  expect(waiting.benchmark!.equity).toEqual(result.benchmark!.equity);
  const plain = backtest(bars, strategy, "s", 1000, costs);
  expect(plain.dividends).toBeUndefined();
  expect(plain.engineVersion).toBe("backtest-3");
  expect(plain.benchmark!.equity.at(-1)!.value).toBe(900);
});
it("rejects malformed plans and daily timelines and rounds each event explicitly to cents", () => {
  const invalid = plan();
  invalid.events.push({ ...invalid.events[0]! });
  expect(() => new DividendLedger(invalid)).toThrow();
  const p = plan();
  p.taxBps = 1000;
  p.events[0]!.perShare = 0.0333;
  const l = new DividendLedger(p);
  l.beforeOpen("2025-01-04", 0);
  l.afterClose("2025-01-04", 17);
  l.beforeOpen("2025-01-07", 17);
  expect(l.afterClose("2025-01-07", 17)).toBe(0.51);
  expect(l.snapshot().movements[0]).toMatchObject({
    gross: 0.57,
    tax: 0.06,
    net: 0.51,
  });
  expect(() => l.beforeOpen("2025-01-07", 17)).toThrow("顺序");
  const bad = structuredClone(bars);
  bad[4]!.date = "2025-01-05 10:00";
  expect(() => backtest(bad, strategy, "s", 1000, costs, 3, plan())).toThrow(
    "日线",
  );
});
