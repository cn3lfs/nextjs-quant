import { expect, it } from "vitest";
import {
  prepareStrategy,
  prepareStrategyRulePoints,
  type StrategyObjectInput,
} from "../src/strategy-object.js";
const bars = Array.from({ length: 220 }, (_, i) => {
  const close = 20 + Math.sin(i / 6) * 2 + i / 100;
  return {
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: close - 0.1,
    high: close + 0.4,
    low: close - 0.4,
    close,
    volume: 1000 + (i % 17),
    amount: 10000,
  };
});
const identity = {
  definitionHash: "a".repeat(64),
  buildHash: "b".repeat(64),
  sourceHashes: { original: "c".repeat(64) },
  observationSourceHashes: { actual: "d".repeat(64) },
};
const strategy: StrategyObjectInput = {
  id: "genuine-db",
  version: 2,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sh600000"] },
  entry: { kind: "double-breakout", side: "entry" },
  exit: {
    rule: { kind: "double-breakout", side: "exit" },
    stop: { kind: "atr", period: 14, multiple: 3 },
    chandelier: { period: 14, multiple: 3 },
  },
  sizing: { kind: "weight", weight: 0.1 },
  sleeve: "swing",
};
it("projects full-history original DB decisions and evidence onto bounded bars without resetting recurrences", () => {
  const dates = bars.slice(-5).map((b) => b.date);
  const group = prepareStrategyRulePoints(strategy, bars, {}, dates, identity);
  const full = prepareStrategy(strategy, bars),
    bounded = bars.slice(-61);
  const projected = prepareStrategy(strategy, bounded, {
    preparedRules: [group],
  });
  for (const date of dates) {
    const i = bars.findIndex((b) => b.date === date),
      j = bounded.findIndex((b) => b.date === date);
    expect(projected.evaluate(j)).toEqual(full.evaluate(i));
    expect(projected.explain(j)).toEqual(full.explain(i));
  }
  expect(() => projected.evaluate(0)).toThrow(
    "Missing genuine full-history rule observation",
  );
  expect(group.points[0]!.sourceHashes).toEqual(
    identity.observationSourceHashes,
  );
  expect(group.strategy.entry.kind).toBe("double-breakout");
});
it("rejects another definition, build, price basis, noncausal point and mismatched signal price", () => {
  const group = prepareStrategyRulePoints(
    strategy,
    bars,
    {},
    [bars.at(-1)!.date],
    identity,
  );
  expect(() =>
    prepareStrategy({ ...strategy, version: 3 }, bars, {
      preparedRules: [group],
    }),
  ).toThrow("mismatched");
  expect(() =>
    prepareStrategy(strategy, bars, {
      preparedRules: [{ ...group, strategyBuildHash: "other" }],
    }),
  ).toThrow("mismatched");
  expect(() =>
    prepareStrategy(strategy, bars, {
      preparedRules: [
        {
          ...group,
          points: group.points.map((p) => ({
            ...p,
            availableAt: "2099-01-01",
          })),
        },
      ],
    }),
  ).toThrow("mismatched");
  const changed = bars.map((b, i) =>
    i === bars.length - 1 ? { ...b, close: b.close + 0.01 } : b,
  );
  expect(() =>
    prepareStrategy(strategy, changed, { preparedRules: [group] }).evaluate(
      changed.length - 1,
    ),
  ).toThrow("price basis");
});
