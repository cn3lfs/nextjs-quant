import { expect, it } from "vitest";
import {
  evaluateStrategy,
  unifiedStrategyCatalog,
  checkStrategyAvailability,
  createStudyDecision,
} from "../src/index.js";

it("keeps missing capabilities and research registration separate", () => {
  expect(new Set(unifiedStrategyCatalog.map((d) => d.id)).size).toBe(
    unifiedStrategyCatalog.length,
  );
  expect(
    checkStrategyAvailability("rank-value", ["cross-section"]),
  ).toMatchObject({
    available: false,
    missing: ["point-in-time-financials", "market-cap"],
  });
  expect(
    checkStrategyAvailability("pairs", ["cross-section", "short-borrow"]),
  ).toMatchObject({ available: false });
  expect(checkStrategyAvailability("unknown", [])).toMatchObject({
    available: false,
  });
});

it("excludes future/missing observations and ranks equal values by symbol", () => {
  const result = evaluateStrategy(
    { strategyId: "rank-momentum", parameters: { topK: 2 } },
    {
      asOf: "2026-01-05",
      candidates: [
        { symbol: "B", availableAt: "2026-01-05", values: { momentum: 2 } },
        { symbol: "A", availableAt: "2026-01-05", values: { momentum: 2 } },
        { symbol: "F", availableAt: "2026-01-06", values: { momentum: 999 } },
        { symbol: "N", availableAt: "2026-01-05", values: { momentum: null } },
      ],
    },
  );
  expect(result).toEqual({
    kind: "weights",
    weights: [
      { symbol: "A", weight: 0.5 },
      { symbol: "B", weight: 0.5 },
    ],
    excluded: ["F", "N"],
  });
});

it("allocates inverse volatility without reciprocal overflow and rejects invalid dates", () => {
  const result = evaluateStrategy(
    { strategyId: "allocation-inverse-volatility" },
    {
      asOf: "2026-01-05",
      candidates: [
        {
          symbol: "A",
          availableAt: "2026-01-05",
          values: { volatility: 1e-320 },
        },
        {
          symbol: "B",
          availableAt: "2026-01-05",
          values: { volatility: 2e-320 },
        },
      ],
    },
  );
  if (result.kind !== "weights") throw new Error("weights expected");
  expect(result.weights.find((w) => w.symbol === "A")!.weight).toBeCloseTo(
    2 / 3,
  );
  expect(result.weights.find((w) => w.symbol === "B")!.weight).toBeCloseTo(
    1 / 3,
  );
  expect(() =>
    evaluateStrategy(
      { strategyId: "allocation-equal" },
      { asOf: "2026-02-30", candidates: [] },
    ),
  ).toThrow();
});

it("keeps original daily allocation decisions in strategy module", () => {
  const bars = Array.from({ length: 150 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  }));
  const state = {
    cash: 100000,
    shares: 0,
    entry: 0,
    entryIndex: 0,
    anchor: 0,
    core: 0,
    sleeveCap: 0,
    initialized: false,
    lastAllocationMonth: "",
    installments: 0,
  };
  expect(
    createStudyDecision("hold80", bars, bars, 100000, 141)(140, state),
  ).toMatchObject({ side: "buy", fraction: 0.8 });
  expect(state.cash).toBe(100000);
});
