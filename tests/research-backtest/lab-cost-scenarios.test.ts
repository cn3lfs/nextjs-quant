import { describe, expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { strategyObjectSchema } from "trading-strategies";
import {
  executionCostsForDate,
  researchCostScenarios,
  researchExecutionCosts,
  type ResearchCostScenario,
} from "trading-strategy-core/costs";
import { labBacktestSchema } from "~/lib/research/lab-backtest";

const dates = ["2023-08-28", "2023-08-29"] as const;
const symbols = Array.from(
  { length: 12 },
  (_, index) => `sh6${String(index).padStart(5, "0")}`,
);

function bars(days: readonly string[], volume = 1_000_000) {
  return days.map((date) => ({
    date,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume,
    amount: 10 * volume,
  }));
}

function instrument(symbol: string, days: readonly string[], volume?: number) {
  const rows = bars(days, volume);
  return {
    symbol,
    market: "cn-equity" as const,
    bars: rows,
    signalBars: rows,
    execution: {
      evidence: "frozen cost-scenario fixture",
      minimum: 100,
      step: 100,
      limitUp: null,
      limitDown: null,
      tradable: true,
    },
  };
}

function strategy(universe: string[], exit: { maxBars?: number } = {}) {
  return strategyObjectSchema.parse({
    id: "cost-scenario-fixture",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: universe },
    entry: { kind: "constant", value: true },
    exit,
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  });
}

/** One frozen request shape is reused by every scenario assertion. */
function frozenRequest(
  universe: string[],
  days: readonly string[],
  options: {
    costScenario?: ResearchCostScenario;
    maxPositions?: number;
    zeroVolumeSymbol?: string;
    exit?: { maxBars?: number };
  } = {},
): PortfolioRequest {
  const rows = universe.map((symbol) =>
    instrument(
      symbol,
      days,
      symbol === options.zeroVolumeSymbol ? 0 : undefined,
    ),
  );
  return {
    market: "cn-equity",
    initial: 1_000_000,
    start: days[0]!,
    end: days.at(-1)!,
    calendar: [...days],
    instruments: rows,
    strategies: [strategy(universe, options.exit)],
    sleeves: [
      {
        id: "swing",
        share: 1,
        riskPerTrade: 0.01,
        maxPositions: options.maxPositions ?? 10,
      },
    ],
    ...(options.costScenario
      ? { costs: researchExecutionCosts("cn-equity", options.costScenario) }
      : {}),
  };
}

describe("shared research cost scenarios", () => {
  it("keeps fixed as the legacy lab default and exposes only declared scenarios", () => {
    expect(researchCostScenarios).toEqual(["fixed", "base", "double-cost"]);
    const fixed = researchExecutionCosts("cn-equity", "fixed");
    expect(fixed).toMatchObject({
      commissionBps: 3,
      minimumCommission: 5,
      sellTaxBps: 5,
      slippageBps: 5,
    });
    expect(fixed.sellTaxSchedule).toBeUndefined();
    const base = researchExecutionCosts("cn-equity", "base");
    expect(base.sellTaxSchedule).toEqual({
      kind: "cn-equity-historical",
      multiplier: 1,
    });
    const baseBefore = executionCostsForDate(base, "2023-08-27");
    const baseAfter = executionCostsForDate(base, "2023-08-28");
    expect(baseBefore.sellTaxBps).toBe(10);
    expect(baseAfter.sellTaxBps).toBe(5);
    const double = researchExecutionCosts("cn-equity", "double-cost");
    expect(double).toMatchObject({
      commissionBps: 6,
      minimumCommission: 10,
      sellTaxBps: 10,
      slippageBps: 10,
    });
    expect(double.sellTaxSchedule).toEqual({
      kind: "cn-equity-historical",
      multiplier: 2,
    });
    const doubleBefore = executionCostsForDate(double, "2023-08-27");
    const doubleAfter = executionCostsForDate(double, "2023-08-28");
    expect(doubleBefore.sellTaxBps).toBe(20);
    expect(doubleAfter.sellTaxBps).toBe(10);
    expect(researchExecutionCosts("crypto", "fixed")).toMatchObject({
      commissionBps: 10,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 5,
    });
    expect(researchExecutionCosts("crypto", "double-cost")).toMatchObject({
      commissionBps: 20,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 10,
    });
  });

  it("accepts fixed, base and double-cost with fixed as the schema default", () => {
    const value = {
      strategy: strategy(["sh600000"]),
      start: "2023-08-01",
      end: "2023-08-31",
      initial: 1_000_000,
    };
    expect(labBacktestSchema.parse(value).costScenario).toBe("fixed");
    for (const costScenario of researchCostScenarios) {
      const parsed = labBacktestSchema.parse({ ...value, costScenario });
      expect(parsed.costScenario).toBe(costScenario);
    }
    expect(() =>
      labBacktestSchema.parse({ ...value, costScenario: "zero-cost" }),
    ).toThrow();
  });
});

describe("common frozen request under cost scenarios", () => {
  it("keeps the fixed scenario exactly equal to the legacy default equity", () => {
    const requests = [undefined, "fixed"] as const;
    const results = requests.map((costScenario) =>
      runPortfolio(frozenRequest(symbols, dates, { costScenario })),
    );
    expect(results[1]!.curve).toEqual(results[0]!.curve);
    expect(results[1]!.fills).toEqual(results[0]!.fills);
    expect(results[1]!.orders).toEqual(results[0]!.orders);
    expect(results[1]!.rejections).toEqual(results[0]!.rejections);
  });

  it("records the same per-order rejections under every scenario", () => {
    const runs = researchCostScenarios.map((costScenario) => ({
      costScenario,
      result: runPortfolio(
        frozenRequest(symbols, dates, {
          costScenario,
          zeroVolumeSymbol: symbols[0]!,
        }),
      ),
    }));
    for (const { result } of runs) {
      expect(result.fills.length).toBe(10);
      expect(result.rejections).toHaveLength(2);
      expect(result.rejections.map((row) => row.reason).sort()).toEqual(
        ["sleeve持仓上限", "停牌或缺少可交易行情"].sort(),
      );
    }
    const reference = runs[0]!.result.rejections.map(
      ({ orderId, date, reason }) => ({
        orderId,
        date,
        reason,
      }),
    );
    for (const { result } of runs.slice(1))
      expect(
        result.rejections.map(({ orderId, date, reason }) => ({
          orderId,
          date,
          reason,
        })),
      ).toEqual(reference);
  });

  it("switches historical stamp duty on the frozen sell dates", () => {
    const windows = [
      {
        days: ["2023-08-23", "2023-08-24", "2023-08-25"],
        taxBps: 10,
      },
      {
        days: ["2023-08-28", "2023-08-29", "2023-08-30"],
        taxBps: 5,
      },
    ];
    for (const row of windows)
      for (const costScenario of ["base", "double-cost"] as const) {
        const result = runPortfolio(
          frozenRequest(["sh600000"], row.days, {
            costScenario,
            exit: { maxBars: 1 },
          }),
        );
        const sell = result.fills.find((fill) => fill.side === "sell");
        expect(sell).toBeDefined();
        const amount = sell!.quantity * sell!.price;
        const multiplier = costScenario === "double-cost" ? 2 : 1;
        const commission = Math.max(
          5 * multiplier,
          amount * ((3 * multiplier) / 10000),
        );
        const tax = amount * ((row.taxBps * multiplier) / 10000);
        expect(sell!.fee).toBeCloseTo(commission + tax, 6);
      }
  });

  it("keeps fixed stamp duty unchanged across the historical boundary", () => {
    for (const days of [
      ["2023-08-23", "2023-08-24", "2023-08-25"],
      ["2023-08-28", "2023-08-29", "2023-08-30"],
    ] as const) {
      const result = runPortfolio(
        frozenRequest(["sh600000"], days, {
          costScenario: "fixed",
          exit: { maxBars: 1 },
        }),
      );
      const sell = result.fills.find((fill) => fill.side === "sell");
      expect(sell).toBeDefined();
      const amount = sell!.quantity * sell!.price;
      expect(sell!.fee).toBeCloseTo(
        Math.max(5, amount * (3 / 10000)) + amount * (5 / 10000),
        6,
      );
    }
  });
});
