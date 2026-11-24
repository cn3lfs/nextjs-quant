import { expect, it } from "vitest";
import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";

const stock = "sh600000";
const bond = "sh511010";
const dates = Array.from({ length: 22 }, (_, i) =>
  new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
);
function instrument(
  symbol: string,
  closes: number[],
  extra: Partial<PortfolioInstrument> = {},
): PortfolioInstrument {
  const bars = closes.map((close, i) => ({
    date: dates[i]!,
    open: close,
    close,
    high: close + 0.1,
    low: close - 0.1,
    volume: 10000,
    amount: 100000,
  }));
  return {
    symbol,
    market: "cn-equity",
    bars,
    signalBars: bars,
    industry: "finance",
    execution: {
      evidence: "fixture",
      tradable: true,
      limitUp: null,
      limitDown: null,
    },
    ...extra,
  };
}
function strategy(
  id: string,
  symbol: string,
  weight: number,
): PortfolioRequest["strategies"][number] {
  return {
    id,
    sleeve: id,
    market: "cn-equity",
    period: "day",
    version: 1,
    universe: { kind: "symbols", symbols: [symbol] },
    entry: { kind: "constant", value: true },
    exit: {
      rule: { kind: "constant", value: false },
      stop: { kind: "fixed", fraction: 0.1 },
    },
    sizing: { kind: "weight", weight },
  };
}
function request(
  instruments: PortfolioInstrument[],
  strategies: PortfolioRequest["strategies"],
): PortfolioRequest {
  const calendar = instruments[0]!.bars.map((b) => b.date);
  return {
    market: "cn-equity",
    initial: 100000,
    start: calendar[0]!,
    end: calendar.at(-1)!,
    calendar,
    instruments,
    strategies,
    sleeves: strategies.map((s) => ({
      id: s.sleeve,
      share: 1 / strategies.length,
      maxPositions: 4,
      riskPerTrade: 1,
    })),
    costs: {
      version: "cost-experiment-1",
      minimumCommission: 0,
      commissionBps: 0,
      slippageBps: 0,
      sellTaxBps: 0,
    },
  };
}

it("combines filled exposure across sleeves before testing the next symbol, industry and stop cap", () => {
  const other = "sh600001",
    utility = "sh600002";
  const r = request(
    [
      instrument(stock, [10, 10]),
      instrument(other, [10, 10]),
      instrument(utility, [10, 10], { industry: "utilities" }),
    ],
    [
      strategy("a", stock, 0.4),
      strategy("b", stock, 0.4),
      strategy("c", other, 0.4),
      strategy("d", utility, 0.4),
    ],
  );
  // 4 sleeves request 1000 shares each. At 10 CNY/stock, one sector has 2000 shares of room,
  // a single name 1500. A stop one CNY below each entry leaves 200 shares in the last sector.
  r.riskPolicy = {
    maxSingleInstrumentWeight: 0.15,
    maxIndustryWeight: 0.2,
    maxTotalStopRisk: 0.022,
    riskPerTrade: 1,
  };
  const result = runPortfolio(r);
  expect(result.fills.map((f) => [f.sleeve, f.quantity])).toEqual([
    ["a", 1000],
    ["b", 500],
    ["c", 500],
    ["d", 200],
  ]);
  expect(result.riskAudit).toMatchObject({ blocked: 0, reduced: 3 });
  expect(result.riskAudit!.entries.map((row) => row.decision.reasons)).toEqual([
    [],
    ["instrument_cap"],
    ["industry_cap"],
    ["total_stop_risk_cap"],
  ]);
  expect(result.riskAudit!.entries.at(-1)!.decision.stopRiskAfter).toBe(2200);
});

it("requires a completed Wilder ATR seed, uses the signal's raw price scale and ignores entry-day range", () => {
  const rows = instrument(stock, Array(16).fill(10));
  rows.bars = rows.bars.map((b, i) => ({
    ...b,
    low: 9.5,
    high: i === 15 ? 19 : 10.5,
  }));
  rows.signalBars = rows.bars.map((b) => ({
    ...b,
    open: b.open / 2,
    close: b.close / 2,
    high: b.high / 2,
    low: b.low / 2,
  }));
  const s = strategy("one", stock, 1);
  s.exit = { rule: { kind: "constant", value: false } };
  const r = request([rows], [s]);
  r.riskPolicy = {};
  const result = runPortfolio(r);
  expect(result.riskAudit!.blocked).toBe(14);
  expect(result.riskAudit!.entries[0]!.decision.reasons).toContain(
    "missing_stop",
  );
  // ATR=0.5 on adjusted bars, 1 on raw bars; 500/(2*1) floors to 200.
  expect(result.fills.map((f) => [f.date, f.quantity])).toEqual([
    [dates[15], 200],
  ]);
  expect(result.riskAudit!.entries.at(-1)!.decision.stopPrice).toBe(8);
});

it("rejects an ATR add-on when the open has crossed the standing stop and still sells the original lot", () => {
  const rows = instrument(stock, [...Array(16).fill(10), 7]);
  rows.bars = rows.bars.map((bar, i) =>
    i < 16 ? { ...bar, high: 10.5, low: 9.5 } : bar,
  );
  rows.signalBars = rows.bars;
  const s = strategy("one", stock, 1);
  s.exit = {};
  s.sizing = { kind: "weight", weight: 1, tranches: 2 };
  const r = request([rows], [s]);
  r.riskPolicy = {};

  // 100000 × 0.005 / (2 × ATR 1) = 250 shares → 200. The next
  // open at 7 breaches the stop at 8, so the original loss is 200 × (10 − 7).
  const result = runPortfolio(r);
  expect(result.riskAudit!.entries.at(-1)).toMatchObject({
    date: dates[16],
    executedQuantity: 0,
    decision: { reasons: ["stop_already_triggered"], quantity: 0 },
  });
  expect(
    result.fills.map(({ side, quantity, price }) => [side, quantity, price]),
  ).toEqual([
    ["buy", 200, 10],
    ["sell", 200, 7],
  ]);
  expect(result.equity.at(-1)!.equity).toBe(99_400);
});

it("stops a bond ETF on its entry day and retries a stock stop next session, charging the dated sale tax only on stock", () => {
  const run = (symbol: string, kind: PortfolioInstrument["instrumentKind"]) => {
    const rows = instrument(symbol, [10.001, 10.001, 9.001], {
      instrumentKind: kind,
    });
    rows.bars = rows.bars.map((b, i) => (i === 1 ? { ...b, low: 8.5 } : b));
    rows.signalBars = rows.bars;
    const s = strategy("one", symbol, 0.3);
    const r = request([rows], [s]);
    r.memberships = r.calendar.map((date, i) => ({
      date,
      availableAt: date,
      strategyId: "one",
      symbols: i === 0 ? [symbol] : [],
    }));
    r.costs = {
      ...r.costs!,
      minimumCommission: 5,
      sellTaxSchedule: { kind: "cn-equity-historical", multiplier: 1 },
      transferSchedule: { kind: "cn-equity-transfer", multiplier: 1 },
    };
    return runPortfolio(r);
  };
  const etf = run(bond, "etf-t0"),
    equity = run(stock, "equity-main");
  expect(etf.fills.map((f) => [f.date, f.price, f.fee])).toEqual([
    [dates[1], 10.001, 5],
    [dates[1], 9, 5],
  ]);
  expect(equity.fills.map((f) => [f.date, f.price])).toEqual([
    [dates[1], 10.01],
    [dates[2], 9],
  ]);
  expect(equity.rejections[0]!.reason).toContain("T+1");
  const sale = equity.fills[1]!;
  expect(sale.fee).toBeCloseTo(5 + sale.quantity * 9 * (0.0005 + 0.00001), 10);
});

it("admits a 201-share STAR order, rejects 199, and retains the legacy template without metadata", () => {
  const run = (initial: number, withMetadata: boolean) => {
    const symbol = "sh688001";
    const rows = instrument(
      symbol,
      [10, 10],
      withMetadata ? { instrumentKind: "equity-star" } : {},
    );
    const r = request([rows], [strategy("one", symbol, 1)]);
    r.initial = initial;
    return runPortfolio(r).fills.map((f) => f.quantity);
  };
  expect(run(2010, true)).toEqual([201]);
  expect(run(1990, true)).toEqual([]);
  expect(run(2010, false)).toEqual([200]);
});

it.each([
  [bond, dates[1]],
  ["sh530000", dates[2]],
] as const)(
  "applies ETF fees and settlement to %s without metadata or an account risk policy",
  (symbol, saleDate) => {
    const rows = instrument(symbol, [10.001, 10.001, 9.001]);
    rows.bars = rows.bars.map((bar, i) =>
      i === 1 ? { ...bar, low: 8.5 } : bar,
    );
    rows.signalBars = rows.bars;
    const r = request([rows], [strategy("one", symbol, 0.3)]);
    r.memberships = r.calendar.map((date, i) => ({
      date,
      availableAt: date,
      strategyId: "one",
      symbols: i === 0 ? [symbol] : [],
    }));
    r.costs = {
      ...r.costs!,
      minimumCommission: 5,
      sellTaxSchedule: { kind: "cn-equity-historical", multiplier: 1 },
      transferSchedule: { kind: "cn-equity-transfer", multiplier: 1 },
    };
    const result = runPortfolio(r);
    expect(
      result.fills.map(({ side, date, price, fee }) => [
        side,
        date,
        price,
        fee,
      ]),
    ).toEqual([
      ["buy", dates[1], 10.001, 5],
      ["sell", saleDate, symbol === bond ? 9 : 9.001, 5],
    ]);
    expect(result.rejections.map(({ reason }) => reason)).toEqual(
      symbol === bond ? [] : [expect.stringContaining("T+1")],
    );
  },
);

it("blocks next-open entries after loss, counts three recovered closes and neutralizes a deposit and withdrawal at open NAV", () => {
  const other = "sh600001",
    path = [10, 10, 8, 10, 10, 10, 10];
  const a = strategy("a", stock, 1),
    b = strategy("b", other, 0.1);
  a.exit = { stop: { kind: "fixed", fraction: 0.5 } };
  const r = request(
    [
      instrument(stock, path),
      instrument(
        other,
        path.map(() => 10),
      ),
    ],
    [a, b],
  );
  // 5000 shares at 10 cost 50% of account. A two-yuan drop loses 10000. At recovery
  // the deposit and redemption exchange units at NAV=1 and cannot advance the counter.
  r.memberships = dates.slice(0, path.length).map((date, i) => ({
    date,
    availableAt: date,
    strategyId: "b",
    symbols: i >= 2 ? [other] : [],
  }));
  r.externalCashFlows = [
    { date: dates[3]!, sleeve: "b", amount: 20000 },
    { date: dates[4]!, sleeve: "b", amount: -10000 },
  ];
  r.riskPolicy = {
    maxSingleInstrumentWeight: 1,
    maxIndustryWeight: 1,
    maxTotalStopRisk: 1,
    riskPerTrade: 1,
  };
  const result = runPortfolio(r);
  expect(
    result.riskAudit!.daily.map((d) => [d.unitNav, d.mode, d.recoveryCloses]),
  ).toEqual([
    [1, "normal", 0],
    [1, "normal", 0],
    [0.9, "paused", 0],
    [1, "paused", 1],
    [1, "paused", 2],
    [1, "normal", 0],
    [1, "normal", 0],
  ]);
  expect(result.riskAudit!.blocked).toBe(3);
  expect(
    result.fills.filter((f) => f.sleeve === "b").map((f) => f.date),
  ).toEqual([dates[6]]);
});

it("halves the next entry only after the drawdown is known at the preceding close", () => {
  const other = "sh600001";
  const r = request(
    [
      instrument(stock, [10, 10, 8.9, 8.9]),
      instrument(other, [10, 10, 10, 10]),
    ],
    [strategy("a", stock, 1), strategy("b", other, 0.2)],
  );
  r.strategies = r.strategies.map((s) => ({
    ...s,
    exit: { stop: { kind: "fixed", fraction: 0.5 } },
  }));
  r.riskPolicy = {
    maxSingleInstrumentWeight: 1,
    maxIndustryWeight: 1,
    maxTotalStopRisk: 1,
    riskPerTrade: 1,
  };
  r.memberships = r.calendar.map((date, i) => ({
    date,
    availableAt: date,
    strategyId: "b",
    symbols: i >= 2 ? [other] : [],
  }));
  const result = runPortfolio(r);
  // The first 5000 shares lose 1.10 each, producing a 5.5% drawdown.
  expect(result.riskAudit!.daily.map((d) => d.mode)).toEqual([
    "normal",
    "normal",
    "reduced",
    "reduced",
  ]);
  expect(result.fills.map((f) => [f.sleeve, f.quantity])).toEqual([
    ["a", 5000],
    ["a", 2500],
    ["b", 500],
  ]);
  expect(result.riskAudit!.entries.at(-1)).toMatchObject({
    requestedQuantity: 1000,
    decision: { quantity: 500, reasons: ["drawdown_reduced"] },
  });
});

it("halves existing exposure at the next open once per drawdown episode with cash conservation", () => {
  const path = [10, 10, 9.7, 9.5, 9.4, 9.4, 10.5, 10.5, 10.5, 9.3, 9.3];
  const s = strategy("one", stock, 1);
  s.exit = { stop: { kind: "fixed", fraction: 0.5 } };
  const r = request([instrument(stock, path)], [s]);
  r.riskPolicy = {
    maxSingleInstrumentWeight: 1,
    maxIndustryWeight: 1,
    maxTotalStopRisk: 1,
    riskPerTrade: 1,
  };
  const result = runPortfolio(r);
  expect(result.riskAudit!.daily.map(({ mode }) => mode)).toEqual([
    "normal",
    "normal",
    "normal",
    "reduced",
    "reduced",
    "reduced",
    "reduced",
    "reduced",
    "normal",
    "reduced",
    "reduced",
  ]);
  expect(
    result.fills.map(
      ({ date, side, price, quantity, holdingAfter, cashAfter }) => [
        date,
        side,
        price,
        quantity,
        holdingAfter,
        cashAfter,
      ],
    ),
  ).toEqual([
    [dates[1], "buy", 10, 10_000, 10_000, 0],
    [dates[4], "sell", 9.4, 5_000, 5_000, 47_000],
    [dates[10], "sell", 9.3, 2_500, 2_500, 70_250],
  ]);
  const firstSale = result.fills[1]!;
  expect(result.equity[4]).toMatchObject({ cash: 47_000, equity: 94_000 });
  expect(
    result.positionSnapshots.find(({ date }) => date === dates[4]),
  ).toMatchObject({ quantity: 5_000, weight: 0.5 });
  expect(
    result.orders.find(({ id }) => id === firstSale.orderId),
  ).toMatchObject({
    signalAt: dates[3],
    due: dates[4],
    status: "filled",
    targetRemainingQuantity: 5_000,
  });
  expect(result.riskAudit).toMatchObject({
    reductions: [
      {
        orderId: firstSale.orderId,
        date: dates[3],
        symbol: stock,
        quantityBefore: 10_000,
        retainedScale: 0.5,
      },
      {
        orderId: result.fills[2]!.orderId,
        date: dates[9],
        symbol: stock,
        quantityBefore: 5_000,
        retainedScale: 0.5,
      },
    ],
  });
  expect(result.rejections).toEqual([]);
});

it("retries the frozen reduction through a suspension and sells only settled board lots after a stock dividend", () => {
  const rows = instrument(stock, [10, 10, 9.5, 4.64, 4.64, 4.64, 4.64]);
  const s = strategy("one", stock, 1);
  s.exit = { stop: { kind: "fixed", fraction: 0.5 } };
  const r = request([rows], [s]);
  // The stock resumes with 1000 old shares sellable. The last session
  // unlocks the 1050 bonus shares. Only 500 of the remaining 537 can be sold.
  rows.execution = (bar) => ({
    evidence: "fixture",
    tradable: bar?.date !== dates[3],
    limitUp: null,
    limitDown: null,
  });
  rows.actions = [
    {
      date: dates[3]!,
      availableAt: dates[3]!,
      sharesSellableAt: dates[6]!,
      bonus: 1.05,
      dividend: 0,
      evidence: "fixture",
    },
  ];
  r.initial = 10_000;
  r.riskPolicy = {
    reducedScale: 0.25,
    maxSingleInstrumentWeight: 1,
    maxIndustryWeight: 1,
    maxTotalStopRisk: 1,
    riskPerTrade: 1,
  };
  const result = runPortfolio(r);
  const [reduction] = result.riskAudit!.reductions;
  expect(result.riskAudit!.reductions).toHaveLength(1);
  expect(result.fills.filter(({ side }) => side === "sell")).toMatchObject([
    {
      date: dates[4],
      orderId: reduction!.orderId,
      quantity: 1_000,
      holdingAfter: 1_050,
      cashAfter: 4_640,
    },
    {
      date: dates[6],
      orderId: reduction!.orderId,
      quantity: 500,
      holdingAfter: 550,
      cashAfter: 6_960,
    },
  ]);
  expect(
    result.rejections.filter(({ orderId }) => orderId === reduction!.orderId),
  ).toMatchObject([
    { date: dates[3], reason: expect.stringContaining("停牌") },
    { date: dates[5], reason: expect.stringContaining("T+1") },
  ]);
  expect(result.equity.at(-1)).toMatchObject({ equity: 9_512 });
});

it("excludes an unpriced holding's close and restarts the recovery count on the next mark", () => {
  const ins = instrument(stock, [10, 10, 9, 10, 10, 10, 10, 10]);
  const r = request([ins], [strategy("a", stock, 1)]);
  const bars = ins.bars.filter((_, i) => i !== 4);
  r.instruments = [{ ...ins, bars, signalBars: bars }];
  r.strategies = r.strategies.map((s) => ({
    ...s,
    exit: { stop: { kind: "fixed", fraction: 0.5 } },
  }));
  r.riskPolicy = {
    riskPerTrade: 1,
    maxSingleInstrumentWeight: 1,
    maxIndustryWeight: 1,
    maxTotalStopRisk: 1,
  };
  const audit = runPortfolio(r).riskAudit!;
  // 10000 shares at 10 fall to 9 => NAV .90. Jan 4 and Jan 6 each
  // start a qualifying streak; Jan 5 had no close for the holding.
  expect(audit.missingCloses).toEqual([dates[4]]);
  // A 1000 CNY deposit on the missing day cannot be converted into NAV units.
  expect(() =>
    runPortfolio({
      ...r,
      externalCashFlows: [{ sleeve: "a", date: dates[4]!, amount: 1000 }],
    }),
  ).toThrow("Missing opening valuation");
  expect(
    audit.daily.slice(2).map((row) => [row.mode, row.recoveryCloses]),
  ).toEqual([
    ["paused", 0],
    ["paused", 1],
    ["paused", 1],
    ["paused", 2],
    ["normal", 0],
  ]);
});

it("counts only a completed Shanghai close or UTC midnight, even when a replay ends intraday", () => {
  for (const market of ["cn-equity", "crypto"] as const) {
    const times =
      market === "cn-equity"
        ? [
            "2024-01-02T14:55:00+08:00",
            "2024-01-02T15:00:00+08:00",
            "2024-01-03T09:35:00+08:00",
          ]
        : [
            "2024-01-02T23:55:00Z",
            "2024-01-03T00:00:00Z",
            "2024-01-03T00:05:00Z",
          ];
    const s = strategy("a", stock, 1);
    const ins = instrument(stock, [10, 10, 10]);
    const bars = ins.bars.map((b, i) => ({ ...b, date: times[i]! }));
    const r = request(
      [{ ...ins, market, bars, signalBars: bars }],
      [
        {
          ...s,
          market,
          period: "5m",
          entry: { kind: "constant", value: false },
        },
      ],
    );
    r.market = market;
    r.riskPolicy = {};
    expect(runPortfolio(r).riskAudit!.daily.map((d) => d.date)).toEqual([
      "2024-01-02",
    ]);
  }
});
