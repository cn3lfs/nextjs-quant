import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import { reconcileFills } from "../../../scripts/lib/backtest-diagnose/reconcile";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const symbol = "sh600000";
const dates = [
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
  "2025-01-09",
  "2025-01-10",
  "2025-01-13",
] as const;
const [start, buyDay, dividendDay, bonusDay, lastHoldingDay, end] = dates;

function request(closes: readonly number[]): PortfolioRequest {
  const bars: Bar[] = closes.map((close, i) => ({
    date: dates[i]!,
    open: close,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume: 100_000,
    amount: close * 100_000,
  }));
  return {
    market: "cn-equity",
    start,
    end,
    initial: 2_500,
    calendar: dates,
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "accounting fixture",
          minimum: 100,
          step: 100,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
    strategies: [buildStrategy("hold", [symbol], "single")],
    sleeves: [{ id: "diag", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 3,
      minimumCommission: 5,
      sellTaxBps: 5,
      slippageBps: 0,
      dividendTaxBps: 1_000,
    },
  };
}

it("credits net dividends and bonus shares on their dates and realizes terminal value into cash", () => {
  const input = request([10, 10, 9.5, 7.6, 8, 8.2]);
  input.instruments = [
    {
      ...input.instruments[0]!,
      actions: [
        {
          date: dividendDay,
          availableAt: dividendDay,
          cashAvailableAt: dividendDay,
          timingAssumption: "ex-date-research-scenario",
          dividend: 0.5,
          bonus: 0,
          evidence: "cash dividend fixture",
        },
        {
          date: bonusDay,
          availableAt: bonusDay,
          cashAvailableAt: bonusDay,
          sharesSellableAt: bonusDay,
          timingAssumption: "ex-date-research-scenario",
          dividend: 0,
          bonus: 0.25,
          evidence: "bonus fixture",
        },
      ],
      terminal: {
        date: end,
        valuation: "last-close",
        evidence: "terminal coverage fixture",
      },
    },
  ];
  const result = runPortfolio(input);
  // ¥2,500 - 200 × ¥10 - ¥5 = ¥495. Dividend adds 200 × ¥0.50 × 90% = ¥90.
  // Bonus adds 200 × 0.25 = 50 shares. Terminal credit is 250 × ¥8.20 = ¥2,050.
  expect(result.fills).toHaveLength(1);
  expect(result.fills[0]).toMatchObject({
    date: buyDay,
    side: "buy",
    price: 10,
    quantity: 200,
    cashAfter: 495,
    holdingAfter: 200,
  });
  expect(result.corporateActions).toHaveLength(2);
  expect(result.corporateActions[0]).toMatchObject({
    date: dividendDay,
    before: 200,
    cash: 90,
    quantity: 200,
  });
  expect(result.corporateActions[1]).toMatchObject({
    date: bonusDay,
    before: 200,
    cash: 0,
    quantity: 250,
  });
  const expected = [
    { date: start, cash: 2_500, quantity: 0, mark: 10, equity: 2_500 },
    { date: buyDay, cash: 495, quantity: 200, mark: 10, equity: 2_495 },
    { date: dividendDay, cash: 585, quantity: 200, mark: 9.5, equity: 2_485 },
    { date: bonusDay, cash: 585, quantity: 250, mark: 7.6, equity: 2_485 },
    { date: lastHoldingDay, cash: 585, quantity: 250, mark: 8, equity: 2_585 },
    { date: end, cash: 2_635, quantity: 0, mark: 8.2, equity: 2_635 },
  ];
  expect(result.curve).toHaveLength(expected.length);
  expected.forEach(({ date, cash, quantity, mark, equity }, i) => {
    const row = result.curve[i]!;
    expect(row.date).toBe(date);
    expect(row.cash).toBe(cash);
    expect(row.cash).toBeGreaterThanOrEqual(0);
    const holding =
      result.positionSnapshots.find((position) => position.date === date)
        ?.quantity ?? 0;
    expect(holding).toBe(quantity);
    expect(row.equity).toBe(equity);
    expect(row.equity).toBeCloseTo(row.cash + holding * mark, 8);
  });
  expect(result.terminalValuations).toHaveLength(1);
  expect(result.terminalValuations[0]).toMatchObject({
    date: end,
    symbol,
    quantity: 250,
    price: 8.2,
    amount: 2_050,
  });
  expect(result.positions).toHaveLength(0);
  expect(reconcileFills(input, result)).toHaveLength(0);
});

it("transfers sleeve cash at the close and preserves total equity and the remaining position mark", () => {
  const input = request([10, 10, 11, 11, 11, 11]);
  input.initial = 4_000;
  input.strategies = [
    { ...input.strategies[0]!, sizing: { kind: "weight", weight: 0.6 } },
  ];
  input.sleeves = [
    { ...input.sleeves[0]!, share: 0.5 },
    { ...input.sleeves[0]!, id: "reserve", share: 0.5 },
  ];
  input.rebalance = { everyBars: 100 };
  input.sleeveTargets = [
    {
      date: dividendDay,
      availableAt: dividendDay,
      shares: { diag: 0.4, reserve: 0.6 },
    },
  ];
  const result = runPortfolio(input);
  // Before rebalancing: ¥995 + 100 × ¥11 = ¥2,095 invested, ¥2,000 reserve.
  // The invested target is 40% × ¥4,095 = ¥1,638, so transfer ¥457.
  expect(result.transfers).toHaveLength(2);
  expect(result.transfers).toContainEqual({
    date: dividendDay,
    sleeve: "diag",
    amount: -457,
  });
  expect(result.transfers).toContainEqual({
    date: dividendDay,
    sleeve: "reserve",
    amount: 457,
  });
  const row = result.curve.find(({ date }) => date === dividendDay)!;
  expect(row.cash).toBe(2_995);
  expect(row.equity).toBe(4_095);
  expect(row.sleeves.find(({ id }) => id === "diag")).toMatchObject({
    cash: 538,
    equity: 1_638,
  });
  expect(row.sleeves.find(({ id }) => id === "reserve")).toMatchObject({
    cash: 2_457,
    equity: 2_457,
  });
  for (const day of result.curve)
    expect(
      day.sleeves.reduce((total, sleeve) => total + sleeve.equity, 0),
    ).toBe(day.equity);
  expect(result.positions[0]).toMatchObject({
    sleeve: "diag",
    symbol,
    quantity: 100,
    mark: 11,
  });
  expect(reconcileFills(input, result)).toHaveLength(0);
});

it("detects a corrupted fill balance, missing position and invalid equity without reusing those outputs", () => {
  const input = request([10, 10, 10, 10, 10, 10]);
  const result = runPortfolio(input);
  const fill = result.fills[0]!;
  fill.cashAfter += 1;
  fill.holdingAfter += 100;
  result.curve[1]!.equity = Infinity;
  result.positionSnapshots = result.positionSnapshots.filter(
    ({ date }) => date !== buyDay,
  );
  const differences = reconcileFills(input, result);
  expect(differences).toHaveLength(4);
  expect(differences).toContainEqual({
    date: buyDay,
    field: "curve.equity",
    expected: 2_495,
    actual: Infinity,
  });
  expect(differences).toContainEqual({
    date: buyDay,
    field: `fills.${fill.orderId}.cashAfter`,
    expected: 495,
    actual: 496,
  });
  expect(differences).toContainEqual({
    date: buyDay,
    field: `fills.${fill.orderId}.holdingAfter`,
    expected: 200,
    actual: 300,
  });
  expect(differences).toContainEqual(
    expect.objectContaining({
      date: buyDay,
      field: expect.stringMatching(/^positionSnapshots\./),
      expected: 200,
      actual: null,
    }),
  );
});
