import { maBaselineSignals } from "trading-strategies";
import {
  factorStrategyPresets,
  factorStrategySchema,
  factorStrategySignals,
  factorStrategyWarmup,
} from "trading-strategies";
import { expect, it } from "vitest";
import {
  runMaBaseline,
  runStrategyExperiment,
  strategyExperimentInputSchema,
  type Bar,
} from "../src/index.js";

function bars(): Bar[] {
  return Array.from({ length: 96 }, (_, i) => {
    const minute = i % 48 < 24 ? 575 + (i % 48) * 5 : 785 + ((i % 48) - 24) * 5;
    const close = 10 + Math.sin(i / 4);
    return {
      date: `${i < 48 ? "2026-10-09" : "2026-10-12"}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`,
      open: close,
      close,
      high: close + 1,
      low: close - 1,
      volume: 100 + i,
      amount: close * (100 + i),
    };
  });
}
const input = strategyExperimentInputSchema.parse({
  symbol: "sh600519",
  start: "2026-10-12",
  end: "2026-10-12",
});
it("modular SMA5/20 is signal- and execution-equivalent to the baseline", () => {
  const data = bars(),
    strategy = factorStrategyPresets[0]!;
  expect(factorStrategyWarmup(strategy)).toBe(20);
  expect(factorStrategySignals(data, strategy).values).toEqual(
    maBaselineSignals(data),
  );
  const modular = runStrategyExperiment(
      { ...input, strategy: factorStrategySchema.parse(strategy) },
      data,
    ),
    baseline = runMaBaseline(input, data);
  for (const key of [
    "fills",
    "orders",
    "cash",
    "shares",
    "totalReturn",
    "maxDrawdown",
    "equity",
  ] as const)
    expect(modular[key]).toEqual(baseline[key]);
  expect(runStrategyExperiment(input, data)).toEqual(baseline);
});
it("applies level/any/all rules, propagates missing evidence, and prioritizes exit", () => {
  const strategy = structuredClone(factorStrategyPresets[0]!);
  strategy.entry = {
    mode: "all",
    conditions: [
      { left: { id: "close" }, operator: "gt", right: { constant: 0 } },
    ],
  };
  strategy.exit = {
    mode: "any",
    conditions: [
      { left: { id: "close" }, operator: "lt", right: { constant: 0 } },
    ],
  };
  expect(
    [...factorStrategySignals(bars(), strategy).values].slice(0, 4),
  ).toEqual([0, 1, 1, 1]);
  strategy.exit.conditions[0]!.operator = "gt";
  expect(
    [...factorStrategySignals(bars(), strategy).values].slice(0, 4),
  ).toEqual([0, -1, -1, -1]);
  strategy.exit.conditions = [
    { left: { id: "rsi" }, operator: "lt", right: { constant: 20 } },
  ];
  const flat = bars().map((b) => ({
    ...b,
    open: 10,
    close: 10,
    high: 11,
    low: 9,
  }));
  expect(
    [...factorStrategySignals(flat, strategy).values].every((v) => v === 0),
  ).toBe(true);
  strategy.entry.conditions.push({
    left: { id: "close" },
    operator: "lt",
    right: { constant: 0 },
  });
  strategy.exit = {
    mode: "all",
    conditions: [
      { left: { id: "close" }, operator: "lt", right: { constant: 0 } },
    ],
  };
  expect(factorStrategySignals(bars(), strategy).values[30]).toBe(0);
  strategy.entry.mode = "any";
  expect(factorStrategySignals(bars(), strategy).values[30]).toBe(1);
});
it("freezes public IDs/defaults, rejects malformed inputs, and preserves signal prefixes", () => {
  const strategy = structuredClone(factorStrategyPresets[0]!);
  strategy.entry.conditions[0]!.left = {
    id: "qlib-MA",
    parameters: { period: 60 },
  };
  expect(factorStrategyWarmup(strategy)).toBe(60);
  expect(
    factorStrategySchema.parse(strategy).entry.conditions[0]!.left.parameters,
  ).toEqual({ period: 60 });
  expect(
    factorStrategySchema.safeParse({
      ...strategy,
      entry: { mode: "all", conditions: [] },
    }).success,
  ).toBe(false);
  expect(
    factorStrategySchema.safeParse({ ...strategy, runCode: "arbitrary" })
      .success,
  ).toBe(false);
  strategy.entry.conditions[0]!.left = {
    id: "qlib-MA",
    parameters: { period: -1 },
  };
  expect(factorStrategySchema.safeParse(strategy).success).toBe(false);
  for (const preset of factorStrategyPresets)
    expect(factorStrategySignals(bars(), preset).values.slice(0, 70)).toEqual(
      factorStrategySignals(bars().slice(0, 70), preset).values,
    );
});
