import { expect, it } from "vitest";
import { runBacktest } from "../src/index.js";
import {
  fillMarketOrder,
  affordableQuantity,
  type ExecutionRules,
} from "../src/execution.js";
import { defaultExecutionCosts } from "../src/costs.js";

const rules: ExecutionRules = {
  evidence: "fixture historical limits",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 2000,
  limitUp: 11,
  limitDown: 9,
  tradable: true,
};
const bar = {
  date: "2026-10-12T09:35:00+08:00",
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 1000,
  amount: 10000,
};
it("declared historical price limits reject unverifiable fills and missing evidence", () => {
  expect(
    fillMarketOrder({ ...bar, open: 11 }, "buy", rules, defaultExecutionCosts)
      .reason,
  ).toContain("涨停");
  expect(
    fillMarketOrder({ ...bar, open: 9 }, "sell", rules, defaultExecutionCosts)
      .reason,
  ).toContain("跌停");
  expect(
    fillMarketOrder(bar, "buy", null, defaultExecutionCosts).reason,
  ).toContain("依据");
  expect(
    fillMarketOrder(
      bar,
      "buy",
      { ...rules, tradable: false },
      defaultExecutionCosts,
    ).reason,
  ).toContain("停牌");
  expect(affordableQuantity(1e7, 10, rules, defaultExecutionCosts)).toBe(2000);
});
it("event engine consumes a signal series independently of the MA strategy", () => {
  const bars = [bar, { ...bar, date: "2026-10-12T09:40:00+08:00" }];
  const input = {
    symbol: "fixture",
    start: "2026-10-12",
    end: "2026-10-12",
    initial: 100000,
    costs: defaultExecutionCosts,
  };
  const result = runBacktest(
    input,
    bars,
    { id: "injected-test-only", warmupBars: 0, values: Int8Array.from([1, 0]) },
    rules,
  );
  expect(result.strategyId).toBe("injected-test-only");
  expect(result.fills).toHaveLength(1);
  expect(result.fills[0]!.signalAt).toBe(bar.date);
  expect(result.fills[0]!.shares).toBe(2000);
  expect(() =>
    runBacktest(
      input,
      bars,
      { id: "bad", warmupBars: 0, values: Int8Array.from([2, 0]) },
      rules,
    ),
  ).toThrow("信号");
  expect(() =>
    runBacktest(
      input,
      bars,
      { id: "bad", warmupBars: 0, values: Int8Array.from([1]) },
      rules,
    ),
  ).toThrow("长度");
});
