import { expect, it } from "vitest";
import {
  runPortfolio,
  type PortfolioFill,
  type PortfolioRequest,
} from "quant-backtest";
import { computeSleeveAttribution } from "~/server/research/diagnose/sleeve-attribution";
import {
  buildCausalRiskParity60Targets,
  buildMonthEndEqualRebalanceTargets,
  computeSleeveTradeMetrics,
} from "~/server/research/diagnose/sleeve-trades";

function sessions(count: number) {
  const result: string[] = [];
  for (let i = 0; result.length < count; i++) {
    const day = new Date(Date.UTC(2024, 0, i + 1));
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6)
      result.push(day.toISOString().slice(0, 10));
  }
  return result;
}

const symbol = "sh600000";
function cashRequest(calendar: string[]): PortfolioRequest {
  const bars = calendar.map((date) => ({
    date,
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 100_000,
    amount: 1_000_000,
  }));
  return {
    market: "cn-equity",
    start: calendar[0]!,
    end: calendar.at(-1)!,
    calendar,
    initial: 100_000,
    sleeves: [
      { id: "a", share: 0.75, riskPerTrade: 0.01, maxPositions: 1 },
      { id: "b", share: 0.25, riskPerTrade: 0.01, maxPositions: 1 },
    ],
    strategies: ["a", "b"].map((id) => ({
      id,
      sleeve: id,
      market: "cn-equity",
      version: 1,
      period: "day",
      universe: { kind: "symbols", symbols: [symbol] },
      entry: { kind: "constant", value: false },
      exit: {},
      sizing: { kind: "weight", weight: 0.5 },
    })),
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
}

it("monthly idle-cash transfers conserve cash and leave each sleeve's investment returns exactly zero", () => {
  const request = cashRequest(sessions(26));
  const targets = buildMonthEndEqualRebalanceTargets(request.calendar, [
    "b",
    "a",
  ]);
  expect(targets).toEqual([
    {
      date: "2024-02-01",
      availableAt: "2024-01-31T15:00:00.001+08:00",
      shares: { a: 0.5, b: 0.5 },
    },
  ]);
  expect(
    buildMonthEndEqualRebalanceTargets(request.calendar.slice(0, 20), [
      "a",
      "b",
    ]),
  ).toEqual([]);
  const result = runPortfolio({
    ...request,
    sleeveTargets: targets,
    rebalance: {},
  });
  expect(result.transfers).toEqual([
    { date: "2024-02-01", sleeve: "a", amount: -25_000 },
    { date: "2024-02-01", sleeve: "b", amount: 25_000 },
  ]);
  expect(result.fills).toEqual([]);
  expect(
    result.equity.every(
      ({ cash, equity }) => cash === 100_000 && equity === cash,
    ),
  ).toBe(true);
  const attribution = computeSleeveAttribution(result);
  expect(attribution.sleeves.map((s) => s.return)).toEqual([2 / 3 - 1, 1]);
  for (const sleeve of attribution.sleeves) {
    expect(sleeve.investmentReturn).toBe(0);
    expect(sleeve.investmentMaxDrawdown).toBe(0);
    expect(sleeve.tradingPnlContribution).toBe(0);
    expect(sleeve.dailyInvestmentReturns.map((row) => row.return)).toEqual(
      request.calendar.map(() => 0),
    );
  }
  expect(attribution.correlations[0]!.correlation).toBeCloseTo(-1, 12);
  expect(attribution.investmentCorrelations[0]!.correlation).toBeNull();
  expect(attribution.contributionSum).toBe(attribution.maxDrawdown);
});

it("keeps the book peak-to-trough contribution additive while compounding transfer-adjusted returns", () => {
  const request = cashRequest(sessions(3));
  const result = runPortfolio(request);
  const marks = [
    [75_000, 25_000],
    [70_000, 30_000],
    [68_500, 35_000],
  ];
  result.equity = result.equity.map((row, i) => ({
    ...row,
    equity: marks[i]![0]! + marks[i]![1]! - (i === 1 ? 2_000 : 0),
    sleeves: row.sleeves.map((sleeve, j) => ({
      ...sleeve,
      equity: marks[i]![j]! - (i === 1 && j === 0 ? 2_000 : 0),
    })),
  }));
  result.transfers = [
    { date: request.calendar[1]!, sleeve: "a", amount: -5_000 },
    { date: request.calendar[1]!, sleeve: "b", amount: 5_000 },
  ];
  const attribution = computeSleeveAttribution(result);
  const [a, b] = attribution.sleeves;
  expect(a!.investmentReturn).toBeCloseTo(
    (73_000 / 75_000) * (68_500 / 68_000) - 1,
    12,
  );
  expect(a!.investmentMaxDrawdown).toBeCloseTo(2_000 / 75_000, 12);
  expect(a!.tradingPnlContribution).toBe(-1_500);
  expect(b!.tradingPnlContribution).toBe(5_000);
  expect(a!.drawdownContribution).toBeCloseTo(0.07, 12);
  expect(b!.drawdownContribution).toBeCloseTo(-0.05, 12);
  expect(
    Math.abs(attribution.contributionSum - attribution.maxDrawdown),
  ).toBeLessThan(1e-12);
});

it("pairs same-symbol round trips by sleeve and reconciles trading days, turnover and fill costs", () => {
  const days = sessions(5);
  const request = cashRequest(days);
  request.costs = {
    version: "cost-experiment-1",
    minimumCommission: 2,
    commissionBps: 10,
    sellTaxBps: 10,
    transferBps: 10,
    slippageBps: 10,
  };
  const result = runPortfolio(request);
  const fill = (
    orderId: number,
    sleeve: string,
    side: PortfolioFill["side"],
    day: number,
    price: number,
    fee: number,
    intendedPrice: number,
  ): PortfolioFill => ({
    orderId,
    sleeve,
    strategyId: sleeve,
    symbol,
    date: days[day]!,
    signalAt: days[day]!,
    side,
    price,
    quantity: 100,
    fee,
    cashAfter: 0,
    holdingAfter: side === "buy" ? 100 : 0,
    executionEvidence: {
      intendedPrice,
      slippageBps: 10,
      source: "portfolio-OHLC-model",
    },
  });
  result.fills = [
    fill(1, "a", "buy", 0, 10.1, 3.01, 10),
    fill(2, "b", "buy", 0, 10.1, 3.01, 10),
    fill(3, "a", "sell", 2, 12.9, 4.58, 13),
    fill(4, "b", "sell", 4, 8.9, 3.78, 9),
  ];
  result.equity = result.equity.map((row) => ({
    ...row,
    cash: 80_000,
    sleeves: row.sleeves.map((s) => ({
      ...s,
      cash: s.id === "a" ? 60_000 : 20_000,
    })),
  }));
  const { portfolio, sleeves } = computeSleeveTradeMetrics(result, request);
  expect(portfolio.roundTrips).toBe(2);
  expect(portfolio.winRate).toBe(0.5);
  expect(portfolio.profitLossRatio).toBeCloseTo(272.41 / 126.79, 12);
  expect(portfolio.profitFactor).toBeCloseTo(272.41 / 126.79, 12);
  expect(portfolio.holdingPeriod).toEqual({
    p25: 2.5,
    p50: 3,
    p75: 3.5,
    p90: 3.8,
  });
  expect(portfolio.cashRatio).toBe(0.8);
  expect(portfolio.oneSidedTurnover).toBeCloseTo(4_200 / 200_000, 12);
  expect(portfolio.costs).toMatchObject({
    commission: 8,
    slippage: 40,
    totalFees: result.fills.reduce((total, f) => total + f.fee, 0),
  });
  expect(portfolio.costs.stampDuty).toBeCloseTo(2.18, 12);
  expect(portfolio.costs.transferFee).toBeCloseTo(4.2, 12);
  expect(
    sleeves.map((s) => [s.roundTrips, s.winRate, s.holdingPeriod.p50]),
  ).toEqual([
    [1, 1, 2],
    [1, 0, 4],
  ]);
});

it("recovers an unclamped protective quote and discloses ambiguous slippage at a clamped low", () => {
  const request = cashRequest(sessions(3));
  request.costs = {
    version: "cost-experiment-1",
    minimumCommission: 0,
    commissionBps: 0,
    sellTaxBps: 0,
    slippageBps: 100,
  };
  request.strategies = request.strategies.map((strategy) =>
    strategy.id === "a"
      ? {
          ...strategy,
          entry: { kind: "constant", value: true },
          exit: { stop: { kind: "fixed", fraction: 0.05 } },
        }
      : strategy,
  );
  for (const clamp of [false, true]) {
    const bars = request.instruments[0]!.bars.map((bar, i) => ({
      ...bar,
      high: 11,
      low: i < 2 ? 9.7 : clamp ? 9.54 : 9.4,
    }));
    request.instruments = [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          tradable: true,
          limitUp: null,
          limitDown: null,
          slippagePolicy: clamp ? "clamp" : "reject",
        },
      },
    ];
    const result = runPortfolio(request);
    expect(result.fills.map((fill) => fill.side)).toEqual(["buy", "sell"]);
    expect(result.fills[1]!.executionEvidence).toBeUndefined();
    const { costs, roundTrips } = computeSleeveTradeMetrics(
      result,
      request,
    ).portfolio;
    expect(roundTrips).toBe(1);
    expect(costs.totalFees).toBe(0);
    if (clamp) {
      expect(result.fills[1]!.price).toBe(9.54);
      expect(costs).toMatchObject({ slippage: null, slippageMissingFills: 1 });
    } else {
      expect(costs.slippage).toBeCloseTo(
        (0.1 + 9.595 * 0.01) * result.fills[0]!.quantity,
        9,
      );
      expect(costs.slippageMissingFills).toBe(0);
    }
  }
});

it("uses only the last 60 completed sessions and retains idle, flat and thin sleeves' prior shares", () => {
  const calendar = sessions(65);
  const initial = { a: 0.2, b: 0.2, idle: 0.3, flat: 0.2, thin: 0.1 };
  const attribution = {
    sleeves: Object.keys(initial).map((id) => ({
      id,
      dailyInvestmentReturns: calendar.map((date, i) => {
        const swing = i % 2 === 0 ? -0.01 : 0.01;
        const value = {
          a: swing,
          b: swing * 2,
          idle: swing * 8,
          flat: 0,
          thin: i > 48 ? swing : null,
        }[id]!;
        return {
          date,
          return: i < 3 && id === "b" ? 0.2 : value,
          invested: id !== "idle" && !(id === "b" && i === 63),
        };
      }),
    })),
  };
  const full = buildCausalRiskParity60Targets(calendar, attribution, initial);
  const prefix = buildCausalRiskParity60Targets(
    calendar.slice(0, 64),
    attribution,
    initial,
  );
  expect(full.slice(0, -1)).toEqual(prefix);
  expect(full[0]!.availableAt).toBe(`${calendar[19]}T15:00:00.001+08:00`);
  expect(full[0]!.date).toBe(calendar[20]);
  const prior = prefix.at(-1)!.shares;
  expect(prior.a).toBeCloseTo((0.4 * 2) / 3, 12);
  expect(prior.b).toBeCloseTo(0.4 / 3, 12);
  expect(full.at(-1)!.shares.b).toBe(prior.b);
  for (const { shares } of full) {
    expect(shares).toMatchObject({ idle: 0.3, flat: 0.2, thin: 0.1 });
    expect(Object.values(shares).every(Number.isFinite)).toBe(true);
    expect(
      Object.values(shares).reduce((sum, value) => sum + value, 0),
    ).toBeCloseTo(1, 12);
  }
});
