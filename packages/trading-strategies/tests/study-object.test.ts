import { expect, it } from "vitest";
import {
  prepareStrategy,
  strategyObjectSchema,
  prepareStrategyRulePoints,
  type StrategyObjectInput,
} from "../src/strategy-object.js";
const bars = Array.from({ length: 330 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1000,
  amount: 100000,
}));
const strategy: StrategyObjectInput = {
  id: "study",
  version: 1,
  market: "crypto",
  period: "day",
  universe: { kind: "symbols", symbols: ["BTCUSDT"] },
  entry: { kind: "study-rule", strategy: "rsi2", side: "entry" },
  exit: { rule: { kind: "study-rule", strategy: "rsi2", side: "exit" } },
  sizing: { kind: "weight", weight: 0.1 },
  sleeve: "swing",
};
it("time exits depend on confirmed fill index, not first signal or hypothetical trades", () => {
  const rule = prepareStrategy(strategy, bars);
  expect(rule.evaluate(320).exit).toBe(false);
  expect(rule.evaluate(320, { entry: 100, entryIndex: 320 }).exit).toBe(false);
  expect(rule.evaluate(320, { entry: 100, entryIndex: 309 }).exit).toBe(true);
  expect(rule.evaluate(100)).toMatchObject({ entry: false, exit: null });
});
it("refuses non-daily and account-only study rules", () => {
  expect(() =>
    strategyObjectSchema.parse({ ...strategy, period: "4h" }),
  ).toThrow("daily");
  expect(() =>
    prepareStrategy(
      {
        ...strategy,
        entry: { kind: "study-rule", strategy: "grid", side: "entry" },
      },
      bars,
    ),
  ).toThrow("account-only");
  expect(() =>
    prepareStrategyRulePoints(strategy, bars, {}, [bars[320]!.date], {
      definitionHash: "a".repeat(64),
      buildHash: "b".repeat(64),
      sourceHashes: { fixture: "c".repeat(64) },
    }),
  ).toThrow("cannot be projected");
});
