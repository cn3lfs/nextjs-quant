import { describe, expect, it } from "vitest";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import {
  evaluatePortfolioRisk,
  isCnEtfSymbol,
  resolveInstrumentRule,
  sizeEntryWithRisk,
  wilderAtr14Series,
  type PortfolioRiskEntry,
  type PortfolioRiskState,
} from "../src/index.js";

const date = "2025-09-01";
const entry: PortfolioRiskEntry = {
  price: 10,
  stopPrice: 9,
  equity: 100_000,
  cash: 100_000,
  symbol: "sh600000",
  date,
  positions: [],
  industry: "钢铁",
};
const next = (day: string, unitNav: number, previous?: PortfolioRiskState) =>
  evaluatePortfolioRisk({ date: day, unitNav, previous });

describe("completed unit NAV drawdown", () => {
  it("keeps the tier but restarts recovery when a trading close is missing", () => {
    const paused = next("2026-01-05", 0.92);
    const first = next("2026-01-06", 0.98, paused);
    // Jan 7 was a session but its NAV is missing. Jan 8 is day one again.
    expect(
      evaluatePortfolioRisk({
        date: "2026-01-08",
        unitNav: 0.99,
        previous: first,
        previousSessionDate: "2026-01-07",
      }),
    ).toMatchObject({ mode: "paused", recoveryCloses: 1 });
  });
  it("holds the paused state until three qualifying closes, resets on a reversal and counts replay once", () => {
    let s = next("2026-01-05", 1.2);
    s = next("2026-01-06", 1.14, s); // (1.20 - 1.14)/1.20 = exactly 5%
    expect(s).toMatchObject({ mode: "reduced", scale: 0.5, drawdown: 0.05 });
    s = next("2026-01-07", 1.104, s);
    expect(s).toMatchObject({ mode: "paused", scale: 0, drawdown: 0.08 });
    s = next("2026-01-08", 1.164, s);
    expect(s).toMatchObject({ mode: "paused", recoveryCloses: 1 });
    expect(next("2026-01-08", 1.164, s)).toBe(s);
    expect(() => next("2026-01-08", 1.16, s)).toThrow();
    expect(() => next("2026-01-07", 1.164, s)).toThrow();
    s = next("2026-01-09", 1.15, s);
    expect(s.recoveryCloses).toBe(0);
    s = next("2026-01-12", 1.164, s);
    s = next("2026-01-13", 1.17, s);
    expect(s.mode).toBe("paused");
    s = next("2026-01-14", 1.19, s);
    expect(s).toMatchObject({ mode: "normal", scale: 1 });
    expect(next("2026-01-15", 0, s).mode).toBe("paused");
  });
  it("uses initial unit NAV and applies reduced scale even when the request is below every other ceiling", () => {
    const state = next(date, 0.95);
    expect(
      sizeEntryWithRisk({ ...entry, state, requestedQuantity: 200 }),
    ).toMatchObject({
      quantity: 100,
      reasons: ["drawdown_reduced"],
      stopRiskAfter: 100,
    });
    expect(
      sizeEntryWithRisk({ ...entry, state: next(date, 0.92) }),
    ).toMatchObject({
      quantity: 0,
      reasons: ["drawdown_paused"],
    });
  });
  it("uses the scale frozen at the last known close and rejects an invalid or future checkpoint", () => {
    const state = evaluatePortfolioRisk({
      date,
      unitNav: 0.95,
      policy: { reducedScale: 0.25 },
    });
    expect(
      sizeEntryWithRisk({ ...entry, state, requestedQuantity: 400 }).quantity,
    ).toBe(100);
    expect(
      sizeEntryWithRisk({ ...entry, date: "2025-08-29", state }).reasons,
    ).toEqual(["invalid_entry"]);
    expect(() =>
      next("2025-09-02", 0.97, { ...state, peakUnitNav: 0 }),
    ).toThrow("previous");
  });
});

describe("portfolio entry constraints", () => {
  it("keeps industry weight within the hard limit after the minimum commission", () => {
    // 2500 × 10 / (100000 − 5) > 25%; 2400 × 10 / 99995 < 25%.
    const decision = sizeEntryWithRisk({
      ...entry,
      requestedQuantity: 2500,
      policy: { maxSingleInstrumentWeight: 1, riskPerTrade: 1 },
      cashCost: (q) => q * 10 + 5,
    });
    expect(decision).toMatchObject({
      quantity: 2400,
      reasons: ["industry_cap"],
    });
  });
  it("uses 0.5% of equity and a Wilder ATR stop, preserving gaps and causal warm-up", () => {
    const steady = Array.from({ length: 15 }, () => ({
      high: 11,
      low: 9,
      close: 10,
    }));
    const bars = [
      ...steady,
      { high: 14, low: 13, close: 14 },
      { high: 15, low: 13, close: 14 },
    ];
    const series = wilderAtr14Series(bars);
    expect(series.slice(0, 14)).toEqual(Array(14).fill(null));
    expect(series[14]).toBe(2);
    expect(series[15]).toBe((13 * 2 + 4) / 14);
    expect(series[16]).toBe((13 * ((13 * 2 + 4) / 14) + 2) / 14);
    expect(wilderAtr14Series(steady)).toEqual(series.slice(0, 15));
    expect(
      wilderAtr14Series([
        ...bars,
        { high: 0, low: 1, close: 0 },
        ...steady,
      ]).slice(-15),
    ).toEqual(series.slice(0, 15));
    // 500 / (2 * 2) = 125 shares, rounded to 100.
    expect(
      sizeEntryWithRisk({ ...entry, stopPrice: null, atr: series[14] }),
    ).toMatchObject({
      quantity: 100,
      stopPrice: 6,
      stopRiskAfter: 400,
      reasons: ["trade_risk_cap"],
    });
    expect(sizeEntryWithRisk({ ...entry, stopPrice: null })).toMatchObject({
      quantity: 0,
      reasons: ["missing_stop"],
    });
  });
  it("budgets aggregate loss from mark to stop, with a conservative fallback and missing-evidence rejection", () => {
    const positions = [
      {
        symbol: "sh600001",
        quantity: 2400,
        mark: 12,
        stopPrice: 10,
        industry: "银行",
      },
    ];
    expect(sizeEntryWithRisk({ ...entry, positions })).toMatchObject({
      existingStopRisk: 4800,
      quantity: 200,
      stopRiskAfter: 5000,
      reasons: ["total_stop_risk_cap"],
    });
    const unprotected = [{ ...positions[0]!, mark: 20, stopPrice: null }];
    expect(
      sizeEntryWithRisk({ ...entry, positions: unprotected }),
    ).toMatchObject({ existingStopRisk: 4800, quantity: 200 });
    expect(
      sizeEntryWithRisk({
        ...entry,
        positions: unprotected,
        policy: { missingStopFraction: null },
      }),
    ).toMatchObject({
      existingStopRisk: null,
      quantity: 0,
      reasons: ["missing_stop"],
    });
    expect(
      sizeEntryWithRisk({
        ...entry,
        positions: [{ ...positions[0]!, stopPrice: 13 }],
      }).existingStopRisk,
    ).toBe(0);
  });
  it("aggregates all unknown industries in one 25% bucket and existing exposure across duplicate symbol lots", () => {
    const positions = [
      {
        symbol: "sh600001",
        quantity: 2400,
        mark: 10,
        stopPrice: 10,
        industry: " ",
      },
    ];
    expect(
      sizeEntryWithRisk({ ...entry, positions, industry: null }),
    ).toMatchObject({ quantity: 100, reasons: ["industry_cap"] });
    expect(
      sizeEntryWithRisk({ ...entry, positions, industry: "钢铁" }).quantity,
    ).toBe(500);
    const lots = [400, 500].map((quantity) => ({
      symbol: entry.symbol,
      quantity,
      mark: 10,
      stopPrice: 10,
    }));
    expect(sizeEntryWithRisk({ ...entry, positions: lots })).toMatchObject({
      quantity: 100,
      reasons: ["instrument_cap"],
    });
  });
  it("honors independent ETF concentration, all-in cash at the exact boundary and minimum buy size", () => {
    const etf = {
      ...entry,
      symbol: "sh510300",
      stopPrice: 9.9,
      policy: { maxEtfWeight: 0.2 },
    };
    expect(sizeEntryWithRisk(etf).quantity).toBe(2000);
    expect(sizeEntryWithRisk({ ...etf, symbol: "sh600000" }).quantity).toBe(
      1000,
    );
    const cashCost = (q: number) => q * 10 + 5;
    expect(sizeEntryWithRisk({ ...etf, cashCost, cash: 1005 }).quantity).toBe(
      100,
    );
    expect(sizeEntryWithRisk({ ...etf, cashCost, cash: 1004 })).toMatchObject({
      quantity: 0,
      reasons: ["cash_cap", "lot_rounded_zero"],
    });
    const star = { ...entry, symbol: "sh688001" };
    expect(
      sizeEntryWithRisk({ ...star, requestedQuantity: 201 }).quantity,
    ).toBe(201);
    expect(
      sizeEntryWithRisk({ ...star, requestedQuantity: 199 }).reasons,
    ).toContain("lot_rounded_zero");
  });
});

describe("instrument rules and charges by exchange session", () => {
  it("uses the exchange-aware market-panel ETF families consistently", () => {
    const costs = researchExecutionCosts("cn-equity", "base");
    for (const symbol of [
      "sh510300",
      "sh521000",
      "sh530000",
      "560000.SH",
      "580000",
      "sz158000",
      "SZ.159915",
    ]) {
      expect(isCnEtfSymbol(symbol)).toBe(true);
      expect(resolveInstrumentRule(symbol, date)).toMatchObject({
        kind: "etf",
        stampDutyExempt: true,
        transferFeeExempt: true,
      });
      expect(executionCostsForInstrument(costs, symbol, date)).toMatchObject({
        sellTaxBps: 0,
        transferBps: 0,
      });
    }
    for (const symbol of [
      "sh600000",
      "sz000001",
      "bj430047",
      "sh53000",
      "sz1599150",
      "sz150001",
      "sh159915",
      "sz510300",
    ]) {
      expect(isCnEtfSymbol(symbol)).toBe(false);
    }
  });
  it("enforces T+1 on stock and exempts both fees for explicitly exempt instruments", () => {
    expect(() =>
      resolveInstrumentRule("sh600000", date, { instrumentKind: "etf-t0" }),
    ).toThrow("conflicts");
    expect(() =>
      resolveInstrumentRule("sh600000", date, { settlementCycle: "T+0" }),
    ).toThrow("T+1");
    const costs = researchExecutionCosts("cn-equity", "base");
    for (const [symbol, options] of [
      ["sh600000", { stampDutyExempt: true }],
      ["sh510300", { stampDutyExempt: false }],
    ] as const) {
      expect(
        executionCostsForInstrument(costs, symbol, date, options),
      ).toMatchObject({ sellTaxBps: 0, transferBps: 0 });
      expect(resolveInstrumentRule(symbol, date, options)).toMatchObject({
        stampDutyExempt: true,
        transferFeeExempt: true,
      });
    }
  });
  it.each([
    ["sh600000", "equity-main", 100, 100, 1, 0.01],
    ["sz300001", "equity-chinext", 100, 100, 1, 0.01],
    ["688001.SH", "equity-star", 200, 1, 1, 0.01],
    ["bj430047", "equity-bj", 100, 1, 1, 0.01],
    ["sh510300", "etf-equity", 100, 100, 1, 0.001],
    ["sz159915", "etf-equity", 100, 100, 1, 0.001],
    ...[
      "sh511010",
      "sh511880",
      "sz159001",
      "sz159003",
      "sz159649",
      "sh518880",
      "sz159934",
      "sz159937",
      "sh513100",
      "sz159941",
      "sz159509",
    ].map((s) => [s, "etf-t0", 100, 100, 0, 0.001]),
  ])(
    "%s has the correct tick, minimum, step and sale cycle",
    (symbol, kind, minimum, step, settlement, tick) => {
      const rule = resolveInstrumentRule(String(symbol), date);
      expect(rule).toMatchObject({
        instrumentKind: kind,
        minimumBuyQuantity: minimum,
        buyQuantityStep: step,
        settlementDays: settlement,
        priceTick: tick,
      });
    },
  );
  it("honors dated cross-border availability and an explicitly identified eligibility exception", () => {
    expect(
      resolveInstrumentRule("sh513100", "2015-01-18").settlementCycle,
    ).toBe("T+1");
    expect(
      resolveInstrumentRule("sh513100", "2015-01-19").settlementCycle,
    ).toBe("T+0");
    expect(
      resolveInstrumentRule("sz159915", date, {
        instrumentKind: "etf-t0",
        settlementCycle: "T+1",
      }),
    ).toMatchObject({
      instrumentKind: "etf-t0",
      settlementDays: 1,
      stampDutyExempt: true,
    });
  });
  it.each([
    ["sh510900", "2015-01-16", "2015-01-19"],
    ["sz159632", "2022-08-02", "2022-08-03"],
    ["sh520900", "2024-07-09", "2024-07-10"],
  ])("uses the announced T+0 effective date for %s", (symbol, prior, from) => {
    expect(resolveInstrumentRule(symbol, prior).settlementCycle).toBe("T+1");
    expect(resolveInstrumentRule(symbol, from).settlementCycle).toBe("T+0");
    expect(
      resolveInstrumentRule(symbol, from, { settlementCycle: "T+1" })
        .settlementCycle,
    ).toBe("T+1");
  });
  it("keeps commission and slippage for ETFs, resolves stock stamp duty and opt-in historical SH face-value fees", () => {
    const costs = researchExecutionCosts("cn-equity", "base");
    expect(
      executionCostsForInstrument(costs, "sh510300", "2023-08-25"),
    ).toMatchObject({
      sellTaxBps: 0,
      transferBps: 0,
      minimumCommission: 5,
      commissionBps: 3,
      slippageBps: 5,
    });
    expect(
      executionCostsForInstrument(costs, "sh600000", "2023-08-25").sellTaxBps,
    ).toBe(10);
    expect(
      executionCostsForInstrument(costs, "sh600000", "2023-08-28").sellTaxBps,
    ).toBe(5);
    const historicalTransfer = "exchange-2015" as const;
    expect(
      executionCostsForInstrument(costs, "sh600000", "2015-07-31", {
        historicalTransfer,
        price: 20,
        faceValue: 1,
      }).transferBps,
    ).toBe(0.15);
    expect(
      executionCostsForInstrument(costs, "sz000001", "2015-07-31", {
        historicalTransfer,
      }).transferBps,
    ).toBe(0.255);
    expect(
      executionCostsForInstrument(costs, "sh600000", "2015-08-01", {
        historicalTransfer,
      }).transferBps,
    ).toBe(0.2);
    expect(() =>
      executionCostsForInstrument(costs, "sh600000", "2015-07-31", {
        historicalTransfer,
      }),
    ).toThrow("face value");
    expect(
      executionCostsForInstrument(costs, "sh510300", "2015-07-31", {
        historicalTransfer,
      }).transferBps,
    ).toBe(0);
  });
});
