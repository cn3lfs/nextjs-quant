import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";

const symbol = "sh600000";
const [signalDay, buyDay, sellDay] = [
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
] as const;
const initial = 5_500;
const lot = 100;
const participation = 0.01;

function request(buyAmount: number, sellAmount?: number): PortfolioRequest {
  const dates =
    sellAmount === undefined
      ? [signalDay, buyDay]
      : [signalDay, buyDay, sellDay];
  const bars = dates.map((date) => ({
    date,
    open: 10,
    high: 11.5,
    low: 9.5,
    close: date === sellDay ? 11 : 10.5,
    volume: 100_000,
    amount:
      date === buyDay ? buyAmount : date === sellDay ? sellAmount! : 1_000_000,
  }));
  return {
    market: "cn-equity",
    initial,
    start: signalDay,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          evidence: "synthetic capacity bars",
          tradable: true,
          minimum: lot,
          step: lot,
          limitUp: 12,
          limitDown: 9,
        },
      },
    ],
    strategies: [
      {
        id: "constant-entry",
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: { kind: "symbols", symbols: [symbol] },
        entry: { kind: "constant", value: true },
        exit: sellAmount === undefined ? {} : { maxBars: 1 },
        sizing: { kind: "weight", weight: 1 },
        sleeve: "capacity",
      },
    ],
    sleeves: [{ id: "capacity", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 3,
      minimumCommission: 5,
      sellTaxBps: 5,
      slippageBps: 0,
    },
  };
}

it("preserves the default next-open fill when participation is absent", () => {
  // ¥5,500 covers 500 shares at ¥10 plus ¥5, even on a low-turnover bar.
  const result = runPortfolio(request(99_000));
  expect(result.fills).toHaveLength(1);
  expect(result.fills[0]).toMatchObject({
    symbol,
    side: "buy",
    signalAt: signalDay,
    date: buyDay,
    price: 10,
    quantity: 500,
    fee: 5,
    cashAfter: 495,
    holdingAfter: 500,
  });
  expect(result.orders[0]?.status).toBe("filled");
  expect(result.fills[0]).not.toHaveProperty("capacityClipped");
  expect(result.orders[0]).not.toHaveProperty("capacityClipped");
  expect(result.rejections).toHaveLength(0);
});

it("clips the buy to a whole lot within the participation amount and books the clipped fill", () => {
  const barAmount = 250_000;
  const result = runPortfolio({
    ...request(barAmount),
    maxParticipation: participation,
    capacityPolicy: "clip",
  });
  expect(result.fills).toHaveLength(1);
  const fill = result.fills[0]!;
  // ¥2,500 funds 250 shares at the open, rounded down to 200. Mark at ¥10.50.
  expect(fill).toMatchObject({
    side: "buy",
    date: buyDay,
    price: 10,
    quantity: 200,
    fee: 5,
    cashAfter: 3_495,
    holdingAfter: 200,
    capacityClipped: true,
  });
  expect(fill.quantity % lot).toBe(0);
  expect(fill.quantity * fill.price).toBeLessThanOrEqual(
    barAmount * participation + 1e-6,
  );
  expect(result.orders[0]).toMatchObject({
    id: fill.orderId,
    status: "filled",
    capacityClipped: true,
  });
  expect(result.rejections).toHaveLength(0);
  expect(result.positions).toHaveLength(1);
  expect(result.positions[0]).toMatchObject({
    symbol,
    quantity: 200,
    mark: 10.5,
  });
  expect(result.curve.at(-1)).toMatchObject({
    date: buyDay,
    cash: 3_495,
    equity: 5_595,
  });
});

it.each([
  {
    caseName: "reject mode above the cap",
    capacityPolicy: "reject",
    amount: 250_000,
  },
  {
    caseName: "clip mode below one lot",
    capacityPolicy: "clip",
    amount: 99_000,
  },
] as const)(
  "rejects the buy in $caseName without posting a fill",
  ({ capacityPolicy, amount }) => {
    const result = runPortfolio({
      ...request(amount),
      maxParticipation: participation,
      capacityPolicy,
    });
    expect(result.fills).toHaveLength(0);
    const order = result.orders[0]!;
    expect(order).toMatchObject({
      side: "buy",
      due: buyDay,
      status: "rejected",
      reason: expect.stringContaining("参与率上限"),
    });
    expect(result.rejections).toEqual([
      {
        orderId: order.id,
        date: buyDay,
        reason: expect.stringContaining("参与率上限"),
      },
    ]);
    expect(result.positions).toHaveLength(0);
    expect(result.curve.at(-1)).toMatchObject({
      date: buyDay,
      cash: initial,
      equity: initial,
    });
  },
);

it("leaves the unfilled shares held and the sell order pending after a clipped sale", () => {
  const sellAmount = 150_000;
  const result = runPortfolio({
    ...request(1_000_000, sellAmount),
    maxParticipation: participation,
    capacityPolicy: "clip",
  });
  expect(result.fills).toHaveLength(2);
  const [buy, sell] = result.fills;
  expect(buy).toMatchObject({
    side: "buy",
    date: buyDay,
    quantity: 500,
    holdingAfter: 500,
    cashAfter: 495,
  });
  expect(buy).not.toHaveProperty("capacityClipped");
  // ¥1,500 funds one sell lot. Cash is ¥495 + ¥1,000 - ¥5.50 in fees.
  expect(sell).toMatchObject({
    side: "sell",
    signalAt: buyDay,
    date: sellDay,
    price: 10,
    quantity: 100,
    fee: 5.5,
    cashAfter: 1_489.5,
    holdingAfter: 400,
    capacityClipped: true,
  });
  expect(sell!.quantity * sell!.price).toBeLessThanOrEqual(
    sellAmount * participation + 1e-6,
  );
  expect(result.orders.find(({ id }) => id === sell!.orderId)).toMatchObject({
    status: "pending",
    reason: null,
    attempts: 1,
    capacityClipped: true,
  });
  expect(result.rejections).toHaveLength(0);
  expect(result.positions).toHaveLength(1);
  expect(result.positions[0]).toMatchObject({
    symbol,
    quantity: 400,
    mark: 11,
  });
  expect(result.curve.at(-1)).toMatchObject({
    date: sellDay,
    cash: 1_489.5,
    equity: 5_889.5,
  });
});
